import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Copy,
  CopyPlus,
  Gauge,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import { CLIENT_META, PROTOCOL_META } from "../config";
import { cacheRateTier, getEndpointMetrics, getHealthBarTone, LIMITED_LATENCY_MS } from "../lib/health";
import type { EndpointMetrics } from "../lib/health";
import { formatTokenCount, relativeTime } from "../lib/format";
import type { ClientTarget, GatewayState, Profile, ProfileEndpoint } from "../types";
import type { BusyAction } from "../ui-types";

const BAR_FILL = {
  healthy: "var(--good)",
  limited: "var(--warn)",
  failed: "var(--bad)",
} as const;

const MAX_BARS = 24;

/** 24 小时健康时间线：最近样本映射为红黄绿柱状图。 */
function HealthBars({ endpoint }: { endpoint?: ProfileEndpoint }): ReactElement {
  const samples = (endpoint?.healthTimeline?.length
    ? endpoint.healthTimeline
    : endpoint?.healthHistory ?? []).slice(-MAX_BARS);
  if (samples.length === 0) {
    return (
      <svg className="health-bars" viewBox="0 0 180 40" preserveAspectRatio="none" role="img" aria-label="暂无健康样本">
        <path d="M2 38 H178" stroke="var(--line)" strokeWidth="1.5" />
      </svg>
    );
  }
  const latencies = samples
    .map((sample) => sample.latencyMs)
    .filter((latency): latency is number => Number.isFinite(latency));
  const ceiling = Math.max(LIMITED_LATENCY_MS, ...latencies);
  const bars = samples.map((sample, index) => {
    const tone = getHealthBarTone(sample);
    const latency = Number.isFinite(sample.latencyMs) ? sample.latencyMs ?? ceiling : ceiling * .65;
    const normalized = Math.min(Math.max(latency / ceiling, 0), 1);
    const height = tone === "failed" ? 8 : Math.round(10 + (1 - normalized) * 18);
    return { tone, height, index, key: `${sample.checkedAt}-${index}` };
  });
  return (
    <svg
      className="health-bars animate"
      viewBox="0 0 180 40"
      preserveAspectRatio="none"
      role="img"
      aria-label="24 小时健康度"
    >
      {bars.map((bar) => (
        <rect
          key={bar.key}
          x={Math.round((bar.index * 7.5 + 1.65) * 10) / 10}
          y={38 - bar.height}
          width="4.2"
          height={bar.height}
          rx="1.4"
          fill={BAR_FILL[bar.tone]}
          style={{ animationDelay: `${bar.index * 12}ms` }}
        />
      ))}
    </svg>
  );
}

function healthSummary(profile: Profile): { label: string; className: string } {
  const status = profile.health?.status ?? "unknown";
  if (status === "healthy") return { label: `${profile.health?.latencyMs ?? 0} ms`, className: "good" };
  if (status === "limited") return { label: "LIMITED", className: "warn" };
  if (status === "unhealthy") return { label: "DOWN", className: "bad" };
  return { label: "———", className: "unknown" };
}

function endpointDot(endpoint: ProfileEndpoint): string {
  const status = endpoint.health?.status;
  if (status === "healthy") return "dot-good";
  if (status === "limited") return "dot-warn";
  if (status === "unhealthy") return "dot-bad";
  return "dot-unknown";
}

/** 累计平均缓存率：累计缓存命中 ÷ 累计输入，返回 0–1 的比值。 */
function cumulativeCacheRate(profile: Profile): number | undefined {
  const input = profile.tokenInputTotal;
  const cached = profile.tokenCachedTotal;
  if (!input || cached === undefined || !Number.isFinite(input) || !Number.isFinite(cached)) {
    return undefined;
  }
  return Math.min(1, cached / input);
}

function endpointLatency(endpoint: ProfileEndpoint): string {
  if (endpoint.health?.status === "healthy" || endpoint.health?.status === "limited") {
    return `${endpoint.health.latencyMs ?? 0} ms`;
  }
  return endpoint.health ? "DOWN" : "———";
}

