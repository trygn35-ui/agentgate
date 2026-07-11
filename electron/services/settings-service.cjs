const { z } = require('zod')
const { SerialExecutor } = require('./storage.cjs')

const THEME_VALUES = ['system', 'light', 'dark']

const SettingsSchema = z.object({
  version: z.literal(1),
  launchAtLogin: z.boolean(),
  closeToTray: z.boolean(),
  startGatewayOnLaunch: z.boolean(),
  theme: z.enum(THEME_VALUES),
  experimentalToolBridge: z.boolean(),
})

const SettingsPatchSchema = SettingsSchema.omit({ version: true }).partial().strict()

function defaultSettings() {
  return {
    version: 1,
    launchAtLogin: false,
    closeToTray: true,
    startGatewayOnLaunch: true,
    theme: 'system',
    experimentalToolBridge: false,
  }
}

class SettingsService {
  constructor({ store, app, onChanged, executablePath } = {}) {
    if (!store || !app) throw new Error('SettingsService requires store and app')
    this.store = store
    this.app = app
    this.onChanged = onChanged
    this.executablePath = executablePath
      || process.env.PORTABLE_EXECUTABLE_FILE
      || process.execPath
    this.serial = new SerialExecutor()
    this.loaded = false
    this.settings = defaultSettings()
  }

  async initialize() {
    return this.serial.run(async () => {
      if (!this.loaded) {
        this.settings = SettingsSchema.parse(await this.store.read())
        this.loaded = true
      }
      this._applyLaunchAtLogin(this.settings.launchAtLogin)
      return this.getPublicSettings()
    })
  }

  getPublicSettings() {
    return { ...this.settings }
  }

  async update(patch) {
    const parsed = SettingsPatchSchema.parse(patch)
    return this.serial.run(async () => {
      if (!this.loaded) {
        this.settings = SettingsSchema.parse(await this.store.read())
        this.loaded = true
      }
      const previous = this.settings
      const next = SettingsSchema.parse({ ...previous, ...parsed, version: 1 })
      if (next.launchAtLogin !== previous.launchAtLogin) {
        this._applyLaunchAtLogin(next.launchAtLogin)
      }
      try {
        this.settings = await this.store.write(next)
      } catch (error) {
        if (next.launchAtLogin !== previous.launchAtLogin) {
          this._applyLaunchAtLogin(previous.launchAtLogin)
        }
        throw error
      }
      if (typeof this.onChanged === 'function') await this.onChanged(this.getPublicSettings())
      return this.getPublicSettings()
    })
  }

  _applyLaunchAtLogin(enabled) {
    this.app.setLoginItemSettings({
      openAtLogin: enabled,
      path: this.executablePath,
      args: [],
    })
  }
}

module.exports = {
  SettingsSchema,
  SettingsPatchSchema,
  defaultSettings,
  SettingsService,
}
