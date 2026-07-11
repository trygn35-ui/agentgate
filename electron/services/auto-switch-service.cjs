const SCHEDULER_TICK_MS = 2 * 60_000
const MINIMUM_IMPROVEMENT_MS = 25
const REQUIRED_CONSECUTIVE_WINS = 2
const HEALTH_HISTORY_WINDOW_MS = 60 * 60_000
const MINIMUM_COMPETING_SAMPLES = 3
const ERROR_MESSAGE_LIMIT = 240

function checkedAtTimestamp(profile) {
  return Math.max(0, ...profile.endpoints.flatMap((endpoint) => {
    const samples = [...(endpoint.healthHistory || []), endpoint.health].filter(Boolean)
    return samples.map((sample) => {
      const timestamp = Date.parse(sample.checkedAt || '')
      return Number.isFinite(timestamp) ? timestamp : 0
    })
  }))
}

function healthIsReachable(health) {
  if (!health) return false
  if (typeof health.reachable === 'boolean') return health.reachable
  return health.status === 'healthy' || health.status === 'limited'
}

function recentHealthHistory(endpoint, now = Date.now()) {
  const minimumTimestamp = now - HEALTH_HISTORY_WINDOW_MS
  return (endpoint.healthHistory || []).filter((sample) => {
    const timestamp = Date.parse(sample.checkedAt || '')
    return Number.isFinite(timestamp) && timestamp >= minimumTimestamp && timestamp <= now + 60_000
  })
}

