import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  LoaderCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { CLIENT_META } from "../config";
import { useI18n } from "../i18n";
import type { Messages } from "../i18n";
import { formatDuration, formatTokenCount } from "../lib/format";
import { cacheRateTier } from "../lib/health";
import { RollingNumber } from "./RollingNumber";
import type { ActiveRequest, ClientTarget } from "../types";
import type { RequestFilter } from "../ui-types";

interface RequestMeta {
  label: string;
  tint: string;
  icon: "loader" | "dot" | "check" | "alert";
  breathe?: boolean;
  spin?: boolean;
}

function requestMeta(m: Messages): Record<ActiveRequest["state"], RequestMeta> {
  const s = m.stream.states;
  return {
    connecting: { label: s.connect, tint: "tint-accent", icon: "loader", spin: true },
    "waiting-first-token": { label: s.wait, tint: "tint-accent", icon: "loader", spin: true },
    streaming: { label: s.stream, tint: "tint-good", icon: "dot", breathe: true },
    completed: { label: s.done, tint: "tint-good", icon: "check" },
    failed: { label: s.fail, tint: "tint-bad", icon: "alert" },
    aborted: { label: s.abort, tint: "tint-warn", icon: "dot" },
    cancelled: { label: s.cancel, tint: "tint-warn", icon: "dot" },
  };
}

const REASONING_LABEL: Record<string, string> = {
  minimal: "MIN",
  low: "LOW",
  medium: "MED",
  high: "HIGH",
  xhigh: "MAX",
};

function clientLabel(client: ActiveRequest["client"]): string {
  return client in CLIENT_META
    ? CLIENT_META[client as ClientTarget].label
    : String(client);
}

/** 客户端品牌色类：Claude 橙 / Codex 绿 / Gemini 蓝 / OpenCode 紫。 */
function clientTone(client: ActiveRequest["client"]): string {
  return client in CLIENT_META
    ? `tone-${CLIENT_META[client as ClientTarget].tone}`
    : "";
}

/** 首字时延色阶：<5s 绿、5-10s 蓝、10-30s 黄、30-60s 橙、60s+ 红。 */
function latencyTier(milliseconds?: number): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "tier-quiet";
  if (milliseconds < 5_000) return "tier-good";
  if (milliseconds < 10_000) return "tier-info";
  if (milliseconds < 30_000) return "tier-warn";
  if (milliseconds < 60_000) return "tier-orange";
  return "tier-bad";
}

function cacheRate(request: ActiveRequest): number | undefined {
  const input = request.tokenUsage?.inputTokens;
  const cached = request.tokenUsage?.cachedTokens;
  if (input === undefined || cached === undefined || !Number.isFinite(input) || input <= 0) {
    return undefined;
  }
  return Math.min(100, (cached / input) * 100);
}

function formatClock(value: string, clock: Intl.DateTimeFormat): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : clock.format(date);
}

function isActive(request: ActiveRequest): boolean {
  return !request.completedAt
    && ["connecting", "waiting-first-token", "streaming"].includes(request.state);
}

function matchesFilter(request: ActiveRequest, filter: RequestFilter): boolean {
  if (filter === "active") return isActive(request);
  if (filter === "completed") return request.outcome === "completed";
  if (filter === "failed") return ["failed", "aborted", "cancelled"].includes(request.outcome ?? "");
  return true;
}

function RequestStateIcon({ meta }: { meta: RequestMeta }): ReactElement {
  if (meta.icon === "loader") return <LoaderCircle size={15} className={meta.spin ? "spin" : ""} />;
  if (meta.icon === "check") return <CheckCircle2 size={15} />;
  if (meta.icon === "alert") return <AlertCircle size={15} />;
  return <CircleDot size={15} />;
}

interface ActivityViewProps {
  requests: ActiveRequest[];
}

/**
 * 动态页：网关转发的实时请求流。
 *
 * 展示进行中与最近完成的请求，含模型、Token、缓存率与时延指标。
 */
