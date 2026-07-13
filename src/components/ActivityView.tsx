import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  LoaderCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { CLIENT_META } from "../config";
import { formatDuration, formatTokenCount } from "../lib/format";
import { cacheRateTier } from "../lib/health";
import type { ActiveRequest, ClientTarget } from "../types";
import type { RequestFilter } from "../ui-types";

const CLOCK_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

interface RequestMeta {
  label: string;
  tint: string;
  icon: "loader" | "dot" | "check" | "alert";
  breathe?: boolean;
  spin?: boolean;
}

const REQUEST_META: Record<ActiveRequest["state"], RequestMeta> = {
  connecting: { label: "CONNECT", tint: "tint-accent", icon: "loader", spin: true },
  "waiting-first-token": { label: "WAIT", tint: "tint-accent", icon: "loader", spin: true },
  streaming: { label: "STREAM", tint: "tint-good", icon: "dot", breathe: true },
  completed: { label: "DONE", tint: "tint-good", icon: "check" },
  failed: { label: "FAIL", tint: "tint-bad", icon: "alert" },
  aborted: { label: "ABORT", tint: "tint-warn", icon: "dot" },
  cancelled: { label: "CANCEL", tint: "tint-warn", icon: "dot" },
};

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

function formatClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : CLOCK_FORMATTER.format(date);
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
  const [filter, setFilter] = useState<RequestFilter>("all");
  const [now, setNow] = useState(() => Date.now());
  const activeCount = requests.filter(isActive).length;
  const visibleRequests = useMemo(
    () => requests.filter((request) => matchesFilter(request, filter)),
    [filter, requests],
  );

  useEffect(() => {
    if (activeCount === 0) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, [activeCount]);

  return (
    <main className="page-scroll" aria-label="动态">
      <div className="page-inner">
        <div className="section-head rise" style={{ alignItems: "center" }}>
          <h1>Stream</h1>
          <span className="head-note">
{activeCount > 0 ? `${activeCount} STREAMING` : "IDLE"} · LAST 100 RETAINED
          </span>
          <span style={{ marginLeft: "auto" }} />
          {(
            <div className="req-filters" role="radiogroup" aria-label="请求筛选">
              {([
                ["all", "ALL"],
                ["active", "LIVE"],
                ["completed", "DONE"],
                ["failed", "FAIL"],
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
              const meta = REQUEST_META[request.state];
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
                    className={`request-state-icon ${meta.tint} ${meta.breathe ? "breathe" : ""}`}
                    title={meta.label}
                  >
                    <RequestStateIcon meta={meta} />
                  </span>
                  <span className="request-main">
                    <span className="request-title">
                      <strong>{request.profileName}</strong>
                      <small className={`tag-client ${clientTone(request.client)}`}>
                        {clientLabel(request.client)}
                      </small>
                    </span>
                    <code className="request-sub" title={request.upstreamUrl}>
                      {formatClock(request.startedAt)} · {request.upstreamUrl || "RESOLVING"}
                    </code>
                  </span>
                  <span className="request-model">
                    <code title={request.model}>{request.model || "———"}</code>
                    <small>{subline}</small>
                  </span>
                  <span className="request-tokens">
                    <code className="tok-in" title="输入 Token">↓{formatTokenCount(tokens?.inputTokens)}</code>
                    <code className="tok-out" title="输出 Token">↑{formatTokenCount(tokens?.outputTokens)}</code>
                    <small>CACHED {formatTokenCount(tokens?.cachedTokens)}</small>
                  </span>
                  <span className="cache-rate" title="缓存命中 Token 占输入的比例">
                    <code className={cacheRateTier(rate)}>
                      {rate === undefined ? "———" : (rate / 100).toFixed(3)}
                    </code>
                    <small>CACHE</small>
                  </span>
                  <span className="request-timing">
                    <code>{formatDuration(elapsed)}</code>
                    <small className={latencyTier(firstLatency)}>{firstLabel} {formatDuration(firstLatency)}</small>
                  </span>
                  <strong className={`request-state-label ${meta.tint}`}>{meta.label}</strong>
                </article>
              );
            })}
          {visibleRequests.length === 0 && (
            <p className="feed-empty">
              {requests.length === 0
                ? "NO REQUESTS YET · 网关收到请求后会在这里即时显示"
                : "NO MATCHING REQUESTS"}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
