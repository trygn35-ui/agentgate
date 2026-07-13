const crypto = require('node:crypto')
const { z } = require('zod')

const MAX_DETECTION_BUFFER_BYTES = 64 * 1024
/** 保留窗口：按时间而非条数保留，1 小时内的记录都留着，供缓存率等窗口指标计算。 */
const RETENTION_WINDOW_MS = 60 * 60_000
/** 硬上限：防止极端高频场景把内存和磁盘撑爆，正常使用远达不到。 */
const MAX_RECENT_REQUESTS = 2_000

const RequestLogEntrySchema = z.object({
  id: z.string(),
  client: z.string(),
  profileId: z.string().optional(),
  profileName: z.string(),
  keyHint: z.string().optional(),
  upstreamUrl: z.string(),
  protocol: z.string().optional(),
  state: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  firstTokenLatencyMs: z.number().optional(),
  firstByteLatencyMs: z.number().optional(),
  statusCode: z.number().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  streaming: z.boolean().optional(),
  outcome: z.string().optional(),
  tokenUsage: z.object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cachedTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
    totalTokens: z.number().optional(),
  }).optional(),
  receivedBytes: z.number().optional().default(0),
})

const RequestLogStoreSchema = z.object({
  version: z.literal(1),
  entries: z.array(RequestLogEntrySchema).max(MAX_RECENT_REQUESTS),
})
const PROGRESS_NOTIFY_INTERVAL_MS = 200
const MAX_MODEL_METADATA_LENGTH = 240
const MAX_REASONING_METADATA_LENGTH = 32

function nonEmptyText(value) {
  if (typeof value === 'string') return value.trim().length > 0
  if (!Array.isArray(value)) return false
  return value.some((item) => (
    nonEmptyText(item)
    || nonEmptyText(item?.text)
    || nonEmptyText(item?.content)
  ))
}

function nonEmptyToolCalls(value) {
  return Array.isArray(value) && value.some((call) => (
    nonEmptyText(call?.function?.arguments)
    || nonEmptyText(call?.arguments)
    || nonEmptyText(call?.input)
  ))
}

function nonEmptyStructured(value) {
  if (nonEmptyText(value)) return true
  return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0)
}

function isMeaningfulPayload(protocol, payload, eventName = '') {
  if (!payload || typeof payload !== 'object') return false
  if (protocol === 'openai-responses') {
    const recognizedTypes = [
      'response.output_text.delta',
      'response.reasoning_summary_text.delta',
      'response.reasoning_text.delta',
      'response.reasoning.delta',
      'response.function_call_arguments.delta',
      'response.custom_tool_call_input.delta',
      'response.refusal.delta',
    ]
    if (recognizedTypes.includes(eventName) || recognizedTypes.includes(payload.type)) {
      return nonEmptyText(payload.delta)
        || nonEmptyText(payload.text)
        || nonEmptyText(payload.arguments)
        || nonEmptyText(payload.input)
    }
    const response = payload.response || payload
    return nonEmptyText(response.output_text)
      || (Array.isArray(response.output) && response.output.some((item) => (
        nonEmptyText(item?.text)
        || nonEmptyText(item?.arguments)
        || nonEmptyStructured(item?.input)
        || (Array.isArray(item?.content) && item.content.some((content) => (
          nonEmptyText(content?.text)
          || nonEmptyText(content?.refusal)
        )))
      )))
  }
  if (protocol === 'openai-chat') {
    return Array.isArray(payload.choices) && payload.choices.some((choice) => {
      const delta = choice?.delta || choice?.message || {}
      return nonEmptyText(delta.content)
        || nonEmptyText(delta.reasoning_content)
        || nonEmptyText(delta.reasoning)
        || nonEmptyText(delta.refusal)
        || nonEmptyToolCalls(delta.tool_calls)
    })
  }
  if (protocol === 'anthropic') {
    const type = eventName === 'content_block_delta' || payload.type === 'content_block_delta'
      ? 'content_block_delta'
      : eventName || payload.type
    const delta = payload.delta || {}
    if (type === 'content_block_delta') {
      return nonEmptyText(delta.text)
        || nonEmptyText(delta.thinking)
        || nonEmptyText(delta.partial_json)
    }
    return Array.isArray(payload.content) && payload.content.some((content) => (
      nonEmptyText(content?.text)
      || nonEmptyText(content?.thinking)
      || nonEmptyStructured(content?.input)
    ))
  }
  if (protocol === 'gemini') {
    return Array.isArray(payload.candidates) && payload.candidates.some((candidate) => (
      candidate?.content?.parts?.some((part) => (
        nonEmptyText(part?.text)
        || nonEmptyText(part?.thought)
        || nonEmptyStructured(part?.functionCall?.args)
      ))
      || nonEmptyText(candidate?.text)
    ))
  }
  return false
}