function median(values) {
  if (values.length === 0) return Number.POSITIVE_INFINITY
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function endpointMetrics(endpoint, now = Date.now()) {
  const history = recentHealthHistory(endpoint, now)
  const reachable = history.filter((sample) => healthIsReachable(sample))
  return {
    sampleCount: history.length,
    availability: history.length === 0 ? 0 : reachable.length / history.length,
    medianLatencyMs: median(reachable.map((sample) => sample.latencyMs)),
  }
}

/**
 * 按最近一小时可用率降序、中位延迟升序排列可竞争端点。
 */
function candidateEndpoints(profile, options = {}) {
  const now = options.now ?? Date.now()
  const allowCold = options.allowCold === true
  return profile.endpoints
    .filter((endpoint) => healthIsReachable(endpoint.health))
    .map((endpoint) => ({ endpoint, metrics: endpointMetrics(endpoint, now) }))
    .filter(({ endpoint, metrics }) => (
      endpoint.url === profile.baseUrl
      || allowCold
      || metrics.sampleCount >= MINIMUM_COMPETING_SAMPLES
    ))
    .sort((left, right) => (
      right.metrics.availability - left.metrics.availability
      || left.metrics.medianLatencyMs - right.metrics.medianLatencyMs
      || left.endpoint.url.localeCompare(right.endpoint.url)
    ))
    .map(({ endpoint, metrics }) => ({ ...endpoint, metrics }))
}

function legacyCandidateEndpoints(profile) {
  return profile.endpoints
    .filter((endpoint) => endpoint.health?.status === 'healthy')
    .filter((endpoint) => endpoint.models.length > 0)
    .filter((endpoint) => !profile.model || endpoint.models.includes(profile.model))
    .sort((left, right) => left.health.latencyMs - right.health.latencyMs)
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : 'Automatic endpoint check failed'
  return message.slice(0, ERROR_MESSAGE_LIMIT)
}

function abortedError() {
  const error = new Error('Automatic endpoint check was stopped')
  error.name = 'AbortError'
  return error
}

/**
 * 在 Keydeck 运行期间定时检测 URL 池并更新网关使用的活动端点。
 *
 * 服务不直接写客户端配置，也不在应用退出后常驻。停止调度会中止网络并使
 * 旧轮次失效；网关运行时只刷新对应方案的内存连接缓存。
 */
class AutoSwitchService {
  constructor({
    profileService,
    healthService,
    applyService,
    gatewayService,
    tickMs = SCHEDULER_TICK_MS,
    now = () => Date.now(),
  }) {
    this.profileService = profileService
    this.healthService = healthService
    this.applyService = applyService
    this.gatewayService = gatewayService
    this.tickMs = tickMs
    this.now = now
    this.running = false
    this.timer = undefined
    this.activeController = undefined
    this.activeTick = undefined
    this.generation = 0
    this.onChange = () => {}
    this.lastRuns = new Map()
    this.candidates = new Map()
  }

  /**
   * 启动无重入的后台调度循环。
   *
   * @param {(event: object) => void} onChange 检测或切换后的主进程通知回调。
   * @returns {void} 已启动时不重复注册计时器。
   */
  start(onChange = () => {}) {
    if (this.timer) return
    this.onChange = onChange
    const generation = ++this.generation
    this.timer = setInterval(() => void this.tick(generation), this.tickMs)
    this.timer.unref?.()
    void this.tick(generation)
  }

  /**
   * 停止调度、中止当前网络请求并使运行中的旧轮次失效。
   *
   * @returns {void} 停止后不会保留计时器或防抖候选。
   */
  stop() {
    this.generation += 1
    this.activeController?.abort()
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.lastRuns.clear()
    this.candidates.clear()
  }

  /**
   * 停止调度并等待当前轮次跨过配置事务的提交或回滚边界。
   *
   * 新的网络工作会立即中止；若配置写入已经开始，活动 tick 会等待 ApplyService
   * 完成全部提交或回滚后结束。重复调用会等待同一个活动 Promise。
   *
   * @returns {Promise<void>} 当前轮次完全结束后完成。
   */
  async stopAndWait() {
    this.stop()
    const activeTick = this.activeTick
    if (!activeTick) return
    await activeTick.catch(() => {})
  }

  assertGeneration(generation, signal) {
    if (signal?.aborted || (generation !== undefined && generation !== this.generation)) {
      throw abortedError()
    }
  }

  /**
   * 判断方案是否达到用户配置的检测周期。
   *
   * @param {object} profile 公开方案。
   * @returns {boolean} 未检测或周期已到时返回 true。
   */
  isDue(profile) {
    const lastRun = Math.max(
      checkedAtTimestamp(profile),
      this.lastRuns.get(profile.id) || 0,
    )
    return this.now() - lastRun >= SCHEDULER_TICK_MS
  }

  /**
   * 执行一次到期方案扫描，同一时刻最多运行一轮。
   *
   * @param {number} generation 当前调度生命周期编号。
   * @returns {Promise<void>} 全部到期方案处理完成后结束。
   */
  tick(generation = this.generation) {
    if (this.activeTick) return this.activeTick
    if (generation !== this.generation) return Promise.resolve()

    const activeTick = this.executeTick(generation)
    this.activeTick = activeTick
    const clearActiveTick = () => {
      if (this.activeTick === activeTick) this.activeTick = undefined
    }
    activeTick.then(clearActiveTick, clearActiveTick)
    return activeTick
  }

  /**
   * 执行单轮到期方案扫描，由 tick 保存并复用其 Promise。
   *
   * @param {number} generation 当前调度生命周期编号。
   * @returns {Promise<void>} 全部到期方案处理完成后结束。
   */
  async executeTick(generation) {
    this.running = true
    const controller = new AbortController()
    this.activeController = controller
    try {
      const profiles = await this.profileService.list()
      this.assertGeneration(generation, controller.signal)
      const enabledIds = new Set(
        profiles.filter((profile) => profile.autoSwitch.enabled).map((profile) => profile.id),
      )
      for (const id of this.candidates.keys()) {
        if (!enabledIds.has(id)) this.candidates.delete(id)
      }

      for (const profile of profiles) {
        if (!profile.autoSwitch.enabled || !this.isDue(profile)) continue
        this.lastRuns.set(profile.id, this.now())
        try {
          const event = await this.runProfile(profile.id, {
            generation,
            signal: controller.signal,
          })
          this.assertGeneration(generation, controller.signal)
          this.onChange(event)
        } catch (error) {
          if (error.name === 'AbortError' || generation !== this.generation) break
          this.onChange({
            type: 'auto-switch-error',
            profileId: profile.id,
            message: errorMessage(error),
          })
        }
      }
    } finally {
      if (this.activeController === controller) this.activeController = undefined
      this.running = false
    }
  }

  /**
   * 检测单个方案并按滚动健康指标切换。
   *
   * 测速返回的 decision revision 会贯穿活动 URL 选择和网关缓存刷新。自动择优
   * 不写客户端配置；任一步失败都会条件式恢复活动 URL。
   *
   * @param {string} profileId 方案 UUID。
   * @param {{generation?: number, signal?: AbortSignal}} context 调度生命周期上下文。
   * @returns {Promise<object>} 可发送给渲染进程的无敏感事件。
   */
  async runProfile(profileId, context = {}) {
    const rollingHealth = typeof this.healthService.testHealthWithSnapshot === 'function'
    const testMethod = rollingHealth
      ? this.healthService.testHealthWithSnapshot.bind(this.healthService)
      : this.healthService.testWithSnapshot.bind(this.healthService)
    const decision = await testMethod(profileId, {
      signal: context.signal,
    })
    this.assertGeneration(context.generation, context.signal)
    const tested = decision.profile
    const current = tested.endpoints.find((endpoint) => endpoint.url === tested.baseUrl)
    const currentFailed = !healthIsReachable(current?.health)
    const candidates = rollingHealth
      ? candidateEndpoints(tested, {
          allowCold: currentFailed,
          now: this.now(),
        })
      : legacyCandidateEndpoints(tested)
    const best = candidates[0]

    if (!best || best.url === tested.baseUrl) {
      this.candidates.delete(profileId)
      return {
        type: 'profile-tested',
        profileId,
        switched: false,
        reason: best ? 'already-best' : 'no-reachable-endpoint',
      }
    }

    let switchReason = currentFailed ? 'current-failed' : 'better-health-score'
    if (!rollingHealth) {
      const improvement = current?.health
        ? current.health.latencyMs - best.health.latencyMs
        : Number.POSITIVE_INFINITY
      if (!currentFailed && improvement < MINIMUM_IMPROVEMENT_MS) {
        this.candidates.delete(profileId)
        return { type: 'profile-tested', profileId, switched: false, reason: 'latency-threshold' }
      }

      const previousCandidate = this.candidates.get(profileId)
      const winCount = previousCandidate?.url === best.url ? previousCandidate.count + 1 : 1
      this.candidates.set(profileId, { url: best.url, count: winCount })
      if (!currentFailed && winCount < REQUIRED_CONSECUTIVE_WINS) {
        return {
          type: 'profile-tested',
          profileId,
          switched: false,
          reason: 'warming-candidate',
        }
      }
      switchReason = currentFailed ? 'current-failed' : 'legacy-latency-win'
    }

    const previousBaseUrl = tested.baseUrl
    const switched = await this.applyService.withLifecycleLock(async () => {
      this.assertGeneration(context.generation, context.signal)
      const assignedTargets = this.gatewayService?.assignedTargetsForProfile(profileId)
        || this.gatewayService?.activeTargetsForProfile(profileId)
        || []
      const gatewayRunning = this.gatewayService?.getPublicState().status === 'running'
      this.assertGeneration(context.generation, context.signal)
      let selected

      try {
        selected = await this.profileService.setActiveEndpoint(profileId, best.url, {
          expectedBaseUrl: tested.baseUrl,
          expectedRevision: decision.connectionRevision,
        })
        this.assertGeneration(context.generation, context.signal)
        if (gatewayRunning && assignedTargets.length > 0) {
          await this.gatewayService.refreshProfile(profileId)
        }
      } catch (error) {
        if (selected) {
          try {
            await this.profileService.setActiveEndpoint(profileId, previousBaseUrl, {
              expectedBaseUrl: best.url,
              expectedRevision: selected.connectionRevision,
            })
            if (gatewayRunning && assignedTargets.length > 0) {
              await this.gatewayService.refreshProfile(profileId)
            }
          } catch {
            throw new Error('Automatic write failed and the active endpoint could not be restored')
          }
        }
        throw error
      }

      return { activeTargets: assignedTargets }
    })

    this.candidates.delete(profileId)
    return {
      type: 'profile-tested',
      profileId,
      switched: true,
      reason: switchReason,
      previousBaseUrl,
      baseUrl: best.url,
      targets: switched.activeTargets,
      ...(rollingHealth && best.metrics ? {
        availability: best.metrics.availability,
        medianLatencyMs: best.metrics.medianLatencyMs,
      } : {}),
    }
  }
}

module.exports = {
  HEALTH_HISTORY_WINDOW_MS,
  MINIMUM_COMPETING_SAMPLES,
  MINIMUM_IMPROVEMENT_MS,
  REQUIRED_CONSECUTIVE_WINS,
  SCHEDULER_TICK_MS,
  AutoSwitchService,
  candidateEndpoints,
  endpointMetrics,
  healthIsReachable,
}
