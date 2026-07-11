const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { z } = require('zod')
const {
  BackupFileSchema,
  PROTOCOL,
  TARGET,
  TARGETS,
  toPublicHistory,
  validationMessage,
} = require('./schemas.cjs')
const { SerialExecutor } = require('./storage.cjs')
const {
  atomicWriteText,
  readTextSnapshot,
  restoreSnapshot,
} = require('./config-utils.cjs')
const { GATEWAY_OWNERSHIP } = require('./adapters.cjs')

const IdSchema = z.string().uuid()
const TargetsSchema = z.array(z.enum(TARGETS)).max(TARGETS.length)
const ApplySourceSchema = z.enum(['manual', 'auto'])
const ConnectionRevisionSchema = z.number().int().positive()
const ExpectedHashesSchema = z.record(z.string().regex(/^[0-9a-f]{64}$/i))
const HISTORY_LIMIT = 100
const FAILURE_MESSAGE_LIMIT = 240
const GATEWAY_RECOVERY_ATTEMPTS = 3
const GATEWAY_BASELINE_VERSION = 2

const GatewayBaselineEntrySchema = z.object({
  capturedAt: z.string(),
  encryptedState: z.string(),
  encryptedBackup: z.string().optional(),
})

const CurrentGatewayBaselineStoreSchema = z.object({
  version: z.literal(GATEWAY_BASELINE_VERSION),
  baselines: z.record(z.enum(TARGETS), GatewayBaselineEntrySchema),
})

const GatewayBaselineStoreSchema = z.union([
  CurrentGatewayBaselineStoreSchema,
  z.object({
    version: z.literal(1),
    baselines: z.record(z.enum(TARGETS), GatewayBaselineEntrySchema),
  }).transform((value) => ({
    version: GATEWAY_BASELINE_VERSION,
    baselines: value.baselines,
  })),
])

function defaultGatewayBaselineStore() {
  return { version: GATEWAY_BASELINE_VERSION, baselines: {} }
}

function compatibleWithTarget(profile, target) {
  const compatible = {
    [PROTOCOL.ANTHROPIC]: [TARGET.CLAUDE, TARGET.OPENCODE],
    [PROTOCOL.OPENAI_RESPONSES]: [TARGET.CODEX, TARGET.OPENCODE],
    [PROTOCOL.OPENAI_CHAT]: [TARGET.CODEX, TARGET.OPENCODE],
    [PROTOCOL.GEMINI]: [TARGET.GEMINI, TARGET.OPENCODE],
  }[profile.protocol] || []
  return compatible.includes(target)
}

function assertCodexGatewayProtocol(profile, baseline) {
  const expectedWireApi = profile.protocol === PROTOCOL.OPENAI_RESPONSES
    ? 'responses'
    : profile.protocol === PROTOCOL.OPENAI_CHAT ? 'chat' : undefined
  if (!expectedWireApi || baseline?.wireApi !== expectedWireApi) {
    throw new Error(
      `Codex active provider uses wire_api=${baseline?.wireApi || 'unknown'}; select a compatible ${expectedWireApi || profile.protocol} profile`,
    )
  }
}

function clientContract(profile, target) {
  return JSON.stringify({
    protocol: profile.protocol,
    model: profile.model || '',
    ...(target === TARGET.CLAUDE
      ? { enableToolSearch: Boolean(profile.enableToolSearch) }
      : {}),
  })
}

async function readAdapterSources(adapter) {
  const snapshots = await Promise.all(adapter.paths.map((filePath) => readTextSnapshot(filePath)))
  return {
    snapshots,
    sources: new Map(snapshots.map((snapshot) => [snapshot.path, snapshot.content])),
  }
}

function sanitizedFailure(error, apiKey) {
  const raw = error instanceof Error ? error.message : 'Unknown error'
  const redacted = apiKey ? raw.split(apiKey).join('[redacted]') : raw
  return redacted.slice(0, FAILURE_MESSAGE_LIMIT)
}

function uniquePaths(drafts) {
  const seen = new Set()
  for (const item of drafts) {
    const comparable = path.resolve(item.path).toLowerCase()
    if (seen.has(comparable)) throw new Error(`Multiple adapters target the same file: ${item.path}`)
    seen.add(comparable)
  }
}

function isConfigurationRace(error) {
  const message = error instanceof Error ? error.message : ''
  return message.includes('Configuration no longer matches the last Keydeck write:')
    || message.includes('Configuration changed while preparing the switch:')
    || message.includes('Configuration changed before it could be written:')
}

/**
 * 协调多客户端配置的预检、加密备份、原子写入和安全撤销。
 *
 * 同一进程内所有应用/撤销操作串行执行；每个文件写入前再次比较哈希。任何一步
 * 失败都会恢复已写文件，且公开历史不包含 Key、路径或备份位置。
 */
