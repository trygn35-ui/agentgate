const crypto = require('node:crypto')
const http = require('node:http')
const https = require('node:https')
const { pipeline, Transform } = require('node:stream')
const { parser: createJsonParser } = require('stream-json')
const { z } = require('zod')
const { TARGETS } = require('./schemas.cjs')
const { SerialExecutor } = require('./storage.cjs')
const {
  MAX_REQUEST_BODY_BYTES,
  convertRequestBuffer,
  createResponsesToolBridgeTransform,
} = require('./responses-tool-bridge.cjs')
const { extractRequestMetadata } = require('./request-monitor-service.cjs')

const DEFAULT_GATEWAY_HOST = '127.0.0.1'
const DEFAULT_GATEWAY_PORT = 17863
const LOCAL_HEADERS_TIMEOUT_MS = 15_000
const LOCAL_REQUEST_TIMEOUT_MS = 5 * 60_000
const LOCAL_IDLE_TIMEOUT_MS = 5 * 60_000
const LOCAL_MAX_CONNECTIONS = 128
const REJECTED_BODY_LIMIT_BYTES = 64 * 1024
const REJECTED_BODY_DRAIN_MS = 1_000
const UPSTREAM_HEADERS_TIMEOUT_MS = 120_000
const MAX_MODEL_METADATA_LENGTH = 240
const MAX_REASONING_METADATA_LENGTH = 32
const GATEWAY_VERSION = 3
const TARGET_SET = new Set(TARGETS)
const ProfileIdSchema = z.string().trim().uuid()
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
])

function createRequestMetadataTap(onMetadata) {
  const jsonParser = createJsonParser({ packStrings: false })
  const keys = []
  const paths = []
  let depth = 0
  let stopped = false
  let stringField
  let stringValue = ''
  let stringExceeded = false

  const publish = (patch) => {
    if (Object.keys(patch).length === 0) return
    try { onMetadata(patch) } catch {}
  }

  const metadataField = (key) => {
    if (depth === 1 && key === 'model') {
      return { name: 'model', limit: MAX_MODEL_METADATA_LENGTH }
    }
    if (depth === 1 && (key === 'reasoning_effort' || key === 'reasoning')) {
      return { name: 'reasoningEffort', limit: MAX_REASONING_METADATA_LENGTH }
    }
    if (depth === 2 && paths[2] === 'reasoning' && key === 'effort') {
      return { name: 'reasoningEffort', limit: MAX_REASONING_METADATA_LENGTH }
    }
    return undefined
  }

  jsonParser.on('data', ({ name, value }) => {
    if (name === 'keyValue') {
      keys[depth] = value
      return
    }
    if (name === 'startObject' || name === 'startArray') {
      const enteringKey = keys[depth]
      delete keys[depth]
      depth += 1
      paths[depth] = enteringKey
      return
    }
    if (name === 'endObject' || name === 'endArray') {
      delete paths[depth]
      delete keys[depth]
      depth = Math.max(0, depth - 1)
      return
    }
    if (name === 'startString') {
      stringField = metadataField(keys[depth])
      delete keys[depth]
      stringValue = ''
      stringExceeded = false
      return
    }
    if (name === 'stringChunk') {
      if (!stringField || stringExceeded) return
      stringValue += value
      if (stringValue.length > stringField.limit) {
        stringValue = ''
        stringExceeded = true
      }
      return
    }
    if (name === 'endString') {
      if (stringField && !stringExceeded && stringValue.trim()) {
        publish({ [stringField.name]: stringValue.trim() })
      }
      stringField = undefined
      stringValue = ''
      stringExceeded = false
      return
    }
    if (!name.endsWith('Value')) return
    const key = keys[depth]
    delete keys[depth]
    if (depth === 1 && key === 'model' && typeof value === 'string') {
      publish({ model: value })
    } else if (depth === 1 && key === 'stream' && typeof value === 'boolean') {
      publish({ streaming: value })
    } else if (depth === 1 && (key === 'reasoning_effort' || key === 'reasoning')
      && typeof value === 'string') {
      publish({ reasoningEffort: value })
    } else if (depth === 2 && paths[2] === 'reasoning'
      && key === 'effort' && typeof value === 'string') {
      publish({ reasoningEffort: value })
    }
  })
  jsonParser.on('error', () => {
    stopped = true
  })

  return new Transform({
    transform(chunk, _encoding, callback) {
      if (!stopped) {
        try { jsonParser.write(chunk) } catch { stopped = true }
      }
      callback(null, chunk)
    },
    flush(callback) {
      if (!stopped) {
        try { jsonParser.end() } catch {}
      }
      callback()
    },
  })
}

