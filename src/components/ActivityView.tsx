import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { CLIENT_META } from "../config";
import { formatDateTime, formatDuration, formatTokenCount } from "../lib/format";
import type { ActiveRequest, ClientTarget, HistoryEntry } from "../types";
import type { FeedTab, RequestFilter } from "../ui-types";

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
  connecting: { label: "连接中", tint: "tint-accent", icon: "loader", spin: true },
  "waiting-first-token": { label: "等待首字", tint: "tint-accent", icon: "loader", spin: true },
  streaming: { label: "流式传输", tint: "tint-good", icon: "dot", breathe: true },
  completed: { label: "已完成", tint: "tint-good", icon: "check" },
  failed: { label: "失败", tint: "tint-bad", icon: "alert" },
  aborted: { label: "已中止", tint: "tint-warn", icon: "dot" },
  cancelled: { label: "已取消", tint: "tint-warn", icon: "dot" },
};

const REASONING_LABEL: Record<string, string> = {
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
};

function clientLabel(client: ActiveRequest["client"]): string {
  return client in CLIENT_META
    ? CLIENT_META[client as ClientTarget].label
    : String(client);
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

/** 缓存率色阶：≥98% 绿、95-98% 蓝、90-95% 黄、<90% 红。 */
function cacheTier(percent?: number): string {
  if (percent === undefined || !Number.isFinite(percent)) return "tier-quiet";
  if (percent >= 98) return "tier-good";
  if (percent >= 95) return "tier-info";
  if (percent >= 90) return "tier-warn";
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
  history: HistoryEntry[];
  busy: boolean;
  busyId?: string;
  feedTab: FeedTab;
  onFeedTabChange: (tab: FeedTab) => void;
  onUndo: (id: string) => void;
}

/**
 * 动态页：实时请求与切换记录两个信息流。
 *
 * 请求流展示网关转发的进行中与最近完成请求（含 Token 与时延指标），
 * 切换记录流展示配置变更历史并提供可撤销入口。
 */
export function ActivityView({
  requests,
  history,
  busy,
  busyId,
  feedTab,
  onFeedTabChange,
  onUndo,
}: ActivityViewProps): ReactElement {
  const [filter, setFilter] = useState<RequestFilter>("all");
  const [now, setNow] = useState(() => Date.now());
  const activeCount = requests.filter(isActive).length;
  const visibleRequests = useMemo(
    () => requests.filter((request) => matchesFilter(request, filter)),
    [filter, requests],
  );

  useEffect(() => {
    if (feedTab !== "requests" || activeCount === 0) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, [activeCount, feedTab]);

  return (
    <main className="page-scroll" aria-label="动态">
      <div className="page-inner">
        <div className="section-head rise" style={{ alignItems: "center" }}>
          <h1>动态</h1>
          <div className="feed-tabs" role="radiogroup" aria-label="动态类型">
            {([["requests", "实时请求"], ["history", "切换记录"]] as Array<[FeedTab, string]>).map(([value, label]) => (
              <button
                type="button"
                role="radio"
                aria-checked={feedTab === value}
                className={feedTab === value ? "active" : ""}
                key={value}
                onClick={() => onFeedTabChange(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <span style={{ marginLeft: "auto" }} />
          {feedTab === "requests" && (
            <div className="req-filters" role="radiogroup" aria-label="请求筛选">
              {([
                ["all", "全部"],
                ["active", "活跃"],
                ["completed", "完成"],
                ["failed", "异常"],
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

        {feedTab === "requests" && (
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
              const firstLabel = request.firstTokenLatencyMs !== undefined ? "首字" : "首包";
              const reasoning = request.reasoningEffort
                ? REASONING_LABEL[request.reasoningEffort.toLocaleLowerCase()] ?? request.reasoningEffort
                : "默认";
              const subline = `推理 ${reasoning}`
                + (request.streaming === true ? " · 流式" : request.streaming === false ? " · 非流式" : "");
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
                      <small className="tag-client">{clientLabel(request.client)}</small>
                    </span>
                    <code className="request-sub" title={request.upstreamUrl}>
                      {formatClock(request.startedAt)} · {request.upstreamUrl || "正在解析上游"}
                    </code>
                  </span>
                  <span className="request-model">
                    <code title={request.model}>{request.model || "未提供"}</code>
                    <small>{subline}</small>
                  </span>
                  <span className="request-tokens">
                    <code className="tok-in" title="输入 Token">↓{formatTokenCount(tokens?.inputTokens)}</code>
                    <code className="tok-out" title="输出 Token">↑{formatTokenCount(tokens?.outputTokens)}</code>
                    <small>缓存 {formatTokenCount(tokens?.cachedTokens)} · 推理 {formatTokenCount(tokens?.reasoningTokens)}</small>
                  </span>
                  <span className="cache-rate" title="缓存命中 Token 占输入的比例">
                    <code className={cacheTier(rate)}>{rate === undefined ? "--" : `${rate.toFixed(1)}%`}</code>
                    <small>缓存率</small>
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
                  ? "还没有请求记录。网关收到请求后会在这里即时显示，并保留最近 100 条。"
                  : "没有符合筛选条件的请求。"}
              </p>
            )}
          </div>
        )}

        {feedTab === "history" && (
          <div>
            {history.map((entry, index) => (
              <article
                className="event-row with-undo"
                key={entry.id}
                style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
              >
                <span className={`event-icon ${entry.success ? "good" : "bad"}`}>
                  {entry.success ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                </span>
                <time>{formatDateTime(entry.createdAt)}</time>
                <span className="event-main">
                  <span className="event-title">
                    <strong>{entry.profileName}</strong>
                    <small>→ {entry.targets.map((target) => CLIENT_META[target].short).join("、")}</small>
                    {entry.source === "auto" && <small className="tag-auto">自动</small>}
                  </span>
                  {entry.message && <small className="event-message">{entry.message}</small>}
                </span>
                <strong className={`event-result ${entry.success ? "good" : "bad"}`}>
                  {entry.success ? "成功" : "失败"}
                </strong>
                <button
                  type="button"
                  className="undo-pill"
                  disabled={!entry.canUndo || busy}
                  title={entry.canUndo
                    ? "恢复本次切换前的配置"
                    : entry.connectionMode === "gateway"
                      ? "网关路由切换无需撤销，可直接选择其他方案"
                      : "该记录已不可撤销"}
                  onClick={() => onUndo(entry.id)}
                >
                  {busyId === entry.id
                    ? <LoaderCircle size={11} className="spin" />
                    : <RotateCcw size={11} />}
                  撤销
                </button>
              </article>
            ))}
            {history.length === 0 && <p className="feed-empty">还没有切换记录。</p>}
          </div>
        )}
      </div>
    </main>
  );
}