export function ActivityView({ requests }: ActivityViewProps): ReactElement {
  const { locale, m, fill } = useI18n();
  const [filter, setFilter] = useState<RequestFilter>("all");
  const [now, setNow] = useState(() => Date.now());
  const activeCount = requests.filter(isActive).length;
  const visibleRequests = useMemo(
    () => requests.filter((request) => matchesFilter(request, filter)),
    [filter, requests],
  );
  const meta = useMemo(() => requestMeta(m), [m]);
  const clock = useMemo(() => new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }), [locale]);

  useEffect(() => {
    if (activeCount === 0) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, [activeCount]);

  const liveText = activeCount > 0 ? fill(m.stream.streaming, { count: activeCount }) : m.stream.idle;

  return (
    <main className="page-scroll" aria-label={m.stream.title}>
      <div className="page-inner">
        <div className="section-head rise" style={{ alignItems: "center" }}>
          <h1>{m.stream.title}</h1>
          <span className="head-note">
            <span key={liveText} className="swap-text">{liveText}</span> · {m.stream.retained}
          </span>
          <span style={{ marginLeft: "auto" }} />
          {(
            <div className="req-filters" role="radiogroup" aria-label={m.stream.title}>
              {([
                ["all", m.stream.all],
                ["active", m.stream.live],
                ["completed", m.stream.done],
                ["failed", m.stream.fail],
              ] as Array<[RequestFilter, string]>).map(([value, label]) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={filter === value}
                  className={filter === value ? "active" : ""}
                  key={value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          {visibleRequests.map((request, index) => {
              const state = meta[request.state];
              const startedAt = new Date(request.startedAt).getTime();
              const elapsed = request.durationMs ?? (
                isActive(request) && Number.isFinite(startedAt)
                  ? Math.max(0, now - startedAt)
                  : undefined
              );
              const firstLatency = request.firstTokenLatencyMs ?? request.firstByteLatencyMs;
              const firstLabel = request.firstTokenLatencyMs !== undefined ? "TTFT" : "TTFB";
              const reasoning = request.reasoningEffort
                ? REASONING_LABEL[request.reasoningEffort.toLocaleLowerCase()] ?? request.reasoningEffort
                : "DEFAULT";
              const subline = reasoning
                + (request.streaming === true ? " · STREAM" : request.streaming === false ? " · SYNC" : "");
              const tokens = request.tokenUsage;
              const rate = cacheRate(request);
              return (
                <article
                  className="request-row"
                  key={request.id}
                  style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
                >
                  <span
                    className={`request-state-icon ${state.tint} ${state.breathe ? "breathe" : ""}`}
                    title={state.label}
                  >
                    <RequestStateIcon meta={state} />
                  </span>
                  <span className="request-main">
                    <span className="request-title">
                      <strong>{request.profileName}</strong>
                      <small className={`tag-client ${clientTone(request.client)}`}>
                        {clientLabel(request.client)}
                      </small>
                    </span>
                    <code className="request-sub" title={request.upstreamUrl}>
                      {formatClock(request.startedAt, clock)} · {request.upstreamUrl || m.stream.resolving}
                    </code>
                  </span>
                  <span className="request-model">
                    <code title={request.model}>{request.model || "———"}</code>
                    <small>{subline}</small>
                  </span>
                  <span className="request-tokens">
                    <RollingNumber className="tok-in" value={`↓${formatTokenCount(tokens?.inputTokens)}`} />
                    <RollingNumber className="tok-out" value={`↑${formatTokenCount(tokens?.outputTokens)}`} />
                    <small>CACHED {formatTokenCount(tokens?.cachedTokens)}</small>
                  </span>
                  <span className="cache-rate">
                    <RollingNumber
                      className={cacheRateTier(rate)}
                      value={rate === undefined ? "———" : (rate / 100).toFixed(3)}
                    />
                    <small>{m.stream.cache}</small>
                  </span>
                  <span className="request-timing">
                    <RollingNumber ticker value={formatDuration(elapsed)} />
                    <small className={latencyTier(firstLatency)}>{firstLabel} {formatDuration(firstLatency)}</small>
                  </span>
                  <strong className={`request-state-label ${state.tint}`}>{state.label}</strong>
                </article>
              );
            })}
          {visibleRequests.length === 0 && (
            <p className="feed-empty">
              {requests.length === 0 ? m.stream.empty : m.stream.noMatch}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
