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

  it("列表里还没有的请求忽略掉——下一次全量通知会带上它", () => {
    const current = [row("a", 1)];
    const merged = mergeActiveRequests(current, [row("未知", 5)]);
    expect(merged.map((r) => r.id)).toEqual(["a"]);
  });
});
