const { Transform } = require('node:stream')
const { StringDecoder } = require('node:string_decoder')

const EXEC_TOOL_NAME = 'exec'
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024
const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024
const MAX_RESPONSE_STREAM_BYTES = 32 * 1024 * 1024
const MAX_RESPONSE_FRAME_BYTES = 8 * 1024 * 1024
const MAX_TOOL_ARGUMENT_BYTES = 1024 * 1024
const MAX_PENDING_ARGUMENT_BYTES = 8 * 1024 * 1024
const MAX_PENDING_EXEC_ITEMS = 128
const MAX_ACTIVE_BRIDGE_TRANSFORMS = 16
const MAX_GLOBAL_BRIDGE_BUFFER_BYTES = 16 * 1024 * 1024
const PART_BLOCK_SIZE = 1024
let activeBridgeTransforms = 0
let globalBridgeBufferBytes = 0

class BridgeBudgetLease {
  constructor() {
    this.bytes = 0
    this.acquired = activeBridgeTransforms < MAX_ACTIVE_BRIDGE_TRANSFORMS
    if (this.acquired) activeBridgeTransforms += 1
  }

  assertAvailable() {
    if (!this.acquired) throw new Error('Too many concurrent bridge responses')
  }

  reserve(bytes) {
    this.assertAvailable()
    if (bytes <= 0) return
    if (globalBridgeBufferBytes + bytes > MAX_GLOBAL_BRIDGE_BUFFER_BYTES) {
      throw new Error('Responses bridge global buffer budget exceeded')
    }
    this.bytes += bytes
    globalBridgeBufferBytes += bytes
  }

  release(bytes) {
    if (!this.acquired || bytes <= 0) return
    const released = Math.min(bytes, this.bytes)
    this.bytes -= released
    globalBridgeBufferBytes -= released
  }

  close() {
    if (!this.acquired) return
    globalBridgeBufferBytes -= this.bytes
    this.bytes = 0
    this.acquired = false
    activeBridgeTransforms -= 1
  }
}

function functionParameters() {
  return {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Raw input for the Codex desktop exec tool.',
      },
    },
    required: ['input'],
    additionalProperties: false,
  }
}

function convertToolDefinition(tool) {
  if (!tool || tool.type !== 'custom' || tool.name !== EXEC_TOOL_NAME) return tool
  return {
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: functionParameters(),
    strict: true,
  }
}

function encodeFunctionArguments(input) {
  if (typeof input !== 'string') {
    throw new Error('Codex exec custom tool input must be a string')
  }
  return JSON.stringify({ input })
}

