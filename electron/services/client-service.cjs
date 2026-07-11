const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { TargetSchema, validationMessage } = require('./schemas.cjs')

const execFileAsync = promisify(execFile)
const COMMAND_LOOKUP_TIMEOUT_MS = 3_000

async function commandExists(command) {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('where.exe', [command], {
        windowsHide: true,
        timeout: COMMAND_LOOKUP_TIMEOUT_MS,
      })
    } else {
      await execFileAsync('which', [command], { timeout: COMMAND_LOOKUP_TIMEOUT_MS })
    }
    return true
  } catch {
    return false
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function sameBaseUrl(left, right) {
  if (!left || !right) return false
  try {
    const normalize = (value) => {
      const url = new URL(value)
      url.pathname = url.pathname.replace(/\/+$/, '')
      url.hash = ''
      return url.toString()
    }
    return normalize(left) === normalize(right)
  } catch {
    return left.replace(/\/+$/, '') === right.replace(/\/+$/, '')
  }
}

function appliedAtTimestamp(profile) {
  const timestamp = Date.parse(profile.lastAppliedAt || '')
  return Number.isFinite(timestamp) ? timestamp : 0
}

/**
 * 扫描客户端原生配置，并提供只读的配置位置打开能力。
 */
class ClientService {
  constructor(adapters, electronShell, gatewayService) {
    this.adapters = adapters
    this.shell = electronShell
    this.gatewayService = gatewayService
  }

  /**
   * 解析客户端配置并与 Keydeck 方案匹配。
   *
   * 扫描只返回端点、模型和结构状态，不读取或返回 Key。文件存在但命令不在 PATH
   * 时仍视为已安装，避免便携版客户端被误判。
   *
   * @param {object[]} profiles 公开方案列表。
   * @returns {Promise<object[]>} 四个客户端的状态。
   */
  async scan(profiles = []) {
    return Promise.all(Object.values(this.adapters).map(async (adapter) => {
      const sources = new Map()
      const files = await Promise.all(adapter.paths.map(async (filePath) => {
        const exists = await fileExists(filePath)
        if (exists) sources.set(filePath, await fs.readFile(filePath, 'utf8'))
        return { path: filePath, exists }
      }))
      let valid = true
      let error

      for (const file of files) {
        if (!file.exists) continue
        try {
          adapter.validate(sources.get(file.path), file.path)
        } catch (validationError) {
          valid = false
          error = validationError.message
          break
        }
      }

      let inspection = {}
      if (valid) {
        try {
          inspection = adapter.inspect(sources)
        } catch (inspectionError) {
          valid = false
          error = inspectionError.message
        }
      }
      const gatewayRoute = inspection.baseUrl
        && this.gatewayService?.matchesLocalBase(inspection.baseUrl, adapter.id)
        ? this.gatewayService.getPublicState().routes.find((route) => route.target === adapter.id)
        : undefined
      const routedProfile = gatewayRoute
        ? profiles.find((profile) => profile.id === gatewayRoute.profileId)
        : undefined
      const matchingProfiles = !routedProfile && inspection.baseUrl
        ? profiles.filter((profile) => (
          Boolean(profile.lastAppliedAt)
          && profile.targets.includes(adapter.id)
          && (profile.endpoints || [{ url: profile.baseUrl }])
            .some((endpoint) => sameBaseUrl(endpoint.url, inspection.baseUrl))
          && (!profile.model || !inspection.model || profile.model === inspection.model)
        ))
        : []
      const activeProfile = routedProfile || matchingProfiles.sort((left, right) => (
        appliedAtTimestamp(right) - appliedAtTimestamp(left)
      ))[0]

      return {
        target: adapter.id,
        label: adapter.name,
        path: adapter.primaryPath,
        installed: files.some((file) => file.exists) || await commandExists(adapter.command),
        ...(activeProfile ? {
          activeProfileId: activeProfile.id,
          activeProfileName: activeProfile.name,
          ...(routedProfile ? { viaGateway: true } : {}),
        } : inspection.baseUrl ? { activeProfileName: 'External configuration' } : {}),
        ...(inspection.baseUrl ? { baseUrl: inspection.baseUrl } : {}),
        ...(valid ? {} : { drifted: true, warning: error || 'Configuration is invalid' }),
      }
    }))
  }

  /**
   * 在资源管理器中定位客户端配置或最近存在的父目录。
   *
   * @param {string} rawTarget 未信任的客户端 ID。
   * @returns {Promise<object>} 实际打开的路径。
   * @throws 目标无效或系统无法打开路径时抛出错误。
   */
  async openConfig(rawTarget) {
    const result = TargetSchema.safeParse(rawTarget)
    if (!result.success) throw new Error(validationMessage(result.error))
    const adapter = this.adapters[result.data]
    const filePath = adapter.primaryPath

    if (await fileExists(filePath)) {
      this.shell.showItemInFolder(filePath)
      return { ok: true, path: filePath }
    }

    let directory = path.dirname(filePath)
    while (!(await fileExists(directory))) {
      const parent = path.dirname(directory)
      if (parent === directory) throw new Error('Configuration directory does not exist')
      directory = parent
    }
    const error = await this.shell.openPath(directory)
    if (error) throw new Error('Could not open the configuration directory')
    return { ok: true, path: directory }
  }
}

module.exports = {
  ClientService,
}
