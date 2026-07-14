import { ChevronDown, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import type { AgentSession, SessionMessage, SessionRemovalPlan } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";
import { RollingNumber } from "./RollingNumber";

/** 会话来自哪个 agent。这些是产品名，不翻译。 */
const SESSION_CLIENT: Record<AgentSession["client"], { label: string; tone: string }> = {
  claude: { label: "Claude Code", tone: "tone-claude" },
  codex: { label: "Codex", tone: "tone-codex" },
  opencode: { label: "OpenCode", tone: "tone-opencode" },
};

type Filter = "all" | AgentSession["client"];

/**
 * 最多渲染多少行。
 *
 * 这台机器上真实扫出来 490 个会话。全渲染就是几千个滚筒字位——和动态页当初卡住
 * 的是同一个病。所以只渲染一截，靠搜索去够更早的会话，而不是靠滚。
 */
const MAX_VISIBLE_ROWS = 60;
/** 展开时先读这么多条；不够看再要全部。 */
const PREVIEW_MESSAGES = 12;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "--";
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 路径太长显示不下，掐中间——头尾才是认路的部分。 */
function shortenPath(value: string, max = 46): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.ceil(max / 2) - 1)}…${value.slice(-Math.floor(max / 2))}`;
}

/** 展开后的对话。挂载时才去读——没人展开就不该碰那 279 MB 的正文。 */
function Transcript({ id }: { id: string }): ReactElement {
  const { m, fill } = useI18n();
  const [messages, setMessages] = useState<SessionMessage[]>();
  const [truncated, setTruncated] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);

  const load = useCallback(async (limit: number) => {
    try {
      const result = await api.readSessionMessages?.(id, limit);
      setMessages(result?.messages ?? []);
      setTruncated(Boolean(result?.truncated));
    } catch {
      setMessages([]);
    }
  }, [id]);

  useEffect(() => {
    void load(PREVIEW_MESSAGES);
  }, [load]);

  if (messages === undefined) {
    return <div className="transcript"><p className="transcript-note">{m.sessions.loading}</p></div>;
  }
  if (messages.length === 0) {
    return <div className="transcript"><p className="transcript-note">{m.sessions.noMessages}</p></div>;
  }

  return (
    <div className="transcript">
      {truncated && (
        <button
          type="button"
          className="transcript-more"
          disabled={loadingAll}
          onClick={() => {
            setLoadingAll(true);
            // 0 = 尽量多。主进程那边有硬上限，不会真把整个文件端上来。
            void load(0).finally(() => setLoadingAll(false));
          }}
        >
          {loadingAll ? m.sessions.loading : m.sessions.loadAll}
        </button>
      )}
      {messages.map((message, index) => (
        <div
          className={`say say-${message.role}`}
          key={`${message.at ?? ""}-${index}`}
          style={{ animationDelay: `${Math.min(index, 10) * 26}ms` }}
        >
          <span className="say-who">{message.role === "user" ? m.sessions.you : m.sessions.agent}</span>
          <p>{message.text}</p>
        </div>
      ))}
      <p className="transcript-note">{fill(m.sessions.showingMessages, { count: messages.length })}</p>
    </div>
  );
}

interface SessionsViewProps {
  onToast: (kind: "success" | "error" | "info", message: string) => void;
}

/**
 * 会话页：把三家 agent 存在本机的会话摊开，能翻、能看、能删。
 *
 * 删除是不可逆的，所以先跑一遍演练：主进程算出到底会动哪些文件、哪些库行，
 * 以及**哪些东西特意不动**——Codex 的附件是跨会话共享的，OpenCode 的快照是个
 * 指着用户真实代码目录的 git 仓库。这两样按会话删都会毁掉别的东西。
 */
export function SessionsView({ onToast }: SessionsViewProps): ReactElement {
  const { locale, m, fill } = useI18n();
  const [sessions, setSessions] = useState<AgentSession[]>();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<string>();
  const [plans, setPlans] = useState<SessionRemovalPlan[]>();
  const [busy, setBusy] = useState(false);

  /**
   * @param silent 留着现有列表重扫。删完之后不该把整页闪回「正在扫描」——
   *   被删的行已经当场拿掉了，剩下的没理由跟着消失一下再回来。
   */
  const scan = useCallback(async (silent = false) => {
    if (!silent) setSessions(undefined);
    try {
      setSessions(await api.listSessions?.() ?? []);
    } catch {
      setSessions([]);
    }
    setPicked(new Set());
    setOpened(undefined);
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
  // 只渲染一截。搜索是够到更早会话的手段，滚不是。
  const shown = useMemo(() => matched.slice(0, MAX_VISIBLE_ROWS), [matched]);
  const hiddenCount = matched.length - shown.length;
  const pickedCount = shown.filter((session) => picked.has(session.id)).length;
  const counts = useMemo(() => {
    const tally = { all: sessions?.length ?? 0, claude: 0, codex: 0, opencode: 0 };
    for (const session of sessions ?? []) tally[session.client] += 1;
    return tally;
  }, [sessions]);

  function toggle(id: string): void {
    setPicked((current) => {
      const next = new Set(current);
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
        // 删掉的行当场拿掉，再去后台重扫核对——别让整页闪一下空白
        const gone = new Set(result.removed);
        setSessions((current) => current?.filter((session) => !gone.has(session.id)));
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
      // 成功那条路原本没复位，删完一次整页的复选框就永远禁用了
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

  return (
    <main className="page-scroll" aria-label={m.sessions.title}>
      <div className="page-inner">
        <div className="section-head rise sticky-head" style={{ alignItems: "center" }}>
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
                disabled={value !== "all" && counts[value] === 0}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            type="search"
            className="session-search"
            placeholder={m.sessions.search}
            aria-label={m.sessions.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="btn-ghost btn-icon"
            title={m.sessions.refresh}
            aria-label={m.sessions.refresh}
            disabled={busy || sessions === undefined}
            onClick={() => void scan()}
          >
            <RefreshCw size={13} className={sessions === undefined ? "spin" : ""} />
          </button>
        </div>

        {sessions === undefined && <p className="feed-empty">{m.sessions.scanning}</p>}

        {sessions !== undefined && shown.map((session, index) => {
          const meta = SESSION_CLIENT[session.client];
          const isPicked = picked.has(session.id);
          const isOpen = opened === session.id;
          return (
            <div className="session-cell" key={session.id}>
              <div
                className={`session-row ${isPicked ? "picked" : ""} ${isOpen ? "open" : ""}`}
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
                onClick={() => setOpened(isOpen ? undefined : session.id)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  setOpened(isOpen ? undefined : session.id);
                }}
              >
                {/* 勾选是「选中待删」，展开是「看内容」——两件事，别抢同一次点击 */}
                <input
                  type="checkbox"
                  checked={isPicked}
                  disabled={busy}
                  aria-label={session.title}
                  onClick={(event) => event.stopPropagation()}
                  onChange={() => toggle(session.id)}
                />
                <span className="session-main">
                  <span className="session-title">
                    <strong title={session.title}>{session.title}</strong>
                    <small className={`tag-client ${meta.tone}`}>{meta.label}</small>
                  </span>
                  <code className="session-path" title={session.workspace || m.sessions.unknownWorkspace}>
                    <FolderOpen size={11} />
                    {session.workspace ? shortenPath(session.workspace) : m.sessions.unknownWorkspace}
                  </code>
                </span>
                <span className="session-size">
                  <RollingNumber value={formatBytes(session.sizeBytes)} />
                  <small>
                    {session.messages !== undefined
                      ? fill(m.sessions.messages, { count: session.messages })
                      : ""}
                  </small>
                </span>
                <span className="session-when">
                  {relativeTime(session.updatedAt, locale, m.keys.never)}
                </span>
                <ChevronDown size={13} className={`session-chev ${isOpen ? "flip" : ""}`} />
              </div>
              {isOpen && <Transcript id={session.id} />}
            </div>
          );
        })}

        {sessions !== undefined && shown.length === 0 && (
          <p className="feed-empty">
            {sessions.length === 0 ? m.sessions.empty : m.sessions.noMatch}
            {sessions.length === 0 && <><br /><small>{m.sessions.emptyHint}</small></>}
          </p>
        )}
        {hiddenCount > 0 && (
          <p className="feed-empty">
            {fill(m.sessions.capped, { shown: shown.length, hidden: hiddenCount })}
          </p>
        )}
      </div>

      {/* 选中后从底部升起的操作条。没选就不占地方。 */}
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
