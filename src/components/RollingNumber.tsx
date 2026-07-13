import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";

const DIGITS = "0123456789";

/**
 * 两次变化间隔小于这个值时走快速单步（里程表式）。
 *
 * 高频小步快滚，低频变化才配整卷慢滚。窗口必须盖住整卷慢滚的最长时长
 * （延迟 160 + 时长 ~1700ms），否则周期性变化的值会在慢滚滚到一半时
 * 又触发下一卷，永远停不下来。
 */
const QUICK_WINDOW_MS = 2000;

/** 慢滚要滚过的随机数字位数。位数随机，于是每一位的滚动时长天然不同。 */
const SPIN_MIN = 5;
const SPIN_MAX = 12;

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

/** 数字与空位（辉光管熄灭态）才滚随机数字；标点、单位、箭头只做单步滑动。 */
function canSpin(from: string, to: string): boolean {
  const digitish = (c: string) => isDigit(c) || c === " ";
  return digitish(from) && digitish(to) && (isDigit(from) || isDigit(to));
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia !== "undefined"
    && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function randomDigit(): string {
  return DIGITS[Math.floor(Math.random() * 10)];
}

interface Reel {
  /** 纸带上的字符，自上而下。 */
  frames: string[];
  /** 窗口的起始格与最终停靠格。 */
  fromIndex: number;
  targetIndex: number;
  /** 整卷慢滚（带回弹与动态模糊）还是单步快滚。 */
  spin: boolean;
  duration: number;
  delay: number;
  /** 每次变化自增，用来丢弃过期动画的收尾回调。 */
  token: number;
}

/**
 * 单个字位的滚筒。
 *
 * 每次变化随机决定向上还是向下滚，随机滚过 5–12 个中间数字，时长与起步延迟
 * 也各自随机——同一读数里的各位不齐步，先后落定。落位前略微冲过头再弹回来
 * （纸带在停靠格之外多垫了一格，回弹时露出它的边）。
 *
 * 落位后把纸带收回单帧，否则每个字位会常驻十几个节点，请求流里成百上千。
 */
export function RollingChar({ char, ticker }: { char: string; ticker?: boolean }): ReactElement {
  const stripRef = useRef<HTMLSpanElement>(null);
  const settled = useRef(char);
  const lastChange = useRef(0);
  const counter = useRef(0);
  const [reel, setReel] = useState<Reel>({
    frames: [char],
    fromIndex: 0,
    targetIndex: 0,
    spin: false,
    duration: 0,
    delay: 0,
    token: 0,
  });

  useEffect(() => {
    const from = settled.current;
    if (from === char) return;
    settled.current = char;
    counter.current += 1;
    const token = counter.current;

    if (prefersReducedMotion()) {
      setReel({ frames: [char], fromIndex: 0, targetIndex: 0, spin: false, duration: 0, delay: 0, token });
      return;
    }

    // 秒表类读数永远快滚——每 10 秒整卷慢滚一次的秒表像坏掉的老虎机
    const now = Date.now();
    const quick = ticker || now - lastChange.current < QUICK_WINDOW_MS || !canSpin(from, char);
    lastChange.current = now;

    if (quick) {
      // 里程表式单步。方向固定向上——高频跳动再随机方向就成抽搐了。
      setReel({
        frames: [from, char],
        fromIndex: 0,
        targetIndex: 1,
        spin: false,
        duration: 230 + Math.random() * 90,
        delay: 0,
        token,
      });
      return;
    }

    const up = Math.random() < 0.5;
    const steps = SPIN_MIN + Math.floor(Math.random() * (SPIN_MAX - SPIN_MIN + 1));
    const mid = Array.from({ length: steps }, randomDigit);
    // 停靠格之外的垫格：回弹时露它的边。落在空位上就垫空位，弹出个数字来很怪。
    const pad = char === " " ? " " : randomDigit();

    setReel({
      // 向上滚：新字从下方来，纸带顺排；向下滚：新字从上方来，纸带倒排
      frames: up ? [from, ...mid, char, pad] : [pad, char, ...mid, from],
      fromIndex: up ? 0 : steps + 2,
      targetIndex: up ? steps + 1 : 1,
      spin: true,
      duration: 700 + steps * 60 + Math.random() * 280,
      delay: Math.random() * 160,
      token,
    });
  }, [char, ticker]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const count = reel.frames.length;
    if (!strip || count < 2) return undefined;

    const cell = 100 / count;
    const ty = (index: number) => `translateY(${-(index * cell)}%)`;
    const fromTy = -(reel.fromIndex * cell);
    const endTy = -(reel.targetIndex * cell);
    // 冲过头三分之一格再弹回；方向跟着行进方向走
    const overTy = endTy + Math.sign(endTy - fromTy) * cell * 0.34;

    const move = strip.animate(
      reel.spin
        ? [
          { transform: `translateY(${fromTy}%)`, easing: "cubic-bezier(.12, .68, .25, 1)" },
          { transform: `translateY(${overTy}%)`, offset: .82, easing: "cubic-bezier(.35, 0, .3, 1)" },
          { transform: `translateY(${endTy}%)` },
        ]
        : [
          { transform: ty(reel.fromIndex), easing: "cubic-bezier(.2, .9, .3, 1)" },
          { transform: ty(reel.targetIndex) },
        ],
      { duration: reel.duration, delay: reel.delay, fill: "both" },
    );

    // 动态模糊只给慢滚：起步最快时最糊，随减速一路变清
    const blur = reel.spin
      ? strip.animate(
        [
          { filter: "blur(0px)" },
          { filter: "blur(1.4px)", offset: .18 },
          { filter: "blur(.5px)", offset: .55 },
          { filter: "blur(0px)", offset: .85 },
          { filter: "blur(0px)" },
        ],
        { duration: reel.duration, delay: reel.delay, fill: "both" },
      )
      : undefined;

    // 收回单帧。cancel 交给下一轮 effect 的清理——它和收帧的 DOM 变更在同一次
    // 提交里同步发生，纸带归零与节点减少同时生效，不会闪。
    move.onfinish = () => {
      setReel((current) => (current.token === reel.token
        ? { ...current, frames: [char], fromIndex: 0, targetIndex: 0, spin: false }
        : current));
    };
    return () => {
      move.cancel();
      blur?.cancel();
    };
  }, [reel, char]);

  const rolling = reel.frames.length > 1;
  // 辉光管的点火辉光跟滚动同长（见 CSS 的 --roll-ms）
  const style = rolling
    ? { "--roll-ms": `${Math.round(reel.delay + reel.duration)}ms` } as CSSProperties
    : undefined;

  return (
    <span className="reel" data-rolling={rolling ? "" : undefined} style={style}>
      <span className="reel-strip" ref={stripRef}>
        {reel.frames.map((frame, index) => (
          <span className="reel-cell" key={index}>
            {frame === " " ? " " : frame}
          </span>
        ))}
      </span>
    </span>
  );
}

interface RollingNumberProps {
  /** 读数文本，逐字位滚到位。 */
  value: string;
  className?: string;
  /** 读数在本应用里默认是等宽的 <code>。 */
  as?: "code" | "strong" | "div" | "span";
  /** 秒表类持续跳动的读数：永远走里程表式快滚，不玩老虎机。 */
  ticker?: boolean;
  title?: string;
}

/** 读数：每一位都是一个滚筒，变化时随机上下滚过一串数字，先后落定。 */
export function RollingNumber({
  value,
  className,
  as: Tag = "code",
  title,
  ticker,
}: RollingNumberProps): ReactElement {
  return (
    <Tag className={["rolling", className].filter(Boolean).join(" ")} title={title}>
      {/* 读屏软件读整串，别让它一位一位念 */}
      <span className="sr-only">{value}</span>
      <span aria-hidden="true" className="reel-row">
        {[...value].map((char, index) => (
          <RollingChar key={index} char={char} ticker={ticker} />
        ))}
      </span>
    </Tag>
  );
}
