import { describe, expect, it } from "vitest";
import {
  finishReelState,
  getReelRemainingMs,
  MIN_REEL_REMAINING_MS,
  requestReelTarget,
} from "../src/components/RollingNumber";

function activeState() {
  const reel = {
    frames: ["4", "8", "2", "1"],
    fromIndex: 3,
    targetIndex: 0,
    spin: true,
    duration: 2840,
    delay: 120,
    token: 7,
  };
  return { reel, desired: "4" };
}

function targetOf(state) {
  return state.reel.frames[state.reel.targetIndex];
}

describe("rolling number", () => {
  it("播放期间原位改写终点，不重启正在播放的纸带", () => {
    const state = activeState();

    const updated = requestReelTarget(state, "9", false, 8);

    expect(updated.desired).toBe("9");
    expect(updated.reel).not.toBe(state.reel);
    expect(updated.reel.frames).toEqual(["9", "8", "2", "1"]);
    expect(targetOf(updated)).toBe("9");
    expect(updated.reel.token).toBe(7);
    expect(updated.reel.duration).toBe(2840);
    expect(updated.reel.delay).toBe(120);
  });

  it("连续多次更新保持当前进度并始终指向最后一个目标", () => {
    const state = activeState();

    const first = requestReelTarget(state, "6", false, 8);
    const second = requestReelTarget(first, "2", false, 9);
    const latest = requestReelTarget(second, "9", false, 10);

    expect(latest.desired).toBe("9");
    expect(targetOf(latest)).toBe("9");
    expect(latest.reel.token).toBe(7);
    expect(latest.reel.duration).toBe(2840);
    expect(latest.reel.delay).toBe(120);
  });

  it("剩余时间充足时仍原位改写终点", () => {
    const state = activeState();

    const updated = requestReelTarget(
      state,
      "9",
      false,
      8,
      MIN_REEL_REMAINING_MS,
    );

    expect(targetOf(updated)).toBe("9");
    expect(updated.reel.token).toBe(7);
  });

  it("进入临界尾段后保留当前终点，并在落位后接上最新目标", () => {
    const state = activeState();

    const queued = requestReelTarget(
      state,
      "9",
      false,
      8,
      MIN_REEL_REMAINING_MS - 1,
    );

    expect(queued.desired).toBe("9");
    expect(queued.reel).toBe(state.reel);
    expect(targetOf(queued)).toBe("4");

    const continued = finishReelState(queued, 7, false, 8);
    expect(continued.desired).toBe("9");
    expect(continued.reel.token).toBe(8);
    expect(continued.reel.delay).toBe(0);
    expect(continued.reel.frames[continued.reel.fromIndex]).toBe("4");
    expect(targetOf(continued)).toBe("9");
  });

  it("临界尾段内连续更新只把下一卷指向最后一个目标", () => {
    const state = activeState();
    const first = requestReelTarget(state, "9", false, 8, 120);
    const latest = requestReelTarget(first, "2", false, 9, 80);

    expect(latest.reel).toBe(state.reel);
    expect(latest.desired).toBe("2");

    const continued = finishReelState(latest, 7, false, 10);
    expect(continued.reel.delay).toBe(0);
    expect(targetOf(continued)).toBe("2");
  });

  it("按动画 currentTime 计算包含 delay 的实际剩余时间", () => {
    const state = activeState();

    expect(getReelRemainingMs(state.reel, 2_600)).toBe(360);
    expect(getReelRemainingMs(state.reel, 3_200)).toBe(0);
    expect(getReelRemainingMs(state.reel, null)).toBeUndefined();
  });

  it("当前纸带直接落到最新目标，不追加第二段动画", () => {
    const state = requestReelTarget(activeState(), "9", false, 8);

    const finished = finishReelState(state, 7, false, 8);

    expect(finished.desired).toBe("9");
    expect(finished.reel.token).toBe(8);
    expect(finished.reel.frames).toEqual(["9"]);
    expect(targetOf(finished)).toBe("9");
  });

  it("陈旧的结束回调不能收掉较新的纸带", () => {
    const state = {
      ...activeState(),
      reel: { ...activeState().reel, token: 9 },
      desired: "8",
    };

    const unchanged = finishReelState(state, 7, false, 10);

    expect(unchanged).toBe(state);
  });

  it("update 与 finish 无论谁先发生都会滚向最新目标", () => {
    const updateFirst = finishReelState(
      requestReelTarget(activeState(), "9", false, 8),
      7,
      false,
      8,
    );
    expect(targetOf(updateFirst)).toBe("9");
    expect(updateFirst.reel.frames).toEqual(["9"]);

    const finished = finishReelState(activeState(), 7, false, 8);
    expect(finished.reel.frames).toEqual(["4"]);
    expect(finished.reel.token).toBe(8);

    const finishFirst = requestReelTarget(finished, "9", false, 9);
    expect(finishFirst.reel.token).toBe(9);
    expect(finishFirst.reel.frames[finishFirst.reel.fromIndex]).toBe("4");
    expect(targetOf(finishFirst)).toBe("9");
  });
});