interface KeyringViewProps {
  profiles: Profile[];
  gateway: GatewayState;
  busy: BusyAction | null;
  busyId?: string;
  loading: boolean;
  error?: string;
  onCreate: () => void;
  onEdit: (profile: Profile) => void;
  onDuplicate: (profile: Profile) => void;
  onDelete: (profile: Profile) => void;
  onApply: (id: string, targets: ClientTarget[]) => void;
  onTest: (id: string) => void;
  onTestAll: () => void;
  /** 正在检测端点的方案 ID；检测不锁定其他操作。 */
  testingIds: ReadonlySet<string>;
  onDiscoverModels: (id: string) => void;
  onProbe: (id: string) => void;
  onCopyKey: (profile: Profile) => void;
  onReorder: (ids: string[]) => void;
  onRetry: () => void;
}

/**
 * 密钥页：以可展开、可拖拽排序的列表管理全部连接方案。
 *
 * 行首展示健康时间线、累计 Token 与统计；行尾提供一键切换与检测；
 * 展开后可查看端点明细、密钥摘要并执行编辑/复制/删除。
 */
export function KeyringView({
  profiles,
  gateway,
  busy,
  busyId,
  loading,
  error,
  onCreate,
  onEdit,
  onDuplicate,
  onDelete,
  onApply,
  onTest,
  onTestAll,
  testingIds,
  onDiscoverModels,
  onProbe,
  onCopyKey,
  onReorder,
  onRetry,
}: KeyringViewProps): ReactElement {
  const [expandedId, setExpandedId] = useState<string>();
  const [dragId, setDragId] = useState<string>();
  const [dragOverId, setDragOverId] = useState<string>();
  const gatewayOn = gateway.status === "running" || gateway.status === "starting";

  useEffect(() => {
    if (!expandedId) return undefined;
    function handleKey(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setExpandedId(undefined);
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [expandedId]);

  useEffect(() => {
    setExpandedId((current) => current && profiles.some((profile) => profile.id === current)
      ? current
      : undefined);
  }, [profiles]);

  function handleHeadKey(event: ReactKeyboardEvent<HTMLDivElement>, id: string): void {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setExpandedId((current) => current === id ? undefined : id);
  }

  function handleDrop(event: ReactDragEvent<HTMLElement>, targetId: string): void {
    event.preventDefault();
    const sourceId = dragId;
    setDragId(undefined);
    setDragOverId(undefined);
    if (!sourceId || sourceId === targetId) return;
    const ids = profiles.map((profile) => profile.id).filter((id) => id !== sourceId);
    const insertAt = ids.indexOf(targetId);
    if (insertAt === -1) return;
    ids.splice(insertAt, 0, sourceId);
    onReorder(ids);
  }

  return (
    <main className="page-scroll" aria-label="密钥">
      <div className="page-inner">
        <div className="section-head rise">
          <h1>Attractor Fields</h1>
          <span className="head-note">{profiles.length} PROFILES · DRAG TO REORDER</span>
          <button
            type="button"
            className="ghost-pill"
            style={{ marginLeft: "auto" }}
            title="并发检测全部方案的端点延迟，期间不影响其他操作"
            disabled={profiles.length === 0 || testingIds.size > 0}
            onClick={onTestAll}
          >
            {testingIds.size > 0
              ? <LoaderCircle size={13} className="spin" />
              : <Gauge size={13} />}
            TEST ALL
          </button>
          <button
            type="button"
            className="primary-pill"
            style={{ marginLeft: 0 }}
            disabled={Boolean(busy)}
            onClick={onCreate}
          >
            <Plus size={13} />NEW
          </button>
        </div>

        {loading && profiles.length === 0 ? (
          <div className="empty-state">
            <LoaderCircle size={24} className="spin" />
            <h2>正在读取本地配置</h2>
          </div>
        ) : error && profiles.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon error-icon"><AlertCircle size={22} /></div>
            <h2>无法读取本地数据</h2>
            <p>{error}</p>
            <button type="button" className="ghost-pill" onClick={onRetry}>
              <RefreshCw size={13} />重试
            </button>
          </div>
        ) : profiles.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><KeyRound size={22} /></div>
            <h2>还没有连接方案</h2>
            <p>录入第一个 API 端点和密钥。</p>
            <button type="button" className="primary-pill" onClick={onCreate}>
              <Plus size={13} />NEW
            </button>
          </div>
        ) : (
          <div className="keyring-list">
            {profiles.map((profile, index) => {
              const expanded = expandedId === profile.id;
              const inUse = gateway.routes.some((route) => route.profileId === profile.id);
              const tone = PROTOCOL_META[profile.protocol].tone;
              const summary = healthSummary(profile);
              const activeEndpoint = profile.endpoints
                .find((endpoint) => endpoint.url === profile.baseUrl) ?? profile.endpoints[0];
              const metrics: EndpointMetrics = activeEndpoint
                ? getEndpointMetrics(activeEndpoint)
                : { sampleCount: 0 };
              const testing = testingIds.has(profile.id);
              const discovering = busy === "test" && busyId === profile.id;
              const probing = busy === "probe" && busyId === profile.id;
              const applying = busy === "apply" && busyId === profile.id;
              const rowClass = [
                "keyring-row",
                dragId === profile.id ? "dragging" : "",
                dragOverId === profile.id && dragId !== profile.id ? "drag-over" : "",
              ].filter(Boolean).join(" ");
              return (
                <article
                  className={rowClass}
                  key={profile.id}
                  style={{ animationDelay: `${60 + index * 50}ms` }}
                  draggable={!busy}
                  onDragStart={(event) => {
                    setDragId(profile.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", profile.id);
                  }}
                  onDragOver={(event) => {
                    if (!dragId || dragId === profile.id) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDragOverId(profile.id);
                  }}
                  onDragLeave={() => {
                    setDragOverId((current) => current === profile.id ? undefined : current);
                  }}
                  onDrop={(event) => handleDrop(event, profile.id)}
                  onDragEnd={() => {
                    setDragId(undefined);
                    setDragOverId(undefined);
                  }}
                >
                  <div
                    className="keyring-head"
                    role="button"
                    tabIndex={0}
                    aria-expanded={expanded}
                    aria-label={`${profile.name} 详情`}
                    onClick={() => setExpandedId(expanded ? undefined : profile.id)}
                    onKeyDown={(event) => handleHeadKey(event, profile.id)}
                  >
                    <span className={`keyring-glyph ${inUse ? "on" : ""}`}>
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="keyring-name">
                      <span className="keyring-name-line">
                        <strong>{profile.name}</strong>
                        {inUse && (
                          <small className={`tag-inuse ${gatewayOn ? "pulse" : ""}`}>ACTIVE</small>
                        )}
                      </span>
                      <code className="keyring-meta">
                        {PROTOCOL_META[profile.protocol].short.toUpperCase()} · {profile.baseUrl.replace(/^https?:\/\//, "")} · {profile.keyHint}
                      </code>
                      <span className="keyring-targets" aria-hidden="true">
                        {profile.targets.map((target) => (
                          <i
                            key={target}
                            className={`tone-${CLIENT_META[target].tone}`}
                            title={CLIENT_META[target].label}
                          />
                        ))}
                      </span>
                    </span>
                    <span className="keyring-usage" title="该密钥经网关转发累计消耗的 Token">
                      <code>{formatTokenCount(profile.tokenUsageTotal ?? 0)}</code>
                      <small>TOKENS</small>
                    </span>
                    <span className="keyring-usage" title="累计缓存命中 Token 占累计输入的比例">
                      <code className={cacheRateTier(cumulativeCacheRate(profile))}>
                        {cumulativeCacheRate(profile) === undefined
                          ? "———"
                          : cumulativeCacheRate(profile)?.toFixed(3)}
                      </code>
                      <small>CACHE</small>
                    </span>
                    <HealthBars endpoint={activeEndpoint} />
                    <span className="keyring-stat">
                      <strong className={summary.className}>{summary.label}</strong>
                      <small>
                        {metrics.sampleCount > 0
                          ? `1H ${metrics.availability ?? 0}% · AVG ${metrics.averageLatencyMs === undefined ? "———" : `${metrics.averageLatencyMs}ms`}`
                          : "AWAITING SAMPLES"}
                      </small>
                    </span>
                    <span className="keyring-tools">
                      <button
                        type="button"
                        className="icon-ghost"
                        title={inUse ? "已在使用中，点击重新分配全部适用客户端" : "切换到此方案（全部适用客户端）"}
                        aria-label={`切换到 ${profile.name}`}
                        disabled={Boolean(busy)}
                        onClick={(event) => {
                          event.stopPropagation();
                          onApply(profile.id, [...profile.targets]);
                        }}
                      >
                        {applying
                          ? <LoaderCircle size={14} className="spin" />
                          : <Zap size={14} fill={inUse ? "currentColor" : "none"} className={inUse ? "tier-good" : ""} />}
                      </button>
                      <button
                        type="button"
                        className="icon-ghost"
                        title="检测端点延迟（不影响其他操作）"
                        aria-label={`检测 ${profile.name} 端点`}
                        disabled={testing}
                        onClick={(event) => {
                          event.stopPropagation();
                          onTest(profile.id);
                        }}
                      >
                        {testing ? <LoaderCircle size={14} className="spin" /> : <Gauge size={14} />}
                      </button>
                      <button
                        type="button"
                        className="icon-ghost"
                        title="实测：发送一条最小消息，测真实可用性与时延"
                        aria-label={`实测 ${profile.name}`}
                        disabled={Boolean(busy)}
                        onClick={(event) => {
                          event.stopPropagation();
                          onProbe(profile.id);
                        }}
                      >
                        {probing ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
                      </button>
                      {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                    </span>
                  </div>
                  <div className={`keyring-expand ${expanded ? "open" : ""}`}>
                    <div>
                      <div className="keyring-detail">
                        <div style={{ minWidth: 0 }}>
                          <div className="endpoint-table">
                            {profile.endpoints.map((endpoint) => (
                              <div
                                className={`endpoint-line ${endpoint.url === profile.baseUrl ? "active" : ""}`}
                                title={endpoint.health?.message ?? endpoint.url}
                                key={endpoint.url}
                              >
                                <i className={endpointDot(endpoint)} />
                                <code>{endpoint.url}</code>
                                <small>{endpointLatency(endpoint)}</small>
                                <small>{endpoint.models.length} 模型</small>
                              </div>
                            ))}
                          </div>
                          {profile.availableModels.length > 0 && (
                            <div className="model-chips">
                              {profile.availableModels.map((model) => (
                                <code key={model}>{model}</code>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="assign-col">
                          <dl className="keyring-facts" style={{ margin: 0 }}>
                            <dt>密钥</dt>
                            <dd className="with-copy">
                              <code>{profile.keyHint}</code>
                              <button
                                type="button"
                                className="icon-mini"
                                title="复制密钥"
                                aria-label="复制密钥"
                                disabled={Boolean(busy)}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onCopyKey(profile);
                                }}
                              >
                                <Copy size={12} />
                              </button>
                            </dd>
                            {profile.protocol === "anthropic" && (
                              <>
                                <dt>认证头</dt>
                                <dd>{profile.authMode === "bearer" ? "Bearer Token" : "x-api-key"}</dd>
                              </>
                            )}
                            <dt>适用客户端</dt>
                            <dd>
                              {profile.targets.map((target, targetIndex) => (
                                <span key={target}>
                                  {targetIndex > 0 && "、"}
                                  <b className={`tone-${CLIENT_META[target].tone}`} style={{ color: "var(--tone)", fontWeight: 650 }}>
                                    {CLIENT_META[target].short}
                                  </b>
                                </span>
                              ))}
                            </dd>
                            <dt>自动择优</dt>
                            <dd>{profile.autoSwitch.enabled ? "每 2 分钟按 1 小时可用率择优" : "关闭"}</dd>
                            <dt>上次切换</dt>
                            <dd>{relativeTime(profile.lastAppliedAt)}</dd>
                          </dl>
                          <span className="keyring-actions">
                            <button
                              type="button"
                              className="ghost-pill"
                              title="请求模型列表并保存可用模型"
                              disabled={Boolean(busy)}
                              onClick={() => onDiscoverModels(profile.id)}
                            >
                              {discovering
                                ? <LoaderCircle size={12} className="spin" />
                                : <RefreshCw size={12} />}
                              识别模型
                            </button>
                            <button
                              type="button"
                              className="ghost-pill"
                              disabled={Boolean(busy)}
                              onClick={() => onEdit(profile)}
                            >
                              <Pencil size={12} />编辑
                            </button>
                            <button
                              type="button"
                              className="ghost-pill"
                              disabled={Boolean(busy)}
                              onClick={() => onDuplicate(profile)}
                            >
                              <CopyPlus size={12} />复制
                            </button>
                            <button
                              type="button"
                              className="danger-pill"
                              disabled={Boolean(busy)}
                              onClick={() => onDelete(profile)}
                            >
                              <Trash2 size={12} />删除
                            </button>
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
