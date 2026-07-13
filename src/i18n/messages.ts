/**
 * 简体中文 / 繁體中文（台灣）/ 日本語 / English 四语文案。
 *
 * 固定不译的技术术语：DIVERGENCE / CACHE HIT / TOKENS / TTFT / TTFB / DPAPI /
 * 协议名 / 客户端名 / 状态码。它们是 SG 仪表读数语言的一部分，也是跨语言的共识符号。
 *
 * zh-TW 不是 zh 的字形转换：台湾用语自成一套（閘道 / 用戶端 / 金鑰 / 快取 /
 * 預設 / 介面 / 協定 / 系統匣 / 檔案），逐条另写。
 */
export type Locale = "zh" | "zh-TW" | "ja" | "en";

export interface Messages {
  nav: { overview: string; keys: string; stream: string; config: string };
  gateway: {
    online: string;
    offline: string;
    syncing: string;
    fault: string;
    toggleOn: string;
    toggleOff: string;
    recover: string;
    hint: string;
  };
  overview: {
    heroOnline: string;
    heroOffline: string;
    heroStarting: string;
    heroStopping: string;
    heroFault: string;
    routesBound: string;
    directToUpstream: string;
    streaming: string;
    idle: string;
    faultHint: string;
    divergence: string;
    cacheHit: string;
    tokens: string;
    awaitingBaseline: string;
    baselineOf: string;
    lastHour: string;
    todayResets: string;
    clients: string;
    worldLines: string;
    clickToJump: string;
    unbound: string;
    noProfileBound: string;
    clientNotDetected: string;
    profileRemoved: string;
    externalEdit: string;
    current: string;
    noCompatibleProfile: string;
    editToEnable: string;
    clientDefault: string;
  };
  keys: {
    title: string;
    subtitle: string;
    testAll: string;
    create: string;
    active: string;
    tokens: string;
    cache: string;
    awaitingSamples: string;
    statLine: string;
    switchTo: string;
    inUseHint: string;
    testEndpoints: string;
    probe: string;
    probeHint: string;
    expand: string;
    key: string;
    authHeader: string;
    targets: string;
    autoSwitch: string;
    autoSwitchOn: string;
    autoSwitchOff: string;
    lastApplied: string;
    never: string;
    discoverModels: string;
    edit: string;
    duplicate: string;
    delete: string;
    copyKey: string;
    models: string;
    loading: string;
    loadError: string;
    retry: string;
    emptyTitle: string;
    emptyHint: string;
    limited: string;
    down: string;
    untested: string;
  };
  stream: {
    title: string;
    streaming: string;
    idle: string;
    retained: string;
    all: string;
    live: string;
    done: string;
    fail: string;
    cache: string;
    empty: string;
    noMatch: string;
    resolving: string;
    states: {
      connect: string;
      wait: string;
      stream: string;
      done: string;
      fail: string;
      abort: string;
      cancel: string;
    };
  };
  config: {
    title: string;
    launchAtLogin: string;
    launchAtLoginDesc: string;
    closeToTray: string;
    closeToTrayDesc: string;
    startGateway: string;
    startGatewayDesc: string;
    toolBridge: string;
    toolBridgeDesc: string;
    update: string;
    updateCurrent: string;
    updateAvailable: string;
    updateDownloading: string;
    updateReady: string;
    updateLatest: string;
    updateFailed: string;
    checkUpdate: string;
    download: string;
    goDownload: string;
    installRestart: string;
    attractorField: string;
    attractorFieldDesc: string;
    system: string;
    language: string;
    languageDesc: string;
    security: string;
  };
  editor: {
    createTitle: string;
    editTitle: string;
    name: string;
    namePlaceholder: string;
    protocol: string;
    apiUrl: string;
    activeUrlHint: string;
    addUrl: string;
    autoSwitch: string;
    autoSwitchHint: string;
    apiKey: string;
    keyKeepHint: string;
    keyPlaceholder: string;
    keyPlaceholderNew: string;
    model: string;
    modelsAvailable: string;
    discoverModels: string;
    modelEmpty: string;
    modelNoMatch: string;
    authMode: string;
    targets: string;
    viaGateway: string;
    incompatible: string;
    toolSearch: string;
    toolSearchDesc: string;
    cancel: string;
    save: string;
    saving: string;
    saveAndUse: string;
    setActive: string;
    removeUrl: string;
    showKey: string;
    hideKey: string;
    notDetected: string;
    unavailable: string;
    close: string;
  };
  confirm: {
    deleteTitle: string;
    deleteMessage: string;
    deleteConfirm: string;
    discardTitle: string;
    discardMessage: string;
    discardConfirm: string;
    cancel: string;
  };
  toast: {
    saved: string;
    duplicated: string;
    deleted: string;
    keyCopied: string;
    reordered: string;
    orderFailed: string;
    gatewayStarted: string;
    gatewayStopped: string;
    gatewaySkipped: string;
    settingsSaved: string;
    modelsFound: string;
    noModels: string;
    healthDone: string;
    healthAllDone: string;
    probePass: string;
    probeFail: string;
    autoSwitched: string;
    autoSwitchFailed: string;
    refreshFailed: string;
    upToDate: string;
    updateCheckFailed: string;
    unsupported: string;
    assignedRunning: string;
    assignedStopped: string;
    close: string;
    undo: string;
  };
  errors: {
    profileNotFound: string;
    nameRequired: string;
    urlInvalid: string;
    urlCredentials: string;
    urlDuplicate: string;
    urlActiveRequired: string;
    keyRequired: string;
    targetRequired: string;
    urlAtLeastOne: string;
  };
  window: { minimize: string; maximize: string; close: string };
  footer: { sealed: string; profiles: string; clients: string; preview: string };
}