class ApplyService {
  constructor({
    profileService,
    adapters,
    historyStore,
    backupDirectory,
    vault,
    gatewayService,
    gatewayBaselineStore,
  }) {
    this.profileService = profileService
    this.adapters = adapters
    this.historyStore = historyStore
    this.backupDirectory = backupDirectory
    this.vault = vault
    this.gatewayService = gatewayService
    let fallbackBaselines = defaultGatewayBaselineStore()
    this.gatewayBaselineStore = gatewayBaselineStore || {
      read: async () => fallbackBaselines,
      write: async (value) => {
        fallbackBaselines = GatewayBaselineStoreSchema.parse(value)
        return fallbackBaselines
      },
    }
    this.serial = new SerialExecutor()
  }

  /**
   * 读取可展示的事务历史。
   *
   * @returns {Promise<object[]>} 已移除敏感内部字段的历史记录。
   */
  async listHistory() {
    const data = await this.historyStore.read()
    return data.entries.map(toPublicHistory)
  }

  /**
   * 在应用、启动和停止共用的生命周期锁内执行跨服务连接切换。
   *
   * 回调必须使用传入的 apply，避免重入公开 apply 后等待自身锁。
   *
   * @param {(context: {apply: Function}) => Promise<unknown>} operation 受保护操作。
   * @returns {Promise<unknown>} 回调结果。
   */
  async withLifecycleLock(operation) {
    if (typeof operation !== 'function') throw new Error('Lifecycle operation must be a function')
    return this.serial.run(() => operation({
      apply: (id, targets, options) => this._assignProfileLocked(id, targets, options),
    }))
  }

  /**
   * 从已暂存路由启动网关，并事务性接管对应客户端。
   *
   * @param {{port?: number}} settings 启动参数。
   * @returns {Promise<object>} 网关公开状态。
   */
  async startGateway(settings = {}) {
    if (!this.gatewayService) throw new Error('Local gateway is unavailable')
    return this.serial.run(async () => {
      if (this.gatewayService.getPublicState().status === 'running') {
        return this.gatewayService.getPublicState()
      }
      const groups = this.gatewayService.getRouteGroups()
      if (groups.length === 0) {
        throw new Error('Assign at least one profile before starting the local gateway')
      }
      const entries = []
      for (const group of groups) {
        const connection = await this.profileService.getConnection(group.profileId)
        for (const target of group.targets) {
          this._assertProfileTarget(connection.profile, target)
          entries.push({ ...connection, target })
        }
      }
      const stagedTargets = [...new Set(groups.flatMap((group) => group.targets))]
      await this.gatewayService.start({
        ...(settings.port === undefined ? {} : { port: settings.port }),
        targets: stagedTargets,
      })
      try {
        await this._writeGatewayEntries(entries, { replaceBaselines: true })
        return this.gatewayService.getPublicState()
      } catch (error) {
        if (!error?.rollbackIncomplete) {
          await this.gatewayService.stop({ clearRoutes: false }).catch(() => {})
        }
        throw error
      }
    })
  }

  /**
   * 恢复首次接管前的受管字段，再停止监听。路由分配保留供下次启用。
   *
   * @returns {Promise<object>} 停止后的网关公开状态及跳过的目标 ID。
   */
  async stopGateway() {
    if (!this.gatewayService) throw new Error('Local gateway is unavailable')
    return this.serial.run(async () => {
      const groups = this.gatewayService.getRouteGroups()
      const gatewayState = this.gatewayService.getPublicState()
      const encryptedToken = this.gatewayService.persisted?.encryptedToken
      let localToken = this.gatewayService.localToken
      if (!localToken && encryptedToken) {
        try {
          localToken = this.vault.decrypt(encryptedToken)
        } catch {
          localToken = undefined
        }
      }

      const baselineData = GatewayBaselineStoreSchema.parse(await this.gatewayBaselineStore.read())
      let recovery
      for (let attempt = 0; attempt < GATEWAY_RECOVERY_ATTEMPTS; attempt += 1) {
        recovery = await this._prepareGatewayRecovery({
          groups,
          gatewayState,
          localToken,
          baselineData,
        })
        try {
          await this._commitDrafts(recovery.drafts)
          await this._verifyGatewayRecovery(recovery.verifications)
          break
        } catch (error) {
          recovery = undefined
          if (!isConfigurationRace(error)) throw error
        }
      }
      if (!recovery) {
        const targets = groups.flatMap((group) => group.targets).join(', ')
        throw new Error(`Configuration kept changing while stopping the gateway: ${targets}`)
      }
      const state = await this.gatewayService.stop({ clearRoutes: false })
      const nextBaselines = { ...baselineData.baselines }
      for (const target of recovery.clearedTargets) delete nextBaselines[target]
      await this.gatewayBaselineStore.write({
        version: GATEWAY_BASELINE_VERSION,
        baselines: nextBaselines,
      })
      return {
        ...state,
        skippedTargets: [...new Set(recovery.skippedTargets)],
      }
    })
  }

