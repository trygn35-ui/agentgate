import type {
  BootstrapData,
  ClientStatus,
  ClientTarget,
  GatewayStartSettings,
  GatewayState,
  HistoryEntry,
  KeydeckBridge,
  Profile,
  SaveProfileInput,
  AppSettings,
  HealthSample,
} from "../types";
import { DEFAULT_SETTINGS } from "../config";

const now = new Date();
const minutesAgo = (minutes: number) =>
  new Date(now.getTime() - minutes * 60_000).toISOString();
const secondsAgo = (seconds: number) =>
  new Date(now.getTime() - seconds * 1_000).toISOString();

const healthSamples = (baseLatency: number, failedAt: number[] = []): HealthSample[] => (
  Array.from({ length: 60 }, (_, index) => ({
    checkedAt: minutesAgo((59 - index) * 2),
    reachable: !failedAt.includes(index),
    ...(!failedAt.includes(index) ? { latencyMs: baseLatency + ((index * 17) % 74) - 28, statusCode: 204 } : { message: "连接超时" }),
  }))
);

const healthData = (baseLatency: number, failedAt: number[] = []) => {
  const healthTimeline = healthSamples(baseLatency, failedAt);
  return { healthHistory: healthTimeline.slice(-30), healthTimeline };
};

let mockProfiles: Profile[] = [
  {
    id: "relay-a",
    name: "主力中转",
    protocol: "anthropic",
    baseUrl: "https://api.relay-a.example",
    endpoints: [
      {
        url: "https://api.relay-a.example",
        models: ["claude-sonnet-4-5", "claude-opus-4-1"],
        health: { status: "healthy", latencyMs: 186, checkedAt: minutesAgo(2) },
        ...healthData(186),
      },
      {
        url: "https://api.relay-a-backup.example",
        models: ["claude-sonnet-4-5"],
        health: { status: "healthy", latencyMs: 268, checkedAt: minutesAgo(2) },
        ...healthData(268, [5]),
      },
    ],
    availableModels: ["claude-sonnet-4-5", "claude-opus-4-1"],
    keyHint: "•••• 18F2",
    model: "claude-sonnet-4-5",
    authMode: "bearer",
    targets: ["claude", "opencode"],
    enableToolSearch: true,
    autoSwitch: { enabled: true, intervalMinutes: 2 },
    createdAt: minutesAgo(2400),
    updatedAt: minutesAgo(18),
    lastAppliedAt: minutesAgo(18),
    health: { status: "healthy", latencyMs: 186, checkedAt: minutesAgo(2) },
    tokenUsageTotal: 12_480_000,
  },
  {
    id: "openai-main",
    name: "Codex 日常",
    protocol: "openai-responses",
    baseUrl: "https://gateway.work.example/v1",
    endpoints: [{
      url: "https://gateway.work.example/v1",
      models: ["gpt-5.2-codex", "gpt-5.2"],
      health: { status: "healthy", latencyMs: 243, checkedAt: minutesAgo(8) },
      ...healthData(243, [9, 10]),
    }],
    availableModels: ["gpt-5.2-codex", "gpt-5.2"],
    keyHint: "•••• 71C3",
    model: "gpt-5.2-codex",
    authMode: "bearer",
    targets: ["codex", "opencode"],
    autoSwitch: { enabled: false, intervalMinutes: 2 },
    createdAt: minutesAgo(1800),
    updatedAt: minutesAgo(51),
    health: { status: "healthy", latencyMs: 243, checkedAt: minutesAgo(8) },
    tokenUsageTotal: 863_200,
  },
  {
    id: "gemini-fast",
    name: "Gemini 快速",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    endpoints: [{
      url: "https://generativelanguage.googleapis.com",
      models: [],
    }],
    availableModels: [],
    keyHint: "•••• 90A1",
    model: "gemini-2.5-flash",
    authMode: "api-key",
    targets: ["gemini"],
    autoSwitch: { enabled: false, intervalMinutes: 2 },
    createdAt: minutesAgo(900),
    updatedAt: minutesAgo(90),
    health: { status: "unknown" },
  },
];

let mockClients: ClientStatus[] = [
  {
    target: "claude",
    label: "Claude Code",
    path: "~/.claude/settings.json",
    installed: true,
    activeProfileId: "relay-a",
    activeProfileName: "主力中转",
    baseUrl: "https://api.relay-a.example",
  },
  {
    target: "codex",
    label: "Codex",
    path: "~/.codex/config.toml",
    installed: true,
    activeProfileName: "外部配置",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    target: "opencode",
    label: "OpenCode",
    path: "~/.config/opencode/opencode.json",
    installed: true,
  },
  {
    target: "gemini",
    label: "Gemini CLI",
    path: "~/.gemini/.env",
    installed: false,
  },
];

