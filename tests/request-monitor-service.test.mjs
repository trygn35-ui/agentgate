import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  MAX_RECENT_REQUESTS,
  RequestMonitorService,
  extractRequestMetadata,
  extractTokenUsage,
  extractTokenUsageFromSource,
} = require("../electron/services/request-monitor-service.cjs");

describe("活动请求监视", () => {
  it("独立跟踪并发请求并在结束后保留最近记录", () => {
    let now = 1_000;
    const onChange = vi.fn();
    const monitor = new RequestMonitorService({ now: () => now, onChange });
    const first = monitor.start({
      client: "codex",
      profileId: "profile-a",
      profileName: "方案 A",
      upstreamUrl: "https://a.example/v1",
      protocol: "openai-responses",
    });
    now += 5;
    const second = monitor.start({
      client: "codex",
      profileName: "方案 B",
      upstreamUrl: "https://b.example/v1",
      protocol: "openai-chat",
    });

    expect(monitor.list().map((request) => request.id)).toEqual([first, second]);
    now += 25;
    expect(monitor.end(first)).toBe(true);
    expect(monitor.list().map((request) => request.id)).toEqual([second, first]);
    expect(monitor.list()[1]).toMatchObject({
      id: first,
      state: "completed",
      outcome: "completed",
      durationMs: 30,
    });
    expect(onChange).toHaveBeenLastCalledWith({
      type: "active-requests-changed",
      activeRequests: [
        expect.objectContaining({ id: second }),
        expect.objectContaining({ id: first, state: "completed" }),
      ],
    });
  });

  it("按一小时窗口保留完成记录，超时的丢弃", () => {
    let now = Date.parse("2026-07-13T12:00:00.000Z");
    const monitor = new RequestMonitorService({ now: () => now });

    const stale = monitor.start({ profileName: "两小时前" });
    monitor.end(stale);

    now += 90 * 60_000; // 推进 90 分钟：上一条已超出保留窗口
    const fresh = monitor.start({ profileName: "刚刚" });
    monitor.end(fresh);

    const records = monitor.list();
    expect(records.map((entry) => entry.profileName)).toEqual(["刚刚"]);
  });

  it("硬上限兜底：极端高频下不超过 MAX_RECENT_REQUESTS", () => {
    let now = Date.parse("2026-07-13T12:00:00.000Z");
    const monitor = new RequestMonitorService({ now: () => now });
    for (let index = 0; index < MAX_RECENT_REQUESTS + 10; index += 1) {
      const id = monitor.start({ profileName: `方案 ${index}` });
      now += 1; // 全部落在同一小时内
      monitor.end(id);
    }
    expect(monitor.list()).toHaveLength(MAX_RECENT_REQUESTS);
  });

  it.each([
    [
      "Responses",
      "openai-responses",
      'data: {"type":"response.output_text.delta","delta":"你"}\n\n',
    ],
    [
      "Responses 推理",
      "openai-responses",
      'event: response.reasoning_summary_text.delta\ndata: {"delta":"分析"}\n\n',
    ],
    [
      "Responses 原始推理",
      "openai-responses",
      'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"思考"}\n\n',
    ],
    [
      "Responses 通用事件名",
      "openai-responses",
      'event: message\ndata: {"type":"response.output_text.delta","delta":"你"}\n\n',
    ],
    [
      "Responses 工具参数",
      "openai-responses",
      'event: response.function_call_arguments.delta\ndata: {"delta":"{\\"path\\":"}\n\n',
    ],
    [
      "Chat",
      "openai-chat",
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    ],
    [
      "Anthropic",
      "anthropic",
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"你"}}\n\n',
    ],
    [
      "Anthropic 通用事件名",
      "anthropic",
      'event: message\ndata: {"type":"content_block_delta","delta":{"text":"你"}}\n\n',
    ],
    [
      "Gemini",
      "gemini",
      '{"candidates":[{"content":{"parts":[{"text":"你"}]}}]}\n',
    ],
  ])("识别 %s 的首个正文增量", (_name, protocol, payload) => {
    let now = 2_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      client: "codex",
      profileName: "测试方案",
      upstreamUrl: "https://relay.example/v1",
      protocol,
      streaming: true,
    });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });
    now += 37;

    const splitAt = Math.floor(payload.length / 2);
    expect(monitor.observeChunk(id, Buffer.from(payload.slice(0, splitAt), "utf8"))).toBe(false);
    expect(monitor.observeChunk(id, Buffer.from(payload.slice(splitAt), "utf8"))).toBe(true);
    expect(monitor.list()[0]).toMatchObject({
      state: "streaming",
      firstTokenLatencyMs: 37,
      statusCode: 200,
      receivedBytes: Buffer.byteLength(payload, "utf8"),
    });
  });

  it("非流式结构化响应识别首字且不公开正文", () => {
    let now = 5_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      client: "codex",
      profileName: "非流式方案",
      upstreamUrl: "https://relay.example/v1",
      protocol: "openai-responses",
    });
    monitor.responseStarted(id, {
      statusCode: 200,
      contentType: "application/json",
    });
    now += 12;
    monitor.observeChunk(id, Buffer.from(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "private response body" }] }],
    }), "utf8"));

    const publicRequest = monitor.list()[0];
    expect(publicRequest.firstTokenLatencyMs).toBe(12);
    expect(JSON.stringify(publicRequest)).not.toContain("private response body");
    expect(Object.keys(publicRequest)).not.toContain("detectionBuffer");
  });

  it("非流式未知响应只记录首包", () => {
    let now = 6_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({ profileName: "未知格式", protocol: "openai-responses" });
    monitor.responseStarted(id, { statusCode: 200, contentType: "application/octet-stream" });
    now += 16;
    monitor.observeChunk(id, Buffer.from("opaque body", "utf8"));

    expect(monitor.list()[0]).toMatchObject({ firstByteLatencyMs: 16 });
    expect(monitor.list()[0].firstTokenLatencyMs).toBeUndefined();
  });

  it("未知流只记录首包且完成后冻结总耗时", () => {
    let now = 8_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      profileName: "未知中转格式",
      protocol: "openai-responses",
      streaming: true,
    });
    monitor.responseStarted(id, { streaming: true });
    now += 350;
    monitor.observeChunk(id, 'data: {"type":"response.created"}\n\n');
    expect(monitor.list()[0]).toMatchObject({ firstByteLatencyMs: 350 });
    expect(monitor.list()[0].firstTokenLatencyMs).toBeUndefined();
    now += 1_650;
    monitor.end(id);
    expect(monitor.list()[0]).toMatchObject({ durationMs: 2_000, outcome: "completed" });
  });

  it("提取请求模型、推理强度和真实 usage", () => {
    expect(extractRequestMetadata({
      model: "gpt-5.2-codex",
      stream: true,
      reasoning: { effort: "high" },
      input: "不得公开",
    })).toEqual({ model: "gpt-5.2-codex", streaming: true, reasoningEffort: "high" });
    expect(extractTokenUsage({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          total_tokens: 125,
          input_tokens_details: { cached_tokens: 40 },
          output_tokens_details: { reasoning_tokens: 8 },
        },
      },
    })).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cachedTokens: 40,
      reasoningTokens: 8,
      totalTokens: 125,
    });
    expect(extractTokenUsage({
      usage: {
        input_tokens: 80,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 30,
      },
    })).toEqual({
      inputTokens: 80,
      outputTokens: 20,
      cachedTokens: 30,
      totalTokens: 100,
    });
  });

  it("Gemini 工具调用参数可作为首个有效增量", () => {
    let now = 12_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({ profileName: "Gemini", protocol: "gemini", streaming: true });
    monitor.responseStarted(id, { streaming: true });
    now += 24;
    monitor.observeChunk(id, JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: "search", args: { query: "x" } } }] } }],
    }));
    expect(monitor.list()[0].firstTokenLatencyMs).toBe(24);
  });

  it("大事件截断正文后仍从尾部提取 usage", () => {
    const payload = `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        output: [{ type: "message", content: [{ text: "x".repeat(70_000) }] }],
        usage: {
          input_tokens: 321,
          output_tokens: 45,
          total_tokens: 366,
          input_tokens_details: { cached_tokens: 120 },
        },
      },
    })}\n\n`;
    expect(extractTokenUsageFromSource(payload)).toEqual({
      inputTokens: 321,
      outputTokens: 45,
      cachedTokens: 120,
      totalTokens: 366,
    });

    let now = 20_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({ profileName: "大响应", protocol: "openai-responses", streaming: true });
    monitor.responseStarted(id, { streaming: true });
    now += 30;
    monitor.observeChunk(id, 'data: {"type":"response.output_text.delta","delta":"首"}\n\n');
    now += 40;
    monitor.observeChunk(id, payload);
    expect(monitor.list()[0].tokenUsage).toEqual({
      inputTokens: 321,
      outputTokens: 45,
      cachedTokens: 120,
      totalTokens: 366,
    });
  });
});

