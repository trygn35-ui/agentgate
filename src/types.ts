export type Protocol =
  | "anthropic"
  | "openai-responses"
  | "openai-chat"
  | "gemini";

export type ClientTarget = "claude" | "codex" | "opencode" | "gemini";

export type AuthMode = "api-key" | "bearer";

export type HealthState = "unknown" | "healthy" | "limited" | "unhealthy";

export interface HealthSample {
  checkedAt: string;
  reachable?: boolean;
  latencyMs?: number;
  statusCode?: number;
  message?: string;
}

export interface HealthResult {
  status: HealthState;
  latencyMs?: number;
  checkedAt?: string;
  statusCode?: number;
  message?: string;
}

export interface ProfileEndpoint {
  url: string;
  health?: HealthResult;
  healthHistory?: HealthSample[];
  healthTimeline?: HealthSample[];
  models: string[];
}

export interface AutoSwitchSettings {
  enabled: boolean;
  intervalMinutes: number;
}

export interface Profile {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  endpoints: ProfileEndpoint[];
  availableModels: string[];
  keyHint: string;
  model: string;
  authMode: AuthMode;
  targets: ClientTarget[];
  enableToolSearch?: boolean;
  autoSwitch: AutoSwitchSettings;
  createdAt: string;
  updatedAt: string;
  lastAppliedAt?: string;
  health?: HealthResult;
  modelsCheckedAt?: string;
  /** 该 Key 经网关转发累计消耗的 Token 数。 */
  tokenUsageTotal?: number;
  /** 累计输入 Token，用于计算平均缓存率。 */
  tokenInputTotal?: number;
  /** 累计缓存命中 Token。 */
  tokenCachedTotal?: number;
  /** 当日用量所属的本地日期（YYYY-MM-DD）；跨日后重新计数。 */
  tokenDayKey?: string;
  /** 当日累计 Token，本地 0 点重置。 */
  tokenUsageToday?: number;
}

export interface SaveProfileInput {
  id?: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  endpoints: Array<{ url: string }>;
  apiKey?: string;
  model: string;
  authMode: AuthMode;
  targets: ClientTarget[];
  enableToolSearch?: boolean;
  autoSwitch: AutoSwitchSettings;
}

export interface ClientStatus {
  target: ClientTarget;
  label: string;
  path: string;
  installed: boolean;
  activeProfileId?: string;
  activeProfileName?: string;
  baseUrl?: string;
  drifted?: boolean;
  warning?: string;
  viaGateway?: boolean;
}

export interface HistoryEntry {
  id: string;
  profileId: string;
  profileName: string;
  targets: ClientTarget[];
  createdAt: string;
  success: boolean;
  message?: string;
  canUndo: boolean;
  source?: "manual" | "auto";
  connectionMode?: "direct" | "gateway";
}

export type GatewayRuntimeStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export interface GatewayRoute {
  target: ClientTarget;
  profileId: string;
  profileName: string;
  protocol: Protocol;
  activatedAt: string;
}

export interface GatewayState {
  status: GatewayRuntimeStatus;
  host: "127.0.0.1";
  port: number;
  targets: ClientTarget[];
  routes: GatewayRoute[];
  startedAt?: string;
  error?: string;
}

export interface GatewayRuntimeEvent {
  status: GatewayRuntimeStatus;
  host: "127.0.0.1";
  port: number;
  targets: ClientTarget[];
  routes: Array<Pick<GatewayRoute, "target" | "profileId">>;
  localBaseUrls: Partial<Record<ClientTarget, string>>;
  startedAt?: string;
  error?: string;
}

export interface GatewayStartSettings {
  port?: number;
}

export type AppTheme = "system" | "light" | "dark";

export type AppLanguage = "system" | "zh" | "zh-TW" | "ja" | "en";

export interface AppSettings {
  launchAtLogin: boolean;
  closeToTray: boolean;
  startGatewayOnLaunch: boolean;
  theme: AppTheme;
  language: AppLanguage;
  experimentalToolBridge: boolean;
}

export type ActiveRequestState =
  | "connecting"
  | "waiting-first-token"
  | "streaming"
  | "completed"
  | "failed"
  | "aborted"
  | "cancelled";

