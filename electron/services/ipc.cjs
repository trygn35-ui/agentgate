const { z } = require('zod')
const { SaveProfileSchema, validationMessage } = require('./schemas.cjs')

const CHANNELS = Object.freeze({
  bootstrap: 'keydeck:get-bootstrap',
  saveProfile: 'keydeck:save-profile',
  duplicateProfile: 'keydeck:duplicate-profile',
  reorderProfiles: 'keydeck:reorder-profiles',
  deleteProfile: 'keydeck:delete-profile',
  copyProfileKey: 'keydeck:copy-profile-key',
  testProfile: 'keydeck:test-profile',
  checkProfileHealth: 'keydeck:check-profile-health',
  probeProfile: 'keydeck:probe-profile',
  applyProfile: 'keydeck:apply-profile',
  undoHistory: 'keydeck:undo-history',
  openConfig: 'keydeck:open-config',
  startGateway: 'keydeck:start-gateway',
  stopGateway: 'keydeck:stop-gateway',
  updateSettings: 'keydeck:update-settings',
  stateChanged: 'keydeck:state-changed',
})

const GatewayStartSchema = z.object({
  port: z.number().int().min(1024).max(65535).optional(),
})

function changedRoutedConfigFields(existing, input) {
  const changed = []
  if (existing.protocol !== input.protocol) changed.push('protocol')
  return changed
}

function routedProfileChangeError(fields) {
  return new Error(
    `This profile is used by the local gateway. Switch its route or stop the gateway before changing: ${fields.join(', ')}`,
  )
}

/**
 * 注册渲染进程允许调用的全部 IPC 命令。
 *
 * 参数在 Service 层再次校验；列表和历史不会返回 Key，复制操作直接写系统剪贴板。
 *
 * @param {object} dependencies Electron 能力和已构建服务。
 * @returns {void} 注册完成后无返回值。
 */
