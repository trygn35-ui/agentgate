import { FolderOpen, RotateCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import type { AgentSession, SessionMessage, SessionRemovalPlan } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";
import { RollingNumber } from "./RollingNumber";
import { ScrollRail } from "./ScrollRail";

/** 会话来自哪个 agent。这些是产品名，不翻译。 */
const SESSION_CLIENT: Record<AgentSession["client"], { label: string; tone: string }> = {
  claude: { label: "Claude Code", tone: "tone-claude" },
  codex: { label: "Codex", tone: "tone-codex" },
  opencode: { label: "OpenCode", tone: "tone-opencode" },
};

type Filter = "all" | AgentSession["client"];

/**
 * 左栏最多渲染多少条。
 *
 * 这台机器上真实扫出来 490 个会话。全渲染就是几千个节点——和动态页当初卡住的是
 * 同一个病。只渲染一截，靠搜索去够更早的会话，而不是靠滚。
 */
const MAX_VISIBLE_ROWS = 80;
/** 选中时先读这么多条；不够看再要全部。 */
const PREVIEW_MESSAGES = 20;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "--";
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 路径太长显示不下，掐中间——头尾才是认路的部分。 */
function shortenPath(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.ceil(max / 2) - 1)}…${value.slice(-Math.floor(max / 2))}`;
}

/**
 * 自绘的勾选框。
 *
 * 原生 checkbox 在这套界面里是外来物——圆角、系统配色、还带自己的一套聚焦环。
 * 这里画一个方框，勾中时填成警示色：勾中就意味着这条会话即将被删。
 */
function Tick({ on, disabled, label, onToggle }: {
  on: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      className={`tick ${on ? "on" : ""}`}
      disabled={disabled}
      // 勾选是「选中待删」，点条目是「看内容」——别让这一下冒上去把正文也换了
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <span />
    </button>
  );
}

/** 右栏：选中会话的正文。会话一换就重读。 */
function Detail({ session, count }: { session: AgentSession; count?: number }): ReactElement {
  const { locale, m, fill } = useI18n();
  const [messages, setMessages] = useState<SessionMessage[]>();
  const [truncated, setTruncated] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  const load = useCallback(async (limit: number) => {
    try {
      const result = await api.readSessionMessages?.(session.id, limit);
      setMessages(result?.messages ?? []);
      setTruncated(Boolean(result?.truncated));
    } catch {
      setMessages([]);
      setTruncated(false);
    }
  }, [session.id]);

  useEffect(() => {
    setMessages(undefined);
    void load(PREVIEW_MESSAGES);
    body.current?.scrollTo({ top: 0 });
  }, [load]);

  const meta = SESSION_CLIENT[session.client];

  return (
    <section className="detail" aria-live="polite">
      <header className="detail-head">
        <h2 title={session.title}>{session.title}</h2>
        <div className="detail-meta">
          <small className={`tag-client ${meta.tone}`}>{meta.label}</small>
          <code title={session.workspace || m.sessions.unknownWorkspace}>
            <FolderOpen size={11} />
            {session.workspace ? shortenPath(session.workspace, 48) : m.sessions.unknownWorkspace}
          </code>
          <span className="detail-dot" />
          <code>{formatBytes(session.sizeBytes)}</code>
          {count !== undefined && (
            <>
              <span className="detail-dot" />
              <code>{fill(m.sessions.messages, { count })}</code>
            </>
          )}
          <span className="detail-dot" />
          <code>{relativeTime(session.updatedAt, locale, m.keys.never)}</code>
        </div>
      </header>

      <div className="pane">
        <div className="detail-body" ref={body}>
          {messages === undefined && <p className="detail-note">{m.sessions.loading}</p>}
          {messages?.length === 0 && <p className="detail-note">{m.sessions.noMessages}</p>}

          {messages && messages.length > 0 && (
            <>
              {truncated && (
                <button
                  type="button"
                  className="detail-more"
                  disabled={loadingAll}
                  onClick={() => {
                    setLoadingAll(true);
                    // 0 = 尽量多。主进程有硬上限，不会真把 279 MB 端上来。
                    void load(0).finally(() => setLoadingAll(false));
                  }}
                >
                  {loadingAll ? m.sessions.loading : m.sessions.loadAll}
                </button>
              )}
              {messages.map((message, index) => (
                <article
                  className={`say say-${message.role}`}
                  key={`${message.at ?? ""}-${index}`}
                  style={{ animationDelay: `${Math.min(index, 14) * 22}ms` }}
                >
                  <span className="say-who">
                    {message.role === "user" ? m.sessions.you : m.sessions.agent}
                  </span>
                  <p>{message.text}</p>
                </article>
              ))}
              <p className="detail-note">{fill(m.sessions.showingMessages, { count: messages.length })}</p>
            </>
          )}
        </div>
        <ScrollRail scroller={body} />
      </div>
    </section>
  );
}

interface SessionsViewProps {
  onToast: (kind: "success" | "error" | "info", message: string) => void;
}

/**
 * 会话页：左边一栏会话清单，右边是选中那条的正文。
 *
 * 删除不可逆，所以先跑演练：主进程算出到底会动哪些文件、哪些库行，以及**哪些东西
 * 特意不动**——Codex 的附件是跨会话共享的，OpenCode 的快照是个指着用户真实代码
 * 目录的 git 仓库。这两样按会话删都会毁掉别的东西。
 */
export function SessionsView({ onToast }: SessionsViewProps): ReactElement {
  const { locale, m, fill } = useI18n();
  const [sessions, setSessions] = useState<AgentSession[]>();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string>();
  const [plans, setPlans] = useState<SessionRemovalPlan[]>();
  const [busy, setBusy] = useState(false);
  const index = useRef<HTMLDivElement>(null);

  /**
   * @param silent 留着现有清单重扫。删完之后不该把整栏闪回「正在扫描」——被删的
   *   已经当场拿掉了，剩下的没理由跟着消失一下再回来。
   */
  const scan = useCallback(async (silent = false) => {
    if (!silent) setSessions(undefined);
    try {
      setSessions(await api.listSessions?.() ?? []);
    } catch {
      setSessions([]);
    }
    setPicked(new Set());
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  const matched = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (sessions ?? []).filter((session) => (
      (filter === "all" || session.client === filter)
      && (!needle
        || session.title.toLowerCase().includes(needle)
        || session.workspace.toLowerCase().includes(needle))
    ));
  }, [filter, query, sessions]);
  const shown = useMemo(() => matched.slice(0, MAX_VISIBLE_ROWS), [matched]);
  const hiddenCount = matched.length - shown.length;
  const pickedCount = shown.filter((session) => picked.has(session.id)).length;

  /*
   * 发言条数要扫全文才知道——三家都没在索引里存它，而正文合计 3.8 GB。
   * 所以只数「这一屏看得见的」，而且只数还没数过的。主进程那边按文件指纹缓存，
   * 换个筛选再回来是免费的。
   */
  useEffect(() => {
    const wanted = shown.map((session) => session.id).filter((id) => counts[id] === undefined);
    if (wanted.length === 0) return undefined;
    let alive = true;
    void api.countSessionMessages?.(wanted)
      .then((result) => {
        if (alive && result) setCounts((current) => ({ ...current, ...result }));
      })
      .catch(() => {
        // 数不出来就不显示，别拿假数糊弄
      });
    return () => { alive = false; };
  }, [shown, counts]);

  // 选中的会话被筛掉了（换了筛选/搜索/刚被删掉），右栏就跟着让出来
  const selected = shown.find((session) => session.id === current);

  const tally = useMemo(() => {
    const value = { all: sessions?.length ?? 0, claude: 0, codex: 0, opencode: 0 };
    for (const session of sessions ?? []) value[session.client] += 1;
    return value;
  }, [sessions]);

  function toggle(id: string): void {
    setPicked((value) => {
      const next = new Set(value);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function openConfirm(): Promise<void> {
    setBusy(true);
    try {
      // 先演练。弹窗里摆的是主进程真算出来的东西，不是我猜的。
      setPlans(await api.planSessionRemoval?.([...picked]) ?? []);
    } catch {
      onToast("error", fill(m.sessions.removeFailed, { count: picked.size }));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove(): Promise<void> {
    const ids = plans?.map((plan) => plan.id) ?? [];
    setPlans(undefined);
    setBusy(true);
    try {
      const result = await api.removeSessions?.(ids) ?? { removed: [], failed: [] };
      if (result.removed.length > 0) {
        const gone = new Set(result.removed);
        setSessions((value) => value?.filter((session) => !gone.has(session.id)));
        if (current && gone.has(current)) setCurrent(undefined);
        onToast("success", fill(m.sessions.removed, { count: result.removed.length }));
      }
      if (result.failed.length > 0) {
        // 正文被正在跑的 agent 占着时删不掉，说清楚为什么，别只报个失败
        onToast("error", `${fill(m.sessions.removeFailed, { count: result.failed.length })} · ${m.sessions.dbLocked}`);
      }
      await scan(true);
    } catch {
      onToast("error", fill(m.sessions.removeFailed, { count: ids.length }));
    } finally {
      // 成功那条路原本没复位，删完一次整页的勾选框就永远禁用了
      setBusy(false);
    }
  }

  const totalBytes = plans?.reduce(
    (sum, plan) => sum + plan.files.reduce((inner, file) => inner + file.bytes, 0),
    0,
  ) ?? 0;
  // 「处」= 要删的文件/目录，加上要清的数据库与状态文件
  const targetCount = plans?.reduce(
    (sum, plan) => sum + plan.files.length + plan.rows.length,
    0,
  ) ?? 0;
  const keptKinds = [...new Set(plans?.flatMap((plan) => plan.kept) ?? [])];
  const scanning = sessions === undefined;

  return (
    <main className="sessions-page" aria-label={m.sessions.title}>
      <div className="sessions-head rise">
        <h1>{m.sessions.title}</h1>
        <span className="head-note">{m.sessions.subtitle}</span>
        <span style={{ marginLeft: "auto" }} />
        <div className="req-filters" role="radiogroup" aria-label={m.sessions.title}>
          {([
            ["all", m.sessions.all],
            ["claude", SESSION_CLIENT.claude.label],
            ["codex", SESSION_CLIENT.codex.label],
            ["opencode", SESSION_CLIENT.opencode.label],
          ] as Array<[Filter, string]>).map(([value, label]) => (
            <button
              type="button"
              role="radio"
              aria-checked={filter === value}
              className={filter === value ? "active" : ""}
              key={value}
              disabled={value !== "all" && tally[value] === 0}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 搜索：一条下划线，没有原生的圆角框，也没有原生的清除叉 */}
        <div className={`finder ${query ? "has" : ""}`}>
          <input
            type="text"
            placeholder={m.sessions.search}
            aria-label={m.sessions.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" aria-label={m.sessions.clear} onClick={() => setQuery("")}>
              <X size={11} />
            </button>
          )}
          <i aria-hidden="true" />
        </div>

        <button
          type="button"
          className="restat"
          title={m.sessions.refresh}
          aria-label={m.sessions.refresh}
          disabled={busy || scanning}
          onClick={() => void scan()}
        >
          <RotateCw size={12} className={scanning ? "spin" : ""} />
        </button>
      </div>

      <div className="sessions-split rise-1">
        {/* 左栏：索引。SG 的 TIPS 那一页就是这个结构——左边一列词条，右边是词条正文。 */}
        <div className="pane">
          <div className="session-index" ref={index} role="listbox" aria-label={m.sessions.title}>
            {scanning && <p className="detail-note">{m.sessions.scanning}</p>}

            {shown.map((session, position) => {
              const meta = SESSION_CLIENT[session.client];
              const isPicked = picked.has(session.id);
              const isCurrent = current === session.id;
              const count = counts[session.id];
              return (
                <div
                  className={`index-item ${isCurrent ? "current" : ""} ${isPicked ? "picked" : ""}`}
                  key={session.id}
                  role="option"
                  tabIndex={0}
                  aria-selected={isCurrent}
                  style={{ animationDelay: `${Math.min(position, 16) * 20}ms` }}
                  onClick={() => setCurrent(session.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setCurrent(session.id);
                  }}
                >
                  <Tick
                    on={isPicked}
                    disabled={busy}
                    label={session.title}
                    onToggle={() => toggle(session.id)}
                  />
                  <span className="index-no">{String(position + 1).padStart(3, "0")}</span>
                  <span className="index-main">
                    <strong title={session.title}>{session.title}</strong>
                    <code title={session.workspace || m.sessions.unknownWorkspace}>
                      {session.workspace ? shortenPath(session.workspace, 28) : m.sessions.unknownWorkspace}
                    </code>
                  </span>
                  <span className="index-side">
                    <small className={`tag-client ${meta.tone}`}>{meta.label}</small>
                    <span className="index-count">
                      {/* 数完才滚出来。数不出来的就空着，不编 */}
                      {count === undefined
                        ? <em className="index-when">{relativeTime(session.updatedAt, locale, m.keys.never)}</em>
                        : (
                          <>
                            <RollingNumber as="span" value={String(count)} />
                            <em>{m.sessions.msgUnit}</em>
                          </>
                        )}
                    </span>
                  </span>
                </div>
              );
            })}

            {!scanning && shown.length === 0 && (
              <p className="detail-note">
                {sessions?.length === 0 ? m.sessions.empty : m.sessions.noMatch}
              </p>
            )}
            {hiddenCount > 0 && (
              <p className="detail-note">
                {fill(m.sessions.capped, { shown: shown.length, hidden: hiddenCount })}
              </p>
            )}
          </div>
          <ScrollRail scroller={index} />
        </div>

        {selected
          ? <Detail key={selected.id} session={selected} count={counts[selected.id]} />
          : (
            <section className="detail detail-empty">
              <p>{scanning ? m.sessions.scanning : m.sessions.pickOne}</p>
            </section>
          )}
      </div>

      {pickedCount > 0 && (
        <div className="session-bar">
          <span>{fill(m.sessions.selected, { count: pickedCount })}</span>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setPicked(new Set(shown.map((session) => session.id)))}
          >
            {m.sessions.selectAll}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setPicked(new Set())}>
            {m.sessions.clear}
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={busy}
            onClick={() => void openConfirm()}
          >
            <Trash2 size={13} />
            {busy ? m.sessions.removing : m.sessions.remove}
          </button>
        </div>
      )}

      {plans && plans.length > 0 && (
        <ConfirmDialog
          danger
          title={fill(m.sessions.confirmTitle, { count: plans.length })}
          message={`${m.sessions.confirmBody} ${m.sessions.confirmIrreversible}`}
          confirmLabel={m.sessions.remove}
          onCancel={() => setPlans(undefined)}
          onConfirm={() => void confirmRemove()}
          details={(
            <div className="plan">
              <div className="plan-row">
                <span className="plan-label">{m.sessions.willDelete}</span>
                {/* 「几处 · 多大」。处 = 文件/目录 + 要清的数据库行。 */}
                <code>{targetCount} · {formatBytes(totalBytes)}</code>
              </div>
              {keptKinds.length > 0 && (
                <div className="plan-row keep">
                  <span className="plan-label">{m.sessions.willKeep}</span>
                  <code>{keptKinds.join(" · ")}</code>
                </div>
              )}
              <p className="plan-hint">{m.sessions.keptHint}</p>
            </div>
          )}
        />
      )}
    </main>
  );
}
