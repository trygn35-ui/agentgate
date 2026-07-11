import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { CHANNELS, registerIpcHandlers } = require("../electron/services/ipc.cjs");

function createHarness({ gatewayRoutes = [], gatewayStatus, ...overrides } = {}) {
  const handlers = new Map();
  const trace = [];
  const profile = {
    id: "00000000-0000-4000-8000-000000000901",
    name: "IPC 夹具",
    protocol: "openai-responses",
    baseUrl: "https://api.example.com/v1",
    endpoints: [{ url: "https://api.example.com/v1", models: [] }],
    model: "gpt-test",
    authMode: "bearer",
    targets: ["codex"],
    enableToolSearch: false,
    autoSwitch: { enabled: false, intervalMinutes: 5 },
  };
  const dependencies = {
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    clipboard: { writeText: vi.fn() },
    profileService: {
      list: vi.fn().mockResolvedValue([profile]),
      save: vi.fn().mockImplementation(async (input) => {
        trace.push("save");
        return { ...profile, ...input };
      }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
    },
    clientService: {
      scan: vi.fn().mockResolvedValue([]),
      openConfig: vi.fn(),
    },
    healthService: {
      test: vi.fn().mockImplementation(async () => {
        trace.push("test");
        return { ...profile, availableModels: ["gpt-test"] };
      }),
      testHealth: vi.fn().mockImplementation(async () => ({
        ...profile,
        endpoints: profile.endpoints.map((endpoint) => ({
          ...endpoint,
          health: { status: "healthy", latencyMs: 123 },
        })),
      })),
    },
    applyService: {
      listHistory: vi.fn().mockResolvedValue([]),
      listVerifiedTargets: vi.fn().mockResolvedValue([]),
      withLifecycleLock: vi.fn().mockImplementation((operation) => operation({})),
      assignProfile: vi.fn().mockImplementation(async (_id, targets) => ({
        assignedTargets: targets || profile.targets,
        gateway: {
          status: gatewayStatus ?? (gatewayRoutes.length > 0 ? "running" : "stopped"),
          host: "127.0.0.1",
          port: 17863,
          targets: gatewayRoutes.map((route) => route.target),
          routes: gatewayRoutes,
        },
      })),
      startGateway: vi.fn().mockResolvedValue(undefined),
      stopGateway: vi.fn().mockResolvedValue({ skippedTargets: ["codex"] }),
    },
    gatewayService: {
      getPublicState: vi.fn().mockImplementation(() => ({
        status: gatewayStatus ?? (gatewayRoutes.length > 0 ? "running" : "stopped"),
        host: "127.0.0.1",
        port: 17863,
        targets: gatewayRoutes.map((route) => route.target),
        routes: gatewayRoutes,
      })),
      refreshProfile: vi.fn().mockImplementation(async () => {
        trace.push("refresh");
      }),
      unassignRoutes: vi.fn().mockResolvedValue({
        targets: gatewayRoutes.map((route) => route.target),
        routes: Object.fromEntries(gatewayRoutes.map((route) => [route.target, route.profileId])),
      }),
      restoreRoutes: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
  registerIpcHandlers(dependencies);
  return { handlers, trace, profile, dependencies };
}

function saveInput(profile, overrides = {}) {
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    endpoints: profile.endpoints.map(({ url }) => ({ url })),
    apiKey: "",
    model: profile.model,
    authMode: profile.authMode,
    targets: [...profile.targets],
    enableToolSearch: profile.enableToolSearch,
    autoSwitch: { ...profile.autoSwitch },
    ...overrides,
  };
}

describe("IPC gateway coordination", () => {
  it("保存方案只刷新网关连接，不自动识别模型", async () => {
    const { handlers, trace, profile } = createHarness();

    const result = await handlers.get(CHANNELS.saveProfile)(null, saveInput(profile));

    expect(trace).toEqual(["save", "refresh"]);
    expect(result).toMatchObject({ id: profile.id });
  });

  it.each([
    ["protocol", { protocol: "openai-chat" }],
  ])("活动路由在保存前拒绝修改 %s", async (field, change) => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, profile, dependencies } = createHarness({ gatewayRoutes: [route] });

    await expect(handlers.get(CHANNELS.saveProfile)(
      null,
      saveInput(profile, change),
    )).rejects.toThrow(field);

    expect(dependencies.profileService.save).not.toHaveBeenCalled();
    expect(dependencies.gatewayService.refreshProfile).not.toHaveBeenCalled();
    expect(dependencies.healthService.test).not.toHaveBeenCalled();
  });

  it("活动路由允许 URL、Key、模型和名称热刷新", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, trace, profile } = createHarness({ gatewayRoutes: [route] });

    await handlers.get(CHANNELS.saveProfile)(null, saveInput(profile, {
      name: "新的名称",
      baseUrl: "https://fast.example.com/v1",
      endpoints: [{ url: "https://fast.example.com/v1" }],
      apiKey: "sk-new",
      model: "gpt-new",
      autoSwitch: { enabled: true, intervalMinutes: 15 },
    }));

    expect(trace).toEqual(["save", "refresh"]);
  });

  it("等待生命周期锁时新激活的路由拒绝修改协议", async () => {
    const field = "protocol";
    const change = { protocol: "openai-chat" };
    const routes = [];
    let enterLock;
    const lockReady = new Promise((resolve) => {
      enterLock = resolve;
    });
    const withLifecycleLock = vi.fn().mockImplementation(async (operation) => {
      await lockReady;
      return operation({});
    });
    const { handlers, profile, dependencies } = createHarness({
      gatewayRoutes: routes,
      applyService: {
        listHistory: vi.fn().mockResolvedValue([]),
        listVerifiedTargets: vi.fn().mockResolvedValue([]),
        withLifecycleLock,
        stopGateway: vi.fn().mockResolvedValue({}),
      },
    });

    const saving = handlers.get(CHANNELS.saveProfile)(null, saveInput(profile, change));
    routes.push({ target: "codex", profileId: profile.id });
    enterLock();

    await expect(saving).rejects.toThrow(field);
    expect(dependencies.profileService.save).not.toHaveBeenCalled();
  });

  it("等待生命周期锁时新激活的路由仍允许保存 URL", async () => {
    const routes = [];
    let enterLock;
    const lockReady = new Promise((resolve) => {
      enterLock = resolve;
    });
    const withLifecycleLock = vi.fn().mockImplementation(async (operation) => {
      await lockReady;
      return operation({});
    });
    const { handlers, trace, profile } = createHarness({
      gatewayRoutes: routes,
      applyService: {
        listHistory: vi.fn().mockResolvedValue([]),
        listVerifiedTargets: vi.fn().mockResolvedValue([]),
        withLifecycleLock,
        stopGateway: vi.fn().mockResolvedValue({}),
      },
    });

    const saving = handlers.get(CHANNELS.saveProfile)(null, saveInput(profile, {
      baseUrl: "https://fast.example.com/v1",
      endpoints: [{ url: "https://fast.example.com/v1" }],
    }));
    routes.push({ target: "codex", profileId: profile.id });
    enterLock();

    await expect(saving).resolves.toBeDefined();
    expect(trace).toEqual(["save", "refresh"]);
  });

  it("活动路由保存空模型方案时不通过自动测速补写模型", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, trace, profile, dependencies } = createHarness({ gatewayRoutes: [route] });
    profile.model = "";

    const result = await handlers.get(CHANNELS.saveProfile)(null, saveInput(profile, {
      name: "仍允许修改名称",
    }));

    expect(result.model).toBe("");
    expect(trace).toEqual(["save", "refresh"]);
    expect(dependencies.healthService.test).not.toHaveBeenCalled();
  });

  it("活动路由的空模型方案仍可手动识别模型", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, profile, dependencies } = createHarness({ gatewayRoutes: [route] });
    profile.model = "";

    await expect(handlers.get(CHANNELS.testProfile)(null, profile.id))
      .resolves.toBeDefined();
    expect(dependencies.healthService.test).toHaveBeenCalledWith(profile.id);
  });

  it("端点检测使用无凭据健康探测且不触发模型识别", async () => {
    const { handlers, profile, dependencies } = createHarness();
    await expect(handlers.get(CHANNELS.checkProfileHealth)(null, profile.id))
      .resolves.toBeDefined();
    expect(dependencies.healthService.testHealth).toHaveBeenCalledWith(profile.id);
    expect(dependencies.healthService.test).not.toHaveBeenCalled();
  });

  it("手动识别模型不依赖应用生命周期锁", async () => {
    const routes = [];
    let enterLock;
    const lockReady = new Promise((resolve) => {
      enterLock = resolve;
    });
    const withLifecycleLock = vi.fn().mockImplementation(async (operation) => {
      await lockReady;
      return operation({});
    });
    const { handlers, profile, dependencies } = createHarness({
      gatewayRoutes: routes,
      applyService: {
        listHistory: vi.fn().mockResolvedValue([]),
        listVerifiedTargets: vi.fn().mockResolvedValue([]),
        withLifecycleLock,
        stopGateway: vi.fn().mockResolvedValue({}),
      },
    });
    profile.model = "";

    const testing = handlers.get(CHANNELS.testProfile)(null, profile.id);
    routes.push({ target: "codex", profileId: profile.id });
    enterLock();

    await expect(testing).resolves.toBeDefined();
    expect(dependencies.healthService.test).toHaveBeenCalledWith(profile.id);
  });

  it("应用方案只分配网关路由并返回 assigned targets", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, profile, dependencies } = createHarness({ gatewayRoutes: [route] });

    const result = await handlers.get(CHANNELS.applyProfile)(null, profile.id, ["codex"]);

    expect(dependencies.applyService.assignProfile).toHaveBeenCalledWith(profile.id, ["codex"]);
    expect(result.assignedTargets).toEqual(["codex"]);
    expect(result.historyEntry).toBeUndefined();
    expect(result.gateway.routes[0]).toMatchObject({
      target: "codex",
      profileId: profile.id,
      profileName: profile.name,
    });
  });

  it("停止网关时把未覆盖的用户漂移目标返回给界面", async () => {
    const { handlers } = createHarness();

    const result = await handlers.get(CHANNELS.stopGateway)();

    expect(result.gateway.status).toBe("stopped");
    expect(result.gatewayRecovery).toEqual({ skippedTargets: ["codex"] });
  });

  it("网关关闭时删除方案会同时移除引用它的预设路由", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, profile, dependencies } = createHarness({
      gatewayRoutes: [route],
      gatewayStatus: "stopped",
    });

    await expect(handlers.get(CHANNELS.deleteProfile)(null, profile.id))
      .resolves.toEqual({ ok: true });
    expect(dependencies.gatewayService.unassignRoutes).toHaveBeenCalledWith(["codex"]);
    expect(dependencies.profileService.delete).toHaveBeenCalledWith(profile.id);
    expect(dependencies.gatewayService.restoreRoutes).not.toHaveBeenCalled();
  });

  it("网关运行时拒绝删除仍被路由引用的方案", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, profile, dependencies } = createHarness({ gatewayRoutes: [route] });

    await expect(handlers.get(CHANNELS.deleteProfile)(null, profile.id))
      .rejects.toThrow("turn off the local gateway");
    expect(dependencies.gatewayService.unassignRoutes).not.toHaveBeenCalled();
    expect(dependencies.profileService.delete).not.toHaveBeenCalled();
  });
});
