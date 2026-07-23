import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

globalThis.window = {};

const { KeyringView } = await import("../src/components/KeyringView");
const { ActivityView } = await import("../src/components/ActivityView");
const {
  cascadeSessionIds,
  groupedSessionRows,
  isCodexSubagent,
  matchesSessionSearch,
  normalizeSessionListResult,
  topLevelSessionIds,
} = await import("../src/components/SessionsView");
const { SettingsView } = await import("../src/components/SettingsView");
const { I18nProvider, MESSAGES } = await import("../src/i18n");
const {
  computeDivergence,
  formatRate,
  todayCacheRate,
  todayRequestCount,
} = await import("../src/lib/divergence");
const { formatTokenCount } = await import("../src/lib/format");
const { mergeProfileUsage } = await import("../src/hooks/useAgentGateController");

function profile(id, name, target, latency = 100) {
  const checkedAt = new Date().toISOString();
  return {
    id,
    name,
    protocol: "openai-responses",
    baseUrl: `https://${name.toLowerCase()}.example/v1`,
    endpoints: [{
      url: `https://${name.toLowerCase()}.example/v1`,
      models: [],
      health: { status: "healthy", latencyMs: latency, checkedAt },
      healthHistory: [80, 100, 120].map((value) => ({
        checkedAt,
        reachable: true,
        latencyMs: value,
        statusCode: 204,
      })),
    }],
    availableModels: [],
    keyHint: "sk-…test",
    model: "gpt-test",
    authMode: "bearer",
    targets: [target],
    enableToolSearch: false,
    autoSwitch: { enabled: false, intervalMinutes: 2 },
    createdAt: checkedAt,
    updatedAt: checkedAt,
  };
}

function codexSession(id, parentNativeId) {
  return {
    id: `codex:${id}`,
    client: "codex",
    nativeId: id,
    title: id,
    workspace: "D:\\AI\\Keydeck",
    sizeBytes: 1,
    parentNativeId,
  };
}

