const crypto = require('node:crypto')
const { StringDecoder } = require('node:string_decoder')
const { z } = require('zod')

const MAX_DETECTION_BUFFER_BYTES = 64 * 1024
/**
 * 单行上限。SSE 的一个 data 行可以很大（整个 response.completed 都在里面），
 * 但不能无限——超过就放弃精确解析，退回结束时的尾部扫描。
 */
const MAX_LINE_BYTES = 1024 * 1024
/** 终止/错误标记跨 chunk 被劈开时的重叠窗口。标记本身最长不过几十个字符。 */
const MARKER_OVERLAP = 64
/**
 * 首字定了之后就只剩 usage 值得解析了。这两个键正是 extractTokenUsage 认的全部
 * 入口——Anthropic/OpenAI 用 usage，Gemini 用 usageMetadata。
 */
const USAGE_HINT = /"usage"|"usageMetadata"/
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
    /** 缓存命中（读）。缓存写入不算命中，单独记在 cacheWriteTokens。 */
    cachedTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
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

/**
 * 增量流扫描器：只看新到的那一片字节，绝不回头重扫。
 *
 * 这段代码同步跑在网关的转发热路径上——它不算完，客户端的字节就出不去。老写法
 * 每来一个 chunk 就把整个 64KB 累积缓冲区重新 split + JSON.parse 一遍（而且先按
 * 空行切一遍、再按换行切一遍，每行 parse 两次），是彻头彻尾的 O(n²)。实测首字之前
 * 有 800 个非有效事件时，网关给首字硬加了 1.4 秒；两千个增量的响应总耗时多 387ms。
 *
 * 现在按行增量喂：残缺的半行留到下一片，完整的块当场解析一次就丢。
 */
class StreamScanner {
  constructor() {
    // chunk 可能从一个多字节字符中间劈开，交给 StringDecoder 兜着，别解出替换字符
    this.decoder = new StringDecoder('utf8')
    this.lineCarry = ''
    this.eventName = ''
    this.dataLines = []
    this.dataBytes = 0
    this.probedLength = -1
    this.sawSse = false
    /** 首字已经认出来了——之后除了 usage，什么都不必再解析。 */
    this.settled = false
    this.markerCarry = ''
    this.sawTerminal = false
    this.sawErrorEvent = false
    /**
     * 正文尾巴，按片存着，只在结束时 join 一次。
     * 每个 chunk 拼一个 64KB 字符串正是要除掉的那笔开销。
     */
    this.tailParts = []
    this.tailBytes = 0
  }

  /** @returns {Array<{eventName: string, payload: unknown}>} 这一片里新解析出来的。 */
  push(bytes) {
    const text = this.decoder.write(bytes)
    if (!text) return []
    return this._consume(text)
  }

  /** 流结束：把残留的半行和未闭合的块也吐出来。 */
  end() {
    const tail = this.decoder.end()
    const out = this._consume(tail, true)
    this._flushBlock(out)
    return out
  }

  /** 结束时的兜底源：非 SSE 正文（尤其是被换行拆开的）只能靠它捞 usage。 */
  tailSource() {
    return this.tailParts.join('')
  }

  _consume(text, final = false) {
    const out = []
    if (text) {
      this._scanMarkers(text)
      this.tailParts.push(text)
      this.tailBytes += text.length
      while (this.tailParts.length > 1
        && this.tailBytes - this.tailParts[0].length >= MAX_DETECTION_BUFFER_BYTES) {
        this.tailBytes -= this.tailParts.shift().length
      }
    }
    const merged = this.lineCarry + text
    const lines = merged.split('\n')
    // 最后一段没跟换行，可能只是半行，留到下一片再说——除非流已经结束了
    this.lineCarry = final ? '' : (lines.pop() ?? '')
    for (const line of lines) this._line(line, out)
    if (this.lineCarry.length > MAX_LINE_BYTES) {
      // 单行大到离谱：只保住内存上限，usage 靠结束时的尾部扫描兜底
      this.lineCarry = this.lineCarry.slice(-MAX_LINE_BYTES)
      this.probedLength = this.lineCarry.length
    } else if (!final) {
      this._probeBody(out)
    }
    return out
  }

