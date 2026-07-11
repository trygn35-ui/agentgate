const { contextBridge, ipcRenderer } = require('electron')

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
  windowControl: 'keydeck:window-control',
  stateChanged: 'keydeck:state-changed',
})

/**
 * 以 `window.keydeck` 暴露给渲染进程的最小 API。
 *
 * 公开方案结构：
 * `{ id, name, protocol, baseUrl, endpoints, availableModels, autoSwitch,
 *    keyHint, model, authMode, targets, enableToolSearch, createdAt,
 *    updatedAt, lastAppliedAt?, health? }`
 *
 * `saveProfile(input)` 接收上述可编辑字段和可选 `apiKey`。编辑已有方案时，
 * 缺失或空白的 `apiKey` 表示保留现有密文。任何接口都不会向渲染进程返回
 * 明文 Key；复制操作由主进程直接写入剪贴板。
 *
 * 方法与 IPC 通道：
 * - getBootstrap()                    -> keydeck:get-bootstrap
 * - saveProfile(input)                -> keydeck:save-profile
 * - duplicateProfile(id)              -> keydeck:duplicate-profile
 * - deleteProfile(id)                 -> keydeck:delete-profile
 * - copyProfileKey(id)                -> keydeck:copy-profile-key
 * - testProfile(id)                   -> keydeck:test-profile
 * - checkProfileHealth(id)            -> keydeck:check-profile-health
 * - applyProfile(id, targets?)        -> keydeck:apply-profile（只分配本地网关路由）
 * - undoHistory(id)                   -> keydeck:undo-history
 * - openConfig(target)                -> keydeck:open-config
 * - startGateway({ port? })           -> keydeck:start-gateway（使用已分配路由）
 * - stopGateway()                     -> keydeck:stop-gateway（保留路由分配）
 * - updateSettings(patch)             -> keydeck:update-settings（保存应用运行设置）
 * - onStateChanged(callback)          -> keydeck:state-changed
 */
const api = Object.freeze({
  getBootstrap: () => ipcRenderer.invoke(CHANNELS.bootstrap),
  saveProfile: (input) => ipcRenderer.invoke(CHANNELS.saveProfile, input),
  duplicateProfile: (id) => ipcRenderer.invoke(CHANNELS.duplicateProfile, id),
  reorderProfiles: (ids) => ipcRenderer.invoke(CHANNELS.reorderProfiles, ids),
  deleteProfile: (id) => ipcRenderer.invoke(CHANNELS.deleteProfile, id),
  copyProfileKey: (id) => ipcRenderer.invoke(CHANNELS.copyProfileKey, id),
  testProfile: (id) => ipcRenderer.invoke(CHANNELS.testProfile, id),
  checkProfileHealth: (id) => ipcRenderer.invoke(CHANNELS.checkProfileHealth, id),
  probeProfile: (id) => ipcRenderer.invoke(CHANNELS.probeProfile, id),
  applyProfile: (id, targets) => ipcRenderer.invoke(CHANNELS.applyProfile, id, targets),
  undoHistory: (id) => ipcRenderer.invoke(CHANNELS.undoHistory, id),
  openConfig: (target) => ipcRenderer.invoke(CHANNELS.openConfig, target),
  startGateway: (settings) => ipcRenderer.invoke(CHANNELS.startGateway, settings),
  stopGateway: () => ipcRenderer.invoke(CHANNELS.stopGateway),
  updateSettings: (patch) => ipcRenderer.invoke(CHANNELS.updateSettings, patch),
  windowControl: (action) => ipcRenderer.invoke(CHANNELS.windowControl, action),
  onStateChanged: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('State listener must be a function')
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on(CHANNELS.stateChanged, listener)
    return () => ipcRenderer.removeListener(CHANNELS.stateChanged, listener)
  },
})

contextBridge.exposeInMainWorld('keydeck', api)