  async _prepareGatewayRecovery({ groups, gatewayState, localToken, baselineData }) {
    const drafts = []
    const skippedTargets = []
    const clearedTargets = []
    const verifications = []
    for (const group of groups) {
      const profile = await this.profileService.getStored(group.profileId).catch((error) => {
        throw new Error(
          `Cannot stop the local gateway because routed profile ${group.profileId} is unavailable`,
          { cause: error },
        )
      })
      for (const target of group.targets) {
        const adapter = this.adapters[target]
        const localBaseUrl = this._gatewayLocalBaseUrl(gatewayState, target)
        if (!adapter?.gatewayOwnership) {
          throw new Error(`Cannot verify local gateway configuration ownership: ${target}`)
        }
        const current = await readAdapterSources(adapter)
        const storedBaseline = baselineData.baselines[target]
        let baseline
        if (storedBaseline) {
          try {
            baseline = JSON.parse(this.vault.decrypt(storedBaseline.encryptedState))
          } catch (error) {
            throw new Error(`Cannot unlock the pre-gateway baseline for ${target}`, { cause: error })
          }
        }
        const state = await adapter.gatewayOwnership(
          { ...profile, baseUrl: localBaseUrl },
          localToken,
          current.sources,
          { gateway: true, baseline },
        )
        if (state === GATEWAY_OWNERSHIP.CONFLICT) {
          throw new Error(
            `Local gateway configuration conflict for ${target}; it still selects the gateway but managed fields changed`,
          )
        }
        if (state === GATEWAY_OWNERSHIP.RELEASED) {
          skippedTargets.push(target)
          clearedTargets.push(target)
          continue
        }
        if (!storedBaseline) {
          throw new Error(`Cannot restore ${target}: its pre-gateway baseline is unavailable`)
        }
        if (typeof adapter.buildRestore !== 'function') {
          throw new Error(`Cannot restore local gateway configuration ownership: ${target}`)
        }
        drafts.push(...await adapter.buildRestore(baseline, current.sources))
        if (typeof adapter.verifyManagedState === 'function') {
          verifications.push({ target, adapter, baseline })
        }
        clearedTargets.push(target)
      }
    }
    return { drafts, skippedTargets, clearedTargets, verifications }
  }

  _gatewayLocalBaseUrl(gatewayState, target) {
    if (typeof this.gatewayService?.getLocalBaseUrl === 'function') {
      return this.gatewayService.getLocalBaseUrl(target)
    }
    return gatewayState.localBaseUrls?.[target]
      || `http://${gatewayState.host}:${gatewayState.port}/${target}`
  }

  async _verifyGatewayRecovery(verifications) {
    for (const { target, adapter, baseline } of verifications) {
      const current = await readAdapterSources(adapter)
      if (!await adapter.verifyManagedState(baseline, current.sources)) {
        throw new Error(`Cannot verify restored local gateway configuration: ${target}`)
      }
    }
  }

  _assertProfileTarget(profile, target) {
    const adapter = this.adapters[target]
    if (!adapter) throw new Error(`Unsupported client: ${target}`)
    if (!compatibleWithTarget(profile, target)) {
      throw new Error(`${adapter.name} does not support the ${profile.protocol} profile protocol`)
    }
    if (target === TARGET.OPENCODE && !profile.model) {
      throw new Error('OpenCode requires a model ID; detect and select a model first')
    }
  }

  /**
   * 将方案分配给网关。关闭时只暂存；运行时仅在客户端契约变化时写受管字段。
   */
  async assignProfile(rawId, rawTargets, options = {}) {
    return this.serial.run(() => this._assignProfileLocked(rawId, rawTargets, options))
  }

