import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  GatewayService,
  GatewayStoreSchema,
  createRequestMetadataTap,
  defaultGatewayStore,
} = require("../electron/services/gateway-service.cjs");
const { RequestMonitorService } = require("../electron/services/request-monitor-service.cjs");

it("请求元数据 Tap 透明转发且只发布允许字段", async () => {
  const metadata = [];
  const tap = createRequestMetadataTap((patch) => metadata.push(patch));
  const chunks = [];
  tap.on("data", (chunk) => chunks.push(chunk));
  const ended = once(tap, "end");
  const body = JSON.stringify({
    model: "gpt-5.2-codex",
    stream: true,
    reasoning: { effort: "high" },
    input: [{ role: "user", content: "private prompt" }],
  });
  tap.end(body);
  await ended;
  expect(Buffer.concat(chunks).toString("utf8")).toBe(body);
  expect(metadata).toEqual(expect.arrayContaining([
    { model: "gpt-5.2-codex" },
    { streaming: true },
    { reasoningEffort: "high" },
  ]));
  expect(JSON.stringify(metadata)).not.toContain("private prompt");
});

it("请求元数据 Tap 丢弃超长字段且保持请求字节不变", async () => {
  const metadata = [];
  const tap = createRequestMetadataTap((patch) => metadata.push(patch));
  const chunks = [];
  tap.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const ended = once(tap, "end");
  const body = Buffer.from(JSON.stringify({
    model: "m".repeat(20_000),
    reasoning: { effort: "e".repeat(2_000) },
    input: "private-body",
  }), "utf8");
  tap.end(body);
  await ended;

  expect(Buffer.concat(chunks)).toEqual(body);
  expect(metadata).toEqual([]);
});

const PROFILE_A = "11111111-1111-4111-8111-111111111111";
const PROFILE_B = "22222222-2222-4222-8222-222222222222";
const activeServices = new Set();
const activeServers = new Set();

function memoryStore(initial = defaultGatewayStore()) {
  let value = structuredClone(initial);
  return {
    writes: [],
    async read() {
      return structuredClone(value);
    },
    async write(next) {
      value = GatewayStoreSchema.parse(structuredClone(next));
      this.writes.push(structuredClone(value));
      return structuredClone(value);
    },
    current() {
      return structuredClone(value);
    },
  };
}

const vault = {
  encrypt(value) {
    return Buffer.from(`gateway:${value}`, "utf8").toString("base64");
  },
  decrypt(value) {
    const clear = Buffer.from(value, "base64").toString("utf8");
    if (!clear.startsWith("gateway:")) throw new Error("测试网关密文无效");
    return clear.slice("gateway:".length);
  },
};

function profileService(connections) {
  return {
    async getConnection(id) {
      const connection = connections[id];
      if (!connection) throw new Error("Profile not found");
      return connection;
    },
  };
}

async function listen(handler, requestedPort = 0) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", resolve);
  });
  activeServers.add(server);
  const { port } = server.address();
  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
  activeServers.delete(server);
}

function rawRequest(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("aborted", () => reject(new Error("Response aborted")));
      response.once("error", reject);
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        chunks,
        body: Buffer.concat(chunks),
      }));
    });
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function abortUpload(url, headers) {
  return new Promise((resolve) => {
    const request = http.request(url, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "content-length": "1048576",
      },
    });
    request.once("error", resolve);
    request.write(Buffer.alloc(1024, 7));
    request.destroy();
  });
}

function interruptRejectedUpload(url, headers = {}) {
  return new Promise((resolve, reject) => {
    let responseStatus;
    const request = http.request(url, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "content-length": "1048576",
      },
    }, (response) => {
      responseStatus = response.statusCode;
      response.on("error", () => {});
      response.resume();
      request.destroy();
    });
    request.once("error", (error) => {
      if (responseStatus === undefined) reject(error);
    });
    request.once("close", () => resolve(responseStatus));
    request.write(Buffer.alloc(1024, 7));
  });
}