let mockClientBaselines: Partial<Record<ClientTarget, ClientStatus>> = {};

let mockHistory: HistoryEntry[] = [
  {
    id: "history-1",
    profileId: "relay-a",
    profileName: "主力中转",
    targets: ["claude", "opencode"],
    createdAt: minutesAgo(18),
    success: true,
    canUndo: true,
  },
];

let mockGateway: GatewayState = {
  status: "stopped",
  host: "127.0.0.1",
  port: 17863,
  targets: ["claude", "opencode"],
  routes: ["claude", "opencode"].map((target) => ({
    target: target as ClientTarget,
    profileId: "relay-a",
    profileName: "主力中转",
    protocol: "anthropic" as const,
    activatedAt: minutesAgo(18),
  })),
};

let mockSettings: AppSettings = { ...DEFAULT_SETTINGS };

const mockRequests = [
  {
    id: "request-active",
    client: "codex" as const,
    profileId: "openai-main",
    profileName: "Codex 日常",
    keyHint: "•••• 71C3",
    upstreamUrl: "https://gateway.work.example/v1/responses",
    protocol: "openai-responses" as const,
    state: "streaming" as const,
    startedAt: secondsAgo(8),
    firstByteLatencyMs: 312,
    firstTokenLatencyMs: 842,
    statusCode: 200,
    model: "gpt-5.2-codex",
    reasoningEffort: "high",
    streaming: true,
    receivedBytes: 84_320,
    tokenUsage: { inputTokens: 25_249, outputTokens: 1_832, cachedTokens: 14_720, reasoningTokens: 640, totalTokens: 27_081 },
  },
  {
    id: "request-completed",
    client: "codex" as const,
    profileId: "openai-main",
    profileName: "Codex 日常",
    keyHint: "•••• 71C3",
    upstreamUrl: "https://gateway.work.example/v1/responses",
    protocol: "openai-responses" as const,
    state: "completed" as const,
    outcome: "completed" as const,
    startedAt: secondsAgo(75),
    completedAt: secondsAgo(60),
    durationMs: 15_300,
    firstByteLatencyMs: 288,
    firstTokenLatencyMs: 2_440,
    statusCode: 200,
    model: "gpt-5.2-codex",
    reasoningEffort: "medium",
    streaming: true,
    receivedBytes: 147_200,
    tokenUsage: { inputTokens: 21_904, outputTokens: 2_118, cachedTokens: 10_240, reasoningTokens: 384, totalTokens: 24_022 },
  },
  {
    id: "request-failed",
    client: "claude" as const,
    profileId: "relay-a",
    profileName: "主力中转",
    keyHint: "•••• 18F2",
    upstreamUrl: "https://api.relay-a.example/v1/messages",
    protocol: "anthropic" as const,
    state: "failed" as const,
    outcome: "failed" as const,
    startedAt: secondsAgo(145),
    completedAt: secondsAgo(143),
    durationMs: 1_860,
    firstByteLatencyMs: 1_820,
    statusCode: 502,
    model: "claude-sonnet-4-5",
    reasoningEffort: "high",
    streaming: true,
    receivedBytes: 226,
  },
];

const clone = <T,>(value: T): T => structuredClone(value);

function getMockKeyHint(input: SaveProfileInput, existing?: Profile): string {
  const apiKey = input.apiKey?.trim();
  if (apiKey) return `•••• ${apiKey.slice(-4).toUpperCase()}`;
  return existing?.keyHint ?? "•••• NEW";
}