  async _assignProfileLocked(rawId, rawTargets, options = {}) {
    const idResult = IdSchema.safeParse(rawId)
    if (!idResult.success) throw new Error(validationMessage(idResult.error))
    const targetsResult = rawTargets === undefined
      ? { success: true, data: undefined }
      : TargetsSchema.safeParse(rawTargets)
    if (!targetsResult.success) throw new Error(validationMessage(targetsResult.error))

    return this.profileService.withConnectionLock(
      idResult.data,
      options.expectedRevision,
      async ({ profile, apiKey, markApplied }) => {
        const targets = [...new Set(targetsResult.data || profile.targets)]
        if (targets.length === 0) throw new Error('Select at least one client for this gateway route')
        targets.forEach((target) => this._assertProfileTarget(profile, target))

        const before = this.gatewayService.getPublicState()
        const previousProfiles = new Map()
        for (const target of targets) {
          const route = before.routes.find((item) => item.target === target)
          if (!route || route.profileId === profile.id) continue
          try {
            previousProfiles.set(target, await this.profileService.getStored(route.profileId))
          } catch {}
        }
        const writeTargets = []
        if (before.status === 'running') {
          for (const target of targets) {
            const route = before.routes.find((item) => item.target === target)
            const previousProfile = route?.profileId === profile.id
              ? profile
              : previousProfiles.get(target)
            if (!route || !previousProfile
              || clientContract(previousProfile, target) !== clientContract(profile, target)) {
              writeTargets.push(target)
              continue
            }
            const adapter = this.adapters[target]
            const localBaseUrl = this._gatewayLocalBaseUrl(before, target)
            const current = await readAdapterSources(adapter)
            const ownershipState = await adapter.gatewayOwnership(
              { ...previousProfile, baseUrl: localBaseUrl },
              this.gatewayService.localToken,
              current.sources,
              { gateway: true },
            )
            if (ownershipState !== GATEWAY_OWNERSHIP.OWNED) writeTargets.push(target)
          }
        }

        const routeSnapshot = await this.gatewayService.assignRoutes(profile, targets)
        try {
          if (before.status === 'running' && writeTargets.length > 0) {
            await this._writeGatewayEntries(writeTargets.map((target) => {
              const route = before.routes.find((item) => item.target === target)
              const ownershipProfile = route?.profileId === profile.id
                ? profile
                : previousProfiles.get(target)
              return {
                profile,
                apiKey,
                target,
                ...(ownershipProfile ? { ownershipProfile } : {}),
              }
            }))
          }
        } catch (error) {
          await this.gatewayService.restoreRoutes(routeSnapshot).catch(() => {})
          throw error
        }
        await markApplied(new Date().toISOString()).catch(() => {})
        return {
          ok: true,
          assignedTargets: targets,
          gateway: this.gatewayService.getPublicState(),
        }
      },
    )
  }

  async _writeGatewayEntries(entries, _options = {}) {
    if (entries.length === 0) return
    const baselineData = GatewayBaselineStoreSchema.parse(await this.gatewayBaselineStore.read())
    const previousBaselines = { ...baselineData.baselines }
    const nextBaselines = { ...previousBaselines }
    const draftGroups = []

    for (const { profile, apiKey, target, ownershipProfile } of entries) {
      const adapter = this.adapters[target]
      const current = await readAdapterSources(adapter)
      const effective = await this.gatewayService.prepareConnection(profile, apiKey, target)
      const currentManagedState = target === TARGET.CODEX
        ? await adapter.captureManagedState(current.sources)
        : undefined
      if (currentManagedState) assertCodexGatewayProtocol(profile, currentManagedState)
      let trustedBaseline
      if (nextBaselines[target]) {
        try {
          trustedBaseline = JSON.parse(this.vault.decrypt(nextBaselines[target].encryptedState))
        } catch (error) {
          throw new Error(`Cannot unlock the pre-gateway baseline for ${target}`, { cause: error })
        }
      }
      const ownershipContract = ownershipProfile
        ? { ...ownershipProfile, baseUrl: effective.profile.baseUrl }
        : effective.profile
      const currentOwnership = await adapter.gatewayOwnership(
        ownershipContract,
        effective.apiKey,
        current.sources,
        { gateway: true, baseline: trustedBaseline },
      )
      if (target === TARGET.CODEX
        && trustedBaseline
        && currentOwnership === GATEWAY_OWNERSHIP.RELEASED) {
        throw new Error(
          'Codex gateway ownership was released; stop the gateway before taking it over again',
        )
      }
      const shouldCapture = !trustedBaseline
        || (target !== TARGET.CODEX && currentOwnership === GATEWAY_OWNERSHIP.RELEASED)
      if (currentOwnership === GATEWAY_OWNERSHIP.CONFLICT) {
        throw new Error(
          `Local gateway configuration conflict for ${target}; managed fields changed outside Keydeck`,
        )
      }
      if (shouldCapture) {
        if (currentOwnership !== GATEWAY_OWNERSHIP.RELEASED) {
          throw new Error(
            `Cannot capture ${target}: it already selects the gateway and has no trusted pre-gateway baseline`,
          )
        }
        if (typeof adapter.captureManagedState !== 'function') {
          throw new Error(`Cannot capture pre-gateway configuration ownership: ${target}`)
        }
        const managedState = await adapter.captureManagedState(current.sources)
        trustedBaseline = managedState
        nextBaselines[target] = {
          capturedAt: new Date().toISOString(),
          encryptedState: this.vault.encrypt(JSON.stringify(managedState)),
          encryptedBackup: this.vault.encrypt(JSON.stringify({
            files: current.snapshots.map((snapshot) => ({
              path: snapshot.path,
              existed: snapshot.existed,
              content: snapshot.content,
            })),
          })),
        }
      }
      draftGroups.push(await adapter.build(effective.profile, effective.apiKey, {
        gateway: true,
        baseline: trustedBaseline,
        ...(effective.adapterOptions || {}),
      }))
    }

    await this.gatewayBaselineStore.write({
      version: GATEWAY_BASELINE_VERSION,
      baselines: nextBaselines,
    })
    try {
      await this._commitDrafts(draftGroups.flat())
    } catch (error) {
      if (!error?.rollbackIncomplete) {
        await this.gatewayBaselineStore.write({
          version: GATEWAY_BASELINE_VERSION,
          baselines: previousBaselines,
        }).catch(() => {})
      }
      throw error
    }
  }

