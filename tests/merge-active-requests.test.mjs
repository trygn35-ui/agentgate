import { describe, expect, it } from "vitest";
import { mergeActiveRequests } from "../src/lib/requests";

const row = (id, tokens) => ({
  id,
  client: "codex",
  profileName: "方案",
  upstreamUrl: "https://relay.example",
  state: "streaming",
  startedAt: "2026-07-14T10:00:00.000Z",
  tokenUsage: { outputTokens: tokens },
});

describe("增量请求合并", () => {
  it("按 id 就地换掉活跃的那几条，历史原样不动", () => {
    const current = [row("live", 10), row("done-1", 99), row("done-2", 88)];
    const merged = mergeActiveRequests(current, [row("live", 42)]);

    expect(merged.map((r) => r.id)).toEqual(["live", "done-1", "done-2"]);
    expect(merged[0].tokenUsage.outputTokens).toBe(42);
    // 历史那两条必须是原来的对象引用——它们没变，React 才不会白重渲
    expect(merged[1]).toBe(current[1]);
    expect(merged[2]).toBe(current[2]);
  });

  it("空增量原样返回，不白造一个新数组", () => {
    const current = [row("a", 1)];
    expect(mergeActiveRequests(current, [])).toBe(current);
  });

  it("列表里还没有的请求也追加进去，避免 bootstrap 与事件交错时丢失", () => {
    const current = [row("a", 1)];
    const merged = mergeActiveRequests(current, [row("未知", 5)]);
    expect(merged.map((r) => r.id)).toEqual(["a", "未知"]);
    expect(merged[0]).toBe(current[0]);
  });

  it("删除过期历史时只移除指定 ID，其他对象引用保持不变", () => {
    const current = [row("live", 10), row("stale", 99), row("keep", 88)];
    const merged = mergeActiveRequests(current, [row("live", 42)], ["stale"]);
    expect(merged.map((r) => r.id)).toEqual(["live", "keep"]);
    expect(merged[0].tokenUsage.outputTokens).toBe(42);
    expect(merged[1]).toBe(current[2]);
  });

  it("bootstrap 竞态追加未知请求时仍保持最新开始时间在前", () => {
    const current = [
      { ...row("old", 1), startedAt: "2026-07-14T10:00:00.000Z" },
      { ...row("older", 2), startedAt: "2026-07-14T09:00:00.000Z" },
    ];
    const merged = mergeActiveRequests(current, [
      { ...row("new", 3), startedAt: "2026-07-14T11:00:00.000Z" },
    ]);
    expect(merged.map((entry) => entry.id)).toEqual(["new", "old", "older"]);
  });
});