describe("frontend state boundaries", () => {
  it("只用实际 engaged 的路由计算分歧率", () => {
    const first = profile("00000000-0000-4000-8000-000000000001", "First", "claude", 400);
    const second = profile("00000000-0000-4000-8000-000000000002", "Second", "codex", 200);
    const result = computeDivergence([first, second], {
      status: "running",
      host: "127.0.0.1",
      port: 17863,
      targets: ["claude", "codex"],
      engaged: ["codex"],
      routes: [
        { target: "claude", profileId: first.id, profileName: first.name, protocol: first.protocol, activatedAt: first.updatedAt },
        { target: "codex", profileId: second.id, profileName: second.name, protocol: second.protocol, activatedAt: second.updatedAt },
      ],
    });

    expect(result?.profileName).toBe("Second");
  });

  it("多条接管线路显示分歧最严重的一条", () => {
    const first = profile("00000000-0000-4000-8000-000000000001", "First", "claude", 150);
    const second = profile("00000000-0000-4000-8000-000000000002", "Second", "codex", 400);
    const result = computeDivergence([first, second], {
      status: "running",
      host: "127.0.0.1",
      port: 17863,
      targets: ["claude", "codex"],
      engaged: ["claude", "codex"],
      routes: [
        { target: "claude", profileId: first.id, profileName: first.name, protocol: first.protocol, activatedAt: first.updatedAt },
        { target: "codex", profileId: second.id, profileName: second.name, protocol: second.protocol, activatedAt: second.updatedAt },
      ],
    });

    expect(result?.profileName).toBe("Second");
  });

  it("首页缓存只统计本地当天，并以百分比显示", () => {
    const now = new Date(2026, 6, 17, 12, 0, 0);
    const request = (startedAt, inputTokens, cachedTokens) => ({
      id: startedAt,
      client: "codex",
      profileName: "Cache",
      upstreamUrl: "https://api.example/v1/responses",
      state: "completed",
      startedAt,
      receivedBytes: 1,
      tokenUsage: { inputTokens, cachedTokens },
    });
    const requests = [
      request(new Date(2026, 6, 16, 23, 59, 0).toISOString(), 1_000, 1_000),
      request(new Date(2026, 6, 17, 0, 1, 0).toISOString(), 800, 400),
      request(new Date(2026, 6, 17, 11, 0, 0).toISOString(), 200, 100),
    ];

    expect(todayCacheRate(requests, now)).toBe(0.5);
    expect(todayRequestCount(requests, now)).toBe(2);
    expect(formatRate(0.5)).toBe("0.500000");
  });

  it("Token 短格式支持十亿级 B", () => {
    expect(formatTokenCount(1_250_000_000)).toBe("1.25B");
    expect(formatTokenCount(12_500_000_000)).toBe("12.5B");
  });

  it("全选使用完整筛选结果的顶层行，不受渲染行数截断影响", () => {
    expect(topLevelSessionIds([
      { session: { id: "codex:root" }, depth: 0 },
      { session: { id: "codex:child" }, depth: 1 },
      { session: { id: "codex:hidden-root" }, depth: 0 },
    ])).toEqual(["codex:root", "codex:hidden-root"]);
  });

  it("会话搜索可用标题、工作区、原始 ID 或带客户端前缀的 ID 精确定位", () => {
    const session = {
      id: "codex:019f69d3-287b-7573-8d3e-fc0d3bf740b3",
      nativeId: "019f69d3-287b-7573-8d3e-fc0d3bf740b3",
      title: "修复会话管理",
      workspace: "D:\\AI\\Keydeck",
    };

    expect(matchesSessionSearch(session, "会话管理")).toBe(true);
    expect(matchesSessionSearch(session, "keydeck")).toBe(true);
    expect(matchesSessionSearch(session, "019F69D3-287B-7573-8D3E-FC0D3BF740B3")).toBe(true);
    expect(matchesSessionSearch(session, "codex:019f69d3")).toBe(true);
    expect(matchesSessionSearch(session, "not-this-session")).toBe(false);
  });

  it("会话扫描兼容旧数组，并保留新版逐客户端错误", () => {
    const sessions = [codexSession("root")];
    expect(normalizeSessionListResult(sessions)).toEqual({ sessions, errors: [] });

    const detailed = {
      sessions,
      errors: [{ client: "claude", reason: "permission denied" }],
    };
    expect(normalizeSessionListResult(detailed)).toBe(detailed);
  });

  it("Codex 旧记录只有父会话 ID 时也识别为子代理", () => {
    expect(isCodexSubagent({
      client: "codex",
      parentNativeId: "019f69d3-287b-7573-8d3e-fc0d3bf740b3",
    })).toBe(true);
    expect(isCodexSubagent({ client: "codex" })).toBe(false);
    expect(isCodexSubagent({
      client: "claude",
      parentNativeId: "019f69d3-287b-7573-8d3e-fc0d3bf740b3",
    })).toBe(false);
  });

  it("Codex 主任务折叠挂靠子代理，删除时递归包含全部后代", () => {
    const root = codexSession("root");
    const child = codexSession("child", "root");
    const grandchild = codexSession("grandchild", "child");
    const other = codexSession("other");
    const sessions = [root, child, grandchild, other];

    expect(cascadeSessionIds(sessions, new Set([root.id, child.id]))).toEqual([
      grandchild.id,
      child.id,
      root.id,
    ]);
    expect(groupedSessionRows(sessions, new Set()).map((row) => ({
      id: row.session.id,
      depth: row.depth,
      descendants: row.descendantCount,
    }))).toEqual([
      { id: root.id, depth: 0, descendants: 2 },
      { id: other.id, depth: 0, descendants: 0 },
    ]);
    expect(groupedSessionRows(sessions, new Set([root.id, child.id])).map((row) => ({
      id: row.session.id,
      depth: row.depth,
    }))).toEqual([
      { id: root.id, depth: 0 },
      { id: child.id, depth: 1 },
      { id: grandchild.id, depth: 2 },
      { id: other.id, depth: 0 },
    ]);
  });

  it("下载中显示禁用的进度按钮而不是检查更新", () => {
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(SettingsView, {
        settings: {
          launchAtLogin: false,
          closeToTray: true,
          startGatewayOnLaunch: true,
          theme: "system",
          language: "en",
          experimentalToolBridge: false,
        },
        busy: false,
        update: { state: "downloading", currentVersion: "1.6.4", portable: false, percent: 42 },
        version: "1.6.4",
        onChange: vi.fn(),
        onCheckUpdate: vi.fn(),
        onDownloadUpdate: vi.fn(),
        onInstallUpdate: vi.fn(),
      }),
    ));

    expect(html).toContain("42%");
    expect(html).not.toContain(MESSAGES.en.config.checkUpdate);
    expect(html).toContain("disabled");
  });

  it("Keyring 把 99% 缓存命中率显示为绿色", () => {
    const cached = {
      ...profile("00000000-0000-4000-8000-000000000003", "Cached", "codex"),
      tokenInputTotal: 100,
      tokenCachedTotal: 99,
    };
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(KeyringView, {
        profiles: [cached],
        gateway: {
          status: "stopped",
          host: "127.0.0.1",
          port: 17863,
          targets: [],
          engaged: [],
          routes: [],
        },
        busy: null,
        loading: false,
        testingIds: new Set(),
        onCreate: vi.fn(),
        onEdit: vi.fn(),
        onDuplicate: vi.fn(),
        onDelete: vi.fn(),
        onApply: vi.fn(),
        onTest: vi.fn(),
        onTestAll: vi.fn(),
        onDiscoverModels: vi.fn(),
        onProbe: vi.fn(),
        onCopyKey: vi.fn(),
        onReorder: vi.fn(),
        onRetry: vi.fn(),
      }),
    ));

    expect(html).toContain("tier-good");
    expect(html).toContain("99.0%");
  });

  it("非流式请求即使残留 firstToken 字段也只显示 TTFB", () => {
    const startedAt = new Date().toISOString();
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(ActivityView, {
        requests: [{
          id: "request-1",
          client: "codex",
          profileName: "Non-streaming",
          upstreamUrl: "https://api.example/v1/responses",
          state: "completed",
          startedAt,
          completedAt: startedAt,
          durationMs: 500,
          firstTokenLatencyMs: 450,
          firstByteLatencyMs: 120,
          streaming: false,
          outcome: "completed",
          receivedBytes: 128,
        }],
      }),
    ));

    expect(html).toContain("TTFB");
    expect(html).toContain("120 ms");
    expect(html).not.toContain("TTFC");
    expect(html).toContain("tint-complete");
  });

  it("流式请求等待首内容时不先显示 TTFB 再中途换指标", () => {
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(ActivityView, {
        requests: [{
          id: "request-2",
          client: "codex",
          profileName: "Streaming",
          upstreamUrl: "https://api.example/v1/responses",
          state: "waiting-first-token",
          startedAt: new Date().toISOString(),
          firstByteLatencyMs: 120,
          streaming: true,
          receivedBytes: 64,
        }],
      }),
    ));

    expect(html).toContain("TTFC --");
    expect(html).not.toContain("TTFB");
    expect(html).not.toContain("TTFC 120 ms");
  });

  it("用量事件只替换对应方案，不触发全量状态重建", () => {
    const first = profile("00000000-0000-4000-8000-000000000010", "First", "codex");
    const second = profile("00000000-0000-4000-8000-000000000011", "Second", "claude");
    const updated = { ...second, tokenUsageTotal: 123 };
    const merged = mergeProfileUsage([first, second], updated);

    expect(merged).toEqual([first, updated]);
    expect(merged[0]).toBe(first);
    expect(mergeProfileUsage([first], updated)).toEqual([first]);
  });
});