const CanonicalGatewayStoreSchema = z.object({
  version: z.literal(GATEWAY_VERSION),
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535),
  targets: z.array(z.enum(TARGETS)).max(TARGETS.length),
  routes: z.record(z.enum(TARGETS), ProfileIdSchema),
  encryptedToken: z.string().optional(),
  encryptedRouteToken: z.string().optional(),
})

function migrateGatewayStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultGatewayStore()
  const routes = routeRecord(value)
  const explicitTargets = Array.isArray(value.targets)
    ? value.targets.filter((target) => TARGET_SET.has(target))
    : []
  const targets = [...new Set([...explicitTargets, ...Object.keys(routes)])]
  const normalized = {
    version: GATEWAY_VERSION,
    enabled: value.enabled === true,
    port: Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535
      ? value.port
      : DEFAULT_GATEWAY_PORT,
    targets,
    routes,
  }
  if (typeof value.encryptedToken === 'string' && value.encryptedToken) {
    normalized.encryptedToken = value.encryptedToken
  }
  if (typeof value.encryptedRouteToken === 'string' && value.encryptedRouteToken) {
    normalized.encryptedRouteToken = value.encryptedRouteToken
  }
  return normalized
}

const GatewayStoreSchema = z.preprocess(migrateGatewayStore, CanonicalGatewayStoreSchema)

function defaultGatewayStore() {
  return {
    version: GATEWAY_VERSION,
    enabled: false,
    port: DEFAULT_GATEWAY_PORT,
    targets: [],
    routes: {},
  }
}

function normalizeTargets(targets) {
  if (!Array.isArray(targets)) throw new Error('Gateway targets must be an array')
  const result = []
  const seen = new Set()
  for (const target of targets) {
    if (!TARGET_SET.has(target)) throw new Error(`Unsupported gateway target: ${target}`)
    if (!seen.has(target)) result.push(target)
    seen.add(target)
  }
  return result
}

function validatePort(port, allowZero = false) {
  const minimum = allowZero ? 0 : 1
  if (!Number.isInteger(port) || port < minimum || port > 65535) {
    throw new Error(`Gateway port must be between ${minimum} and 65535`)
  }
  return port
}

function localBaseUrl(port, target, routeToken) {
  const route = target === 'codex' && routeToken
    ? `${target}/${encodeURIComponent(routeToken)}`
    : target
  return `http://${DEFAULT_GATEWAY_HOST}:${port}/${route}`
}

function routeRecord(value) {
  const source = value?.routes || value || {}
  const result = {}
  if (Array.isArray(source)) {
    for (const route of source) {
      const profileId = ProfileIdSchema.safeParse(route?.profileId)
      if (route && TARGET_SET.has(route.target) && profileId.success) {
        result[route.target] = profileId.data
      }
    }
    return result
  }
  for (const [target, profileId] of Object.entries(source)) {
    const parsedProfileId = ProfileIdSchema.safeParse(profileId)
    if (TARGET_SET.has(target) && parsedProfileId.success) {
      result[target] = parsedProfileId.data
    }
  }
  return result
}

function drainRejectedRequest(request) {
  if (request.complete || request.destroyed) return
  let received = 0
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    clearTimeout(timer)
  }
  const destroy = () => {
    finish()
    if (!request.destroyed) request.destroy()
  }
  const timer = setTimeout(destroy, REJECTED_BODY_DRAIN_MS)
  timer.unref?.()
  request.on('data', (chunk) => {
    received += chunk.length
    if (received > REJECTED_BODY_LIMIT_BYTES) destroy()
  })
  request.once('end', finish)
  request.once('close', finish)
  request.once('error', destroy)
  request.resume()
}

function rejectRequest(request, response, statusCode, message) {
  if (!response.headersSent) {
    response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' })
  }
  if (!response.writableEnded) response.end(message)
  drainRejectedRequest(request)
}

