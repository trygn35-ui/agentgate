import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  defaultSettings,
  SettingsSchema,
  SettingsService,
} = require('../electron/services/settings-service.cjs')

function memoryStore(initial = defaultSettings()) {
  let value = structuredClone(initial)
  return {
    read: vi.fn(async () => structuredClone(value)),
    write: vi.fn(async (next) => {
      value = SettingsSchema.parse(structuredClone(next))
      return structuredClone(value)
    }),
  }
}

describe('SettingsService', () => {
  it('默认关闭开机自启和实验协议桥，保留托盘与网关恢复', async () => {
    const app = { setLoginItemSettings: vi.fn() }
    const service = new SettingsService({ store: memoryStore(), app, executablePath: 'D:\\Keydeck.exe' })

    await expect(service.initialize()).resolves.toEqual({
      version: 1,
      launchAtLogin: false,
      closeToTray: true,
      startGatewayOnLaunch: true,
      theme: 'system',
      experimentalToolBridge: false,
    })
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      path: 'D:\\Keydeck.exe',
      args: [],
    })
  })

  it('原子保存局部设置并同步 Windows 登录项', async () => {
    const store = memoryStore()
    const app = { setLoginItemSettings: vi.fn() }
    const onChanged = vi.fn()
    const service = new SettingsService({
      store,
      app,
      onChanged,
      executablePath: 'D:\\Keydeck.exe',
    })
    await service.initialize()

    const result = await service.update({
      launchAtLogin: true,
      theme: 'dark',
      experimentalToolBridge: true,
    })

    expect(result).toMatchObject({
      launchAtLogin: true,
      closeToTray: true,
      theme: 'dark',
      experimentalToolBridge: true,
    })
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({
      openAtLogin: true,
      path: 'D:\\Keydeck.exe',
      args: [],
    })
    expect(onChanged).toHaveBeenCalledWith(result)
  })

  it('拒绝未知字段，持久化失败时恢复登录项', async () => {
    const store = memoryStore()
    const app = { setLoginItemSettings: vi.fn() }
    const service = new SettingsService({ store, app, executablePath: 'D:\\Keydeck.exe' })
    await service.initialize()

    await expect(service.update({ hiddenOption: true })).rejects.toBeDefined()
    store.write.mockRejectedValueOnce(new Error('disk full'))
    await expect(service.update({ launchAtLogin: true })).rejects.toThrow('disk full')
    expect(app.setLoginItemSettings.mock.calls.slice(-2)).toEqual([
      [{ openAtLogin: true, path: 'D:\\Keydeck.exe', args: [] }],
      [{ openAtLogin: false, path: 'D:\\Keydeck.exe', args: [] }],
    ])
  })
})