describe("请求记录持久化", () => {
  it("启动时加载存储并在请求结束后写回最近 100 条", async () => {
    const persisted = {
      version: 1,
      entries: [{
        id: "old-1",
        client: "codex",
        profileName: "旧记录",
        upstreamUrl: "https://a.example/v1",
        state: "completed",
        startedAt: new Date(1_000).toISOString(),
        outcome: "completed",
        receivedBytes: 12,
      }],
    };
    const writes = [];
    const store = {
      read: async () => persisted,
      write: async (value) => { writes.push(value); return value; },
    };
    let now = 50_000;
    const monitor = new RequestMonitorService({ now: () => now, store });
    await monitor.initialize();
    expect(monitor.list().map((entry) => entry.id)).toEqual(["old-1"]);

    const id = monitor.start({ client: "codex", profileName: "新请求" });
    now += 20;
    monitor.end(id);
    await monitor.flush();

    expect(writes.at(-1).entries.map((entry) => entry.profileName)).toEqual(["新请求", "旧记录"]);
    expect(writes.at(-1).entries).toHaveLength(2);
  });
});

describe("中止归类", () => {
  it("流中已出现完成标记时，socket 中止改判为已完成", () => {
    let now = 30_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      client: "codex",
      profileName: "子代理请求",
      protocol: "anthropic",
      streaming: true,
    });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });
    now += 40;
    monitor.observeChunk(id, 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"好"}}\n\n');
    monitor.observeChunk(id, 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
    now += 5;
    monitor.end(id, { outcome: "aborted" });

    expect(monitor.list()[0]).toMatchObject({ state: "completed", outcome: "completed" });
  });

  it("没有完成标记的中止保持已中止", () => {
    let now = 31_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      client: "codex",
      profileName: "真实中止",
      protocol: "openai-responses",
      streaming: true,
    });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });
    now += 40;
    monitor.observeChunk(id, 'data: {"type":"response.output_text.delta","delta":"部分"}\n\n');
    monitor.end(id, { outcome: "aborted" });

    expect(monitor.list()[0]).toMatchObject({ state: "aborted", outcome: "aborted" });
  });
});