const mockBridge: KeydeckBridge = {
  async getBootstrap(): Promise<BootstrapData> {
    return clone({
      profiles: mockProfiles,
      clients: mockClients,
      history: mockHistory,
      gateway: mockGateway,
      settings: mockSettings,
      activeRequests: mockRequests,
    });
  },

  async saveProfile(input: SaveProfileInput) {
    const existing = input.id
      ? mockProfiles.find((profile) => profile.id === input.id)
      : undefined;
    const timestamp = new Date().toISOString();
    const endpoints = input.endpoints.map((endpoint) => {
      const previous = existing?.endpoints.find((item) => item.url === endpoint.url);
      return previous ?? { url: endpoint.url, models: [] };
    });
    const activeEndpoint = endpoints.find((endpoint) => endpoint.url === input.baseUrl)
      ?? endpoints[0];
    const profile: Profile = {
      ...input,
      baseUrl: activeEndpoint.url,
      endpoints,
      availableModels: activeEndpoint.models,
      id: existing?.id ?? crypto.randomUUID(),
      keyHint: getMockKeyHint(input, existing),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      lastAppliedAt: existing?.lastAppliedAt,
      health: existing?.health ?? { status: "unknown" },
    };
    delete (profile as Profile & { apiKey?: string }).apiKey;
    if (existing) {
      mockProfiles = mockProfiles.map((item) => (
        item.id === profile.id ? profile : item
      ));
    } else {
      mockProfiles = [profile, ...mockProfiles];
    }
    return clone(profile);
  },

  async reorderProfiles(ids: string[]) {
    const byId = new Map(mockProfiles.map((profile) => [profile.id, profile]));
    const ordered: Profile[] = [];
    for (const id of ids) {
      const profile = byId.get(id);
      if (!profile) continue;
      byId.delete(id);
      ordered.push(profile);
    }
    for (const profile of mockProfiles) {
      if (byId.has(profile.id)) ordered.push(profile);
    }
    mockProfiles = ordered;
    return clone(mockProfiles);
  },

  async duplicateProfile(id: string) {
    const sourceIndex = mockProfiles.findIndex((profile) => profile.id === id);
    if (sourceIndex === -1) throw new Error("方案不存在");
    const source = mockProfiles[sourceIndex];
    const timestamp = new Date().toISOString();
    const duplicate: Profile = {
      ...clone(source),
      id: crypto.randomUUID(),
      name: `${source.name} 副本`,
      endpoints: source.endpoints.map((endpoint) => ({ url: endpoint.url, models: [] })),
      availableModels: [],
      autoSwitch: { ...source.autoSwitch, enabled: false },
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAppliedAt: undefined,
      health: undefined,
      modelsCheckedAt: undefined,
    };
    mockProfiles.splice(sourceIndex + 1, 0, duplicate);
    return clone(duplicate);
  },

  async deleteProfile(id: string) {
    mockProfiles = mockProfiles.filter((profile) => profile.id !== id);
  },

  async copyProfileKey() {
    await navigator.clipboard?.writeText("mock-key-hidden-in-browser-preview");
  },

  async testProfile(id: string): Promise<Profile> {
    const source = mockProfiles.find((profile) => profile.id === id);
    if (!source) throw new Error("方案不存在");
    const discoveredModels = source.protocol === "gemini"
      ? ["gemini-2.5-flash", "gemini-2.5-pro"]
      : source.protocol === "anthropic"
        ? ["claude-sonnet-4-5", "claude-opus-4-1"]
        : ["gpt-5.2-codex", "gpt-5.2"];
    const checkedAt = new Date().toISOString();
    const endpoints = source.endpoints.map((endpoint, index) => ({
      ...endpoint,
      models: discoveredModels,
      health: {
        status: "healthy" as const,
        latencyMs: 128 + index * 86,
        checkedAt,
      },
    }));
    const activeEndpoint = endpoints.find((endpoint) => endpoint.url === source.baseUrl)
      ?? endpoints[0];
    const tested: Profile = {
      ...source,
      endpoints,
      availableModels: activeEndpoint.models,
      health: activeEndpoint.health,
      modelsCheckedAt: checkedAt,
    };
    mockProfiles = mockProfiles.map((profile) => profile.id === id ? tested : profile);
    return clone(tested);
  },

  async probeProfile(id: string) {
    const source = mockProfiles.find((profile) => profile.id === id);
    if (!source) throw new Error("方案不存在");
    const model = source.model || source.availableModels[0];
    if (!model) throw new Error("请先设置模型 ID 或识别模型后再实测");
    await new Promise((resolve) => setTimeout(resolve, 700));
    return {
      ok: true,
      statusCode: 200,
      firstByteMs: 486,
      totalMs: 1_240,
      model,
      checkedAt: new Date().toISOString(),
      tokenUsage: { inputTokens: 9, outputTokens: 12, totalTokens: 21 },
    };
  },

  async checkProfileHealth(id: string): Promise<Profile> {
    const source = mockProfiles.find((profile) => profile.id === id);
    if (!source) throw new Error("方案不存在");
    const checkedAt = new Date().toISOString();
    const endpoints = source.endpoints.map((endpoint, index) => {
      const sample = {
        checkedAt,
        reachable: true,
        latencyMs: 156 + index * 88,
        statusCode: 204,
        message: "端点可达",
      };
      return {
        ...endpoint,
        health: { status: "healthy" as const, ...sample },
        healthHistory: [...(endpoint.healthHistory ?? []), sample].slice(-30),
        healthTimeline: [
          ...(endpoint.healthTimeline?.length ? endpoint.healthTimeline : endpoint.healthHistory ?? []),
          sample,
        ].slice(-60),
      };
    });
    const activeEndpoint = endpoints.find((endpoint) => endpoint.url === source.baseUrl)
      ?? endpoints[0];
    const tested: Profile = { ...source, endpoints, health: activeEndpoint.health };
    mockProfiles = mockProfiles.map((profile) => profile.id === id ? tested : profile);
    return clone(tested);
  },

  async applyProfile(id: string, targets?: ClientTarget[]) {
    const profile = mockProfiles.find((item) => item.id === id);
    if (!profile) throw new Error("方案不存在");
    const appliedTargets = targets?.length ? targets : profile.targets;
    const timestamp = new Date().toISOString();
    const gatewayTargets = appliedTargets;
    const nextProfile = { ...profile, lastAppliedAt: timestamp };
    mockProfiles = mockProfiles.map((item) => (item.id === id ? nextProfile : item));
    if (gatewayTargets.length > 0) {
      const retainedRoutes = mockGateway.routes.filter(
        (route) => !gatewayTargets.includes(route.target),
      );
      mockGateway = {
        ...mockGateway,
        targets: [...new Set([...mockGateway.targets, ...gatewayTargets])],
        routes: [
          ...retainedRoutes,
          ...gatewayTargets.map((target) => ({
            target,
            profileId: profile.id,
            profileName: profile.name,
            protocol: profile.protocol,
            activatedAt: timestamp,
          })),
        ],
      };
    }
    mockClients = mockClients.map((client) =>
      appliedTargets.includes(client.target) && mockGateway.status === "running"
        ? {
            ...client,
            installed: true,
            activeProfileId: id,
            activeProfileName: profile.name,
            baseUrl: gatewayTargets.includes(client.target) && mockGateway.status === "running"
              ? `http://127.0.0.1:${mockGateway.port}/${client.target}`
              : client.baseUrl,
            drifted: false,
            viaGateway: gatewayTargets.includes(client.target) && mockGateway.status === "running",
          }
        : client,
    );
    return clone({
      profile: nextProfile,
      clients: mockClients,
      gateway: mockGateway,
      assignedTargets: appliedTargets,
    });
  },

  async undoHistory(id: string) {
    mockHistory = mockHistory.map((entry) =>
      entry.id === id ? { ...entry, canUndo: false } : entry,
    );
    return clone({
      profiles: mockProfiles,
      clients: mockClients,
      history: mockHistory,
      gateway: mockGateway,
    });
  },

  async openConfig() {},

  async startGateway(settings: GatewayStartSettings): Promise<BootstrapData> {
    if (mockGateway.routes.length === 0) throw new Error("请先把方案分配给至少一个客户端");
    const timestamp = new Date().toISOString();
    const port = settings.port ?? mockGateway.port ?? 17863;
    mockGateway = {
      status: "running",
      host: "127.0.0.1",
      port,
      targets: mockGateway.routes.map((route) => route.target),
      routes: mockGateway.routes,
      startedAt: timestamp,
    };
    mockClients = mockClients.map((client) => {
      const route = mockGateway.routes.find((item) => item.target === client.target);
      if (!route) return client;
      if (!mockClientBaselines[client.target]) {
        mockClientBaselines[client.target] = clone(client);
      }
      const profile = mockProfiles.find((item) => item.id === route.profileId);
      return {
        ...client,
        activeProfileId: profile?.id,
        activeProfileName: profile?.name,
        baseUrl: `http://127.0.0.1:${port}/${client.target}`,
        drifted: false,
        viaGateway: true,
      };
    });
    return clone({ profiles: mockProfiles, clients: mockClients, history: mockHistory, gateway: mockGateway });
  },

  async stopGateway(): Promise<BootstrapData> {
    mockClients = mockClients.map((client) => {
      const baseline = mockClientBaselines[client.target];
      return baseline ? clone(baseline) : client;
    });
    mockClientBaselines = {};
    mockGateway = {
      status: "stopped",
      host: "127.0.0.1",
      port: mockGateway.port,
      targets: mockGateway.targets,
      routes: mockGateway.routes,
    };
    return clone({ profiles: mockProfiles, clients: mockClients, history: mockHistory, gateway: mockGateway });
  },

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    mockSettings = { ...mockSettings, ...patch };
    return clone(mockSettings);
  },

  onStateChanged() {
    return () => {};
  },
};

/**
 * 渲染进程统一 API。Electron 中使用隔离的 preload 桥，纯浏览器预览使用内存实现。
 */
export const api: KeydeckBridge = window.keydeck ?? mockBridge;

/** 当前页面是否运行在具备本地文件权限的 Electron 容器中。 */
export const isDesktop = Boolean(window.keydeck);