function parsedJson(value) {
  if (!value || value === '[DONE]') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

function streamPayloads(source) {
  const results = []
  const normalized = source.replace(/\r\n/g, '\n')
  const seen = new Set()

  for (const block of normalized.split('\n\n')) {
    let eventName = ''
    const data = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    const value = data.join('\n').trim()
    for (const payload of parsedJson(value)) {
      const key = `${eventName}\n${value}`
      if (!seen.has(key)) {
        seen.add(key)
        results.push({ eventName, payload })
      }
    }
  }

  for (const line of normalized.split('\n')) {
    const value = line.trim()
    if (!value || value.startsWith('event:') || value.startsWith(':')) continue
    const data = value.startsWith('data:') ? value.slice(5).trim() : value
    for (const payload of parsedJson(data)) {
      const key = `\n${data}`
      if (!seen.has(key)) {
        seen.add(key)
        results.push({ eventName: '', payload })
      }
    }
  }
  return results
}

function hasMeaningfulStreamDelta(protocol, source) {
  return streamPayloads(source).some(({ eventName, payload }) => (
    isMeaningfulPayload(protocol, payload, eventName)
  ))
}

function numberOrUndefined(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined
}

function extractTokenUsage(payload) {
  const container = payload?.response || payload?.message || payload
  const usage = container?.usage || payload?.usageMetadata
  if (!usage || typeof usage !== 'object') return undefined
  const inputTokens = numberOrUndefined(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount,
  )
  const outputTokens = numberOrUndefined(
    usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount,
  )
  const standardCachedTokens = numberOrUndefined(
    usage.input_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.cachedContentTokenCount,
  )
  const cacheReadTokens = numberOrUndefined(usage.cache_read_input_tokens)
  const cacheCreationTokens = numberOrUndefined(usage.cache_creation_input_tokens)
  const cachedTokens = standardCachedTokens ?? (
    cacheReadTokens !== undefined || cacheCreationTokens !== undefined
      ? (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0)
      : undefined
  )
  const reasoningTokens = numberOrUndefined(
    usage.output_tokens_details?.reasoning_tokens
      ?? usage.completion_tokens_details?.reasoning_tokens
      ?? usage.thoughtsTokenCount,
  )
  const explicitTotal = numberOrUndefined(usage.total_tokens ?? usage.totalTokenCount)
  if ([inputTokens, outputTokens, cachedTokens, reasoningTokens, explicitTotal]
    .every((value) => value === undefined)) return undefined
  const totalTokens = explicitTotal ?? (
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined
  )
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  }
}

function extractJsonObjectProperty(source, propertyName) {
  const needle = `"${propertyName}"`
  let searchFrom = source.length
  while (searchFrom > 0) {
    const propertyIndex = source.lastIndexOf(needle, searchFrom - 1)
    if (propertyIndex < 0) return undefined
    const colonIndex = source.indexOf(':', propertyIndex + needle.length)
    if (colonIndex < 0) return undefined
    let start = colonIndex + 1
    while (/\s/.test(source[start] || '')) start += 1
    if (source[start] !== '{') {
      searchFrom = propertyIndex
      continue
    }
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < source.length; index += 1) {
      const character = source[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') inString = true
      else if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          try { return JSON.parse(source.slice(start, index + 1)) } catch { break }
        }
      }
    }
    searchFrom = propertyIndex
  }
  return undefined
}