function registerIpcHandlers({
  ipcMain,
  clipboard,
  profileService,
  clientService,
  healthService,
  applyService,
  gatewayService,
  settingsService,
}) {
  const getBootstrap = async () => {
    const [profiles, history] = await Promise.all([
      profileService.list(),
      applyService.listHistory(),
    ])
    const scannedClients = await clientService.scan(profiles)
    const activeProfileIds = [...new Set(
      scannedClients.map((client) => client.activeProfileId).filter(Boolean),
    )]
    const verifiedEntries = await Promise.all(activeProfileIds.map(async (profileId) => [
      profileId,
      await applyService.listVerifiedTargets(profileId),
    ]))
    const verifiedTargets = new Map(verifiedEntries)
    const clients = scannedClients.map((client) => {
      if (!client.activeProfileId || client.drifted || client.viaGateway) return client
      const verified = verifiedTargets.get(client.activeProfileId)?.includes(client.target)
      return verified ? client : {
        ...client,
        drifted: true,
        warning: 'Configuration no longer matches the last Keydeck write',
      }
    })
    const rawGateway = gatewayService.getPublicState()
    const gateway = {
      status: rawGateway.status,
      host: rawGateway.host,
      port: rawGateway.port,
      targets: rawGateway.targets,
      routes: rawGateway.routes.map((route) => {
        const profile = profiles.find((item) => item.id === route.profileId)
        return {
          ...route,
          profileName: profile?.name || 'Missing profile',
          protocol: profile?.protocol || 'openai-responses',
          activatedAt: rawGateway.startedAt || profile?.updatedAt || new Date(0).toISOString(),
        }
      }),
      ...(rawGateway.startedAt ? { startedAt: rawGateway.startedAt } : {}),
      ...(rawGateway.error ? { error: rawGateway.error } : {}),
    }
    return {
      profiles,
      clients,
      history,
      gateway,
      ...(settingsService ? { settings: settingsService.getPublicSettings() } : {}),
      ...(gatewayService.getActiveRequests ? { activeRequests: gatewayService.getActiveRequests() } : {}),
    }
  }

  ipcMain.handle(CHANNELS.bootstrap, getBootstrap)

  ipcMain.handle(CHANNELS.saveProfile, async (_event, input) => {
    const parsed = SaveProfileSchema.safeParse(input)
    if (!parsed.success) throw new Error(validationMessage(parsed.error))
    const nextProfile = parsed.data
    return applyService.withLifecycleLock(async () => {
      const gatewayState = gatewayService.getPublicState()
      const routedTargets = (gatewayState.status === 'running' ? gatewayState.routes : [])
        .filter((route) => route.profileId === nextProfile.id)
        .map((route) => route.target)
      if (routedTargets.length > 0) {
        const existing = (await profileService.list())
          .find((profile) => profile.id === nextProfile.id)
        if (existing) {
          const changedFields = changedRoutedConfigFields(existing, nextProfile)
          if (changedFields.length > 0) throw routedProfileChangeError(changedFields)
        }
      }
      const saved = await profileService.save(nextProfile)
      await gatewayService.refreshProfile(saved.id)
      return saved
    })
  })
  ipcMain.handle(CHANNELS.duplicateProfile, (_event, id) => profileService.duplicate(id))
  ipcMain.handle(CHANNELS.reorderProfiles, (_event, ids) => profileService.reorder(ids))
  ipcMain.handle(CHANNELS.deleteProfile, (_event, id) => {
    return applyService.withLifecycleLock(async () => {
      const gatewayState = gatewayService.getPublicState()
      const routedTargets = gatewayState.routes
        .filter((route) => route.profileId === id)
        .map((route) => route.target)
      if (routedTargets.length === 0) return profileService.delete(id)
      if (gatewayState.status !== 'stopped') {
        throw new Error('Switch this gateway route or turn off the local gateway before deleting the profile')
      }
      const routeSnapshot = await gatewayService.unassignRoutes(routedTargets)
      try {
        return await profileService.delete(id)
      } catch (error) {
        await gatewayService.restoreRoutes(routeSnapshot).catch(() => {})
        throw error
      }
    })
  })
  ipcMain.handle(CHANNELS.copyProfileKey, async (_event, id) => {
    const apiKey = await profileService.getSecret(id)
    clipboard.writeText(apiKey)
    return { ok: true }
  })
  ipcMain.handle(CHANNELS.testProfile, async (_event, id) => {
    return healthService.test(id)
  })
  ipcMain.handle(CHANNELS.checkProfileHealth, async (_event, id) => {
    return healthService.testHealth(id)
  })
  ipcMain.handle(CHANNELS.probeProfile, async (_event, id) => {
    return healthService.probeProfile(id)
  })
  ipcMain.handle(CHANNELS.applyProfile, async (_event, id, targets) => {
    const result = await applyService.assignProfile(id, targets)
    const profiles = await profileService.list()
    const clients = await clientService.scan(profiles)
    const profile = profiles.find((item) => item.id === id)
    if (!profile) throw new Error('Applied profile no longer exists')
    return {
      profile,
      clients,
      gateway: {
        ...result.gateway,
        routes: result.gateway.routes.map((route) => {
          const routedProfile = profiles.find((item) => item.id === route.profileId)
          return {
            ...route,
            profileName: routedProfile?.name || 'Missing profile',
            protocol: routedProfile?.protocol || 'openai-responses',
            activatedAt: routedProfile?.updatedAt || new Date(0).toISOString(),
          }
        }),
      },
      assignedTargets: result.assignedTargets,
      ...(result.history ? { historyEntry: result.history } : {}),
    }
  })
  ipcMain.handle(CHANNELS.undoHistory, async (_event, id) => {
    await applyService.undo(id)
    return getBootstrap()
  })
  ipcMain.handle(CHANNELS.openConfig, (_event, target) => clientService.openConfig(target))
  ipcMain.handle(CHANNELS.startGateway, async (_event, rawSettings) => {
    const result = GatewayStartSchema.safeParse(rawSettings)
    if (!result.success) throw new Error(validationMessage(result.error))
    await applyService.startGateway(result.data)
    return getBootstrap()
  })
  ipcMain.handle(CHANNELS.stopGateway, async () => {
    const recovery = await applyService.stopGateway()
    return {
      ...await getBootstrap(),
      gatewayRecovery: {
        skippedTargets: recovery.skippedTargets || [],
      },
    }
  })
  ipcMain.handle(CHANNELS.updateSettings, async (_event, patch) => {
    if (!settingsService) throw new Error('Application settings are unavailable')
    return settingsService.update(patch)
  })
}

module.exports = {
  CHANNELS,
  registerIpcHandlers,
}
