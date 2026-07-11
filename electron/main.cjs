const path = require('node:path')
const { z } = require('zod')
const {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  shell,
  Tray,
} = require('electron')
const {
  ProfileStoreSchema,
  HistoryStoreSchema,
} = require('./services/schemas.cjs')
const { JsonFileStore, Vault } = require('./services/storage.cjs')
const { resolveClientPaths } = require('./services/paths.cjs')
const { createAdapters } = require('./services/adapters.cjs')
const { ProfileService } = require('./services/profile-service.cjs')
const { ClientService } = require('./services/client-service.cjs')
const { HealthService } = require('./services/health-service.cjs')
const { AutoSwitchService } = require('./services/auto-switch-service.cjs')
const {
  RequestLogStoreSchema,
  RequestMonitorService,
} = require('./services/request-monitor-service.cjs')
const {
  SettingsSchema,
  defaultSettings,
  SettingsService,
} = require('./services/settings-service.cjs')
const {
  ApplyService,
  GatewayBaselineStoreSchema,
  defaultGatewayBaselineStore,
} = require('./services/apply-service.cjs')
const {
  GatewayService,
  GatewayStoreSchema,
  defaultGatewayStore,
} = require('./services/gateway-service.cjs')
const { CHANNELS, registerIpcHandlers } = require('./services/ipc.cjs')

const APP_NAME = 'Keydeck'
const APP_DISPLAY_NAME = 'Key Core'
const APP_USER_MODEL_ID = 'dev.keydeck.desktop'
const DATA_DIRECTORY_NAME = 'data'
const PROFILE_STORE_FILE = 'profiles.json'
const HISTORY_STORE_FILE = 'history.json'
const GATEWAY_STORE_FILE = 'gateway.json'
const GATEWAY_BASELINE_STORE_FILE = 'gateway-recovery.json'
const SETTINGS_STORE_FILE = 'settings.json'
const REQUEST_LOG_STORE_FILE = 'requests.json'
const WINDOW_STATE_STORE_FILE = 'window-state.json'
const BACKUP_DIRECTORY_NAME = 'backups'
const WINDOW_OPTIONS = Object.freeze({
  width: 1180,
  height: 760,
  minWidth: 1000,
  minHeight: 620,
  useContentSize: true,
  frame: false,
})

const WindowStateSchema = z.object({
  version: z.literal(1),
  bounds: z.object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().min(WINDOW_OPTIONS.minWidth),
    height: z.number().int().min(WINDOW_OPTIONS.minHeight),
  }).optional(),
  maximized: z.boolean().optional(),
})

app.setName(APP_NAME)

let mainWindow
let tray
let services
let quitBarrierComplete = false
let quitBarrierPromise
let quitting = false

/**
 * 创建主进程服务并绑定应用数据目录。
 *
 * @returns 配置管理、客户端扫描、健康检测和事务写入服务。
 * @throws 当 DPAPI 或本地数据文件不可用时，由具体服务在首次调用时抛出错误。
 */