function decodeFunctionArguments(argumentsText) {
  if (Buffer.byteLength(String(argumentsText), 'utf8') > MAX_TOOL_ARGUMENT_BYTES) {
    throw new Error('Upstream exec function arguments are too large')
  }
  let value
  try {
    value = JSON.parse(argumentsText)
  } catch {
    throw new Error('Upstream exec function arguments are not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.input !== 'string') {
    throw new Error('Upstream exec function arguments must contain a string input field')
  }
  return value.input
}

function convertInputItem(item, execCallIds, allowContinuationOutput) {
  if (!item || typeof item !== 'object') return item
  if (item.type === 'custom_tool_call' && item.name === EXEC_TOOL_NAME) {
    return {
      ...item,
      type: 'function_call',
      arguments: encodeFunctionArguments(item.input),
      input: undefined,
      /*
       * 服务端签发的 item.id 前缀即类型：custom_tool_call 是 ctc_、
       * function_call 是 fc_。改了类型还带着旧前缀的 id，上游会按
       * 「function_call 必须 fc 开头」拒收整个请求。历史项的 id 本就
       * 可省略，摘掉最稳；call_id 才是调用与结果的关联键，保留不动。
       */
      id: undefined,
    }
  }
  if (item.type === 'custom_tool_call_output'
    && (execCallIds.has(item.call_id) || allowContinuationOutput)) {
    return { ...item, type: 'function_call_output', id: undefined }
  }
  return item
}

function convertRequestPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Responses request body must be a JSON object')
  }
  const tools = Array.isArray(payload.tools)
    ? payload.tools.map(convertToolDefinition)
    : payload.tools
  if (Array.isArray(tools)) {
    const execFunctions = tools.filter((tool) => (
      tool?.type === 'function' && tool.name === EXEC_TOOL_NAME
    ))
    if (execFunctions.length > 1) {
      throw new Error('Responses request contains conflicting exec tool definitions')
    }
  }
  const execCallIds = new Set(Array.isArray(payload.input)
    ? payload.input
      .filter((item) => item?.type === 'custom_tool_call'
        && item.name === EXEC_TOOL_NAME
        && typeof item.call_id === 'string')
      .map((item) => item.call_id)
    : [])
  const customTools = Array.isArray(payload.tools)
    ? payload.tools.filter((tool) => tool?.type === 'custom')
    : []
  const allowContinuationOutput = typeof payload.previous_response_id === 'string'
    && payload.previous_response_id.trim()
    && customTools.length === 1
    && customTools[0].name === EXEC_TOOL_NAME
  const input = Array.isArray(payload.input)
    ? payload.input.map((item) => convertInputItem(
        item,
        execCallIds,
        allowContinuationOutput,
      ))
    : payload.input
  return { ...payload, ...(tools ? { tools } : {}), ...(input ? { input } : {}) }
}

function convertRequestBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Responses request body must be a Buffer')
  if (buffer.length > MAX_REQUEST_BODY_BYTES) {
    throw new Error('Responses request body is too large for experimental tool compatibility mode')
  }
  let payload
  try {
    payload = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new Error('Responses request body is not valid UTF-8 JSON')
  }
  return Buffer.from(JSON.stringify(convertRequestPayload(payload)), 'utf8')
}

function argumentBufferText(buffer) {
  if (typeof buffer === 'string') return buffer
  if (!buffer) return ''
  if (buffer.joined === undefined) {
    buffer.joined = [...buffer.blocks, buffer.parts.join('')].join('')
  }
  return buffer.joined
}

function convertFunctionItem(item, argumentBuffers, aliases = new Map()) {
  if (!item || item.type !== 'function_call' || item.name !== EXEC_TOOL_NAME) return item
  const rawKey = item.id || item.call_id
  const key = aliases.get(rawKey) ?? rawKey
  const argumentsText = typeof item.arguments === 'string'
    ? item.arguments
    : argumentBufferText(argumentBuffers.get(key))
  const input = argumentsText ? decodeFunctionArguments(argumentsText) : ''
  return {
    ...item,
    type: 'custom_tool_call',
    input,
    arguments: undefined,
    // `function_call` ids use the `fc_` prefix, while Codex expects
    // `custom_tool_call` ids to use `ctc_`. The call_id remains the stable
    // correlation key, so omit the mismatched item id rather than leaking a
    // type-invalid identifier to the client.
    id: undefined,
  }
}

function convertResponseObject(value, argumentBuffers = new Map(), aliases = new Map()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const converted = { ...value }
  if (Array.isArray(value.output)) {
    converted.output = value.output.map((item) => convertFunctionItem(item, argumentBuffers, aliases))
  }
  if (value.response && typeof value.response === 'object') {
    converted.response = convertResponseObject(value.response, argumentBuffers, aliases)
  }
  return converted
}

function convertResponseBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Responses response body must be a Buffer')
  if (buffer.length > MAX_RESPONSE_BODY_BYTES) {
    throw new Error('Responses response body is too large for experimental tool compatibility mode')
  }
  let payload
  try {
    payload = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new Error('Upstream Responses body is not valid JSON')
  }
  return Buffer.from(JSON.stringify(convertResponseObject(payload)), 'utf8')
}

