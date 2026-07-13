import type { ReactElement } from "react";
import type { DivergenceTier } from "../lib/divergence";

interface NixieTubesProps {
  /** 要显示的数字串，可含小数点；undefined 表示无数据（全管留空）。 */
  value?: string;
  /** 无数据时的管位数，用于渲染空管阵列。 */
  blankLength?: number;
  tier?: DivergenceTier;
  label?: string;
}

const TIER_CLASS: Record<DivergenceTier, string> = {
  nominal: "",
  diverging: "warn",
  critical: "bad",
};

/**
 * 辉光管数字阵列（Divergence Meter）。
 *
 * 三个细节缺一不可，少任何一个就只是「橙色数字」：
 * 1. 幽灵阴极——每管后面叠着极暗的未点亮数字（用 data-ghost 由 CSS 绘制）
 * 2. 阳极栅网——管面的斜向细网格（暗色主题下的 ::after）
 * 3. 小数点独占一管——原作就是这么排的
 *
 * 无数据时全管留空，对应原作分歧仪无法显示负值时首位留空的约定。
 */
export function NixieTubes({
  value,
  blankLength = 8,
  tier = "nominal",
  label,
}: NixieTubesProps): ReactElement {
  const chars = value ? [...value] : Array.from({ length: blankLength }, () => "0");
  const blank = !value;

  return (
    <div
      className={`tubes ${TIER_CLASS[tier]}`}
      role="img"
      aria-label={label ?? (value ? `读数 ${value}` : "无数据")}
    >
      {chars.map((char, index) => {
        const isDot = char === ".";
        const className = [
          "tube",
          isDot ? "dot" : "",
          blank ? "blank" : "",
        ].filter(Boolean).join(" ");
        return (
          <span
            key={index}
            className={className}
            aria-hidden="true"
            data-ghost={isDot ? "." : "8"}
          >
            {char}
          </span>
        );
      })}
    </div>
  );
}
