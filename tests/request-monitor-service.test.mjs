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

    // 最新的永远在最上面：不按「活跃优先」分组，也不按完成时间排
    expect(monitor.list().map((request) => request.id)).toEqual([second, first]);
    now += 25;
    expect(monitor.end(first)).toBe(true);
    // first 刚刚完成，但它开始得早，所以仍排在还活着的 second 下面
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

  it("只回错误事件的 200 流记为 failed，而不是 completed", () => {
    // 真实事故：中转校验请求失败后仍以 HTTP 200 开流，只发一个
    // response.failed 就结束；此前会被记成「已完成」且无任何 token。
    const monitor = new RequestMonitorService({ now: () => 1_000 });
    const id = monitor.start({ profileName: "中转", protocol: "openai-responses", streaming: true });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });
    monitor.observeChunk(id, 'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"invalid_id_prefix"}}}\n\n');
    monitor.end(id);
    expect(monitor.list()[0]).toMatchObject({ state: "failed", outcome: "failed" });
  });

  it("正文里出现 error 字样但已产出内容的流仍是 completed", () => {
    const monitor = new RequestMonitorService({ now: () => 1_000 });
    const id = monitor.start({ profileName: "中转", protocol: "openai-responses", streaming: true });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });
    monitor.observeChunk(id, 'data: {"type":"response.output_text.delta","delta":"讲讲 \\"type\\":\\"error\\" 事件"}\n\n');
    monitor.observeChunk(id, 'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}\n\n');
    monitor.end(id);
    expect(monitor.list()[0]).toMatchObject({ state: "completed", outcome: "completed" });
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
  });

  it("Anthropic：input 不含缓存，必须补回来——否则用量少算、命中率恒等于 100%", () => {
    /*
     * Anthropic 的 input_tokens 只是「未命中缓存的新输入」，缓存读写是两个
     * 独立字段。老代码直接拿 input 当分母、把缓存写入算成命中：
     *   cached/input = (20000+12000)/5 = 6400 → 被 Math.min 夹成 100%
     * 而 total = input+output = 305，把 3.2 万个缓存 token 全丢了。
     */
    expect(extractTokenUsage({
      usage: {
        input_tokens: 5,
        cache_read_input_tokens: 20_000,
        cache_creation_input_tokens: 12_000,
        output_tokens: 300,
      },
    })).toEqual({
      inputTokens: 32_005,        // 5 + 20000 + 12000：归一化成「全部提示 token」
      outputTokens: 300,
      cachedTokens: 20_000,       // 只有「读」算命中
      cacheWriteTokens: 12_000,   // 「写」是 miss，还按 1.25× 计费
      totalTokens: 32_305,        // 不再漏掉缓存
    });
  });

  it("缓存写入不是命中：全新建缓存的请求命中率必须是 0，而不是 100%", () => {
    const usage = extractTokenUsage({
      usage: {
        input_tokens: 80,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 30,
      },
    });
    expect(usage).toEqual({
      inputTokens: 110,          // 80 + 0 + 30
      outputTokens: 20,
      cachedTokens: 0,           // 一个字都没命中
      cacheWriteTokens: 30,
      totalTokens: 130,
    });
    // 这正是最贵的一次请求，绝不能显示成「100% 命中」
    expect(usage.cachedTokens / usage.inputTokens).toBe(0);
  });

  it("OpenAI / Gemini：prompt 已含缓存，不能重复加", () => {
    // OpenAI：prompt_tokens 里已经包含 cached_tokens
    expect(extractTokenUsage({
      usage: {
        prompt_tokens: 25_000,
        completion_tokens: 800,
        prompt_tokens_details: { cached_tokens: 20_000 },
        completion_tokens_details: { reasoning_tokens: 640 },
      },
    })).toEqual({
      inputTokens: 25_000,       // 原样，不能再加 20000
      outputTokens: 800,
      cachedTokens: 20_000,
      reasoningTokens: 640,      // 已含在 output 里，只为显示
      totalTokens: 25_800,
    });

    // Gemini：promptTokenCount 里已经包含 cachedContentTokenCount
    expect(extractTokenUsage({
      usageMetadata: {
        promptTokenCount: 9_000,
        candidatesTokenCount: 500,
        cachedContentTokenCount: 7_200,
        thoughtsTokenCount: 210,
        totalTokenCount: 9_500,
      },
    })).toEqual({
      inputTokens: 9_000,
      outputTokens: 500,
      cachedTokens: 7_200,
      reasoningTokens: 210,
      totalTokens: 9_500,
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

  it("后开始的请求排在前面，跟谁先完成无关", () => {
    let now = 40_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const early = monitor.start({ profileName: "先发起" });
    now += 10;
    const late = monitor.start({ profileName: "后发起" });

    // 后发起的先完成——老写法按完成时间 unshift，会把它排到已完成组的最前面，
    // 而 early 还活着又被「活跃优先」顶到最上面，时间戳列于是乱的。
    now += 5;
    monitor.end(late);
    now += 5;
    monitor.end(early);

    expect(monitor.list().map((request) => request.profileName))
      .toEqual(["后发起", "先发起"]);
  });

  it("多字节字符被 chunk 从中间劈开也不会解错", () => {
    let now = 50_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({ profileName: "分片", protocol: "openai-responses", streaming: true });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });

    const payload = Buffer.from(
      'data: {"type":"response.output_text.delta","delta":"世界线"}\n\n',
      "utf8",
    );
    // 「世」是 3 字节，切在它中间。逐字节 toString('utf8') 会解出替换字符，
    // 整块 JSON 就废了；StringDecoder 会把残字节留到下一片。
    const cut = payload.indexOf(Buffer.from("世", "utf8")) + 1;
    now += 20;
    expect(monitor.observeChunk(id, payload.subarray(0, cut))).toBe(false);
    expect(monitor.observeChunk(id, payload.subarray(cut))).toBe(true);
    expect(monitor.list()[0]).toMatchObject({ firstTokenLatencyMs: 20, state: "streaming" });
  });

  it("传输途中只推活跃请求，不把整部历史重发一遍", () => {
    let now = 70_000;
    const events = [];
    const monitor = new RequestMonitorService({
      now: () => now,
      onChange: (event) => events.push(event),
    });

    // 攒一点历史
    for (let index = 0; index < 5; index += 1) {
      const old = monitor.start({ profileName: `历史 ${index}`, protocol: "openai-responses" });
      monitor.end(old);
    }

    const id = monitor.start({ profileName: "在跑", protocol: "openai-responses", streaming: true });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });
    monitor.observeChunk(id, 'data: {"type":"response.output_text.delta","delta":"首"}\n\n');
    events.length = 0;

    // 传输途中：节流窗口过了，应当只推还在跑的那一条
    now += 300;
    monitor.observeChunk(id, 'data: {"type":"response.output_text.delta","delta":"续"}\n\n');
    const progress = events.at(-1);
    expect(progress.patch).toBe(true);
    expect(progress.activeRequests).toHaveLength(1);
    expect(progress.activeRequests[0].id).toBe(id);

    /*
     * 历史记录只在请求「结束」时才变，传输途中一条都不该跟着重发——这段代码同步压在
     * 网关的转发路径上，实测 4 条并发流跑 30 秒会白推一百万条记录，吃掉八成六的 CPU。
     */
    now += 300;
    monitor.end(id);
    const final = events.at(-1);
    expect(final.patch).toBeUndefined();
    expect(final.activeRequests).toHaveLength(6);
  });

  it("首字前的大量事件不会拖慢转发（增量解析，不重扫缓冲区）", () => {
    const monitor = new RequestMonitorService({ now: () => 60_000 });
    const id = monitor.start({ profileName: "长前导", protocol: "openai-responses", streaming: true });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });

    /*
     * 首字之前塞 4000 个非有效事件——推理模型开流后常先刷一串状态事件。
     *
     * 老写法每来一片就把整个累积缓冲区重新 split + JSON.parse 一遍（还切两遍、
     * 每行 parse 两次），这段代码又同步卡在网关的转发路径上：实测 800 个事件就给
     * 首字硬加了 1.4 秒。这里 4000 个，老写法要跑几十秒；增量解析是几毫秒。
     * 上限拍在 2 秒——离新写法有几百倍余量，又稳稳卡死 O(n²) 的回归。
     */
    const started = performance.now();
    for (let index = 0; index < 4_000; index += 1) {
      monitor.observeChunk(
        id,
        `event: response.output_item.added\ndata: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: index,
          item: { type: "reasoning", id: `rs_${index}`, summary: [] },
        })}\n\n`,
      );
    }
    const elapsed = performance.now() - started;

    expect(monitor.list()[0].firstTokenLatencyMs).toBeUndefined();
    expect(monitor.observeChunk(id, 'data: {"type":"response.output_text.delta","delta":"来"}\n\n')).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  });
});
