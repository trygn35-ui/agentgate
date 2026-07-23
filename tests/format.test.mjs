import { describe, expect, it } from "vitest";
import { formatDateTime, relativeTime } from "../src/lib/format";

describe("time formatting", () => {
  it("非法非空时间使用安全占位而不是抛出异常", () => {
    expect(relativeTime("not-a-date", "zh-CN", "从未")).toBe("从未");
    expect(formatDateTime("not-a-date", "zh-CN")).toBe("--");
  });
});