const zh: Messages = {
  nav: { overview: "概览", keys: "密钥", stream: "动态", config: "设置" },
  gateway: {
    online: "网关运行中",
    offline: "网关已关闭",
    syncing: "正在同步",
    fault: "需要处理",
    toggleOn: "开启本地网关",
    toggleOff: "关闭本地网关",
    recover: "恢复配置并关闭本地网关",
    hint: "客户端固定连接本地地址；切换方案不改客户端配置",
  },
  overview: {
    heroOnline: "网关运行中",
    heroOffline: "网关已关闭",
    heroStarting: "网关正在启动",
    heroStopping: "网关正在停止",
    heroFault: "网关需要处理",
    routesBound: "{routes} 条路由生效 · {profiles} 个方案就绪",
    directToUpstream: "客户端直连上游 · 打开右上角开关接管",
    streaming: "{count} 个请求进行中",
    idle: "当前空闲",
    faultHint: "配置被外部修改，请在顶栏恢复并关闭网关",
    divergence: "分歧率",
    cacheHit: "缓存命中",
    tokens: "用量",
    awaitingBaseline: "等待基准 · 需 3 个探测样本",
    baselineOf: "{current}ms / 基准 {baseline}ms · {profile}",
    lastHour: "最近 1 小时 · {count} 个请求",
    todayResets: "今日 · 0 点重置",
    clients: "客户端",
    worldLines: "世界线",
    clickToJump: "点击跳线 · 立即生效",
    unbound: "未接入",
    noProfileBound: "尚未分配方案",
    clientNotDetected: "未检测到客户端",
    profileRemoved: "方案已删除",
    externalEdit: "检测到外部修改",
    current: "当前",
    noCompatibleProfile: "没有适配此客户端的方案",
    editToEnable: "编辑方案，勾选 {client}",
    clientDefault: "沿用客户端",
  },
  keys: {
    title: "密钥",
    subtitle: "{count} 个方案 · 拖动排序",
    testAll: "检测全部",
    create: "新建",
    active: "使用中",
    tokens: "累计",
    cache: "缓存率",
    awaitingSamples: "尚无样本",
    statLine: "1 小时 {availability}% · 平均 {latency}",
    switchTo: "切换到「{name}」",
    inUseHint: "已在使用中，点击重新分配全部适用客户端",
    testEndpoints: "检测端点延迟（不影响其他操作）",
    probe: "实测",
    probeHint: "实测：发送一条最小消息，测真实可用性与时延",
    expand: "{name} 详情",
    key: "密钥",
    authHeader: "认证头",
    targets: "适用客户端",
    autoSwitch: "自动择优",
    autoSwitchOn: "每 2 分钟按 1 小时可用率择优",
    autoSwitchOff: "关闭",
    lastApplied: "上次切换",
    never: "从未",
    discoverModels: "识别模型",
    edit: "编辑",
    duplicate: "复制",
    delete: "删除",
    copyKey: "复制密钥",
    models: "个模型",
    loading: "正在读取本地配置",
    loadError: "无法读取本地数据",
    retry: "重试",
    emptyTitle: "还没有连接方案",
    emptyHint: "录入第一个 API 端点和密钥",
    limited: "受限",
    down: "异常",
    untested: "未测试",
  },
  stream: {
    title: "动态",
    streaming: "{count} 个请求进行中",
    idle: "当前空闲",
    retained: "保留最近 1 小时",
    all: "全部",
    live: "活跃",
    done: "完成",
    fail: "异常",
    cache: "缓存率",
    empty: "还没有请求记录 · 网关收到请求后会在这里即时显示",
    noMatch: "没有符合筛选条件的请求",
    resolving: "正在解析上游",
    states: {
      connect: "连接中",
      wait: "等待首字",
      stream: "传输中",
      done: "已完成",
      fail: "失败",
      abort: "已中止",
      cancel: "已取消",
    },
  },
  config: {
    title: "设置",
    launchAtLogin: "开机自启（静默）",
    launchAtLoginDesc: "登录 Windows 后自动启动并直接驻留托盘，不弹出窗口；手动启动仍正常显示",
    closeToTray: "关闭时驻留托盘",
    closeToTrayDesc: "网关运行时保持后台驻留，关闭网关后按此设置退出",
    startGateway: "启动时恢复网关",
    startGatewayDesc: "启动后恢复上次的网关开关状态",
    toolBridge: "Codex 工具兼容模式（实验性）",
    toolBridgeDesc: "只转换 Responses 的 exec 工具协议，不能修复上游裁剪上下文",
    update: "软件更新",
    updateCurrent: "当前版本 {version}",
    updateAvailable: "发现新版本 {version}",
    updateDownloading: "正在下载 {percent}%",
    updateReady: "新版本 {version} 已就绪，重启即可安装",
    updateLatest: "已是最新版本",
    updateFailed: "检查更新失败",
    checkUpdate: "检查更新",
    download: "下载更新",
    goDownload: "前往下载",
    installRestart: "重启并安装",
    attractorField: "世界线",
    attractorFieldDesc: "α 纸与墨 · β 分歧率显示器 · 立即生效",
    system: "跟随系统",
    language: "语言",
    languageDesc: "界面语言 · 立即生效",
    security: "真实 Key 由 Windows DPAPI 加密，只在本机交给网关；客户端不会保存上游 Key。方案中的 URL 与 Key 永不写入客户端配置文件。",
  },
  editor: {
    createTitle: "新建连接方案",
    editTitle: "编辑 · {name}",
    name: "方案名称",
    namePlaceholder: "例如：主力中转",
    protocol: "API 协议",
    apiUrl: "API URL",
    activeUrlHint: "圆点标记活动 URL",
    addUrl: "添加 URL",
    autoSwitch: "自动择优",
    autoSwitchHint: "自动选择一小时可用率最高的 URL",
    apiKey: "API Key",
    keyKeepHint: "留空保留 {hint}",
    keyPlaceholder: "保留现有密钥",
    keyPlaceholderNew: "sk-...",
    model: "模型 ID",
    modelsAvailable: "{count} 个可用",
    discoverModels: "识别模型",
    modelEmpty: "还没有识别到模型，点击上方「识别模型」",
    modelNoMatch: "没有匹配的模型，点右侧箭头查看全部",
    authMode: "认证方式",
    targets: "适用客户端",
    viaGateway: "可由网关转发",
    incompatible: "协议不兼容",
    toolSearch: "Claude Tool Search",
    toolSearchDesc: "为非官方域名写入 ENABLE_TOOL_SEARCH",
    cancel: "取消",
    save: "保存",
    saving: "正在保存",
    saveAndUse: "保存并使用",
    setActive: "设为活动 URL",
    removeUrl: "删除 URL",
    showKey: "显示密钥",
    hideKey: "隐藏密钥",
    notDetected: "未检测",
    unavailable: "不可用",
    close: "关闭",
  },
  confirm: {
    deleteTitle: "删除「{name}」？",
    deleteMessage: "指向它的路由也会一并移除。此操作不修改已写入客户端的配置。",
    deleteConfirm: "删除",
    discardTitle: "放弃尚未保存的修改？",
    discardMessage: "表单中的改动不会写入方案。",
    discardConfirm: "放弃修改",
    cancel: "取消",
  },
  toast: {
    saved: "已保存「{name}」",
    duplicated: "已复制为「{name}」",
    deleted: "已删除「{name}」",
    keyCopied: "「{name}」的密钥已复制",
    reordered: "排序已保存",
    orderFailed: "当前版本不支持方案排序",
    gatewayStarted: "本地网关已启动，并接管已分配的客户端",
    gatewayStopped: "本地网关已停止",
    gatewaySkipped: "本地网关已停止；已跳过用户修改的 {targets}",
    settingsSaved: "设置已保存",
    modelsFound: "已识别 {count} 个可用模型",
    noModels: "请求已完成，但没有识别到模型",
    healthDone: "端点检测完成：{reachable} / {total} 可达",
    healthAllDone: "全部检测完成：{reachable} / {total} 个方案可达",
    probePass: "实测通过 · {model} · 首包 {ttfb} · 总耗时 {total}{usage}",
    probeFail: "实测失败{status}{message}",
    autoSwitched: "已自动切换到 {url}",
    autoSwitchFailed: "自动检测失败",
    refreshFailed: "{message}，但界面刷新失败：{error}",
    upToDate: "已是最新版本 {version}",
    updateCheckFailed: "检查更新失败",
    unsupported: "当前版本不支持此功能",
    assignedRunning: "「{name}」已成为 {targets} 的当前网关方案",
    assignedStopped: "「{name}」已设为 {targets} 的下次启动方案",
    close: "关闭",
    undo: "撤销",
  },
  errors: {
    profileNotFound: "方案不存在",
    nameRequired: "请输入方案名称",
    urlInvalid: "请输入有效的 HTTP(S) API URL",
    urlCredentials: "API URL 不能包含凭据或片段",
    urlDuplicate: "API URL 不能重复",
    urlActiveRequired: "请选择一个活动 URL",
    keyRequired: "请输入 API Key",
    targetRequired: "至少选择一个适用客户端",
    urlAtLeastOne: "至少保留一个 API URL",
  },
  window: { minimize: "最小化", maximize: "最大化 / 还原", close: "关闭" },
  footer: {
    sealed: "DPAPI 本机加密",
    profiles: "方案",
    clients: "客户端",
    preview: "界面预览",
  },
};