function createServices() {
  const dataDirectory = path.join(app.getPath('userData'), DATA_DIRECTORY_NAME)
  const profileStore = new JsonFileStore(
    path.join(dataDirectory, PROFILE_STORE_FILE),
    ProfileStoreSchema,
    () => ({ version: 2, profiles: [] }),
  )
  const historyStore = new JsonFileStore(
    path.join(dataDirectory, HISTORY_STORE_FILE),
    HistoryStoreSchema,
    () => ({ version: 1, entries: [] }),
  )
  const gatewayStore = new JsonFileStore(
    path.join(dataDirectory, GATEWAY_STORE_FILE),
    GatewayStoreSchema,
    defaultGatewayStore,
  )
  const gatewayBaselineStore = new JsonFileStore(
    path.join(dataDirectory, GATEWAY_BASELINE_STORE_FILE),
    GatewayBaselineStoreSchema,
    defaultGatewayBaselineStore,
  )
  const settingsStore = new JsonFileStore(
    path.join(dataDirectory, SETTINGS_STORE_FILE),
    SettingsSchema,
    defaultSettings,
  )
  const requestLogStore = new JsonFileStore(
    path.join(dataDirectory, REQUEST_LOG_STORE_FILE),
    RequestLogStoreSchema,
    () => ({ version: 1, entries: [] }),
  )
  const windowStateStore = new JsonFileStore(
    path.join(dataDirectory, WINDOW_STATE_STORE_FILE),
    WindowStateSchema,
    () => ({ version: 1 }),
  )
  const vault = new Vault(safeStorage)
  const profileService = new ProfileService(profileStore, vault)
  const requestMonitor = new RequestMonitorService({
    onChange: (event) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(CHANNELS.stateChanged, event)
    },
    onRequestEnded: (entry) => {
      if (!entry.profileId) return
      const usage = entry.tokenUsage
      const total = Number.isFinite(usage?.totalTokens)
        ? usage.totalTokens
        : (usage?.inputTokens || 0) + (usage?.outputTokens || 0)
      void profileService.addTokenUsage(entry.profileId, total).catch(() => {})
    },
    store: requestLogStore,
  })
  const gatewayService = new GatewayService({
    profileService,
    store: gatewayStore,
    vault,
    requestMonitor,
    onStateChanged: (event) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(CHANNELS.stateChanged, {
        type: 'gateway-state-changed',
        gateway: event,
      })
    },
  })
  const adapters = createAdapters(resolveClientPaths())
  const clientService = new ClientService(adapters, shell, gatewayService)
  const healthService = new HealthService(profileService)
  const applyService = new ApplyService({
    profileService,
    adapters,
    historyStore,
    backupDirectory: path.join(dataDirectory, BACKUP_DIRECTORY_NAME),
    vault,
    gatewayService,
    gatewayBaselineStore,
  })
  const autoSwitchService = new AutoSwitchService({
    profileService,
    healthService,
    applyService,
    gatewayService,
  })
  const settingsService = new SettingsService({
    store: settingsStore,
    app,
    onChanged: (settings) => {
      gatewayService.setExperimentalToolBridgeEnabled?.(settings.experimentalToolBridge)
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(CHANNELS.stateChanged, {
        type: 'settings-changed',
        settings,
      })
    },
  })

  return {
    profileService,
    clientService,
    healthService,
    applyService,
    autoSwitchService,
    gatewayService,
    settingsService,
    requestMonitor,
    windowStateStore,
  }
}

/**
 * 限制渲染窗口导航范围，阻止页面跳转接管本地权限。
 *
 * @param window 需要加固的 Electron 窗口。
 * @returns 无返回值；会注册导航和新窗口拦截器。
 */
function secureWindowNavigation(window) {
  const devUrl = process.env.VITE_DEV_SERVER_URL
  const allowedOrigin = devUrl ? new URL(devUrl).origin : undefined

  window.webContents.on('will-navigate', (event, destination) => {
    if (allowedOrigin && new URL(destination).origin === allowedOrigin) return
    event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
}

/**
 * 校验保存的窗口位置仍然落在某个可见屏幕的工作区内。
 *
 * @param {{x: number, y: number, width: number, height: number}} bounds 保存的窗口位置。
 * @returns {boolean} 至少有可抓取的标题栏区域可见时返回 true。
 */
function boundsOnScreen(bounds) {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return bounds.x < area.x + area.width - 60
      && bounds.x + bounds.width > area.x + 60
      && bounds.y >= area.y - 20
      && bounds.y < area.y + area.height - 60
  })
}

let windowStateTimer

async function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || !services) return
  const state = {
    version: 1,
    bounds: mainWindow.getNormalBounds(),
    maximized: mainWindow.isMaximized(),
  }
  try {
    await services.windowStateStore.write(state)
  } catch {
    // 窗口状态持久化失败不影响使用。
  }
}