function extractTokenUsageFromSource(source) {
  const usage = extractJsonObjectProperty(source, 'usage')
  const fromUsage = usage ? extractTokenUsage({ usage }) : undefined
  if (fromUsage) return fromUsage
  const usageMetadata = extractJsonObjectProperty(source, 'usageMetadata')
  return usageMetadata ? extractTokenUsage({ usageMetadata }) : undefined
}

function extractRequestMetadata(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}
  const reasoning = payload.reasoning
  const reasoningEffort = typeof payload.reasoning_effort === 'string'
    ? payload.reasoning_effort
    : typeof reasoning === 'string'
      ? reasoning
      : typeof reasoning?.effort === 'string' ? reasoning.effort : undefined
  return {
    ...(typeof payload.model === 'string'
      && payload.model.trim()
      && payload.model.trim().length <= MAX_MODEL_METADATA_LENGTH
      ? { model: payload.model.trim() }
      : {}),
    ...(reasoningEffort && reasoningEffort.trim().length <= MAX_REASONING_METADATA_LENGTH
      ? { reasoningEffort: reasoningEffort.trim() }
      : {}),
    ...(typeof payload.stream === 'boolean' ? { streaming: payload.stream } : {}),
  }
}

/**
 * 判断已接收的流数据是否包含协议级完成标记。
 *
 * 客户端常在拿到完整响应后立即关闭连接，socket 层面表现为中止；
 * 只要流里出现过终止事件，就应把请求视为正常完成。
 */
const TERMINAL_MARKER_PATTERN = new RegExp([
  'message_stop',
  'response\\.completed',
  'response\\.incomplete',
  '\\[DONE\\]',
  '"finish_reason"\\s*:\\s*"',
  '"finishReason"\\s*:\\s*"',
].join('|'))

function hasTerminalMarker(source) {
  return TERMINAL_MARKER_PATTERN.test(source)
}

function mergeUsage(current, next) {
  if (!next) return current
  const merged = { ...(current || {}) }
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) merged[key] = value
  }
  if (next.totalTokens === undefined
    && (merged.inputTokens !== undefined || merged.outputTokens !== undefined)) {
    merged.totalTokens = (merged.inputTokens ?? 0) + (merged.outputTokens ?? 0)
  }
  return merged
}