const zhTW: Messages = {
  nav: { overview: "總覽", keys: "金鑰", stream: "動態", config: "設定" },
  gateway: {
    online: "閘道運行中",
    offline: "閘道已關閉",
    syncing: "正在同步",
    fault: "需要處理",
    toggleOn: "開啟本機閘道",
    toggleOff: "關閉本機閘道",
    recover: "還原設定並關閉本機閘道",
    hint: "用戶端固定連線本機位址；切換方案不改用戶端設定",
  },
  overview: {
    heroOnline: "閘道運行中",
    heroOffline: "閘道已關閉",
    heroStarting: "閘道正在啟動",
    heroStopping: "閘道正在停止",
    heroFault: "閘道需要處理",
    routesBound: "{routes} 條路由生效 · {profiles} 個方案就緒",
    directToUpstream: "用戶端直連上游 · 開啟右上角開關接管",
    streaming: "{count} 個請求進行中",
    idle: "目前閒置",
    faultHint: "設定被外部修改，請在頂列還原並關閉閘道",
    divergence: "分歧率",
    cacheHit: "快取命中",
    tokens: "用量",
    awaitingBaseline: "等待基準 · 需 3 個探測樣本",
    baselineOf: "{current}ms / 基準 {baseline}ms · {profile}",
    lastHour: "最近 1 小時 · {count} 個請求",
    todayResets: "今日 · 0 點重置",
    clients: "用戶端",
    worldLines: "世界線",
    clickToJump: "點擊跳線 · 立即生效",
    unbound: "未接入",
    noProfileBound: "尚未指派方案",
    clientNotDetected: "未偵測到用戶端",
    profileRemoved: "方案已刪除",
    externalEdit: "偵測到外部修改",
    current: "目前",
    noCompatibleProfile: "沒有適用此用戶端的方案",
    editToEnable: "編輯方案，勾選 {client}",
    clientDefault: "沿用用戶端",
  },
  keys: {
    title: "金鑰",
    subtitle: "{count} 個方案 · 拖曳排序",
    testAll: "檢測全部",
    create: "新增",
    active: "使用中",
    tokens: "累計",
    cache: "快取率",
    awaitingSamples: "尚無樣本",
    statLine: "1 小時 {availability}% · 平均 {latency}",
    switchTo: "切換至「{name}」",
    inUseHint: "已在使用中，點擊重新指派全部適用用戶端",
    testEndpoints: "檢測端點延遲（不影響其他操作）",
    probe: "實測",
    probeHint: "實測：送出一則最小訊息，測真實可用性與延遲",
    expand: "{name} 詳細資料",
    key: "金鑰",
    authHeader: "驗證標頭",
    targets: "適用用戶端",
    autoSwitch: "自動擇優",
    autoSwitchOn: "每 2 分鐘依 1 小時可用率擇優",
    autoSwitchOff: "關閉",
    lastApplied: "上次切換",
    never: "從未",
    discoverModels: "辨識模型",
    edit: "編輯",
    duplicate: "複製",
    delete: "刪除",
    copyKey: "複製金鑰",
    models: "個模型",
    loading: "正在讀取本機設定",
    loadError: "無法讀取本機資料",
    retry: "重試",
    emptyTitle: "還沒有連線方案",
    emptyHint: "登錄第一個 API 端點和金鑰",
    limited: "受限",
    down: "異常",
    untested: "未測試",
  },
  stream: {
    title: "動態",
    streaming: "{count} 個請求進行中",
    idle: "目前閒置",
    retained: "保留最近 1 小時",
    all: "全部",
    live: "活躍",
    done: "完成",
    fail: "異常",
    cache: "快取率",
    empty: "還沒有請求記錄 · 閘道收到請求後會在這裡即時顯示",
    noMatch: "沒有符合篩選條件的請求",
    resolving: "正在解析上游",
    states: {
      connect: "連線中",
      wait: "等待首字",
      stream: "傳輸中",
      done: "已完成",
      fail: "失敗",
      abort: "已中止",
      cancel: "已取消",
    },
  },
  config: {
    title: "設定",
    launchAtLogin: "開機自動啟動（靜默）",
    launchAtLoginDesc: "登入 Windows 後自動啟動並直接常駐系統匣，不彈出視窗；手動啟動仍正常顯示",
    closeToTray: "關閉時常駐系統匣",
    closeToTrayDesc: "閘道運行時保持背景常駐，關閉閘道後依此設定結束",
    startGateway: "啟動時還原閘道",
    startGatewayDesc: "啟動後還原上次的閘道開關狀態",
    toolBridge: "Codex 工具相容模式（實驗性）",
    toolBridgeDesc: "只轉換 Responses 的 exec 工具協定，無法修復上游裁切的上下文",
    update: "軟體更新",
    updateCurrent: "目前版本 {version}",
    updateAvailable: "發現新版本 {version}",
    updateDownloading: "正在下載 {percent}%",
    updateReady: "新版本 {version} 已就緒，重新啟動即可安裝",
    updateLatest: "已是最新版本",
    updateFailed: "檢查更新失敗",
    checkUpdate: "檢查更新",
    download: "下載更新",
    goDownload: "前往下載",
    installRestart: "重新啟動並安裝",
    attractorField: "世界線",
    attractorFieldDesc: "α 紙與墨 · β 分歧率顯示器 · 立即生效",
    system: "跟隨系統",
    language: "語言",
    languageDesc: "介面語言 · 立即生效",
    security: "真實 Key 由 Windows DPAPI 加密，只在本機交給閘道；用戶端不會儲存上游 Key。方案中的 URL 與 Key 永不寫入用戶端設定檔。",
  },
  editor: {
    createTitle: "新增連線方案",
    editTitle: "編輯 · {name}",
    name: "方案名稱",
    namePlaceholder: "例如：主力中轉",
    protocol: "API 協定",
    apiUrl: "API URL",
    activeUrlHint: "圓點標記使用中的 URL",
    addUrl: "新增 URL",
    autoSwitch: "自動擇優",
    autoSwitchHint: "自動選擇一小時可用率最高的 URL",
    apiKey: "API Key",
    keyKeepHint: "留空保留 {hint}",
    keyPlaceholder: "保留現有金鑰",
    keyPlaceholderNew: "sk-...",
    model: "模型 ID",
    modelsAvailable: "{count} 個可用",
    discoverModels: "辨識模型",
    modelEmpty: "還沒有辨識到模型，點擊上方「辨識模型」",
    modelNoMatch: "沒有相符的模型，點右側箭頭檢視全部",
    authMode: "驗證方式",
    targets: "適用用戶端",
    viaGateway: "可由閘道轉送",
    incompatible: "協定不相容",
    toolSearch: "Claude Tool Search",
    toolSearchDesc: "為非官方網域寫入 ENABLE_TOOL_SEARCH",
    cancel: "取消",
    save: "儲存",
    saving: "正在儲存",
    saveAndUse: "儲存並使用",
    setActive: "設為使用中的 URL",
    removeUrl: "刪除 URL",
    showKey: "顯示金鑰",
    hideKey: "隱藏金鑰",
    notDetected: "未檢測",
    unavailable: "不可用",
    close: "關閉",
  },
  confirm: {
    deleteTitle: "刪除「{name}」？",
    deleteMessage: "指向它的路由也會一併移除。此操作不會修改已寫入用戶端的設定。",
    deleteConfirm: "刪除",
    discardTitle: "放棄尚未儲存的修改？",
    discardMessage: "表單中的變更不會寫入方案。",
    discardConfirm: "放棄修改",
    cancel: "取消",
  },
  toast: {
    saved: "已儲存「{name}」",
    duplicated: "已複製為「{name}」",
    deleted: "已刪除「{name}」",
    keyCopied: "「{name}」的金鑰已複製",
    reordered: "排序已儲存",
    orderFailed: "目前版本不支援方案排序",
    gatewayStarted: "本機閘道已啟動，並接管已指派的用戶端",
    gatewayStopped: "本機閘道已停止",
    gatewaySkipped: "本機閘道已停止；已略過使用者修改的 {targets}",
    settingsSaved: "設定已儲存",
    modelsFound: "已辨識 {count} 個可用模型",
    noModels: "請求已完成，但沒有辨識到模型",
    healthDone: "端點檢測完成：{reachable} / {total} 可達",
    healthAllDone: "全部檢測完成：{reachable} / {total} 個方案可達",
    probePass: "實測通過 · {model} · 首包 {ttfb} · 總耗時 {total}{usage}",
    probeFail: "實測失敗{status}{message}",
    autoSwitched: "已自動切換至 {url}",
    autoSwitchFailed: "自動檢測失敗",
    refreshFailed: "{message}，但介面重新整理失敗：{error}",
    upToDate: "已是最新版本 {version}",
    updateCheckFailed: "檢查更新失敗",
    unsupported: "目前版本不支援此功能",
    assignedRunning: "「{name}」已成為 {targets} 的目前閘道方案",
    assignedStopped: "「{name}」已設為 {targets} 的下次啟動方案",
    close: "關閉",
    undo: "復原",
  },
  errors: {
    profileNotFound: "方案不存在",
    nameRequired: "請輸入方案名稱",
    urlInvalid: "請輸入有效的 HTTP(S) API URL",
    urlCredentials: "API URL 不能包含憑證或片段",
    urlDuplicate: "API URL 不能重複",
    urlActiveRequired: "請選擇一個使用中的 URL",
    keyRequired: "請輸入 API Key",
    targetRequired: "至少選擇一個適用用戶端",
    urlAtLeastOne: "至少保留一個 API URL",
  },
  window: { minimize: "最小化", maximize: "最大化 / 還原", close: "關閉" },
  footer: {
    sealed: "DPAPI 本機加密",
    profiles: "方案",
    clients: "用戶端",
    preview: "介面預覽",
  },
};