export interface RequestTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface ActiveRequest {
  id: string;
  client: ClientTarget | string;
  profileId?: string;
  profileName: string;
  keyHint?: string;
  upstreamUrl: string;
  protocol?: Protocol;
  state: ActiveRequestState;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  firstTokenLatencyMs?: number;
  firstByteLatencyMs?: number;
  statusCode?: number;
  model?: string;
  reasoningEffort?: string;
  streaming?: boolean;
  outcome?: "completed" | "failed" | "aborted" | "cancelled";
  tokenUsage?: RequestTokenUsage;
  receivedBytes?: number;
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "error";

/** 应用更新状态。便携版不能就地更新，只提示新版本。 */
export interface UpdateState {
  state: UpdateStatus;
  currentVersion: string;
  portable: boolean;
  version?: string;
  percent?: number;
  message?: string;
  releaseNotes?: string;
}

export type StateChangedEvent =
  | {
      type: "profile-tested" | "auto-switch-error";
      profileId: string;
      switched?: boolean;
      previousBaseUrl?: string;
      baseUrl?: string;
      targets?: ClientTarget[];
      message?: string;
    }
  | {
      type: "gateway-state-changed";
      gateway: GatewayRuntimeEvent;
    }
  | {
      type: "active-requests-changed";
      activeRequests: ActiveRequest[];
    }
  | {
      type: "settings-changed";
      settings: AppSettings;
    }
  | {
      type: "update-state-changed";
      update: UpdateState;
    };

export interface BootstrapData {
  profiles: Profile[];
  clients: ClientStatus[];
  history: HistoryEntry[];
  gateway: GatewayState;
  settings?: AppSettings;
  activeRequests?: ActiveRequest[];
  update?: UpdateState;
  gatewayRecovery?: {
    skippedTargets: ClientTarget[];
  };
}

/** 渠道实测结果：发送最小消息后的可用性、时延与上游计量摘要。 */
export interface ProbeResult {
  ok: boolean;
  statusCode?: number;
  firstByteMs: number;
  totalMs: number;
  model: string;
  checkedAt: string;
  /** 上游响应中报告的 Token 计量；用于识别中转注入的前缀。 */
  tokenUsage?: RequestTokenUsage;
  message?: string;
}

export interface ApplyResult {
  profile: Profile;
  clients: ClientStatus[];
  gateway: GatewayState;
  assignedTargets: ClientTarget[];
  historyEntry?: HistoryEntry;
}

/**
 * preload 向渲染进程公开的受限主进程接口。
 *
 * 所有 Promise 都可能因参数校验、DPAPI、网络或文件系统错误而拒绝；调用方必须
 * 显式处理失败。接口不会返回明文 Key。
 */
export interface AgentGateBridge {
  /** 读取方案、客户端扫描状态和公开历史。 */
  getBootstrap(): Promise<BootstrapData>;
  /** 新建或更新方案；编辑时缺失 apiKey 表示保留现有密文。 */
  saveProfile(input: SaveProfileInput): Promise<Profile>;
  /** 在主进程内复制方案设置并重新加密同一 Key。 */
  duplicateProfile(id: string): Promise<Profile>;
  /** 按给定顺序持久化方案排序。旧版 preload 可能暂未提供。 */
  reorderProfiles?(ids: string[]): Promise<Profile[]>;
  /** 删除管理库中的方案，不修改客户端配置。 */
  deleteProfile(id: string): Promise<void>;
  /** 由主进程将方案 Key 写入系统剪贴板。 */
  copyProfileKey(id: string): Promise<void>;
  /** 直接探测全部 URL 的模型列表并返回更新后的公开方案。 */
  testProfile(id: string): Promise<Profile>;
  /** 无凭据检测全部 URL 的可达性和延迟，不识别模型。 */
  checkProfileHealth(id: string): Promise<Profile>;
  /** 用真实 Key 发送最小消息实测渠道可用性与时延。旧版 preload 可能暂未提供。 */
  probeProfile?(id: string): Promise<ProbeResult>;
  /** 将方案分配给指定客户端，缺失 targets 时使用方案的全部适用客户端。 */
  applyProfile(id: string, targets?: ClientTarget[]): Promise<ApplyResult>;
  /** 在当前配置未被外部修改时恢复指定事务的加密快照。 */
  undoHistory(id: string): Promise<BootstrapData>;
  /** 在资源管理器中打开客户端配置位置。 */
  openConfig(target: ClientTarget): Promise<void>;
  /** 启动本地透明网关并接管已有方案分配的客户端。 */
  startGateway(settings: GatewayStartSettings): Promise<BootstrapData>;
  /** 恢复接管前的受管字段，保留方案分配并停止网关。 */
  stopGateway(): Promise<BootstrapData>;
  /** 更新应用行为设置。旧版 preload 可能暂未提供。 */
  updateSettings?(patch: Partial<AppSettings>): Promise<AppSettings | BootstrapData>;
  /** 无边框窗口的最小化/最大化/关闭控制。仅桌面环境提供。 */
  windowControl?(action: "minimize" | "maximize" | "close"): Promise<void>;
  /** 检查 GitHub Releases 上是否有新版本。 */
  checkForUpdate?(): Promise<UpdateState>;
  /** 下载已发现的更新；便携版改为打开下载页。 */
  downloadUpdate?(): Promise<UpdateState>;
  /** 停止网关、恢复客户端配置后退出并安装更新。 */
  installUpdate?(): Promise<{ ok: boolean }>;
  /** 订阅主进程定时检测和自动切换事件。 */
  onStateChanged(listener: (event: StateChangedEvent) => void): () => void;
}

declare global {
  interface Window {
    agentgate?: AgentGateBridge;
  }
}