function timingSafeTokenEqual(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false
  const left = Buffer.from(candidate, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function bearerValue(value) {
  if (typeof value !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(value.trim())
  return match ? match[1] : value.trim()
}

function requestHasToken(request, url, token) {
  const candidates = [
    bearerValue(request.headers.authorization),
    request.headers['x-api-key'],
    request.headers['x-goog-api-key'],
    url.searchParams.get('key'),
  ]
  return candidates.some((value) => (
    Array.isArray(value)
      ? value.some((item) => timingSafeTokenEqual(item, token))
      : timingSafeTokenEqual(value, token)
  ))
}

function stripHeaders(headers, extra = []) {
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...CREDENTIAL_HEADERS, ...extra])
  const connection = headers.connection
  if (typeof connection === 'string') {
    for (const name of connection.split(',')) blocked.add(name.trim().toLowerCase())
  }
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !blocked.has(name.toLowerCase())) result[name] = value
  }
  return result
}

function injectUpstreamCredential(headers, profile, apiKey) {
  if (profile.protocol === 'gemini') {
    headers['x-goog-api-key'] = apiKey
    return
  }
  if (profile.authMode === 'api-key') {
    headers['x-api-key'] = apiKey
    return
  }
  headers.authorization = `Bearer ${apiKey}`
}

function upstreamUrl(profile, suffix, incomingSearchParams) {
  const url = new URL(profile.baseUrl)
  const basePath = url.pathname.replace(/\/+$/, '')
  const suffixPath = suffix
    ? (suffix.startsWith('/') ? suffix : `/${suffix}`)
    : ''
  url.pathname = `${basePath}${suffixPath}` || '/'
  url.hash = ''
  const query = new URLSearchParams(url.search)
  for (const [name, value] of incomingSearchParams) {
    if (name !== 'key') query.append(name, value)
  }
  url.search = query.toString()
  return url
}

async function readRequestBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new Error('Responses request body is too large for experimental tool compatibility mode')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, size)
}

/**
 * 可选的本地原样转发网关。
 *
 * 默认路径不解析请求或响应正文。只有用户显式开启 Codex 工具兼容实验时，
 * `/responses` 才会经过受限的 exec 工具协议转换。真实 Key 只写入上游请求头。
 */
class GatewayService {
  constructor({
    profileService,
    store,
    vault,
    host = DEFAULT_GATEWAY_HOST,
    onStateChanged,
    requestMonitor,
  }) {
    if (!profileService || !store || !vault) {
      throw new Error('GatewayService requires profileService, store, and vault')
    }
    this.profileService = profileService
    this.store = store
    this.vault = vault
    this.host = host
    this.onStateChanged = onStateChanged
    this.requestMonitor = requestMonitor
    this.serial = new SerialExecutor()
    this.server = undefined
    this.sockets = new Set()
    this.upstreamRequests = new Set()
    this.loaded = false
    this.status = 'stopped'
    this.startedAt = undefined
    this.error = undefined
    this.persisted = defaultGatewayStore()
    this.localToken = undefined
    this.routeToken = undefined
    this.connectionCache = new Map()
    this.experimentalToolBridgeEnabled = false
  }