const ja: Messages = {
  nav: { overview: "概要", keys: "キー", stream: "ストリーム", config: "設定" },
  gateway: {
    online: "ゲートウェイ稼働中",
    offline: "ゲートウェイ停止中",
    syncing: "同期中",
    fault: "要対応",
    toggleOn: "ローカルゲートウェイを開始",
    toggleOff: "ローカルゲートウェイを停止",
    recover: "設定を復元してゲートウェイを停止",
    hint: "クライアントはローカルアドレスに固定接続。プロファイル切替時に設定を書き換えません",
  },
  overview: {
    heroOnline: "ゲートウェイ稼働中",
    heroOffline: "ゲートウェイ停止中",
    heroStarting: "ゲートウェイ起動中",
    heroStopping: "ゲートウェイ停止中",
    heroFault: "ゲートウェイ異常",
    routesBound: "{routes} 経路が有効 · {profiles} プロファイル待機",
    directToUpstream: "クライアントは上流に直結 · 右上のスイッチで接続",
    streaming: "{count} リクエスト進行中",
    idle: "アイドル",
    faultHint: "設定が外部から変更されました。上部から復元して停止してください",
    divergence: "ダイバージェンス",
    cacheHit: "キャッシュヒット",
    tokens: "トークン",
    awaitingBaseline: "基準値待ち · 3 サンプル必要",
    baselineOf: "{current}ms / 基準 {baseline}ms · {profile}",
    lastHour: "直近 1 時間 · {count} リクエスト",
    todayResets: "本日 · 0 時にリセット",
    clients: "クライアント",
    worldLines: "世界線",
    clickToJump: "クリックでリープ · 即時反映",
    unbound: "未接続",
    noProfileBound: "プロファイル未割当",
    clientNotDetected: "クライアント未検出",
    profileRemoved: "プロファイル削除済み",
    externalEdit: "外部変更を検出",
    current: "現在",
    noCompatibleProfile: "対応するプロファイルがありません",
    editToEnable: "プロファイルを編集し {client} を選択",
    clientDefault: "クライアント既定",
  },
  keys: {
    title: "キー",
    subtitle: "{count} プロファイル · ドラッグで並替",
    testAll: "一括検査",
    create: "新規",
    active: "使用中",
    tokens: "累計",
    cache: "キャッシュ",
    awaitingSamples: "サンプルなし",
    statLine: "1時間 {availability}% · 平均 {latency}",
    switchTo: "「{name}」に切替",
    inUseHint: "使用中です。クリックで全対応クライアントに再割当",
    testEndpoints: "エンドポイント遅延を検査（他の操作に影響しません）",
    probe: "実測",
    probeHint: "実測：最小メッセージを送信し、実際の可用性と遅延を計測",
    expand: "{name} の詳細",
    key: "キー",
    authHeader: "認証ヘッダ",
    targets: "対象クライアント",
    autoSwitch: "自動最適化",
    autoSwitchOn: "2 分毎に 1 時間の可用率で最適化",
    autoSwitchOff: "無効",
    lastApplied: "前回切替",
    never: "未実行",
    discoverModels: "モデル検出",
    edit: "編集",
    duplicate: "複製",
    delete: "削除",
    copyKey: "キーをコピー",
    models: "モデル",
    loading: "ローカル設定を読込中",
    loadError: "ローカルデータを読込めません",
    retry: "再試行",
    emptyTitle: "プロファイルがありません",
    emptyHint: "最初の API エンドポイントとキーを登録",
    limited: "制限",
    down: "異常",
    untested: "未検査",
  },
  stream: {
    title: "ストリーム",
    streaming: "{count} リクエスト進行中",
    idle: "アイドル",
    retained: "直近 1 時間を保持",
    all: "全て",
    live: "実行中",
    done: "完了",
    fail: "異常",
    cache: "キャッシュ",
    empty: "リクエスト記録なし · ゲートウェイ経由のリクエストがここに表示されます",
    noMatch: "条件に一致するリクエストがありません",
    resolving: "上流を解決中",
    states: {
      connect: "接続中",
      wait: "初トークン待ち",
      stream: "転送中",
      done: "完了",
      fail: "失敗",
      abort: "中断",
      cancel: "キャンセル",
    },
  },
  config: {
    title: "設定",
    launchAtLogin: "自動起動（サイレント）",
    launchAtLoginDesc: "Windows ログイン時に自動起動しトレイに常駐。手動起動時は通常表示",
    closeToTray: "閉じてもトレイに常駐",
    closeToTrayDesc: "ゲートウェイ稼働中は常に常駐。停止後はこの設定に従います",
    startGateway: "起動時にゲートウェイを復元",
    startGatewayDesc: "前回のゲートウェイ状態を復元します",
    toolBridge: "Codex ツール互換モード（実験的）",
    toolBridgeDesc: "Responses の exec ツールプロトコルのみ変換。上流のコンテキスト切詰めは修正できません",
    update: "ソフトウェア更新",
    updateCurrent: "現在のバージョン {version}",
    updateAvailable: "新バージョン {version} が利用可能",
    updateDownloading: "ダウンロード中 {percent}%",
    updateReady: "新バージョン {version} 準備完了。再起動でインストール",
    updateLatest: "最新版です",
    updateFailed: "更新確認に失敗",
    checkUpdate: "更新を確認",
    download: "更新をダウンロード",
    goDownload: "ダウンロードページへ",
    installRestart: "再起動してインストール",
    attractorField: "世界線",
    attractorFieldDesc: "α 紙と墨 · β ダイバージェンスメーター · 即時反映",
    system: "システムに従う",
    language: "言語",
    languageDesc: "表示言語 · 即時反映",
    security: "実際のキーは Windows DPAPI で暗号化され、ローカルのゲートウェイにのみ渡されます。クライアントは上流キーを保存せず、プロファイルの URL とキーがクライアント設定に書き込まれることはありません。",
  },
  editor: {
    createTitle: "接続プロファイルを新規作成",
    editTitle: "編集 · {name}",
    name: "プロファイル名",
    namePlaceholder: "例：メイン中継",
    protocol: "API プロトコル",
    apiUrl: "API URL",
    activeUrlHint: "丸印がアクティブ URL",
    addUrl: "URL を追加",
    autoSwitch: "自動最適化",
    autoSwitchHint: "1 時間の可用率が最も高い URL を自動選択",
    apiKey: "API キー",
    keyKeepHint: "空欄で {hint} を維持",
    keyPlaceholder: "既存のキーを維持",
    keyPlaceholderNew: "sk-...",
    model: "モデル ID",
    modelsAvailable: "{count} 件利用可能",
    discoverModels: "モデル検出",
    modelEmpty: "モデル未検出。上の「モデル検出」をクリック",
    modelNoMatch: "一致するモデルなし。右の矢印で全件表示",
    authMode: "認証方式",
    targets: "対象クライアント",
    viaGateway: "ゲートウェイ経由可",
    incompatible: "プロトコル非対応",
    toolSearch: "Claude Tool Search",
    toolSearchDesc: "非公式ドメインに ENABLE_TOOL_SEARCH を書込",
    cancel: "キャンセル",
    save: "保存",
    saving: "保存中",
    saveAndUse: "保存して使用",
    setActive: "アクティブ URL に設定",
    removeUrl: "URL を削除",
    showKey: "キーを表示",
    hideKey: "キーを隠す",
    notDetected: "未検査",
    unavailable: "利用不可",
    close: "閉じる",
  },
  confirm: {
    deleteTitle: "「{name}」を削除しますか？",
    deleteMessage: "これを指す経路も併せて削除されます。書込済みのクライアント設定は変更しません。",
    deleteConfirm: "削除",
    discardTitle: "未保存の変更を破棄しますか？",
    discardMessage: "フォームの変更はプロファイルに書き込まれません。",
    discardConfirm: "変更を破棄",
    cancel: "キャンセル",
  },
  toast: {
    saved: "「{name}」を保存しました",
    duplicated: "「{name}」として複製しました",
    deleted: "「{name}」を削除しました",
    keyCopied: "「{name}」のキーをコピーしました",
    reordered: "並び順を保存しました",
    orderFailed: "このバージョンは並替に未対応です",
    gatewayStarted: "ローカルゲートウェイを開始し、割当済みクライアントを引継ぎました",
    gatewayStopped: "ローカルゲートウェイを停止しました",
    gatewaySkipped: "ゲートウェイを停止。ユーザー変更済みの {targets} はスキップしました",
    settingsSaved: "設定を保存しました",
    modelsFound: "{count} 件のモデルを検出しました",
    noModels: "完了しましたが、モデルを検出できませんでした",
    healthDone: "エンドポイント検査完了：{reachable} / {total} 到達可",
    healthAllDone: "全件検査完了：{reachable} / {total} プロファイル到達可",
    probePass: "実測成功 · {model} · 初バイト {ttfb} · 総時間 {total}{usage}",
    probeFail: "実測失敗{status}{message}",
    autoSwitched: "{url} に自動切替しました",
    autoSwitchFailed: "自動検査に失敗しました",
    refreshFailed: "{message}、ただし画面更新に失敗：{error}",
    upToDate: "最新版です {version}",
    updateCheckFailed: "更新確認に失敗しました",
    unsupported: "このバージョンでは利用できません",
    assignedRunning: "「{name}」が {targets} の現在のゲートウェイプロファイルになりました",
    assignedStopped: "「{name}」を {targets} の次回起動プロファイルに設定しました",
    close: "閉じる",
    undo: "元に戻す",
  },
  errors: {
    profileNotFound: "プロファイルが見つかりません",
    nameRequired: "プロファイル名を入力してください",
    urlInvalid: "有効な HTTP(S) API URL を入力してください",
    urlCredentials: "API URL に認証情報やフラグメントは含められません",
    urlDuplicate: "API URL が重複しています",
    urlActiveRequired: "アクティブ URL を選択してください",
    keyRequired: "API キーを入力してください",
    targetRequired: "対象クライアントを 1 つ以上選択してください",
    urlAtLeastOne: "API URL を 1 つ以上残してください",
  },
  window: { minimize: "最小化", maximize: "最大化 / 元に戻す", close: "閉じる" },
  footer: {
    sealed: "DPAPI ローカル暗号化",
    profiles: "プロファイル",
    clients: "クライアント",
    preview: "プレビュー",
  },
};

