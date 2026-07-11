import { AlertCircle, ArrowRight, CheckCircle2, ChevronsUpDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { CLIENT_META, CLIENT_TARGET_ORDER, PROTOCOL_META } from "../config";
import { formatDateTime } from "../lib/format";
import type {
  ClientStatus,
  ClientTarget,
  GatewayState,
  HealthState,
  HistoryEntry,
  Profile,
} from "../types";
import type { FeedTab } from "../ui-types";

const HEALTH_DOT: Record<HealthState, string> = {
  healthy: "dot-good",
  limited: "dot-warn",
  unhealthy: "dot-bad",
  unknown: "dot-unknown",
};

interface OverviewViewProps {
  profiles: Profile[];
  clients: ClientStatus[];
  gateway: GatewayState;
  activeRequestCount: number;
  history: HistoryEntry[];
  busy: boolean;
  onApply: (id: string, target: ClientTarget) => void;
  onGoActivity: (tab: FeedTab) => void;
}

function healthTag(profile: Profile): { text: string; className: string } {
  const status = profile.health?.status ?? "unknown";
  if (status === "healthy") return { text: `${profile.health?.latencyMs ?? 0} ms`, className: "tint-good" };
  if (status === "limited") return { text: "受限", className: "tint-warn" };
  if (status === "unhealthy") return { text: "异常", className: "tint-bad" };
  return { text: "", className: "tint-quiet" };
}

/**
 * 概览页：网关状态标题、四张客户端卡片和最近切换。
 *
 * 点击客户端卡片弹出适配方案菜单，选择后立即切换该客户端的网关路由。
 */
export function OverviewView({
  profiles,
  clients,
  gateway,
  activeRequestCount,
  history,
  busy,
  onApply,
  onGoActivity,
}: OverviewViewProps): ReactElement {
  const [pickerFor, setPickerFor] = useState<ClientTarget>();
  const [flashTarget, setFlashTarget] = useState<ClientTarget>();
  const flashTimer = useRef<number>(undefined);
  const gatewayOn = gateway.status === "running" || gateway.status === "starting";

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  useEffect(() => {
    if (!pickerFor) return undefined;
    function handleKey(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setPickerFor(undefined);
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [pickerFor]);

  function pick(profileId: string, target: ClientTarget): void {
    setPickerFor(undefined);
    onApply(profileId, target);
    setFlashTarget(target);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashTarget(undefined), 600);
  }

  const routeCount = gateway.routes
    .filter((route) => profiles.some((profile) => profile.id === route.profileId))
    .length;
  const heroTitle = gateway.status === "starting"
    ? "网关正在启动"
    : gateway.status === "stopping"
      ? "网关正在停止"
      : gateway.status === "error"
        ? "网关需要处理"
        : gatewayOn ? "网关运行中" : "网关已关闭";
  const heroSub = gateway.status === "error"
    ? gateway.error ?? "配置被外部修改，请在顶栏恢复并关闭网关"
    : gatewayOn
      ? `${routeCount} 条路由生效 · ${profiles.length} 个方案就绪`
      : "客户端暂时直连上游 · 打开右上角开关恢复接管";

  return (
    <main className="page-scroll" aria-label="概览">
      {pickerFor && (
        <button
          type="button"
          className="overlay-scrim"
          aria-label="关闭浮层"
          onClick={() => setPickerFor(undefined)}
        />
      )}
      <div className="page-inner">
        <section aria-label="状态" className="hero rise">
          <h1>{heroTitle}</h1>
          <p>
            <span>{heroSub}</span>
            <button
              type="button"
              className={`live-link ${activeRequestCount > 0 ? "live" : ""}`}
              onClick={() => onGoActivity("requests")}
            >
              <i />
              {activeRequestCount > 0 ? `${activeRequestCount} 个活跃请求` : "当前空闲"}
              <ArrowRight size={12} />
            </button>
          </p>
        </section>

        <section aria-label="客户端" className="rise-1" style={{ marginTop: 28 }}>
          <div className="section-head">
            <span className="kicker">CLIENTS</span>
            <h2>客户端</h2>
            <span className="head-hint">点击卡片换方案，立即生效</span>
          </div>
          <div className="socket-grid">
            {CLIENT_TARGET_ORDER.map((target, index) => {
              const client = clients.find((item) => item.target === target);
              const route = gateway.routes.find((item) => item.target === target);
              const profile = route
                ? profiles.find((item) => item.id === route.profileId)
                : undefined;
              const options = profiles.filter((item) => item.targets.includes(target));
              const open = pickerFor === target;
              const cardClass = [
                "socket-card",
                profile ? "" : "empty",
                open ? "picker-open" : "",
                flashTarget === target ? "flash" : "",
              ].filter(Boolean).join(" ");
              const dotClass = profile
                ? gatewayOn ? HEALTH_DOT[profile.health?.status ?? "unknown"] : "dot-warn"
                : "dot-unknown";
              const detail = client?.drifted
                ? "检测到外部修改"
                : profile
                  ? profile.baseUrl.replace(/^https?:\/\//, "")
                  : route
                    ? "方案已删除"
                    : client && !client.installed
                      ? "未检测到客户端"
                      : "在密钥页分配方案";
              return (
                <div className="socket-cell" key={target}>
                  <button
                    type="button"
                    className={cardClass}
                    style={{ animationDelay: `${90 + index * 55}ms` }}
                    aria-label={`为 ${CLIENT_META[target].label} 选择方案`}
                    aria-expanded={open}
                    onClick={() => setPickerFor(open ? undefined : target)}
                  >
                    <span className="socket-title">
                      <strong>{CLIENT_META[target].label}</strong>
                      <ChevronsUpDown size={13} />
                    </span>
                    <span className="socket-profile">
                      <span className="socket-profile-line">
                        <i className={`socket-dot ${dotClass} ${profile && gatewayOn ? "pulse" : ""}`} />
                        <strong>{profile?.name ?? route?.profileName ?? "未接入"}</strong>
                      </span>
                      <code className={`socket-detail ${client?.drifted ? "warn" : ""}`} title={detail}>
                        {detail}
                      </code>
                    </span>
                  </button>
                  {open && (
                    <div className="picker-menu" role="menu" aria-label="选择方案">
                      {options.length > 0 ? options.map((option) => {
                        const current = route?.profileId === option.id;
                        const tag = current ? { text: "当前", className: "tint-accent" } : healthTag(option);
                        return (
                          <button
                            type="button"
                            role="menuitem"
                            className={`picker-item ${current ? "current" : ""}`}
                            key={option.id}
                            disabled={current || busy}
                            onClick={() => pick(option.id, target)}
                          >
                            <i className={HEALTH_DOT[option.health?.status ?? "unknown"]} />
                            <span style={{ minWidth: 0 }}>
                              <strong>{option.name}</strong>
                              <code>
                                {PROTOCOL_META[option.protocol].short} · {option.model || "沿用客户端"}
                              </code>
                            </span>
                            <small className={tag.className}>{tag.text}</small>
                          </button>
                        );
                      }) : (
                        <button type="button" role="menuitem" className="picker-item" disabled>
                          <i className="dot-unknown" />
                          <span style={{ minWidth: 0 }}>
                            <strong>没有适配此客户端的方案</strong>
                            <code>编辑方案，勾选 {CLIENT_META[target].label}</code>
                          </span>
                          <small />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section aria-label="最近切换" className="rise-2" style={{ marginTop: 30 }}>
          <div className="section-head">
            <span className="kicker">RECENT</span>
            <h2>最近切换</h2>
            <button type="button" className="text-link" onClick={() => onGoActivity("history")}>
              全部记录<ArrowRight size={12} />
            </button>
          </div>
          <div>
            {history.slice(0, 3).map((entry, index) => (
              <div className="event-row" key={entry.id} style={{ animationDelay: `${index * 40}ms` }}>
                <span className={`event-icon ${entry.success ? "good" : "bad"}`}>
                  {entry.success ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                </span>
                <time>{formatDateTime(entry.createdAt)}</time>
                <span className="event-main event-title">
                  <strong>{entry.profileName}</strong>
                  <small>→ {entry.targets.map((target) => CLIENT_META[target].short).join("、")}</small>
                </span>
                <small className={`event-result ${entry.success ? "good" : "bad"}`}>
                  {entry.success ? "成功" : "失败"}
                </small>
              </div>
            ))}
            {history.length === 0 && <p className="feed-empty">还没有切换记录。</p>}
          </div>
        </section>
      </div>
    </main>
  );
}