  _line(raw, out) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('data:')) {
      this.sawSse = true
      if (this.dataBytes < MAX_LINE_BYTES) {
        const value = line.slice(5).replace(/^ /, '')
        this.dataLines.push(value)
        this.dataBytes += value.length
      }
      return
    }
    if (line.startsWith('event:')) {
      this.sawSse = true
      this.eventName = line.slice(6).trim()
      return
    }
    if (line.startsWith(':')) return // SSE 注释，中转常拿它当心跳
    if (line.trim() === '') {
      this._flushBlock(out)
      return
    }
    // 不是 SSE：可能是 JSON-lines，也可能是被换行拆开的一整个正文
    this._emit('', line.trim(), out)
  }

  _flushBlock(out) {
    if (this.dataLines.length === 0) {
      this.eventName = ''
      return
    }
    const eventName = this.eventName
    const value = this.dataLines.join('\n').trim()
    this.dataLines = []
    this.dataBytes = 0
    this.eventName = ''
    this._emit(eventName, value, out)
  }

  /**
   * 首字认出来之后，剩下的事件里只有 usage 还值得看一眼。
   *
   * 绝大多数增量事件里压根没有 usage，照样 JSON.parse 一遍纯属白烧 CPU——一个
   * 两千增量的回复就是两千次无用的解析，而这活是同步卡在转发路径上的。先用一次
   * 正则筛掉，命中了才解析。
   */
  _emit(eventName, value, out) {
    if (!value) return
    if (this.settled && !USAGE_HINT.test(value)) return
    for (const payload of parsedJson(value)) out.push({ eventName, payload })
  }

  /**
   * 非流式正文没有换行，一辈子等不到行结束——得在这儿主动试一次。
   *
   * 但不能每片都试：一个 10MB 的正文分 160 片到达，就是 160 次全量 JSON.parse。
   * 所以先做 O(1) 预检——正文没闭合（末字符不是 } 或 ]）就绝不可能解析成功。
   * 多片正文里只有最后一片能过这道闸。
   */
  _probeBody(out) {
    if (this.sawSse) return
    const source = this.lineCarry
    if (source.length === 0 || source.length === this.probedLength) return
    let end = source.length - 1
    while (end >= 0 && (source[end] === ' ' || source[end] === '\t' || source[end] === '\r')) end -= 1
    if (end < 0) return
    const last = source[end]
    if (last !== '}' && last !== ']') return
    this.probedLength = source.length
    for (const payload of parsedJson(source.trim())) out.push({ eventName: '', payload })
  }

  _scanMarkers(text) {
    if (this.sawTerminal && this.sawErrorEvent) return
    const window = this.markerCarry + text
    if (!this.sawTerminal && hasTerminalMarker(window)) this.sawTerminal = true
    if (!this.sawErrorEvent && hasErrorEvent(window)) this.sawErrorEvent = true
    this.markerCarry = window.slice(-MARKER_OVERLAP)
  }
}

function numberOrUndefined(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined
}

/**
 * 把各家的 usage 归一化成同一套口径。
 *
 * 三家对「输入 token」的定义并不一致，直接拿去算比率会得出垃圾数：
 *
 * - Anthropic：`input_tokens` 只是**未命中缓存的新输入**，缓存读写是两个独立字段
 *   （`cache_read_input_tokens` / `cache_creation_input_tokens`），都不含在里面。
 * - OpenAI：`prompt_tokens`（或 Responses 的 `input_tokens`）**已经包含**
 *   `cached_tokens`；没有单独的「写缓存」计数。
 * - Gemini：`promptTokenCount` **已经包含** `cachedContentTokenCount`。
 *
 * 归一化后 inputTokens 一律是「这次请求的全部提示 token，含缓存读写」，
 * 于是 cacheReadTokens / inputTokens 在三家都是同一个含义的命中率。
 *
 * 另外两点：
 * - 缓存**写入**不是命中。它按 1.25× 计费——是最贵的一次请求，不能算进命中里。
 * - reasoning token 已经含在 output 里（OpenAI 的 reasoning_tokens、Gemini 的
 *   thoughtsTokenCount 都是如此），单独拿出来只为显示，**不再加总**。
 */
function extractTokenUsage(payload) {
  const container = payload?.response || payload?.message || payload
  const usage = container?.usage || payload?.usageMetadata
  if (!usage || typeof usage !== 'object') return undefined

  const outputTokens = numberOrUndefined(
    usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount,
  )
  const reasoningTokens = numberOrUndefined(
    usage.output_tokens_details?.reasoning_tokens
      ?? usage.completion_tokens_details?.reasoning_tokens
      ?? usage.thoughtsTokenCount,
  )

  // 只有 Anthropic 会发这两个键，拿它们当判别式
  const anthropicRead = numberOrUndefined(usage.cache_read_input_tokens)
  const anthropicWrite = numberOrUndefined(usage.cache_creation_input_tokens)
  const anthropicStyle = anthropicRead !== undefined || anthropicWrite !== undefined

  const rawInput = numberOrUndefined(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount,
  )
  const cacheReadTokens = anthropicStyle
    ? anthropicRead
    : numberOrUndefined(
      usage.input_tokens_details?.cached_tokens
        ?? usage.prompt_tokens_details?.cached_tokens
        ?? usage.cachedContentTokenCount,
    )
  const cacheWriteTokens = anthropicWrite

  // Anthropic 的 input 不含缓存，补回来；其余两家本来就含
  const inputTokens = anthropicStyle && rawInput !== undefined
    ? rawInput + (anthropicRead ?? 0) + (anthropicWrite ?? 0)
    : rawInput

  const explicitTotal = numberOrUndefined(usage.total_tokens ?? usage.totalTokenCount)
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, explicitTotal]
    .every((value) => value === undefined)) return undefined

  /*
   * Anthropic 不发 total_tokens，而它的 input 又不含缓存——按老写法
   * total = input + output，一个读了 3.2 万缓存 token 的请求只会被记成 305 个。
   * 归一化后的 inputTokens 已经含缓存，这里加起来才是真实用量。
   */
  const totalTokens = explicitTotal ?? (
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined
  )
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cachedTokens: cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
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

