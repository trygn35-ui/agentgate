import type { ReactElement } from "react";
import type { GatewayState } from "../types";

interface GatewaySwitchProps {
  gateway: GatewayState;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
}

const STATUS_LABEL = {
  stopped: "网关已关闭",
  starting: "网关正在启动",
  running: "网关运行中",
  stopping: "网关正在停止",
  error: "网关需要处理",
} as const;

/**
 * 顶栏网关开关：胶囊形态的 role=switch，含状态点、文字和拨杆。
 *
 * starting/stopping 显示过渡状态；error 时点击执行恢复并关闭。
 */
export function GatewaySwitch({ gateway, busy, onStart, onStop }: GatewaySwitchProps): ReactElement {
  const enabled = gateway.status === "running" || gateway.status === "starting";
  const transitioning = gateway.status === "starting" || gateway.status === "stopping";
  const needsRecovery = gateway.status === "error" && gateway.routes.length > 0;
  const actionLabel = needsRecovery
    ? "恢复配置并关闭本地网关"
    : `${enabled ? "关闭" : "开启"}本地网关`;
  const className = [
    "gateway-switch",
    enabled ? "on" : "",
    transitioning ? "busy" : "",
    gateway.status === "error" ? "error" : "",
  ].filter(Boolean).join(" ");

  return (
    <button
      type="button"
      className={className}
      role="switch"
      aria-checked={enabled}
      aria-label={actionLabel}
      title={gateway.error
        ? `${STATUS_LABEL[gateway.status]}：${gateway.error}`
        : "客户端固定连接本地地址；切换方案不改客户端配置"}
      disabled={busy}
      onClick={() => {
        if (enabled || needsRecovery) onStop();
        else onStart();
      }}
    >
      <i className="gateway-dot"><i /></i>
      <strong>网关</strong>
      <span className="gateway-track" aria-hidden="true"><span /></span>
    </button>
  );
}
