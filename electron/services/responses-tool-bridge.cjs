const { Transform } = require('node:stream')

const EXEC_TOOL_NAME = 'exec'
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024

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

function convertInputItem(item) {
  if (!item || typeof item !== 'object') return item
  if (item.type === 'custom_tool_call' && item.name === EXEC_TOOL_NAME) {
    return {
      ...item,
      type: 'function_call',
      arguments: encodeFunctionArguments(item.input),
      input: undefined,
    }
  }
  if (item.type === 'custom_tool_call_output') {
    return { ...item, type: 'function_call_output' }
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
  const input = Array.isArray(payload.input)
    ? payload.input.map(convertInputItem)
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

function convertFunctionItem(item, argumentBuffers) {
  if (!item || item.type !== 'function_call' || item.name !== EXEC_TOOL_NAME) return item
  const key = item.id || item.call_id
  const argumentsText = typeof item.arguments === 'string'
    ? item.arguments
    : argumentBuffers.get(key) || ''
  const input = argumentsText ? decodeFunctionArguments(argumentsText) : ''
  return {
    ...item,
    type: 'custom_tool_call',
    input,
    arguments: undefined,
  }
}

function convertResponseObject(value, argumentBuffers = new Map()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const converted = { ...value }
  if (Array.isArray(value.output)) {
    converted.output = value.output.map((item) => convertFunctionItem(item, argumentBuffers))
  }
  if (value.response && typeof value.response === 'object') {
    converted.response = convertResponseObject(value.response, argumentBuffers)
  }
  return converted
}

function encodeSseEvent(eventName, data) {
  return `${eventName ? `event: ${eventName}\n` : ''}data: ${JSON.stringify(data)}\n\n`
}

class ResponsesToolBridgeTransform extends Transform {
  constructor() {
    super()
    this.pending = ''
    this.argumentBuffers = new Map()
    this.execItems = new Map()
  }

  _transform(chunk, _encoding, callback) {
    try {
      this.pending += chunk.toString('utf8')
      this._flushFrames(false)
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _flush(callback) {
    try {
      this._flushFrames(true)
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _flushFrames(final) {
    const normalized = this.pending.replace(/\r\n/g, '\n')
    const frames = normalized.split('\n\n')
    this.pending = final ? '' : frames.pop()
    if (final && frames.at(-1) === '') frames.pop()
    for (const frame of frames) this._processFrame(frame)
    if (final && this.pending) this._processFrame(this.pending)
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
      const key = data.item.id || data.item.call_id
      this.execItems.set(key, data.item)
      this.argumentBuffers.set(key, data.item.arguments || '')
      return [{ eventName, data: { ...data, item: convertFunctionItem(data.item, this.argumentBuffers) } }]
    }
    if (eventName === 'response.function_call_arguments.delta') {
      const key = data.item_id || data.call_id
      if (!this.execItems.has(key)) return [{ eventName, data }]
      this.argumentBuffers.set(key, `${this.argumentBuffers.get(key) || ''}${data.delta || ''}`)
      return []
    }
    if (eventName === 'response.function_call_arguments.done') {
      const key = data.item_id || data.call_id
      if (!this.execItems.has(key)) return [{ eventName, data }]
      const argumentsText = data.arguments || this.argumentBuffers.get(key) || ''
      const input = decodeFunctionArguments(argumentsText)
      this.argumentBuffers.set(key, argumentsText)
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
      const item = convertFunctionItem(data.item, this.argumentBuffers)
      const key = data.item.id || data.item.call_id
      this.execItems.delete(key)
      this.argumentBuffers.delete(key)
      return [{ eventName, data: { ...data, item } }]
    }
    if (eventName === 'response.completed') {
      return [{ eventName, data: convertResponseObject(data, this.argumentBuffers) }]
    }
    return [{ eventName, data }]
  }
}

function createResponsesToolBridgeTransform() {
  return new ResponsesToolBridgeTransform()
}

module.exports = {
  EXEC_TOOL_NAME,
  MAX_REQUEST_BODY_BYTES,
  convertRequestPayload,
  convertRequestBuffer,
  convertResponseObject,
  createResponsesToolBridgeTransform,
}