function encodeSseEvent(eventName, data) {
  return `${eventName ? `event: ${eventName}\n` : ''}data: ${JSON.stringify(data)}\n\n`
}

class ResponsesToolBridgeTransform extends Transform {
  constructor() {
    super()
    this.lease = new BridgeBudgetLease()
    this.decoder = new StringDecoder('utf8')
    this.lineBlocks = []
    this.lineParts = []
    this.lineBytes = 0
    this.frameLines = []
    this.frameBytes = 0
    this.argumentBuffers = new Map()
    this.argumentBufferBytes = 0
    this.execItems = new Set()
    this.execAliases = new Map()
    this.itemAliases = new Map()
  }

  _construct(callback) {
    try {
      this.lease.assertAvailable()
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _transform(chunk, _encoding, callback) {
    try {
      this.lease.assertAvailable()
      this._consumeText(this.decoder.write(chunk))
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _flush(callback) {
    try {
      this.lease.assertAvailable()
      this._consumeText(this.decoder.end(), true)
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _destroy(error, callback) {
    this.lineBlocks = []
    this.lineParts = []
    this.frameLines = []
    this.argumentBuffers.clear()
    this.execItems.clear()
    this.execAliases.clear()
    this.itemAliases.clear()
    this.lease.close()
    callback(error)
  }

  _appendLine(text) {
    if (!text) return
    const bytes = Buffer.byteLength(text, 'utf8')
    this.lineBytes += bytes
    if (this.frameBytes + this.lineBytes > MAX_RESPONSE_FRAME_BYTES) {
      throw new Error('Upstream Responses SSE frame is too large')
    }
    this.lineParts.push(text)
    if (this.lineParts.length >= PART_BLOCK_SIZE) {
      this.lineBlocks.push(this.lineParts.join(''))
      this.lineParts = []
    }
  }

  _finishLine(hasNewline) {
    const rawLine = [...this.lineBlocks, this.lineParts.join('')].join('')
    const lineBytes = this.lineBytes
    this.lineBlocks = []
    this.lineParts = []
    this.lineBytes = 0
    this.frameBytes += lineBytes + (hasNewline ? 1 : 0)
    if (this.frameBytes > MAX_RESPONSE_FRAME_BYTES) {
      throw new Error('Upstream Responses SSE frame is too large')
    }
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      this._flushFrame()
    } else {
      this.frameLines.push(line)
    }
  }

  _flushFrame() {
    const lines = this.frameLines
    const bytes = this.frameBytes
    this.frameLines = []
    this.frameBytes = 0
    try {
      if (lines.length > 0) this._processFrame(lines.join('\n'))
    } finally {
      this.lease.release(bytes)
    }
  }

  _consumeText(text, final = false) {
    if (text) this.lease.reserve(Buffer.byteLength(text, 'utf8'))
    let start = 0
    for (let newline = text.indexOf('\n', start); newline >= 0; newline = text.indexOf('\n', start)) {
      this._appendLine(text.slice(start, newline))
      this._finishLine(true)
      start = newline + 1
    }
    this._appendLine(text.slice(start))
    if (final) {
      if (this.lineBytes > 0) this._finishLine(false)
      if (this.frameLines.length > 0 || this.frameBytes > 0) this._flushFrame()
    }
  }

  _newArgumentBuffer(text = '') {
    const buffer = { blocks: [], parts: [], bytes: 0, joined: undefined }
    if (text) {
      buffer.parts.push(text)
      buffer.bytes = Buffer.byteLength(text, 'utf8')
    }
    return buffer
  }

  _replaceArgumentBuffer(key, value) {
    const text = typeof value === 'string' ? value : String(value ?? '')
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_TOOL_ARGUMENT_BYTES) throw new Error('Upstream exec function arguments are too large')
    const previous = this.argumentBuffers.get(key)
    const previousBytes = previous?.bytes || 0
    const total = this.argumentBufferBytes - previousBytes + bytes
    if (total > MAX_PENDING_ARGUMENT_BYTES) throw new Error('Upstream exec function arguments are too large')
    if (bytes > previousBytes) this.lease.reserve(bytes - previousBytes)
    else this.lease.release(previousBytes - bytes)
    this.argumentBuffers.set(key, this._newArgumentBuffer(text))
    this.argumentBufferBytes = total
  }

  _appendArgumentBuffer(key, value) {
    const text = typeof value === 'string' ? value : String(value ?? '')
    if (!text) return
    const bytes = Buffer.byteLength(text, 'utf8')
    const buffer = this.argumentBuffers.get(key) || this._newArgumentBuffer()
    if (buffer.bytes + bytes > MAX_TOOL_ARGUMENT_BYTES
      || this.argumentBufferBytes + bytes > MAX_PENDING_ARGUMENT_BYTES) {
      throw new Error('Upstream exec function arguments are too large')
    }
    this.lease.reserve(bytes)
    buffer.parts.push(text)
    if (buffer.parts.length >= PART_BLOCK_SIZE) {
      buffer.blocks.push(buffer.parts.join(''))
      buffer.parts = []
    }
    buffer.bytes += bytes
    buffer.joined = undefined
    this.argumentBuffers.set(key, buffer)
    this.argumentBufferBytes += bytes
  }

  _deleteArgumentBuffer(key) {
    const buffer = this.argumentBuffers.get(key)
    if (!buffer) return
    this.argumentBufferBytes -= buffer.bytes
    this.lease.release(buffer.bytes)
    this.argumentBuffers.delete(key)
  }

  _registerExecItem(item) {
    const key = item.call_id || item.id
    if (!this.execItems.has(key) && this.execItems.size >= MAX_PENDING_EXEC_ITEMS) {
      throw new Error('Upstream Responses stream contains too many pending exec calls')
    }
    this.execItems.add(key)
    const aliases = new Set([key, item.id, item.call_id])
    this.itemAliases.set(key, aliases)
    for (const alias of aliases) this.execAliases.set(alias, key)
    return key
  }

  _resolveExecKey(value) {
    return this.execAliases.get(value) ?? value
  }

  _deleteExecItem(key) {
    this.execItems.delete(key)
    for (const alias of this.itemAliases.get(key) || []) this.execAliases.delete(alias)
    this.itemAliases.delete(key)
    this._deleteArgumentBuffer(key)
  }

  _processFrame(frame) {
    if (!frame) return
    const lines = frame.split('\n')
    const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim()
    const dataLines = lines.filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
    if (dataLines.length === 0) {
      this.push(`${frame}\n\n`)
      return
    }
    const rawData = dataLines.join('\n')
    if (rawData === '[DONE]') {
      this.push(`${eventName ? `event: ${eventName}\n` : ''}data: [DONE]\n\n`)
      return
    }
    let data
    try {
      data = JSON.parse(rawData)
    } catch {
      throw new Error('Upstream Responses SSE event contains invalid JSON')
    }
    const outputs = this._convertEvent(eventName || data.type, data)
    for (const output of outputs) this.push(encodeSseEvent(output.eventName, output.data))
  }

  _convertEvent(eventName, data) {
    if (eventName === 'response.output_item.added'
      && data.item?.type === 'function_call'
      && data.item.name === EXEC_TOOL_NAME) {
      const key = this._registerExecItem(data.item)
      this._replaceArgumentBuffer(key, data.item.arguments || '')
      return [{
        eventName,
        data: { ...data, item: convertFunctionItem(data.item, this.argumentBuffers, this.execAliases) },
      }]
    }
    if (eventName === 'response.function_call_arguments.delta') {
      const key = this._resolveExecKey(data.item_id || data.call_id)
      if (!this.execItems.has(key)) return [{ eventName, data }]
      this._appendArgumentBuffer(key, data.delta || '')
      return []
    }
    if (eventName === 'response.function_call_arguments.done') {
      const key = this._resolveExecKey(data.item_id || data.call_id)
      if (!this.execItems.has(key)) return [{ eventName, data }]
      const argumentsText = data.arguments || argumentBufferText(this.argumentBuffers.get(key))
      const input = decodeFunctionArguments(argumentsText)
      this._replaceArgumentBuffer(key, argumentsText)
      return [
        {
          eventName: 'response.custom_tool_call_input.delta',
          data: { ...data, type: 'response.custom_tool_call_input.delta', delta: input, arguments: undefined },
        },
        {
          eventName: 'response.custom_tool_call_input.done',
          data: { ...data, type: 'response.custom_tool_call_input.done', input, arguments: undefined },
        },
      ]
    }
    if (eventName === 'response.output_item.done'
      && data.item?.type === 'function_call'
      && data.item.name === EXEC_TOOL_NAME) {
      const key = this._resolveExecKey(data.item.id || data.item.call_id)
      const item = convertFunctionItem(data.item, this.argumentBuffers, this.execAliases)
      this._deleteExecItem(key)
      return [{ eventName, data: { ...data, item } }]
    }
    if (eventName === 'response.completed') {
      const converted = convertResponseObject(data, this.argumentBuffers, this.execAliases)
      for (const key of [...this.execItems]) this._deleteExecItem(key)
      return [{ eventName, data: converted }]
    }
    return [{ eventName, data }]
  }
}

class ResponsesToolBridgeJsonTransform extends Transform {
  constructor() {
    super()
    this.lease = new BridgeBudgetLease()
    this.chunks = []
    this.size = 0
  }

  _construct(callback) {
    try {
      this.lease.assertAvailable()
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _transform(chunk, _encoding, callback) {
    try {
      this.lease.assertAvailable()
      if (this.size + chunk.length > MAX_RESPONSE_BODY_BYTES) {
        throw new Error('Responses response body is too large for experimental tool compatibility mode')
      }
      this.lease.reserve(chunk.length)
      this.size += chunk.length
      this.chunks.push(Buffer.from(chunk))
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _flush(callback) {
    try {
      this.lease.assertAvailable()
      const size = this.size
      const body = Buffer.concat(this.chunks, size)
      this.chunks = []
      this.size = 0
      this.lease.release(size)
      this.push(convertResponseBuffer(body))
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _destroy(error, callback) {
    this.chunks = []
    this.size = 0
    this.lease.close()
    callback(error)
  }
}

/**
 * 将 Responses 的流式事件收拢成同步 API 需要的完整 JSON。
 *
 * 某些中转只实现了 stream=true，但 Codex 的后台请求仍会明确要求
 * stream=false。网关可以在上游使用流式，等 response.completed 后再把
 * 同一个 Response 对象交给下游；这里不保留中间增量，只保留完成事件。
 */
class ResponsesSseJsonTransform extends Transform {
  constructor({ mapResponse } = {}) {
    super()
    this.lease = new BridgeBudgetLease()
    this.decoder = new StringDecoder('utf8')
    this.lineParts = []
    this.lineBytes = 0
    this.frameLines = []
    this.frameBytes = 0
    this.totalBytes = 0
    this.reservedBytes = 0
    this.response = undefined
    this.errorPayload = undefined
    this.mapResponse = mapResponse
  }

  _construct(callback) {
    try {
      this.lease.assertAvailable()
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _transform(chunk, _encoding, callback) {
    try {
      this.lease.assertAvailable()
      this.totalBytes += chunk.length
      if (this.totalBytes > MAX_RESPONSE_STREAM_BYTES) {
        throw new Error('Upstream Responses stream is too large')
      }
      this.lease.reserve(chunk.length)
      this.reservedBytes += chunk.length
      this._consume(this.decoder.write(chunk))
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _flush(callback) {
    try {
      this.lease.assertAvailable()
      this._consume(this.decoder.end(), true)
      if (!this.response || typeof this.response !== 'object') {
        throw new Error(
          this.errorPayload
            ? 'Upstream Responses stream ended with an error'
            : 'Upstream Responses stream did not include response.completed',
        )
      }
      let response = this.response
      if (this.mapResponse) response = this.mapResponse(response)
      const body = Buffer.from(JSON.stringify(response), 'utf8')
      if (body.length > MAX_RESPONSE_BODY_BYTES) {
        throw new Error('Upstream Responses response is too large')
      }
      this.lease.reserve(body.length)
      this.push(body)
      this.lease.release(body.length)
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _destroy(error, callback) {
    this.lineParts = []
    this.frameLines = []
    this.response = undefined
    this.errorPayload = undefined
    this.reservedBytes = 0
    this.lease.close()
    callback(error)
  }

  _consume(text, final = false) {
    let start = 0
    for (let newline = text.indexOf('\n', start); newline >= 0; newline = text.indexOf('\n', start)) {
      this._appendLine(text.slice(start, newline))
      this._finishLine(true)
      start = newline + 1
    }
    this._appendLine(text.slice(start))
    if (final) {
      if (this.lineBytes > 0) this._finishLine(false)
      if (this.frameLines.length > 0 || this.frameBytes > 0) this._flushFrame()
    }
  }

  _appendLine(text) {
    if (!text) return
    const bytes = Buffer.byteLength(text, 'utf8')
    this.lineBytes += bytes
    if (this.lineBytes > MAX_RESPONSE_FRAME_BYTES) {
      throw new Error('Upstream Responses SSE frame is too large')
    }
    this.lineParts.push(text)
  }

  _finishLine(hasNewline) {
    const raw = this.lineParts.join('')
    const bytes = this.lineBytes
    this.lineParts = []
    this.lineBytes = 0
    this.frameBytes += bytes + (hasNewline ? 1 : 0)
    if (this.frameBytes > MAX_RESPONSE_FRAME_BYTES) {
      throw new Error('Upstream Responses SSE frame is too large')
    }
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') this._flushFrame()
    else this.frameLines.push(line)
  }

  _flushFrame() {
    const lines = this.frameLines
    const bytes = this.frameBytes
    this.frameLines = []
    this.frameBytes = 0
    if (bytes > 0) {
      this.lease.release(bytes)
      this.reservedBytes = Math.max(0, this.reservedBytes - bytes)
    }
    if (lines.length === 0) return
    const eventName = lines.find((line) => line.startsWith('event:'))
      ?.slice(6).trim()
    const data = lines.filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') return
    let payload
    try {
      payload = JSON.parse(data)
    } catch {
      throw new Error('Upstream Responses SSE event contains invalid JSON')
    }
    const type = eventName || payload?.type
    if (type === 'response.completed') {
      this.response = payload.response
    } else if (type === 'response.failed' || type === 'response.incomplete') {
      this.response = payload.response
    } else if (type === 'error' || type === 'response.error') {
      this.errorPayload = payload
    }
  }
}

function createResponsesToolBridgeTransform() {
  return new ResponsesToolBridgeTransform()
}

function createResponsesToolBridgeJsonTransform() {
  return new ResponsesToolBridgeJsonTransform()
}

function createResponsesSseJsonTransform(options) {
  return new ResponsesSseJsonTransform(options)
}

module.exports = {
  EXEC_TOOL_NAME,
  MAX_ACTIVE_BRIDGE_TRANSFORMS,
  MAX_GLOBAL_BRIDGE_BUFFER_BYTES,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  MAX_RESPONSE_STREAM_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
  MAX_TOOL_ARGUMENT_BYTES,
  convertRequestPayload,
  convertRequestBuffer,
  convertResponseBuffer,
  convertResponseObject,
  createResponsesToolBridgeJsonTransform,
  createResponsesToolBridgeTransform,
  createResponsesSseJsonTransform,
  ResponsesSseJsonTransform,
}