/**
 * 上游错误事件标记：流只回了个错误就结束时（HTTP 仍是 200），不该记成「已完成」。
 *
 * 模式收紧到 SSE 事件行与事件体的 type 字段，避免误伤正文里恰好出现的字样；
 * 最终判定还要求全程没出现过首个有效 token（见 end()），双保险。
 */
const ERROR_EVENT_PATTERN = new RegExp([
  'event:\\s*(?:response\\.failed|error)\\b',
  '"type"\\s*:\\s*"(?:response\\.failed|error)"',
].join('|'))

function hasErrorEvent(source) {
  return ERROR_EVENT_PATTERN.test(source)
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

/** 活跃记录带 startedAtMs；从磁盘恢复的只有 ISO 串。排序两边都得认。 */
function startedAtMillis(entry) {
  if (Number.isFinite(entry.startedAtMs)) return entry.startedAtMs
  const parsed = Date.parse(entry.startedAt)
  return Number.isFinite(parsed) ? parsed : 0
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

  /**
   * 全部记录按「开始时间」倒序，最新的永远在最上面。
   *
   * 老写法是 [...active, ...recent]：活跃的整组置顶，组内还按正序排，于是刚发出的
   * 请求只能落在活跃组的末尾——看上去像是「新请求出现在下面」。而 recent 是按完成
   * 时间 unshift 的，并发请求交错完成时，时间戳列也是乱的。
   *
   * recent 本身仍保持完成时间倒序不动：_prune 靠这个顺序截断最旧的。
   */
  list() {
    return [...this.active.values(), ...this.recent]
      .sort((left, right) => startedAtMillis(right) - startedAtMillis(left))
      .map(toPublicRequest)
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
      scanner: new StreamScanner(),
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

  observeChunk(id, chunk) {
    const entry = this.active.get(id)
    if (!entry) return false
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (bytes.byteLength === 0) return false
    entry.receivedBytes += bytes.byteLength
    if (entry.firstByteLatencyMs === undefined) {
      entry.firstByteLatencyMs = Math.max(0, this.now() - entry.startedAtMs)
      this._notify()
    }
    const marked = this._absorb(entry, entry.scanner.push(bytes))
    if (marked) return true
    this._notifyProgress(entry)
    return false
  }

  /** 消化新解析出的 payload：累计 usage、认领模型、判首字。 */
  _absorb(entry, payloads) {
    let marked = false
    for (const { eventName, payload } of payloads) {
      const usage = extractTokenUsage(payload)
      if (usage) entry.tokenUsage = mergeUsage(entry.tokenUsage, usage)
      if (entry.firstTokenLatencyMs !== undefined) continue
      const metadata = extractRequestMetadata(payload?.response || payload)
      if (metadata.model) entry.model = metadata.model
      if (isMeaningfulPayload(entry.protocol, payload, eventName)) {
        this._markFirstToken(entry)
        marked = true
      }
    }
    if (entry.scanner.sawTerminal) entry.sawCompletion = true
    if (entry.scanner.sawErrorEvent) entry.sawErrorEvent = true
    return marked
  }

  end(id, { outcome } = {}) {
    const entry = this.active.get(id)
    if (!entry) return false
    this.active.delete(id)
    // 收尾：残留的半行、没闭合的块，还有非 SSE 正文——被换行拆开的正文行行都解析
    // 不出来，只能从尾巴里把 usage 捞出来（它通常就在 JSON 末尾）。
    this._absorb(entry, entry.scanner.end())
    if (entry.tokenUsage === undefined) {
      const usage = extractTokenUsageFromSource(entry.scanner.tailSource())
      if (usage) entry.tokenUsage = mergeUsage(entry.tokenUsage, usage)
    }
    const completedAtMs = this.now()
    entry.completedAt = new Date(completedAtMs).toISOString()
    entry.durationMs = Math.max(0, completedAtMs - entry.startedAtMs)
    // 流里已出现协议级完成标记时，socket 层的中止只是客户端提前收尾，不改判为中止。
    const effectiveOutcome = outcome === 'aborted' && entry.sawCompletion ? undefined : outcome
    entry.outcome = effectiveOutcome || (
      entry.statusCode !== undefined && entry.statusCode >= 400 ? 'failed'
        // 只见错误事件、始终没等来首个有效 token 的流，是伪装成 200 的失败
        : entry.sawErrorEvent && entry.firstTokenLatencyMs === undefined ? 'failed'
          : 'completed'
    )
    entry.state = entry.outcome === 'completed' ? 'completed' : entry.outcome
    // 记录会在 recent 里留一小时。扫描器攥着 64KB 尾巴，留着就是 2000 × 64KB。
    delete entry.scanner
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
    // 告诉扫描器：可以只盯 usage 了，别再解析每一个增量
    entry.scanner.settled = true
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
  StreamScanner,
  extractRequestMetadata,
  extractTokenUsage,
  extractTokenUsageFromSource,
  isMeaningfulPayload,
}