  async _commitDrafts(drafts) {
    if (drafts.length === 0) return
    uniquePaths(drafts)
    await this.assertUnchanged(drafts)
    const written = []
    try {
      for (const item of drafts) {
        const current = await readTextSnapshot(item.path)
        if (current.existed !== item.before.existed || current.hash !== item.before.hash) {
          throw new Error(`Configuration changed before it could be written: ${item.path}`)
        }
        if (current.hash !== item.afterHash) {
          await atomicWriteText(item.path, item.content)
          written.push(item)
        }
      }
    } catch (error) {
      let rollbackComplete = true
      for (const item of written.reverse()) {
        try {
          await restoreSnapshot(item.before)
        } catch {
          rollbackComplete = false
        }
      }
      if (!rollbackComplete) {
        const incomplete = new Error(
          'Gateway configuration write failed and rollback was incomplete; the local gateway was kept running for recovery',
        )
        incomplete.rollbackIncomplete = true
        throw incomplete
      }
      throw error
    }
  }

  /**
   * 从同一组文件快照判定 ownership 并生成带预期哈希的直连事务。若用户恰好在
   * 判定后修改配置，重新读取并判定；无法稳定取得快照时保留网关监听器。
   *
   * @param {object} input 单目标恢复上下文。
   * @returns {Promise<boolean>} 已恢复为直连时为 true，用户已切走时为 false。
   */
  async _restoreGatewayTarget({ profile, target, adapter, localBaseUrl, localToken }) {
    for (let attempt = 0; attempt < GATEWAY_RECOVERY_ATTEMPTS; attempt += 1) {
      const snapshots = await Promise.all(adapter.paths.map((filePath) => readTextSnapshot(filePath)))
      const sources = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot.content]))
      const state = await adapter.gatewayOwnership(
        { ...profile, baseUrl: localBaseUrl },
        localToken,
        sources,
        { gateway: true },
      )
      if (state === GATEWAY_OWNERSHIP.RELEASED) return false
      if (state === GATEWAY_OWNERSHIP.CONFLICT) {
        throw new Error(
          `Local gateway configuration conflict for ${target}; it still selects the gateway but managed fields changed`,
        )
      }

      const expectedHashes = Object.fromEntries(snapshots.map((snapshot) => [
        path.resolve(snapshot.path).toLowerCase(),
        snapshot.hash,
      ]))
      try {
        await this._applyLocked(profile.id, [target], {
          bypassGateway: true,
          expectedHashes,
        })
        return true
      } catch (error) {
        if (!isConfigurationRace(error)) throw error
      }
    }
    throw new Error(`Configuration kept changing while stopping the gateway: ${target}`)
  }

  async _gatewayOwnership({ profile, adapter, localBaseUrl, localToken }) {
    const snapshots = await Promise.all(adapter.paths.map((filePath) => readTextSnapshot(filePath)))
    const sources = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot.content]))
    return adapter.gatewayOwnership(
      { ...profile, baseUrl: localBaseUrl },
      localToken,
      sources,
      { gateway: true },
    )
  }

  /**
   * 新增或更新内部历史，并限制记录数量。
   *
   * 超过数量上限的记录会在存储成功后清理受控目录中的备份。
   *
   * @param {object} entry 已通过内部结构构造的事务记录。
   * @returns {Promise<void>} 持久化完成后的 Promise。
   */
  async saveHistory(entry) {
    const data = await this.historyStore.read()
    const index = data.entries.findIndex((item) => item.id === entry.id)
    if (index >= 0) data.entries[index] = entry
    else data.entries.unshift(entry)
    const removed = data.entries.slice(HISTORY_LIMIT)
    data.entries = data.entries.slice(0, HISTORY_LIMIT)
    await this.historyStore.write(data)

    const backupRoot = `${path.resolve(this.backupDirectory)}${path.sep}`.toLowerCase()
    await Promise.all(removed.map(async (item) => {
      const backupFile = path.resolve(item.backupFile)
      if (!backupFile.toLowerCase().startsWith(backupRoot)) return
      await fs.rm(backupFile, { force: true }).catch(() => {})
    }))
  }

  /**
   * 将被本次成功写入覆盖的旧记录标为不可撤销。
   *
   * 该整理发生在配置、历史和最近写入时间均成功持久化之后；整理失败不会反向
   * 回滚已经完成的配置事务，旧记录仍会由撤销时的哈希校验保护。
   *
   * @param {string} currentId 当前旧版事务 UUID。
   * @param {string[]} writtenPaths 当前写入的绝对路径。
   * @returns {Promise<void>} 历史状态整理完成后的 Promise。
   */
  async supersedeOlderHistory(currentId, writtenPaths) {
    const replaced = new Set(writtenPaths.map((filePath) => path.resolve(filePath).toLowerCase()))
    if (replaced.size === 0) return

    const data = await this.historyStore.read()
    let changed = false
    data.entries = data.entries.map((item) => {
      const overlaps = item.id !== currentId
        && item.status === 'applied'
        && item.changes.some((change) => replaced.has(path.resolve(change.path).toLowerCase()))
      if (!overlaps) return item
      changed = true
      return { ...item, status: 'superseded' }
    })
    if (changed) await this.historyStore.write(data)
  }

  /**
   * 在真正写入前确认草稿基于最新文件生成。
   *
   * @param {object[]} drafts 适配器生成的文件草稿。
   * @returns {Promise<void>} 所有文件未变化时完成。
   * @throws 任一文件存在状态或哈希变化时拒绝覆盖。
   */
  async assertUnchanged(drafts) {
    for (const item of drafts) {
      const current = await readTextSnapshot(item.path)
      if (current.existed !== item.before.existed || current.hash !== item.before.hash) {
        throw new Error(`Configuration changed while preparing the switch: ${item.path}`)
      }
    }
  }

  /**
   * 找出仍与最近成功写入哈希完全一致的方案目标。
   *
   * 自动切换只使用该结果，避免仅凭 URL/模型误认外部配置或同地址的另一把 Key。
   * 任一关联文件被外部修改后，该历史对应的全部目标都不会进入自动写入范围。
   *
   * @param {string} rawProfileId 方案 UUID。
   * @returns {Promise<{targets: string[], hashes: Record<string, string>}>} 已验证目标和规范化路径哈希。
   */
  async getVerifiedWriteState(rawProfileId) {
    const idResult = IdSchema.safeParse(rawProfileId)
    if (!idResult.success) throw new Error(validationMessage(idResult.error))
    const [data, profile] = await Promise.all([
      this.historyStore.read(),
      this.profileService.getStored(idResult.data),
    ])
    const targets = new Set()
    const hashes = {}

    for (const entry of data.entries) {
      if (entry.profileId !== idResult.data
        || entry.status !== 'applied'
        || entry.appliedConnectionRevision !== profile.connectionRevision) continue
      let verified = true
      for (const change of entry.changes) {
        const current = await readTextSnapshot(change.path)
        if (!current.existed || current.hash !== change.afterHash) {
          verified = false
          break
        }
      }
      if (verified) {
        entry.targets.forEach((target) => targets.add(target))
        entry.changes.forEach((change) => {
          const key = path.resolve(change.path).toLowerCase()
          if (!hashes[key]) hashes[key] = change.afterHash
        })
      }
    }
    return { targets: [...targets], hashes }
  }

  /**
   * 返回仍与最近写入哈希一致的方案目标。
   *
   * @param {string} rawProfileId 方案 UUID。
   * @returns {Promise<string[]>} 当前仍可证明由该方案写入的目标 ID。
   */
  async listVerifiedTargets(rawProfileId) {
    return (await this.getVerifiedWriteState(rawProfileId)).targets
  }

  /**
   * 将方案事务性写入指定客户端。
   *
   * @param {string} rawId 方案 UUID。
   * @param {string[] | undefined} rawTargets 可选目标；缺失时使用方案全部目标。
   * @param {{source?: 'manual' | 'auto', expectedRevision?: number, expectedHashes?: Record<string, string>, shouldContinue?: () => boolean, bypassGateway?: boolean}} options 内部写入来源、决策 revision、文件哈希证明和取消检查；IPC 不直接透传。
   * @returns {Promise<object>} 公开历史摘要。
   * @throws 输入无效、配置无法解析、并发修改、写入失败或回滚不完整时抛出错误。
   */
  async apply(rawId, rawTargets, options = {}) {
    return this.serial.run(() => this._applyLocked(rawId, rawTargets, options))
  }

  async _applyLocked(rawId, rawTargets, options = {}) {
    const idResult = IdSchema.safeParse(rawId)
    if (!idResult.success) throw new Error(validationMessage(idResult.error))
    const targetsResult = rawTargets === undefined
      ? { success: true, data: undefined }
      : TargetsSchema.safeParse(rawTargets)
    if (!targetsResult.success) throw new Error(validationMessage(targetsResult.error))
    const sourceResult = ApplySourceSchema.safeParse(options.source || 'manual')
    if (!sourceResult.success) throw new Error(validationMessage(sourceResult.error))
    const revisionResult = options.expectedRevision === undefined
      ? { success: true, data: undefined }
      : ConnectionRevisionSchema.safeParse(options.expectedRevision)
    if (!revisionResult.success) throw new Error(validationMessage(revisionResult.error))
    const hashesResult = options.expectedHashes === undefined
      ? { success: true, data: undefined }
      : ExpectedHashesSchema.safeParse(options.expectedHashes)
    if (!hashesResult.success) throw new Error(validationMessage(hashesResult.error))
    if (options.shouldContinue !== undefined && typeof options.shouldContinue !== 'function') {
      throw new Error('Apply continuation check must be a function')
    }
    if (options.bypassGateway !== undefined && typeof options.bypassGateway !== 'boolean') {
      throw new Error('Gateway bypass flag must be a boolean')
    }
    const ensureContinue = () => {
      if (options.shouldContinue && !options.shouldContinue()) {
        throw new Error('Automatic configuration write was stopped')
      }
    }

    return this.profileService.withConnectionLock(
      idResult.data,
      revisionResult.data,
      async ({ profile, apiKey, markApplied }) => {
        ensureContinue()
        const targets = [...new Set(targetsResult.data || profile.targets)]
        if (targets.length === 0) throw new Error('Select at least one client to apply this profile')
        if (targets.includes(TARGET.OPENCODE) && !profile.model) {
          throw new Error('OpenCode requires a model ID; detect and select a model first')
        }
        const gatewayTargets = options.bypassGateway || !this.gatewayService
          ? []
          : targets.filter((target) => this.gatewayService.isTargetEnabled(target))

        let draftGroups
        try {
          draftGroups = await Promise.all(targets.map(async (target) => {
            const adapter = this.adapters[target]
            if (!adapter) throw new Error(`Unsupported client: ${target}`)
            if (!gatewayTargets.includes(target)) return adapter.build(profile, apiKey)
            const effective = await this.gatewayService.prepareConnection(profile, apiKey, target)
            return adapter.build(effective.profile, effective.apiKey, {
              gateway: true,
              ...(effective.adapterOptions || {}),
            })
          }))
        } catch (error) {
          throw new Error(sanitizedFailure(error, apiKey))
        }
        ensureContinue()
        const drafts = draftGroups.flat()
        uniquePaths(drafts)
        if (hashesResult.data) {
          for (const item of drafts) {
            const expectedHash = hashesResult.data[path.resolve(item.path).toLowerCase()]
            if (!expectedHash || item.before.hash !== expectedHash) {
              throw new Error(`Configuration no longer matches the last Keydeck write: ${item.path}`)
            }
          }
        }
        await this.assertUnchanged(drafts)
        ensureContinue()

        const id = crypto.randomUUID()
        const createdAt = new Date().toISOString()
        const backupFile = path.join(this.backupDirectory, `${id}.json`)
        const backup = BackupFileSchema.parse({
          version: 1,
          id,
          createdAt,
          files: drafts.map((item) => ({
            path: item.path,
            existed: item.before.existed,
            encryptedContent: this.vault.encrypt(item.before.content),
          })),
        })
        await atomicWriteText(backupFile, `${JSON.stringify(backup, null, 2)}\n`)

        const history = {
          id,
          profileId: profile.id,
          profileName: profile.name,
          appliedConnectionRevision: profile.connectionRevision,
          targets,
          createdAt,
          status: 'applied',
          source: sourceResult.data,
          connectionMode: gatewayTargets.length > 0 ? 'gateway' : 'direct',
          changes: drafts.map((item) => ({
            target: item.target,
            path: item.path,
            existed: item.before.existed,
            beforeHash: item.before.hash,
            afterHash: item.afterHash,
          })),
          backupFile,
        }

        const written = []
        let previousRoutes
        let routesActivated = false
        try {
          if (gatewayTargets.length > 0) {
            previousRoutes = await this.gatewayService.activateRoutes(profile, gatewayTargets)
            routesActivated = true
          }
          for (const item of drafts) {
            ensureContinue()
            const current = await readTextSnapshot(item.path)
            if (current.existed !== item.before.existed || current.hash !== item.before.hash) {
              throw new Error(`Configuration changed before it could be written: ${item.path}`)
            }
            ensureContinue()
            if (current.hash !== item.afterHash) {
              await atomicWriteText(item.path, item.content)
              written.push(item)
            }
          }
          ensureContinue()
          await this.saveHistory(history)
          await markApplied(createdAt)
        } catch (error) {
          let rollbackComplete = true
          if (routesActivated) {
            try {
              await this.gatewayService.restoreRoutes(previousRoutes)
            } catch {
              rollbackComplete = false
            }
          }
          for (const item of written.reverse()) {
            try {
              await restoreSnapshot(item.before)
            } catch {
              rollbackComplete = false
            }
          }
          history.status = rollbackComplete ? 'rolled-back' : 'failed'
          history.failureMessage = sanitizedFailure(error, apiKey)
          await this.saveHistory(history).catch(() => {})
          if (!rollbackComplete) {
            throw new Error('Apply failed and automatic rollback was incomplete')
          }
          throw new Error(`Apply failed: ${history.failureMessage}`)
        }

        await this.supersedeOlderHistory(
          history.id,
          drafts.map((item) => item.path),
        ).catch(() => {})

        return { ok: true, history: toPublicHistory(history) }
      },
    )
  }

  /**
   * 使用 DPAPI 加密快照撤销一次仍未被外部修改的写入。
   *
   * @param {string} rawId 历史记录 UUID。
   * @returns {Promise<object>} 更新后的公开历史摘要。
   * @throws 快照缺失、当前文件已变化或恢复失败时抛出错误。
   */
  async undo(rawId) {
    const idResult = IdSchema.safeParse(rawId)
    if (!idResult.success) throw new Error(validationMessage(idResult.error))

    return this.serial.run(async () => {
      const historyData = await this.historyStore.read()
      const index = historyData.entries.findIndex((entry) => entry.id === idResult.data)
      if (index === -1) throw new Error('History entry not found')
      const history = historyData.entries[index]
      if (history.status !== 'applied') throw new Error('Only an applied history entry can be undone')
      if (history.connectionMode === 'gateway') {
        throw new Error('Stop the local gateway to restore a direct connection')
      }

      let backup
      try {
        backup = BackupFileSchema.parse(JSON.parse(await fs.readFile(history.backupFile, 'utf8')))
      } catch {
        throw new Error('The encrypted rollback backup is missing or invalid')
      }
      if (backup.id !== history.id) throw new Error('Rollback backup does not match this history entry')
      if (
        backup.files.length !== history.changes.length
        || backup.files.some((file, fileIndex) => (
          path.resolve(file.path).toLowerCase()
            !== path.resolve(history.changes[fileIndex].path).toLowerCase()
          || file.existed !== history.changes[fileIndex].existed
        ))
      ) {
        throw new Error('Rollback backup file list does not match this history entry')
      }

      const currentSnapshots = []
      for (const change of history.changes) {
        const current = await readTextSnapshot(change.path)
        if (!current.existed || current.hash !== change.afterHash) {
          throw new Error(`Configuration changed after this switch and cannot be safely undone: ${change.path}`)
        }
        currentSnapshots.push(current)
      }

      const originals = backup.files.map((file) => ({
        path: file.path,
        existed: file.existed,
        content: this.vault.decrypt(file.encryptedContent),
      }))

      const restored = []
      try {
        for (const original of originals) {
          await restoreSnapshot(original)
          restored.push(original)
        }
        history.status = 'undone'
        history.undoneAt = new Date().toISOString()
        historyData.entries[index] = history
        await this.historyStore.write(historyData)
      } catch {
        let rollbackComplete = true
        for (let i = restored.length - 1; i >= 0; i -= 1) {
          try {
            await restoreSnapshot(currentSnapshots[i])
          } catch {
            rollbackComplete = false
          }
        }
        if (!rollbackComplete) {
          throw new Error('Undo failed and restoration of the applied state was incomplete')
        }
        throw new Error('Undo failed; the applied state was restored')
      }

      return { ok: true, history: toPublicHistory(history) }
    })
  }
}

module.exports = {
  ApplyService,
  GatewayBaselineStoreSchema,
  defaultGatewayBaselineStore,
}