async function createGateway(connections, options = {}) {
  const store = options.store || memoryStore();
  const service = new GatewayService({
    profileService: profileService(connections),
    store,
    vault,
    ...(options.requestMonitor ? { requestMonitor: options.requestMonitor } : {}),
  });
  activeServices.add(service);
  if (options.initialize) await service.initialize();
  else await service.start({ port: options.port ?? 0, targets: options.targets || ["codex"] });
  return { service, store };
}

async function localCredential(service, profile, target = "codex", apiKey = "upstream-secret") {
  const prepared = await service.prepareConnection(profile, apiKey, target);
  return prepared.apiKey;
}

afterEach(async () => {
  await Promise.all([...activeServices].map(async (service) => {
    try {
      await service.stopAndWait();
    } catch {
      // 测试清理不能遮蔽原始断言错误。
    }
  }));
  activeServices.clear();
  await Promise.all([...activeServers].map((server) => closeServer(server)));
});

describe("GatewayService", () => {
  it("将旧版或未知版本网关状态归一化为 staged routes 的 v3 结构", () => {
    expect(GatewayStoreSchema.parse({
      version: 0,
      enabled: true,
      port: "invalid",
      routes: [
        { target: "codex", profileId: PROFILE_A },
        { target: "unknown", profileId: PROFILE_B },
      ],
      encryptedToken: "ciphertext",
      legacyField: "ignored",
    })).toEqual({
      version: 3,
      enabled: true,
      port: 17863,
      targets: ["codex"],
      routes: { codex: PROFILE_A },
      encryptedToken: "ciphertext",
    });
    expect(GatewayStoreSchema.parse({ version: 99, enabled: "yes" }))
      .toEqual(defaultGatewayStore());
  });

  it("迁移时过滤非法 profileId，但保留合法的已删除方案路由", () => {
    expect(GatewayStoreSchema.parse({
      version: 1,
      enabled: true,
      port: 17863,
      targets: ["codex", "claude", "gemini"],
      routes: {
        codex: "not-a-uuid",
        claude: PROFILE_A,
        gemini: "  ",
      },
    })).toEqual({
      version: 3,
      enabled: true,
      port: 17863,
      targets: ["codex", "claude", "gemini"],
      routes: { claude: PROFILE_A },
    });
  });

  it("Codex 路径令牌加密持久化并在重启监听后保持不变", async () => {
    const store = memoryStore();
    const service = new GatewayService({
      profileService: profileService({}),
      store,
      vault,
    });
    activeServices.add(service);

    await service.start({ port: 0, targets: ["codex"] });
    const firstUrl = service.getPublicState().localBaseUrls.codex;
    const routeToken = firstUrl.split("/").at(-1);
    expect(routeToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(store.current().encryptedRouteToken).toBeTruthy();
    expect(JSON.stringify(store.current())).not.toContain(routeToken);

    const port = service.getPublicState().port;
    await service.stopAndWait();
    await service.start({ port, targets: ["codex"] });
    expect(service.getPublicState().localBaseUrls.codex).toBe(firstUrl);
  });

  it("停止状态可预先分配路由并验证方案密钥，不启动监听器", async () => {
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: "https://relay.example/v1",
      targets: ["codex"],
    };
    const getConnection = vi.fn().mockResolvedValue({ profile, apiKey: "upstream-key" });
    const store = memoryStore();
    const service = new GatewayService({
      profileService: { getConnection },
      store,
      vault,
    });
    activeServices.add(service);

    const previous = await service.assignRoutes(profile.id, ["codex"]);

    expect(previous).toEqual({ targets: [], routes: {} });
    expect(getConnection).toHaveBeenCalledWith(PROFILE_A);
    expect(service.getPublicState()).toMatchObject({
      status: "stopped",
      targets: ["codex"],
      routes: [{ target: "codex", profileId: PROFILE_A }],
    });
    expect(service.server).toBeUndefined();
    expect(service.connectionCache.size).toBe(0);
  });

  it("路由激活后复用内存连接快照，不在每个请求上读取和解密存储", async () => {
    const upstream = await listen((_request, response) => response.end("ok"));
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1`,
      targets: ["codex"],
    };
    const getConnection = vi.fn().mockResolvedValue({ profile, apiKey: "upstream-key" });
    const service = new GatewayService({
      profileService: { getConnection },
      store: memoryStore(),
      vault,
    });
    activeServices.add(service);
    await service.start({ port: 0, targets: ["codex"] });
    const prepared = await service.prepareConnection(profile, "upstream-key", "codex");
    await service.activateRoutes(profile, ["codex"]);
    const url = `${service.getPublicState().localBaseUrls.codex}/responses`;
    const headers = { authorization: `Bearer ${prepared.apiKey}` };

    expect((await rawRequest(url, { headers })).status).toBe(200);
    expect((await rawRequest(url, { headers })).status).toBe(200);
    expect(getConnection).toHaveBeenCalledTimes(1);
  });

  it("Codex 只接受持久路径令牌且忽略入站认证头", async () => {
    let upstreamCalls = 0;
    const upstream = await listen((_request, response) => {
      upstreamCalls += 1;
      response.end("unexpected");
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "real-upstream-key" },
    });
    await service.activateRoutes(profile, ["codex"]);
    const state = service.getPublicState();
    const baseUrl = state.localBaseUrls.codex;
    const wrongBaseUrl = baseUrl.replace(/[^/]+$/, "wrong-route-token");

    expect((await rawRequest(`${wrongBaseUrl}/responses`)).status).toBe(401);
    expect((await rawRequest(`${wrongBaseUrl}/responses`, {
      headers: { authorization: "Bearer wrong-token" },
    })).status).toBe(401);
    expect((await rawRequest(`${baseUrl}/responses`, {
      headers: { authorization: "Bearer unrelated-codex-auth" },
    })).status).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(JSON.stringify(state)).not.toContain("real-upstream-key");
    expect(JSON.stringify(state)).not.toContain("encryptedToken");
    expect(JSON.stringify(state)).not.toContain("gateway:");
  });

  it("合并基础路径和查询参数，并移除入站凭据后按方案注入真实凭据", async () => {
    let received;
    const upstream = await listen((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received = {
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks),
        };
        response.writeHead(201, { "content-type": "application/octet-stream" });
        response.end(Buffer.from([9, 8, 7]));
      });
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/tenant/v1?region=cn`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    });
    await service.activateRoutes(profile);
    const localToken = await localCredential(service, profile);
    const payload = Buffer.from([0, 255, 1, 2, 128, 10]);
    const response = await rawRequest(
      `${service.getPublicState().localBaseUrls.codex}/responses?key=${encodeURIComponent(localToken)}&stream=true`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer should-be-removed",
          "x-api-key": "also-remove",
          "x-goog-api-key": "remove-too",
          "content-type": "application/octet-stream",
          "content-length": String(payload.length),
        },
        body: payload,
      },
    );

    expect(response.status).toBe(201);
    expect(response.body).toEqual(Buffer.from([9, 8, 7]));
    expect(received.url).toBe("/tenant/v1/responses?region=cn&stream=true");
    expect(received.body).toEqual(payload);
    expect(received.headers.authorization).toBe("Bearer upstream-secret");
    expect(received.headers["x-api-key"]).toBeUndefined();
    expect(received.headers["x-goog-api-key"]).toBeUndefined();
  });

  it("保持二进制内容并逐块转发 SSE，不解析或重编码响应", async () => {
    const binary = Buffer.from(Array.from({ length: 256 }, (_value, index) => index));
    const sseChunks = [
      Buffer.from("event: message\ndata: {\"delta\":\"你\"}\n\n", "utf8"),
      Buffer.from("data: [DONE]\n\n", "utf8"),
    ];
    const upstream = await listen((request, response) => {
      if (request.url.endsWith("/binary")) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(binary);
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write(sseChunks[0]);
      setTimeout(() => response.end(sseChunks[1]), 25);
    });
    const profile = {
      id: PROFILE_A,
      protocol: "anthropic",
      authMode: "api-key",
      baseUrl: `${upstream.baseUrl}/api`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "anthropic-secret" },
    });
    await service.activateRoutes(profile);
    const token = await localCredential(service, profile, "codex", "anthropic-secret");
    const baseUrl = service.getPublicState().localBaseUrls.codex;
    const headers = { "x-api-key": token };

    const binaryResponse = await rawRequest(`${baseUrl}/binary`, { headers });
    const sseResponse = await rawRequest(`${baseUrl}/events`, { headers });
    expect(binaryResponse.body).toEqual(binary);
    expect(sseResponse.body).toEqual(Buffer.concat(sseChunks));
    expect(sseResponse.chunks.length).toBeGreaterThanOrEqual(2);
    expect(sseResponse.chunks[0]).toEqual(sseChunks[0]);
  });

  it("请求监控覆盖响应生命周期且不接触正文和认证", async () => {
    const monitor = {
      start: vi.fn().mockReturnValue("request-1"),
    responseStarted: vi.fn(),
    observeChunk: vi.fn(),
    updateMetadata: vi.fn(),
      end: vi.fn(),
      list: vi.fn().mockReturnValue([{ id: "request-1" }]),
      clear: vi.fn(),
    };
    const upstream = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"type":"response.output_text.delta","delta":"ok"}\n\n');
    });
    const profile = {
      id: PROFILE_A,
      name: "Monitored",
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1?private=query`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    }, { requestMonitor: monitor });
    await service.activateRoutes(profile);

    const response = await rawRequest(`${service.getPublicState().localBaseUrls.codex}/responses`);
    expect(response.status).toBe(200);
    expect(monitor.start).toHaveBeenCalledWith(expect.objectContaining({
      client: "codex",
      profileId: PROFILE_A,
      profileName: "正在载入方案",
      upstreamUrl: "",
    }));
    expect(monitor.updateMetadata).toHaveBeenCalledWith("request-1", expect.objectContaining({
      profileName: "Monitored",
      upstreamUrl: `${upstream.baseUrl}/v1/responses`,
      protocol: "openai-responses",
    }));
    expect(JSON.stringify(monitor.start.mock.calls)).not.toContain("upstream-secret");
    expect(JSON.stringify(monitor.start.mock.calls)).not.toContain("private=query");
    expect(monitor.responseStarted).toHaveBeenCalledWith("request-1", expect.objectContaining({
      statusCode: 200,
      streaming: true,
    }));
    expect(monitor.observeChunk).toHaveBeenCalled();
    expect(monitor.end).toHaveBeenCalledWith("request-1");
    expect(service.getActiveRequests()).toEqual([{ id: "request-1" }]);
  });

  it("真实请求监视器串联采集元数据、首字和 usage 且不公开正文或完整 Key", async () => {
    const monitor = new RequestMonitorService();
    let upstreamHeaders;
    const upstream = await listen((request, response) => {
      upstreamHeaders = request.headers;
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          'event: response.output_text.delta\n',
          'data: {"type":"response.output_text.delta","delta":"首"}\n\n',
          'event: response.completed\n',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":5,"total_tokens":17}}}\n\n',
        ].join(""));
      });
    });
    const profile = {
      id: PROFILE_A,
      name: "真实监控",
      keyHint: "•••• 1234",
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    }, { requestMonitor: monitor });
    await service.activateRoutes(profile);
    const response = await rawRequest(`${service.getPublicState().localBaseUrls.codex}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-encoding": "gzip" },
      body: Buffer.from(JSON.stringify({
        model: "gpt-test",
        stream: true,
        reasoning: { effort: "high" },
        input: "private prompt body",
      }), "utf8"),
    });
    expect(response.status).toBe(200);
    expect(upstreamHeaders["accept-encoding"]).toBe("identity");
    const [record] = monitor.list();
    expect(record).toMatchObject({
      profileName: "真实监控",
      keyHint: "•••• 1234",
      model: "gpt-test",
      reasoningEffort: "high",
      firstTokenLatencyMs: expect.any(Number),
      tokenUsage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      outcome: "completed",
    });
    expect(JSON.stringify(record)).not.toContain("private prompt body");
    expect(JSON.stringify(record)).not.toContain("upstream-secret");
  });

  it("实验工具桥默认透明，开启后只转换 Codex Responses 请求和 SSE", async () => {
    const received = [];
    const within = (promise, label) => Promise.race([
      promise,
      new Promise((_resolve, reject) => setTimeout(() => reject(
        new Error(`${label}; upstream requests=${received.length}`),
      ), 1_500)),
    ]);
    const upstreamSse = [
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added","item":{"id":"item_1","type":"function_call","name":"exec","call_id":"call_1","arguments":"{\\"input\\":\\"Get-Date\\"}"}}\n\n',
      'event: response.output_item.done\n',
      'data: {"type":"response.output_item.done","item":{"id":"item_1","type":"function_call","name":"exec","call_id":"call_1","arguments":"{\\"input\\":\\"Get-Date\\"}"}}\n\n',
      'data: [DONE]\n\n',
    ].join("");
    const upstream = await listen((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks) });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(upstreamSse);
      });
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    });
    await service.activateRoutes(profile);
    const url = `${service.getPublicState().localBaseUrls.codex}/responses`;
    const payload = Buffer.from(JSON.stringify({
      tools: [{ type: "custom", name: "exec", description: "desktop exec" }],
      input: [],
    }), "utf8");

    const transparent = await within(rawRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(payload.length) },
      body: payload,
    }), "transparent request timed out");
    expect(JSON.parse(received[0].body.toString("utf8")).tools[0].type).toBe("custom");
    expect(transparent.body.toString("utf8")).toContain('"type":"function_call"');

    service.setExperimentalToolBridgeEnabled(true);
    const bridged = await within(rawRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(payload.length) },
      body: payload,
    }), "bridged request timed out");
    const bridgedRequest = JSON.parse(received[1].body.toString("utf8"));
    expect(bridgedRequest.tools[0]).toMatchObject({ type: "function", name: "exec", strict: true });
    expect(Number(received[1].headers["content-length"])).toBe(received[1].body.length);
    expect(bridged.body.toString("utf8")).toContain('"type":"custom_tool_call"');
    expect(bridged.body.toString("utf8")).toContain('"input":"Get-Date"');

    const failed = await within(rawRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from("not-json", "utf8"),
    }), "invalid bridge request timed out");
    expect(failed.status).toBe(502);
    expect(failed.body.toString("utf8")).toBe("Responses tool bridge request conversion failed");
    expect(received).toHaveLength(2);
  });

  it("热切换和回滚只替换持久化 profileId 路由", async () => {
    const upstreamA = await listen((_request, response) => response.end("A"));
    const upstreamB = await listen((_request, response) => response.end("B"));
    const profileA = {
      id: PROFILE_A,
      protocol: "openai-chat",
      authMode: "bearer",
      baseUrl: upstreamA.baseUrl,
      targets: ["codex"],
    };
    const profileB = { ...profileA, id: PROFILE_B, baseUrl: upstreamB.baseUrl };
    const { service, store } = await createGateway({
      [PROFILE_A]: { profile: profileA, apiKey: "key-a" },
      [PROFILE_B]: { profile: profileB, apiKey: "key-b" },
    });
    await service.activateRoutes(profileA);
    const token = await localCredential(service, profileA, "codex", "key-a");
    const url = `${service.getPublicState().localBaseUrls.codex}/chat`;
    const headers = { authorization: `Bearer ${token}` };
    expect((await rawRequest(url, { headers })).body.toString()).toBe("A");

    const previousRoutes = await service.activateRoutes(profileB);
    expect((await rawRequest(url, { headers })).body.toString()).toBe("B");
    expect(store.current().routes).toEqual({ codex: PROFILE_B });
    expect(store.current()).not.toHaveProperty("apiKey");

    await service.restoreRoutes(previousRoutes);
    expect((await rawRequest(url, { headers })).body.toString()).toBe("A");
    expect(service.activeTargetsForProfile(PROFILE_A)).toEqual(["codex"]);
    expect(service.getRouteGroups()).toEqual([{ profileId: PROFILE_A, targets: ["codex"] }]);
  });

  it("prepareConnection 在路由激活前不留下明文连接缓存", async () => {
    const profileA = {
      id: PROFILE_A,
      protocol: "openai-chat",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["codex"],
    };
    const profileB = { ...profileA, id: PROFILE_B };
    const { service } = await createGateway({
      [PROFILE_A]: { profile: profileA, apiKey: "key-a" },
      [PROFILE_B]: { profile: profileB, apiKey: "key-b" },
    });
    await service.prepareConnection(profileA, "key-a", "codex");
    expect(service.connectionCache.size).toBe(0);

    await service.activateRoutes(profileA);
    expect([...service.connectionCache.keys()]).toEqual([PROFILE_A]);

    await service.prepareConnection(profileB, "key-b", "codex");
    expect([...service.connectionCache.keys()]).toEqual([PROFILE_A]);

    await service.activateRoutes(profileB);
    expect([...service.connectionCache.keys()]).toEqual([PROFILE_B]);
  });

  it("运行中缩减 targets 会立即驱逐不再路由的明文连接缓存", async () => {
    const profileA = {
      id: PROFILE_A,
      protocol: "openai-chat",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["codex"],
    };
    const profileB = {
      ...profileA,
      id: PROFILE_B,
      targets: ["claude"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile: profileA, apiKey: "key-a" },
      [PROFILE_B]: { profile: profileB, apiKey: "key-b" },
    }, { targets: ["codex", "claude"] });
    await service.activateRoutes(profileA, ["codex"]);
    await service.activateRoutes(profileB, ["claude"]);
    expect([...service.connectionCache.keys()].sort()).toEqual([PROFILE_A, PROFILE_B]);

    await service.start({ port: service.getPublicState().port, targets: ["codex"] });

    expect(service.getPublicState().routes).toEqual([
      { target: "codex", profileId: PROFILE_A },
    ]);
    expect([...service.connectionCache.keys()]).toEqual([PROFILE_A]);
  });

  it("停止状态持久化失败时仍清除本地令牌和明文连接缓存", async () => {
    const profile = {
      id: PROFILE_A,
      protocol: "openai-chat",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["codex"],
    };
    const store = memoryStore();
    const originalWrite = store.write.bind(store);
    let rejectWrites = false;
    store.write = async (next) => {
      if (rejectWrites) throw new Error("simulated gateway store failure");
      return originalWrite(next);
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "key-a" },
    }, { store });
    await service.activateRoutes(profile);
    expect(service.localToken).toBeTypeOf("string");
    expect([...service.connectionCache.keys()]).toEqual([PROFILE_A]);

    rejectWrites = true;
    await expect(service.stopAndWait()).rejects.toThrow("simulated gateway store failure");

    expect(service.server).toBeUndefined();
    expect(service.localToken).toBeUndefined();
    expect(service.connectionCache.size).toBe(0);
  });

  it("停止后刷新方案不会重新填充已清空的明文缓存", async () => {
    const profile = {
      id: PROFILE_A,
      protocol: "openai-chat",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["codex"],
    };
    const getConnection = vi.fn().mockResolvedValue({ profile, apiKey: "key-a" });
    const service = new GatewayService({
      profileService: { getConnection },
      store: memoryStore(),
      vault,
    });
    activeServices.add(service);
    await service.start({ port: 0, targets: ["codex"] });
    await service.prepareConnection(profile, "key-a", "codex");
    await service.activateRoutes(profile);
    getConnection.mockClear();
    await service.stopAndWait();
    await service.refreshProfile(PROFILE_A);

    expect(service.connectionCache.size).toBe(0);
    expect(getConnection).not.toHaveBeenCalled();
  });

  it("上游响应中途断开时关闭当前响应且网关继续服务", async () => {
    const upstream = await listen((request, response) => {
      if (request.url.endsWith("/reset")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        setImmediate(() => response.destroy(new Error("simulated reset")));
        return;
      }
      response.end("ok");
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: upstream.baseUrl,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-key" },
    });
    await service.activateRoutes(profile);
    const token = await localCredential(service, profile);
    const baseUrl = service.getPublicState().localBaseUrls.codex;
    const headers = { authorization: `Bearer ${token}` };

    await expect(rawRequest(`${baseUrl}/reset`, { headers })).rejects.toThrow();
    expect((await rawRequest(`${baseUrl}/ok`, { headers })).body.toString()).toBe("ok");
  });

  it("客户端上传中断不会留下未处理流错误", async () => {
    const upstream = await listen((request, response) => {
      request.on("error", () => {});
      request.on("end", () => response.end("uploaded"));
      request.resume();
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: upstream.baseUrl,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-key" },
    });
    await service.activateRoutes(profile);
    const token = await localCredential(service, profile);
    const baseUrl = service.getPublicState().localBaseUrls.codex;
    const headers = { authorization: `Bearer ${token}` };

    await abortUpload(`${baseUrl}/upload`, headers);
    expect((await rawRequest(`${baseUrl}/upload`, {
      method: "POST",
      headers,
      body: Buffer.from("complete"),
    })).status).toBe(200);
  });

  it("首次连接加载期间上传中断不会形成未处理错误，网关之后仍可服务", async () => {
    let upstreamCalls = 0;
    const upstream = await listen((request, response) => {
      upstreamCalls += 1;
      request.resume();
      request.on("end", () => response.end("uploaded"));
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: upstream.baseUrl,
      targets: ["codex"],
    };
    let releaseConnection;
    let connectionRequested;
    const connectionGate = new Promise((resolve) => {
      releaseConnection = resolve;
    });
    const connectionStarted = new Promise((resolve) => {
      connectionRequested = resolve;
    });
    let connectionCalls = 0;
    const getConnection = vi.fn(async () => {
      connectionCalls += 1;
      if (connectionCalls > 1) {
        connectionRequested();
        await connectionGate;
      }
      return { profile, apiKey: "upstream-key" };
    });
    const service = new GatewayService({
      profileService: { getConnection },
      store: memoryStore(),
      vault,
    });
    activeServices.add(service);
    await service.start({ port: 0, targets: ["codex"] });
    await service.activateRoutes(profile);
    const token = await localCredential(service, profile);
    const url = `${service.getPublicState().localBaseUrls.codex}/upload`;
    const headers = { authorization: `Bearer ${token}` };
    service.connectionCache.clear();

    let uploadRequest;
    const interrupted = new Promise((resolve) => {
      uploadRequest = http.request(url, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/octet-stream",
          "content-length": "1048576",
        },
      });
      uploadRequest.on("error", () => {});
      uploadRequest.once("close", resolve);
      uploadRequest.write(Buffer.alloc(1024, 7));
    });
    await connectionStarted;
    uploadRequest.destroy();
    await interrupted;
    releaseConnection();
    await new Promise((resolve) => setImmediate(resolve));

    expect(upstreamCalls).toBe(0);
    expect((await rawRequest(url, {
      method: "POST",
      headers,
      body: Buffer.from("complete"),
    })).status).toBe(200);
    expect(upstreamCalls).toBe(1);
  });

  it("401 和 404 拒绝体中断不会重复销毁请求，网关之后仍可服务", async () => {
    const upstream = await listen((_request, response) => response.end("ok"));
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: upstream.baseUrl,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-key" },
    });
    await service.activateRoutes(profile);
    const token = await localCredential(service, profile);
    const baseUrl = service.getPublicState().localBaseUrls.codex;

    const wrongBaseUrl = baseUrl.replace(/[^/]+$/, "wrong-route-token");
    expect(await interruptRejectedUpload(`${wrongBaseUrl}/upload`)).toBe(401);
    const rootUrl = new URL(baseUrl);
    expect(await interruptRejectedUpload(`${rootUrl.origin}/unknown/upload`, {
      authorization: `Bearer ${token}`,
    })).toBe(404);
    expect((await rawRequest(`${baseUrl}/ok`, {
      headers: { authorization: `Bearer ${token}` },
    })).body.toString()).toBe("ok");
  });

  it("请求处理 Promise 拒绝时返回 500 而不形成未处理拒绝", async () => {
    const { service } = await createGateway({});
    const originalHandleRequest = service._handleRequest.bind(service);
    service._handleRequest = vi.fn()
      .mockRejectedValueOnce(new Error("simulated handler failure"))
      .mockImplementation(originalHandleRequest);
    const baseUrl = service.getPublicState().localBaseUrls.codex;

    expect((await rawRequest(baseUrl)).status).toBe(500);
    expect((await rawRequest(baseUrl)).status).toBe(404);
  });

  it("限制本地连接数并为请求和空闲连接设置有限超时", async () => {
    const { service } = await createGateway({});
    expect(service.server.maxConnections).toBe(128);
    expect(service.server.requestTimeout).toBeGreaterThan(0);
    expect(service.server.timeout).toBeGreaterThan(0);
  });

  it("端口冲突不持久化启用状态，停止后关闭端口并保留 staged route", async () => {
    const occupied = await listen((_request, response) => response.end("occupied"));
    const store = memoryStore();
    const connections = {};
    const service = new GatewayService({
      profileService: profileService(connections),
      store,
      vault,
    });
    activeServices.add(service);

    await expect(service.start({ port: occupied.port, targets: ["codex"] }))
      .rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(store.current().enabled).toBe(false);
    await closeServer(occupied.server);

    await service.start({ port: occupied.port, targets: ["codex"] });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["codex"],
    };
    connections[PROFILE_A] = { profile, apiKey: "upstream" };
    await service.activateRoutes(profile);
    expect(store.current().routes).toEqual({ codex: PROFILE_A });
    await service.stopAndWait();
    expect(store.current()).toMatchObject({ enabled: false, routes: { codex: PROFILE_A } });
    expect(service.getPublicState().status).toBe("stopped");
    await expect(rawRequest(`http://127.0.0.1:${occupied.port}/codex`)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  });

  it("initialize 自动恢复已启用网关，但不暴露持久化令牌", async () => {
    const encryptedToken = vault.encrypt("stable-local-token");
    const store = memoryStore({
      version: 1,
      enabled: true,
      port: 0,
      targets: ["claude"],
      routes: { claude: PROFILE_A },
      encryptedToken,
    });
    // 持久化结构不允许端口 0，先取得一个随后释放的可用端口。
    const reservation = await listen((_request, response) => response.end());
    const restoredPort = reservation.port;
    await closeServer(reservation.server);
    store.write({ ...store.current(), port: restoredPort });
    const profile = {
      id: PROFILE_A,
      protocol: "anthropic",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["claude"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream" },
    }, { store, initialize: true });

    const state = service.getPublicState();
    expect(state).toMatchObject({ status: "running", port: restoredPort });
    expect(state.routes).toEqual([{ target: "claude", profileId: PROFILE_A }]);
    expect(JSON.stringify(state)).not.toContain("stable-local-token");
    const prepared = await service.prepareConnection(profile, "upstream", "claude");
    expect(prepared.apiKey).toBe("stable-local-token");
    expect(prepared.profile.baseUrl).toBe(`http://127.0.0.1:${restoredPort}/claude`);
  });
});