function scheduleWindowStateSave() {
  clearTimeout(windowStateTimer)
  windowStateTimer = setTimeout(() => { void saveWindowState() }, 600)
  windowStateTimer.unref?.()
}

/**
 * 创建并加载主窗口，恢复上次记录的位置、大小和最大化状态。
 *
 * 开发环境加载 Vite 地址，生产环境加载打包后的静态文件。窗口在内容准备完成前
 * 保持隐藏，加载失败时 Promise 会拒绝并交由 Electron 启动流程处理。
 *
 * @returns 窗口完成页面加载后的 Promise。
 */
async function createWindow() {
  let savedState
  try {
    savedState = await services?.windowStateStore.read()
  } catch {
    savedState = undefined
  }
  const savedBounds = savedState?.bounds && boundsOnScreen(savedState.bounds)
    ? savedState.bounds
    : undefined

  mainWindow = new BrowserWindow({
    ...WINDOW_OPTIONS,
    ...(savedBounds ?? {}),
    show: false,
    title: APP_DISPLAY_NAME,
    backgroundColor: '#1C1A16',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (savedState?.maximized) mainWindow.maximize()

  secureWindowNavigation(mainWindow)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('resize', scheduleWindowStateSave)
  mainWindow.on('move', scheduleWindowStateSave)
  mainWindow.on('maximize', scheduleWindowStateSave)
  mainWindow.on('unmaximize', scheduleWindowStateSave)
  mainWindow.on('close', (event) => {
    void saveWindowState()
    const gatewayRunning = services?.gatewayService.getPublicState().status === 'running'
    const closeToTray = services?.settingsService.getPublicSettings().closeToTray
    if (quitting || (!closeToTray && !gatewayRunning)) return
    event.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray() {
  if (tray) return tray
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon)
  tray.setToolTip(APP_DISPLAY_NAME)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `打开 ${APP_DISPLAY_NAME}`, click: showMainWindow },
    { type: 'separator' },
    { label: `退出 ${APP_DISPLAY_NAME}（暂停网关）`, click: () => app.quit() },
  ]))
  tray.on('double-click', showMainWindow)
  return tray
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_USER_MODEL_ID)
    Menu.setApplicationMenu(null)
    services = createServices()
    const settings = await services.settingsService.initialize()
    await services.requestMonitor.initialize()
    services.gatewayService.setExperimentalToolBridgeEnabled?.(settings.experimentalToolBridge)
    await services.gatewayService.initialize({ start: settings.startGatewayOnLaunch })
    registerIpcHandlers({ ipcMain, clipboard, ...services })
    ipcMain.handle('keydeck:window-control', (_event, action) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (action === 'minimize') mainWindow.minimize()
      else if (action === 'maximize') {
        if (mainWindow.isMaximized()) mainWindow.unmaximize()
        else mainWindow.maximize()
      } else if (action === 'close') mainWindow.close()
    })
    await createWindow()
    createTray()
    services.autoSwitchService.start((event) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(CHANNELS.stateChanged, event)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })
}

app.on('before-quit', (event) => {
  quitting = true
  if (quitBarrierComplete) return
  event.preventDefault()
  if (quitBarrierPromise) return

  quitBarrierPromise = (async () => {
    try {
      await services?.autoSwitchService.stopAndWait()
      await services?.gatewayService.shutdown()
      await services?.requestMonitor.flush()
    } finally {
      tray?.destroy()
      tray = undefined
      quitBarrierComplete = true
      app.quit()
    }
  })()
})

app.on('window-all-closed', () => {
  const gatewayRunning = services?.gatewayService.getPublicState().status === 'running'
  if (process.platform !== 'darwin'
    && !services?.settingsService.getPublicSettings().closeToTray
    && !gatewayRunning) {
    app.quit()
  }
})