const en: Messages = {
  nav: { overview: "OVERVIEW", keys: "KEYS", stream: "STREAM", config: "CONFIG" },
  gateway: {
    online: "GATEWAY ONLINE",
    offline: "GATEWAY OFFLINE",
    syncing: "SYNCING",
    fault: "FAULT",
    toggleOn: "Start local gateway",
    toggleOff: "Stop local gateway",
    recover: "Restore config and stop gateway",
    hint: "Clients bind to a fixed local address; switching profiles never rewrites client config",
  },
  overview: {
    heroOnline: "Gateway Online",
    heroOffline: "Gateway Offline",
    heroStarting: "Gateway Starting",
    heroStopping: "Gateway Stopping",
    heroFault: "Gateway Fault",
    routesBound: "{routes} ROUTES BOUND · {profiles} PROFILES READY",
    directToUpstream: "CLIENTS DIRECT TO UPSTREAM · TOGGLE GATEWAY TO BIND",
    streaming: "{count} STREAMING",
    idle: "IDLE",
    faultHint: "Config was edited externally. Restore and stop from the top bar.",
    divergence: "DIVERGENCE",
    cacheHit: "CACHE HIT",
    tokens: "TOKENS",
    awaitingBaseline: "AWAITING BASELINE · 3 SAMPLES NEEDED",
    baselineOf: "{current}ms / {baseline}ms BASELINE · {profile}",
    lastHour: "LAST HOUR · {count} REQUESTS",
    todayResets: "TODAY · RESETS AT 00:00",
    clients: "CLIENTS",
    worldLines: "World Lines",
    clickToJump: "CLICK TO JUMP · INSTANT",
    unbound: "UNBOUND",
    noProfileBound: "NO PROFILE BOUND",
    clientNotDetected: "CLIENT NOT DETECTED",
    profileRemoved: "PROFILE REMOVED",
    externalEdit: "EXTERNAL EDIT DETECTED",
    current: "CURRENT",
    noCompatibleProfile: "No compatible profile",
    editToEnable: "Edit a profile and enable {client}",
    clientDefault: "CLIENT DEFAULT",
  },
  keys: {
    title: "Attractor Fields",
    subtitle: "{count} PROFILES · DRAG TO REORDER",
    testAll: "TEST ALL",
    create: "NEW",
    active: "ACTIVE",
    tokens: "TOKENS",
    cache: "CACHE",
    awaitingSamples: "AWAITING SAMPLES",
    statLine: "1H {availability}% · AVG {latency}",
    switchTo: "Switch to {name}",
    inUseHint: "Already active — click to re-bind all compatible clients",
    testEndpoints: "Probe endpoint latency (non-blocking)",
    probe: "Probe",
    probeHint: "Probe: send a minimal message to measure real availability and latency",
    expand: "{name} details",
    key: "KEY",
    authHeader: "AUTH",
    targets: "CLIENTS",
    autoSwitch: "AUTO",
    autoSwitchOn: "Every 2 min by 1h availability",
    autoSwitchOff: "OFF",
    lastApplied: "LAST JUMP",
    never: "NEVER",
    discoverModels: "MODELS",
    edit: "EDIT",
    duplicate: "COPY",
    delete: "DELETE",
    copyKey: "Copy key",
    models: "models",
    loading: "Reading local config",
    loadError: "Cannot read local data",
    retry: "RETRY",
    emptyTitle: "No profiles yet",
    emptyHint: "Add your first API endpoint and key",
    limited: "LIMITED",
    down: "DOWN",
    untested: "———",
  },
  stream: {
    title: "Stream",
    streaming: "{count} STREAMING",
    idle: "IDLE",
    retained: "LAST HOUR RETAINED",
    all: "ALL",
    live: "LIVE",
    done: "DONE",
    fail: "FAIL",
    cache: "CACHE",
    empty: "NO REQUESTS YET · gateway traffic appears here in real time",
    noMatch: "NO MATCHING REQUESTS",
    resolving: "RESOLVING",
    states: {
      connect: "CONNECT",
      wait: "WAIT",
      stream: "STREAM",
      done: "DONE",
      fail: "FAIL",
      abort: "ABORT",
      cancel: "CANCEL",
    },
  },
  config: {
    title: "Config",
    launchAtLogin: "Launch at login (silent)",
    launchAtLoginDesc: "Starts to tray on Windows login without a window; manual launch shows normally",
    closeToTray: "Close to tray",
    closeToTrayDesc: "Always resident while the gateway runs; otherwise follows this setting",
    startGateway: "Restore gateway on launch",
    startGatewayDesc: "Restores the last gateway state at startup",
    toolBridge: "Codex tool bridge (experimental)",
    toolBridgeDesc: "Only converts the Responses exec tool protocol; cannot fix upstream context truncation",
    update: "Software update",
    updateCurrent: "Current version {version}",
    updateAvailable: "Version {version} available",
    updateDownloading: "Downloading {percent}%",
    updateReady: "Version {version} ready — restart to install",
    updateLatest: "Up to date",
    updateFailed: "Update check failed",
    checkUpdate: "CHECK",
    download: "DOWNLOAD",
    goDownload: "OPEN PAGE",
    installRestart: "RESTART & INSTALL",
    attractorField: "Attractor Field",
    attractorFieldDesc: "α paper & ink · β divergence meter · applies instantly",
    system: "SYSTEM",
    language: "Language",
    languageDesc: "Interface language · applies instantly",
    security: "Real keys are encrypted with Windows DPAPI and handed only to the local gateway. Clients never store upstream keys, and profile URLs and keys are never written to client config files.",
  },
  editor: {
    createTitle: "New connection profile",
    editTitle: "Edit · {name}",
    name: "Profile name",
    namePlaceholder: "e.g. Primary relay",
    protocol: "API protocol",
    apiUrl: "API URL",
    activeUrlHint: "Dot marks the active URL",
    addUrl: "ADD URL",
    autoSwitch: "AUTO",
    autoSwitchHint: "Auto-select the URL with the best 1h availability",
    apiKey: "API Key",
    keyKeepHint: "Blank keeps {hint}",
    keyPlaceholder: "Keep existing key",
    keyPlaceholderNew: "sk-...",
    model: "Model ID",
    modelsAvailable: "{count} available",
    discoverModels: "MODELS",
    modelEmpty: "No models yet — click MODELS above",
    modelNoMatch: "No match — use the arrow to see all",
    authMode: "Auth mode",
    targets: "Target clients",
    viaGateway: "Via gateway",
    incompatible: "Protocol mismatch",
    toolSearch: "Claude Tool Search",
    toolSearchDesc: "Writes ENABLE_TOOL_SEARCH for non-official domains",
    cancel: "CANCEL",
    save: "SAVE",
    saving: "SAVING",
    saveAndUse: "SAVE & USE",
    setActive: "Set as active URL",
    removeUrl: "Remove URL",
    showKey: "Show key",
    hideKey: "Hide key",
    notDetected: "———",
    unavailable: "DOWN",
    close: "Close",
  },
  confirm: {
    deleteTitle: "Delete {name}?",
    deleteMessage: "Routes pointing to it are removed too. Client configs already written are not modified.",
    deleteConfirm: "DELETE",
    discardTitle: "Discard unsaved changes?",
    discardMessage: "Form edits will not be written to the profile.",
    discardConfirm: "DISCARD",
    cancel: "CANCEL",
  },
  toast: {
    saved: "Saved {name}",
    duplicated: "Duplicated as {name}",
    deleted: "Deleted {name}",
    keyCopied: "Key for {name} copied",
    reordered: "Order saved",
    orderFailed: "This build does not support reordering",
    gatewayStarted: "Local gateway started and bound to assigned clients",
    gatewayStopped: "Local gateway stopped",
    gatewaySkipped: "Gateway stopped; skipped user-edited {targets}",
    settingsSaved: "Settings saved",
    modelsFound: "Found {count} models",
    noModels: "Completed, but no models were recognized",
    healthDone: "Probe complete: {reachable} / {total} reachable",
    healthAllDone: "All probes complete: {reachable} / {total} profiles reachable",
    probePass: "Probe OK · {model} · TTFB {ttfb} · total {total}{usage}",
    probeFail: "Probe failed{status}{message}",
    autoSwitched: "Auto-switched to {url}",
    autoSwitchFailed: "Auto probe failed",
    refreshFailed: "{message}, but the view failed to refresh: {error}",
    upToDate: "Up to date {version}",
    updateCheckFailed: "Update check failed",
    unsupported: "Not supported in this build",
    assignedRunning: "{name} is now the gateway profile for {targets}",
    assignedStopped: "{name} set as the next-launch profile for {targets}",
    close: "Close",
    undo: "Undo",
  },
  errors: {
    profileNotFound: "Profile not found",
    nameRequired: "Enter a profile name",
    urlInvalid: "Enter a valid HTTP(S) API URL",
    urlCredentials: "API URL cannot contain credentials or fragments",
    urlDuplicate: "API URLs must be unique",
    urlActiveRequired: "Select an active URL",
    keyRequired: "Enter an API key",
    targetRequired: "Select at least one client",
    urlAtLeastOne: "Keep at least one API URL",
  },
  window: { minimize: "Minimize", maximize: "Maximize / Restore", close: "Close" },
  footer: {
    sealed: "DPAPI SEALED",
    profiles: "PROFILES",
    clients: "CLIENTS",
    preview: "PREVIEW",
  },
};

export const MESSAGES: Record<Locale, Messages> = { zh, "zh-TW": zhTW, ja, en };

export const LOCALE_LABELS: Record<Locale, string> = {
  zh: "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語",
  en: "English",
};

/** 台湾 / 香港 / 澳门，以及显式声明 Hant 字集的标签，都走繁体。 */
const TRADITIONAL = /^zh-(tw|hk|mo)\b|hant/;

/** 从系统语言推断界面语言，无法匹配时回退简体中文。 */
export function detectLocale(): Locale {
  const languages = typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language];
  for (const language of languages) {
    const tag = language.toLowerCase();
    if (tag.startsWith("zh")) return TRADITIONAL.test(tag) ? "zh-TW" : "zh";
    if (tag.startsWith("ja")) return "ja";
    if (tag.startsWith("en")) return "en";
  }
  return "zh";
}