function toPublicRequest(entry) {
  return {
    id: entry.id,
    client: entry.client,
    ...(entry.profileId ? { profileId: entry.profileId } : {}),
    profileName: entry.profileName,
    ...(entry.keyHint ? { keyHint: entry.keyHint } : {}),
    upstreamUrl: entry.upstreamUrl,
    ...(entry.protocol ? { protocol: entry.protocol } : {}),
    state: entry.state,
    startedAt: entry.startedAt,
    ...(entry.completedAt ? { completedAt: entry.completedAt } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    ...(entry.firstTokenLatencyMs !== undefined
      ? { firstTokenLatencyMs: entry.firstTokenLatencyMs }
      : {}),
    ...(entry.firstByteLatencyMs !== undefined
      ? { firstByteLatencyMs: entry.firstByteLatencyMs }
      : {}),
    ...(entry.statusCode !== undefined ? { statusCode: entry.statusCode } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
    ...(entry.streaming !== undefined ? { streaming: entry.streaming } : {}),
    ...(entry.outcome ? { outcome: entry.outcome } : {}),
    ...(entry.tokenUsage ? { tokenUsage: { ...entry.tokenUsage } } : {}),
    receivedBytes: entry.receivedBytes,
  }
}

class RequestMonitorService {
  constructor({ now = () => Date.now(), onChange, onRequestEnded, store } = {}) {
    this.now = now
    this.onChange = onChange
    this.onRequestEnded = onRequestEnded
    this.store = store
    this.active = new Map()
    this.recent = []
    this._persistTimer = undefined
  }

  /**
   * 从持久化存储恢复最近完成的请求记录。
   *
   * 存储缺失或损坏时静默从空列表开始，不阻塞网关启动。
   */
  async initialize() {
    if (!this.store) return
    try {
      const data = await this.store.read()
      this.recent = data.entries.slice(0, MAX_RECENT_REQUESTS)
      this._prune()
    } catch {
      this.recent = []
    }
  }

  _schedulePersist() {
    if (!this.store) return
    clearTimeout(this._persistTimer)
    this._persistTimer = setTimeout(() => { void this._persist() }, 800)
    this._persistTimer.unref?.()
  }

  async _persist() {
    if (!this.store) return
    try {
      await this.store.write({
        version: 1,
        entries: this.recent.map(toPublicRequest),
      })
    } catch {
      // 记录持久化失败不影响网关转发。
    }
  }

  /** 立即写盘挂起的记录变更，供应用退出前调用。 */
  async flush() {
    if (!this.store) return
    clearTimeout(this._persistTimer)
    await this._persist()
  }

  /**
   * 丢弃保留窗口之外的记录。
   *
   * 按时间保留而非条数：缓存率等窗口指标需要完整的一小时样本，固定条数会在高频
   * 场景下把窗口截短。硬上限只在极端流量下兜底。
   */
  _prune() {
    const cutoff = this.now() - RETENTION_WINDOW_MS
    this.recent = this.recent.filter((entry) => {
      const completedAt = Date.parse(entry.completedAt || entry.startedAt)
      return !Number.isFinite(completedAt) || completedAt >= cutoff
    })
    if (this.recent.length > MAX_RECENT_REQUESTS) this.recent.length = MAX_RECENT_REQUESTS
  }

  setOnChange(onChange) {
    this.onChange = onChange
  }

  list() {
    const active = [...this.active.values()]
      .sort((left, right) => left.startedAtMs - right.startedAtMs)
    return [...active, ...this.recent].map(toPublicRequest)
  }

  start(input) {
    const startedAtMs = this.now()
    const id = crypto.randomUUID()
    this.active.set(id, {
      id,
      client: input.client || 'unknown',
      profileId: input.profileId,
      profileName: input.profileName || 'Unknown profile',
      keyHint: input.keyHint,
      upstreamUrl: input.upstreamUrl || '',
      protocol: input.protocol,
      state: 'connecting',
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      receivedBytes: 0,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      streaming: input.streaming,
      detectionBuffer: '',
      usageBuffer: '',
      lastProgressNotifyAt: startedAtMs,
    })
    this._notify()
    return id
  }

  updateMetadata(id, patch = {}) {
    const entry = this.active.get(id)
    if (!entry) return false
    if (typeof patch.profileName === 'string' && patch.profileName.trim()) {
      entry.profileName = patch.profileName.trim()
    }
    if (typeof patch.keyHint === 'string' && patch.keyHint.trim()) entry.keyHint = patch.keyHint.trim()
    if (typeof patch.upstreamUrl === 'string') entry.upstreamUrl = patch.upstreamUrl
    if (typeof patch.protocol === 'string' && patch.protocol.trim()) entry.protocol = patch.protocol.trim()
    if (typeof patch.model === 'string'
      && patch.model.trim()
      && patch.model.trim().length <= MAX_MODEL_METADATA_LENGTH) {
      entry.model = patch.model.trim()
    }
    if (typeof patch.reasoningEffort === 'string' && patch.reasoningEffort.trim()) {
      const reasoningEffort = patch.reasoningEffort.trim()
      if (reasoningEffort.length <= MAX_REASONING_METADATA_LENGTH) {
        entry.reasoningEffort = reasoningEffort
      }
    }
    if (typeof patch.streaming === 'boolean') entry.streaming = patch.streaming
    if (patch.tokenUsage) entry.tokenUsage = mergeUsage(entry.tokenUsage, patch.tokenUsage)
    this._notify()
    return true
  }

  responseStarted(id, { statusCode, contentType, streaming } = {}) {
    const entry = this.active.get(id)
    if (!entry) return false
    entry.statusCode = statusCode
    entry.state = 'waiting-first-token'
    entry.streaming = streaming ?? entry.streaming
      ?? String(contentType || '').toLowerCase().includes('text/event-stream')
    this._notify()
    return true
  }

  observeChunk(id, chunk, options = {}) {
    const entry = this.active.get(id)
    if (!entry) return false
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (bytes.byteLength === 0) return false
    entry.receivedBytes += bytes.byteLength
    const firstByteObserved = entry.firstByteLatencyMs === undefined
    if (firstByteObserved) {
      entry.firstByteLatencyMs = Math.max(0, this.now() - entry.startedAtMs)
      this._notify()
    }

    const streaming = options.streaming ?? entry.streaming
    const decoded = bytes.toString('utf8')
    entry.usageBuffer = `${entry.usageBuffer}${decoded}`.slice(-MAX_DETECTION_BUFFER_BYTES)
    const tailUsage = extractTokenUsageFromSource(entry.usageBuffer)
    if (tailUsage) entry.tokenUsage = mergeUsage(entry.tokenUsage, tailUsage)
    if (!entry.sawCompletion && hasTerminalMarker(entry.usageBuffer)) {
      entry.sawCompletion = true
    }
    if (entry.firstTokenLatencyMs === undefined) {
      entry.detectionBuffer = `${entry.detectionBuffer}${decoded}`
        .slice(-MAX_DETECTION_BUFFER_BYTES)
    }
    const payloads = entry.firstTokenLatencyMs === undefined
      ? streamPayloads(entry.detectionBuffer)
      : []
    for (const { payload } of payloads) {
      const metadata = extractRequestMetadata(payload?.response || payload)
      if (metadata.model) entry.model = metadata.model
      const usage = extractTokenUsage(payload)
      if (usage) entry.tokenUsage = mergeUsage(entry.tokenUsage, usage)
    }

    if (entry.firstTokenLatencyMs === undefined && streaming === false
      && payloads.some(({ eventName, payload }) => (
        isMeaningfulPayload(entry.protocol, payload, eventName)
      ))) {
      this._markFirstToken(entry)
      return true
    }

    if (streaming !== false && entry.firstTokenLatencyMs === undefined
      && payloads.some(({ eventName, payload }) => (
        isMeaningfulPayload(entry.protocol, payload, eventName)
      ))) {
      this._markFirstToken(entry)
      return true
    }

    this._notifyProgress(entry)
    return false
  }

  end(id, { outcome } = {}) {
    const entry = this.active.get(id)
    if (!entry) return false
    this.active.delete(id)
    const completedAtMs = this.now()
    entry.completedAt = new Date(completedAtMs).toISOString()
    entry.durationMs = Math.max(0, completedAtMs - entry.startedAtMs)
    // 流里已出现协议级完成标记时，socket 层的中止只是客户端提前收尾，不改判为中止。
    const effectiveOutcome = outcome === 'aborted' && entry.sawCompletion ? undefined : outcome
    entry.outcome = effectiveOutcome || (
      entry.statusCode !== undefined && entry.statusCode >= 400 ? 'failed' : 'completed'
    )
    entry.state = entry.outcome === 'completed' ? 'completed' : entry.outcome
    entry.detectionBuffer = ''
    entry.usageBuffer = ''
    delete entry.lastProgressNotifyAt
    this.recent.unshift(entry)
    this._prune()
    if (typeof this.onRequestEnded === 'function') {
      try {
        this.onRequestEnded(toPublicRequest(entry))
      } catch {
        // 统计订阅者不得影响网关请求。
      }
    }
    this._schedulePersist()
    this._notify()
    return true
  }

  clear() {
    if (this.active.size === 0) return
    for (const id of [...this.active.keys()]) this.end(id, { outcome: 'cancelled' })
  }

  _markFirstToken(entry) {
    entry.firstTokenLatencyMs = Math.max(0, this.now() - entry.startedAtMs)
    entry.state = 'streaming'
    this._notify()
  }

  _notifyProgress(entry) {
    const now = this.now()
    if (now - entry.lastProgressNotifyAt < PROGRESS_NOTIFY_INTERVAL_MS) return
    entry.lastProgressNotifyAt = now
    this._notify()
  }

  _notify() {
    if (typeof this.onChange !== 'function') return
    try {
      this.onChange({
        type: 'active-requests-changed',
        activeRequests: this.list(),
      })
    } catch {
      // UI 订阅者不得影响网关请求。
    }
  }
}

module.exports = {
  MAX_DETECTION_BUFFER_BYTES,
  MAX_RECENT_REQUESTS,
  RequestLogStoreSchema,
  RequestMonitorService,
  extractRequestMetadata,
  extractTokenUsage,
  extractTokenUsageFromSource,
  hasMeaningfulStreamDelta,
  isMeaningfulPayload,
  streamPayloads,
}