  async initialize({ start = true } = {}) {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      if (!start || !this.persisted.enabled || this.server) return this.getPublicState()
      try {
        return await this._startLoaded({
          port: this.persisted.port,
          targets: this.persisted.targets,
        })
      } catch (error) {
        this.status = 'error'
        this.error = error instanceof Error ? error.message : String(error)
        this._notify()
        return this.getPublicState()
      }
    })
  }

  async start(options = {}) {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      return this._startLoaded(options)
    })
  }

  async _startLoaded({ port = this.persisted.port, targets = this.persisted.targets } = {}) {
    const requestedPort = validatePort(port, true)
    const requestedTargets = normalizeTargets(targets)
    if (this.server) {
      const currentPort = this.persisted.port
      if (requestedPort !== 0 && requestedPort !== currentPort) {
        await this._closeServer()
      } else {
        this.persisted = await this.store.write({
          ...this.persisted,
          enabled: true,
          targets: requestedTargets,
          routes: this._routesForTargets(this.persisted.routes, requestedTargets),
        })
        this._evictUnroutedConnections()
        this.status = 'running'
        this.error = undefined
        this._notify()
        return this.getPublicState()
      }
    }

    this.status = 'starting'
    this.error = undefined
    this._notify()
    let token
    let routeToken
    try {
      token = this.persisted.encryptedToken
        ? this.vault.decrypt(this.persisted.encryptedToken)
        : crypto.randomBytes(32).toString('base64url')
      routeToken = this.persisted.encryptedRouteToken
        ? this.vault.decrypt(this.persisted.encryptedRouteToken)
        : crypto.randomBytes(32).toString('base64url')
      const server = http.createServer((request, response) => {
        // _handleRequest may await a first connection before pipeline installs its listener.
        request.on('error', () => {})
        request.on('aborted', () => {})
        this._handleRequest(request, response).catch(() => {
          if (!response.headersSent) {
            rejectRequest(request, response, 500, 'Gateway request failed')
          } else {
            response.destroy()
            request.destroy()
          }
        })
      })
      server.headersTimeout = LOCAL_HEADERS_TIMEOUT_MS
      server.requestTimeout = LOCAL_REQUEST_TIMEOUT_MS
      server.keepAliveTimeout = 5_000
      server.maxConnections = LOCAL_MAX_CONNECTIONS
      server.setTimeout(LOCAL_IDLE_TIMEOUT_MS, (socket) => socket.destroy())
      server.on('connection', (socket) => {
        this.sockets.add(socket)
        socket.once('close', () => this.sockets.delete(socket))
      })
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen({ host: this.host, port: requestedPort, exclusive: true })
      })
      const address = server.address()
      const boundPort = typeof address === 'object' && address ? address.port : requestedPort
      this.server = server
      this.localToken = token
      this.routeToken = routeToken
      try {
        this.persisted = await this.store.write({
          version: GATEWAY_VERSION,
          enabled: true,
          port: boundPort,
          targets: requestedTargets,
          routes: this._routesForTargets(this.persisted.routes, requestedTargets),
          encryptedToken: this.persisted.encryptedToken || this.vault.encrypt(token),
          encryptedRouteToken: this.persisted.encryptedRouteToken
            || this.vault.encrypt(routeToken),
        })
        this._evictUnroutedConnections()
      } catch (error) {
        await this._closeServer()
        throw error
      }
      await this._preloadRouteConnections()
      this.status = 'running'
      this.startedAt = new Date().toISOString()
      this.error = undefined
      this._notify()
      return this.getPublicState()
    } catch (error) {
      this.status = 'error'
      this.error = error instanceof Error ? error.message : String(error)
      this.localToken = undefined
      this.routeToken = undefined
      this.connectionCache.clear()
      this._notify()
      throw error
    }
  }

  async stop({ clearRoutes = false } = {}) {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      this.status = 'stopping'
      this._notify()
      try {
        await this._closeServer()
        this.persisted = await this.store.write({
          ...this.persisted,
          enabled: false,
          targets: clearRoutes ? [] : this.persisted.targets,
          routes: clearRoutes ? {} : this.persisted.routes,
        })
        this.status = 'stopped'
        this.error = undefined
      } catch (error) {
        this.status = 'error'
        this.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        this.startedAt = undefined
        this.localToken = undefined
        this.routeToken = undefined
        this.connectionCache.clear()
        this._notify()
      }
      return this.getPublicState()
    })
  }

  async stopAndWait(options) {
    return this.stop(options)
  }

  /**
   * 仅关闭本进程监听器，不改变持久化接管状态。
   *
   * 用于应用退出时直连恢复失败的兜底；下次启动会按原端口和路由自动恢复。
   *
   * @returns {Promise<object>} 关闭后的公开运行状态。
   */
  async shutdown() {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      try {
        await this._closeServer()
        this.status = 'stopped'
      } finally {
        this.startedAt = undefined
        this.localToken = undefined
        this.routeToken = undefined
        this.connectionCache.clear()
        this._notify()
      }
      return this.getPublicState()
    })
  }

  getPublicState() {
    const port = this.persisted.port
    const targets = [...this.persisted.targets]
    return {
      status: this.status,
      host: this.host,
      port,
      targets,
      routes: Object.entries(this.persisted.routes).map(([target, profileId]) => ({
        target,
        profileId,
      })),
      localBaseUrls: Object.fromEntries(targets.map((target) => [
        target,
        (() => {
          try {
            return this.getLocalBaseUrl(target)
          } catch {
            return localBaseUrl(port, target)
          }
        })(),
      ])),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
    }
  }

  getLocalBaseUrl(target) {
    if (!TARGET_SET.has(target)) throw new Error(`Unsupported gateway target: ${target}`)
    if (target !== 'codex') return localBaseUrl(this.persisted.port, target)
    const routeToken = this.routeToken || (this.persisted.encryptedRouteToken
      ? this.vault.decrypt(this.persisted.encryptedRouteToken)
      : undefined)
    if (!routeToken) throw new Error('Codex gateway route token is unavailable')
    return localBaseUrl(this.persisted.port, target, routeToken)
  }

  setExperimentalToolBridgeEnabled(enabled) {
    this.experimentalToolBridgeEnabled = enabled === true
  }

  getActiveRequests() {
    try {
      if (typeof this.requestMonitor?.getActiveRequests === 'function') {
        return this.requestMonitor.getActiveRequests()
      }
      return this.requestMonitor?.list?.() || []
    } catch {
      return []
    }
  }

  async prepareConnection(profileOrId, apiKeyOrTarget, maybeTarget) {
    let profile
    let target
    if (profileOrId && typeof profileOrId === 'object') {
      profile = profileOrId
      target = maybeTarget
    } else {
      target = apiKeyOrTarget
      const connection = await this.profileService.getConnection(profileOrId)
      profile = connection.profile
    }
    this._assertRunningTarget(target)
    if (!profile?.id) throw new Error('Gateway connection requires a profile ID')
    const baseUrl = this.getLocalBaseUrl(target)
    return {
      profile: { ...profile, baseUrl },
      apiKey: this.localToken,
      localBaseUrl: baseUrl,
      adapterOptions: {
        providerId: 'keydeck_gateway',
        providerName: 'Keydeck Local Gateway',
      },
      mode: 'gateway',
    }
  }

  async activateRoutes(profileOrId, targets) {
    return this.assignRoutes(profileOrId, targets)
  }

  /**
   * 分配持久化路由。分配与监听状态无关，因此可以在网关关闭时预先完成。
   *
   * @returns {Promise<object>} 修改前的 targets/routes 快照，供跨服务事务回滚。
   */
  async assignRoutes(profileOrId, targets) {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      const parsedProfileId = ProfileIdSchema.safeParse(
        typeof profileOrId === 'string' ? profileOrId : profileOrId?.id,
      )
      if (!parsedProfileId.success) throw new Error('Gateway route requires a valid profile ID')
      const profileId = parsedProfileId.data
      const selected = normalizeTargets(
        targets === undefined
          ? (typeof profileOrId === 'object' ? profileOrId.targets : [])
          : (Array.isArray(targets) ? targets : [targets]),
      )
      if (selected.length === 0) throw new Error('Select at least one gateway target')
      for (const target of selected) {
        if (!TARGET_SET.has(target)) throw new Error(`Unsupported gateway target: ${target}`)
      }
      const connection = await this.profileService.getConnection(profileId)
      const previous = {
        targets: [...this.persisted.targets],
        routes: { ...this.persisted.routes },
      }
      const routes = { ...previous.routes }
      for (const target of selected) routes[target] = profileId
      const nextTargets = [...new Set([...this.persisted.targets, ...selected])]
      this.persisted = await this.store.write({
        ...this.persisted,
        targets: nextTargets,
        routes,
      })
      this._evictUnroutedConnections()
      if (this.status === 'running' && this.server
        && Object.values(this.persisted.routes).includes(profileId)) {
        this.connectionCache.set(profileId, connection)
      }
      this._notify()
      return previous
    })
  }

  async unassignRoutes(targets) {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      const selected = new Set(normalizeTargets(Array.isArray(targets) ? targets : [targets]))
      const previous = {
        targets: [...this.persisted.targets],
        routes: { ...this.persisted.routes },
      }
      const routes = Object.fromEntries(
        Object.entries(this.persisted.routes).filter(([target]) => !selected.has(target)),
      )
      const nextTargets = this.persisted.targets.filter((target) => !selected.has(target))
      this.persisted = await this.store.write({
        ...this.persisted,
        targets: nextTargets,
        routes,
      })
      this._evictUnroutedConnections()
      this._notify()
      return previous
    })
  }

  async restoreRoutes(snapshot) {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      const routes = routeRecord(snapshot)
      const targets = Array.isArray(snapshot?.targets)
        ? normalizeTargets(snapshot.targets)
        : [...new Set([...this.persisted.targets, ...Object.keys(routes)])]
      this.persisted = await this.store.write({
        ...this.persisted,
        targets,
        routes: this._routesForTargets(routes, targets),
      })
      this._evictUnroutedConnections()
      if (this.status === 'running' && this.server) await this._preloadRouteConnections()
      else this.connectionCache.clear()
      this._notify()
      return this.getPublicState()
    })
  }

  isTargetEnabled(target) {
    return this.status === 'running'
      && Boolean(this.server)
      && this.persisted.targets.includes(target)
  }

  activeTargetsForProfile(profileOrId) {
    const profileId = typeof profileOrId === 'string' ? profileOrId : profileOrId?.id
    return Object.entries(this.persisted.routes)
      .filter(([, routedProfileId]) => routedProfileId === profileId)
      .map(([target]) => target)
  }

  assignedTargetsForProfile(profileOrId) {
    return this.activeTargetsForProfile(profileOrId)
  }

  getRouteGroups() {
    const groups = new Map()
    for (const [target, profileId] of Object.entries(this.persisted.routes)) {
      if (!groups.has(profileId)) groups.set(profileId, [])
      groups.get(profileId).push(target)
    }
    return [...groups].map(([profileId, targets]) => ({ profileId, targets }))
  }

  async refreshProfile(profileOrId) {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      const profileId = typeof profileOrId === 'string' ? profileOrId : profileOrId?.id
      if (this.status !== 'running'
        || !this.server
        || !profileId
        || this.activeTargetsForProfile(profileId).length === 0) return
      const connection = await this.profileService.getConnection(profileId)
      if (this.status !== 'running'
        || !this.server
        || this.activeTargetsForProfile(profileId).length === 0) return
      this.connectionCache.set(profileId, connection)
    })
  }

  matchesLocalBase(value, target) {
    if (typeof value !== 'string') return false
    try {
      const url = new URL(value)
      const expectedTarget = target || url.pathname.split('/').filter(Boolean)[0]
      if (expectedTarget === 'codex') {
        return url.toString() === this.getLocalBaseUrl('codex')
      }
      return TARGET_SET.has(expectedTarget)
        && url.protocol === 'http:'
        && url.hostname === DEFAULT_GATEWAY_HOST
        && Number(url.port || 80) === this.persisted.port
        && url.pathname.replace(/\/+$/, '') === `/${expectedTarget}`
        && !url.search
        && !url.hash
    } catch {
      return false
    }
  }

  async _ensureLoaded() {
    if (this.loaded) return
    this.persisted = GatewayStoreSchema.parse(await this.store.read())
    this.loaded = true
  }

  _routesForTargets(routes, targets) {
    const enabled = new Set(targets)
    return Object.fromEntries(Object.entries(routeRecord(routes)).filter(([target]) => enabled.has(target)))
  }

  async _preloadRouteConnections() {
    const profileIds = [...new Set(Object.values(this.persisted.routes))]
    await Promise.all(profileIds.map(async (profileId) => {
      try {
        const connection = await this.profileService.getConnection(profileId)
        this.connectionCache.set(profileId, connection)
      } catch {
        this.connectionCache.delete(profileId)
      }
    }))
    this._evictUnroutedConnections()
  }

  _evictUnroutedConnections() {
    const routedProfileIds = new Set(Object.values(this.persisted.routes))
    for (const profileId of this.connectionCache.keys()) {
      if (!routedProfileIds.has(profileId)) this.connectionCache.delete(profileId)
    }
  }

  async _connection(profileId) {
    const cached = this.connectionCache.get(profileId)
    if (cached) return cached
    const connection = await this.profileService.getConnection(profileId)
    if (this.status !== 'running'
      || !Object.values(this.persisted.routes).includes(profileId)) {
      throw new Error('Gateway route changed while loading its connection')
    }
    this.connectionCache.set(profileId, connection)
    return connection
  }

  _assertEnabledTarget(target) {
    if (!TARGET_SET.has(target)) throw new Error(`Unsupported gateway target: ${target}`)
    if (!this.isTargetEnabled(target)) throw new Error(`Gateway target is not enabled: ${target}`)
  }

  _assertRunningTarget(target) {
    if (this.status !== 'running' || !this.server || !this.localToken || !this.routeToken) {
      throw new Error('Local gateway is not running')
    }
    this._assertEnabledTarget(target)
  }

  _notify() {
    if (typeof this.onStateChanged !== 'function') return
    try {
      this.onStateChanged(this.getPublicState())
    } catch {
      // 状态订阅者不得影响网关生命周期。
    }
  }

  async _closeServer() {
    const server = this.server
    this.server = undefined
    for (const request of this.upstreamRequests) request.destroy()
    this.upstreamRequests.clear()
    if (!server) {
      this.requestMonitor?.clear?.()
      return
    }
    const closed = new Promise((resolve) => server.close(() => resolve()))
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
    for (const socket of this.sockets) socket.destroy()
    await closed
    this.sockets.clear()
    this.requestMonitor?.clear?.()
  }

  async _handleRequest(request, response) {
    const incomingUrl = new URL(request.url || '/', `http://${DEFAULT_GATEWAY_HOST}`)
    const routeMatch = /^\/([^/]+)(\/.*)?$/.exec(incomingUrl.pathname)
    const target = routeMatch?.[1]
    if (!TARGET_SET.has(target) || !this.isTargetEnabled(target)) {
      rejectRequest(request, response, 404, 'Gateway route not found')
      return
    }
    const codexRoute = target === 'codex'
      ? /^\/codex\/([^/]+)(\/.*)?$/.exec(incomingUrl.pathname)
      : undefined
    const routeAuthorized = target === 'codex'
      && this.routeToken
      && timingSafeTokenEqual(codexRoute?.[1], this.routeToken)
    const headerAuthorized = target !== 'codex'
      && this.localToken
      && requestHasToken(request, incomingUrl, this.localToken)
    if (!routeAuthorized && !headerAuthorized) {
      rejectRequest(request, response, 401, 'Unauthorized')
      return
    }
    const suffix = target === 'codex' ? (codexRoute?.[2] || '') : (routeMatch?.[2] || '')
    const profileId = this.persisted.routes[target]
    if (!profileId) {
      rejectRequest(request, response, 404, 'Gateway route not active')
      return
    }

    let monitorId
    try {
      monitorId = this.requestMonitor?.start?.({
        client: target,
        profileId,
        profileName: '正在载入方案',
        upstreamUrl: '',
      })
    } catch {
      monitorId = undefined
    }
    let monitorEnded = false
    const endMonitor = (outcome) => {
      if (monitorEnded || !monitorId) return
      monitorEnded = true
      try {
        if (outcome) this.requestMonitor?.end?.(monitorId, { outcome })
        else this.requestMonitor?.end?.(monitorId)
      } catch {}
    }

    let connection
    try {
      connection = await this._connection(profileId)
    } catch {
      if (request.destroyed || request.aborted || response.destroyed) {
        endMonitor('aborted')
        return
      }
      endMonitor('failed')
      rejectRequest(request, response, 502, 'Upstream profile is unavailable')
      return
    }
    if (request.destroyed || request.aborted || response.destroyed) {
      endMonitor('aborted')
      return
    }

    let destination
    try {
      destination = upstreamUrl(connection.profile, suffix, incomingUrl.searchParams)
    } catch {
      endMonitor('failed')
      rejectRequest(request, response, 502, 'Upstream URL is invalid')
      return
    }
    try {
      this.requestMonitor?.updateMetadata?.(monitorId, {
        profileName: connection.profile.name,
        keyHint: connection.profile.keyHint,
        upstreamUrl: `${destination.origin}${destination.pathname}`,
        protocol: connection.profile.protocol,
        model: connection.profile.model || undefined,
      })
    } catch {}
    const bridgeEnabled = this.experimentalToolBridgeEnabled
      && target === 'codex'
      && connection.profile.protocol === 'openai-responses'
      && request.method === 'POST'
      && suffix === '/responses'
    let requestBody
    if (bridgeEnabled) {
      try {
        requestBody = convertRequestBuffer(await readRequestBody(request))
      } catch {
        endMonitor(request.aborted ? 'aborted' : 'failed')
        rejectRequest(request, response, 502, 'Responses tool bridge request conversion failed')
        return
      }
      if (request.aborted || response.destroyed) {
        endMonitor('aborted')
        return
      }
    }
    const headers = stripHeaders(request.headers, ['host'])
    // Keep the monitoring side-channel readable; the gateway forwards the
    // response bytes unchanged to the client, but asks upstream for identity.
    headers['accept-encoding'] = 'identity'
    if (bridgeEnabled) headers['content-length'] = String(requestBody.length)
    injectUpstreamCredential(headers, connection.profile, connection.apiKey)
    const transport = destination.protocol === 'https:' ? https : http
    let upstreamRequest
    try {
      upstreamRequest = transport.request(destination, {
        method: request.method,
        headers,
      })
    } catch {
      endMonitor('failed')
      rejectRequest(request, response, 502, 'Upstream request configuration is invalid')
      return
    }
    let upstreamTimedOut = false
    const upstreamTimer = setTimeout(() => {
      upstreamTimedOut = true
      upstreamRequest.destroy(new Error('Upstream response headers timed out'))
    }, UPSTREAM_HEADERS_TIMEOUT_MS)
    upstreamTimer.unref?.()
    this.upstreamRequests.add(upstreamRequest)
    let responseReceived = false
    upstreamRequest.once('close', () => {
      clearTimeout(upstreamTimer)
      this.upstreamRequests.delete(upstreamRequest)
      if (!responseReceived) endMonitor('failed')
    })
    upstreamRequest.on('response', (upstreamResponse) => {
      responseReceived = true
      clearTimeout(upstreamTimer)
      const contentType = String(upstreamResponse.headers['content-type'] || '')
      const responseIsEventStream = contentType.toLowerCase().includes('text/event-stream')
      const bridgeResponse = bridgeEnabled && responseIsEventStream
      const responseHeaders = stripHeaders(
        upstreamResponse.headers,
        bridgeResponse ? ['content-length'] : [],
      )
      try {
        this.requestMonitor?.responseStarted?.(monitorId, {
          statusCode: upstreamResponse.statusCode || 502,
          contentType,
          streaming: responseIsEventStream ? true : undefined,
        })
      } catch {}
      upstreamResponse.on('data', (chunk) => {
        try {
          this.requestMonitor?.observeChunk?.(monitorId, chunk)
        } catch {}
      })
      upstreamResponse.once('end', () => endMonitor())
      upstreamResponse.once('aborted', () => endMonitor('aborted'))
      upstreamResponse.once('error', () => endMonitor('failed'))

      if (!bridgeResponse) {
        response.writeHead(
          upstreamResponse.statusCode || 502,
          upstreamResponse.statusMessage,
          responseHeaders,
        )
        pipeline(upstreamResponse, response, (error) => {
          if (error && !response.destroyed) response.destroy(error)
        })
        return
      }

      response.statusCode = upstreamResponse.statusCode || 502
      if (upstreamResponse.statusMessage) response.statusMessage = upstreamResponse.statusMessage
      for (const [name, value] of Object.entries(responseHeaders)) {
        if (value !== undefined) response.setHeader(name, value)
      }
      const transform = createResponsesToolBridgeTransform()
      pipeline(upstreamResponse, transform, response, (error) => {
        if (!error) return
        if (!response.headersSent) {
          for (const name of response.getHeaderNames()) response.removeHeader(name)
          response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('Responses tool bridge response conversion failed')
        } else if (!response.destroyed) {
          response.destroy(error)
        }
      })
    })
    upstreamRequest.on('error', () => {
      endMonitor('failed')
      if (!response.headersSent) {
        response.writeHead(upstreamTimedOut ? 504 : 502, {
          'content-type': 'text/plain; charset=utf-8',
        })
        response.end(upstreamTimedOut
          ? 'Upstream response timed out'
          : 'Could not reach upstream endpoint')
      } else {
        response.destroy()
      }
    })
    request.on('aborted', () => {
      endMonitor('aborted')
      upstreamRequest.destroy()
    })
    response.on('close', () => {
      if (!response.writableEnded) upstreamRequest.destroy()
    })
    if (bridgeEnabled) {
      try {
        this.requestMonitor?.updateMetadata?.(
          monitorId,
          extractRequestMetadata(JSON.parse(requestBody.toString('utf8'))),
        )
      } catch {}
      upstreamRequest.end(requestBody)
    } else {
      const requestContentType = String(request.headers['content-type'] || '').toLowerCase()
      const requestEncoding = String(request.headers['content-encoding'] || '').toLowerCase()
      const metadataTap = requestContentType.includes('json') && !requestEncoding
        ? createRequestMetadataTap((patch) => {
            try { this.requestMonitor?.updateMetadata?.(monitorId, patch) } catch {}
          })
        : undefined
      const streams = metadataTap
        ? [request, metadataTap, upstreamRequest]
        : [request, upstreamRequest]
      pipeline(...streams, (error) => {
        if (error && !upstreamRequest.destroyed) upstreamRequest.destroy(error)
      })
    }
  }
}

module.exports = {
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PORT,
  GatewayStoreSchema,
  defaultGatewayStore,
  GatewayService,
  createRequestMetadataTap,
  localBaseUrl,
}
