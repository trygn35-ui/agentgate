import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { CLIENT_META, CLIENT_TARGET_ORDER, PROTOCOL_META } from "../config";
import {
  computeDivergence,
  formatDivergence,
  formatRate,
  formatTokenTotal,
  recentCacheRate,
  todayTokenTotal,
} from "../lib/divergence";
import type {
  ActiveRequest,
  ClientStatus,
  ClientTarget,
  GatewayState,
  HealthState,
  Profile,
} from "../types";
import { NixieTubes } from "./NixieTubes";

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
  /** 最近一小时的请求记录，用于窗口指标。 */
  requests: ActiveRequest[];
  activeRequestCount: number;
  busy: boolean;
  onApply: (id: string, target: ClientTarget) => void;
  onGoActivity: () => void;
}

function healthTag(profile: Profile): { text: string; className: string } {
  const status = profile.health?.status ?? "unknown";
  if (status === "healthy") return { text: `${profile.health?.latencyMs ?? 0} ms`, className: "tier-good" };
  if (status === "limited") return { text: "LIMITED", className: "tier-warn" };
  if (status === "unhealthy") return { text: "DOWN", className: "tier-bad" };
  return { text: "", className: "tier-quiet" };
}

/**
 * 概览页：DIVERGENCE METER 与客户端铭牌。
 *
 * 仪表三格各司其职：左边告诉你「该不该换线路」（分歧率），中间「省不省钱」
 * （缓存率），右边「用了多少」（累计 Token）。
 */
export function OverviewView({
  profiles,
  clients,
  gateway,
  requests,
  activeRequestCount,
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
    flashTimer.current = window.setTimeout(() => setFlashTarget(undefined), 500);
  }

  const routeCount = gateway.routes
    .filter((route) => profiles.some((profile) => profile.id === route.profileId))
    .length;
  const divergence = computeDivergence(profiles, gateway);
  const cacheRate = recentCacheRate(requests);
  const tokenToday = todayTokenTotal(profiles);

  const heroTitle = gateway.status === "starting"
    ? "Gateway Starting"
    : gateway.status === "stopping"
      ? "Gateway Stopping"
      : gateway.status === "error"
        ? "Gateway Fault"
        : gatewayOn ? "Gateway Online" : "Gateway Offline";
  const heroSub = gateway.status === "error"
    ? gateway.error ?? "配置被外部修改，请在顶栏恢复并关闭网关"
    : gatewayOn
      ? `${routeCount} ROUTES BOUND · ${profiles.length} PROFILES READY`
      : "CLIENTS DIRECT TO UPSTREAM · TOGGLE GATEWAY TO BIND";

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
              onClick={onGoActivity}
            >
              <i />
              {activeRequestCount > 0 ? `${activeRequestCount} STREAMING` : "IDLE"}
              <ArrowRight size={11} />
            </button>
          </p>
        </section>

        <section className="meter rise-1" aria-label="指标">
          <div className="meter-cell">
            <div className="meter-label">D I V E R G E N C E</div>
            <NixieTubes
              value={divergence ? formatDivergence(divergence.ratio) : undefined}
              tier={divergence?.tier}
              label={divergence
                ? `分歧率 ${formatDivergence(divergence.ratio)}，当前 ${divergence.currentMs} 毫秒，基准 ${divergence.baselineMs} 毫秒`
                : "分歧率无数据，等待基准样本"}
            />
            <div
              className={`meter-sub ${divergence?.tier === "critical"
                ? "tier-bad"
                : divergence?.tier === "diverging" ? "tier-warn" : ""}`}
            >
              {divergence
                ? `${divergence.currentMs}ms / ${divergence.baselineMs}ms BASELINE · ${divergence.profileName}`
                : gatewayOn ? "AWAITING BASELINE · 需 3 个探测样本" : "GATEWAY OFFLINE"}
            </div>
          </div>

          <div className="meter-divider" />

          <div className="meter-cell">
            <div className="meter-label">C A C H E &nbsp; H I T</div>
            <div className={`meter-plain ${cacheRate === undefined ? "dim" : ""}`}>
              {formatRate(cacheRate)}
            </div>
            <div className="meter-sub">LAST HOUR · {requests.length} REQUESTS</div>
          </div>

          <div className="meter-divider" />

          <div className="meter-cell">
            <div className="meter-label">T O K E N S</div>
            <div className={`meter-plain ${tokenToday === 0 ? "dim" : ""}`}>
              {formatTokenTotal(tokenToday)}
            </div>
            <div className="meter-sub">TODAY · RESETS AT 00:00</div>
          </div>
        </section>

        <section aria-label="客户端" className="rise-2" style={{ marginTop: 22 }}>
          <div className="section-head">
            <span className="kicker">CLIENTS</span>
            <h2>World Lines</h2>
            <span className="head-hint">CLICK TO JUMP · INSTANT</span>
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
                `tone-${CLIENT_META[target].tone}`,
                profile ? "" : "empty",
                open ? "picker-open" : "",
                flashTarget === target ? "flash" : "",
              ].filter(Boolean).join(" ");
              const dotClass = profile
                ? gatewayOn ? HEALTH_DOT[profile.health?.status ?? "unknown"] : "dot-warn"
                : "dot-unknown";
              const detail = client?.drifted
                ? "EXTERNAL EDIT DETECTED"
                : profile
                  ? profile.baseUrl.replace(/^https?:\/\//, "")
                  : route
                    ? "PROFILE REMOVED"
                    : client && !client.installed
                      ? "CLIENT NOT DETECTED"
                      : "NO PROFILE BOUND";
              return (
                <div className="socket-cell" key={target}>
                  <button
                    type="button"
                    className={cardClass}
                    style={{ animationDelay: `${80 + index * 45}ms` }}
                    aria-label={`为 ${CLIENT_META[target].label} 选择方案`}
                    aria-expanded={open}
                    onClick={() => setPickerFor(open ? undefined : target)}
                  >
                    <span className="socket-no">{String(index + 1).padStart(2, "0")}</span>
                    <span className="socket-title">
                      <strong>{CLIENT_META[target].label.toUpperCase()}</strong>
                    </span>
                    <span className="socket-profile">
                      <span className="socket-profile-line">
                        <i className={`socket-dot ${dotClass}`} />
                        <strong>{profile?.name ?? route?.profileName ?? "UNBOUND"}</strong>
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
                        const tag = current
                          ? { text: "CURRENT", className: "tier-orange" }
                          : healthTag(option);
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
                                {PROTOCOL_META[option.protocol].short.toUpperCase()} · {option.model || "CLIENT DEFAULT"}
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
      </div>
    </main>
  );
}
