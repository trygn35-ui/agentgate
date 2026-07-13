import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Circle,
  Eye,
  EyeOff,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement, SyntheticEvent } from "react";
import {
  BLANK_PROFILE_INPUT,
  CLIENT_META,
  CLIENT_TARGET_ORDER,
  PROTOCOL_META,
} from "../config";
import { normalizeHttpUrl } from "../lib/url";
import type {
  ClientTarget,
  Profile,
  ProfileEndpoint,
  Protocol,
  SaveProfileInput,
} from "../types";
import { ConfirmDialog } from "./ConfirmDialog";

interface ProfileEditorProps {
  profile?: Profile;
  busy: boolean;
  /** 正在识别模型。 */
  discovering?: boolean;
  /** 识别模型：用当前 Key 请求上游模型列表；返回最新可用模型。 */
  onDiscoverModels?: () => Promise<string[] | undefined>;
  onClose: () => void;
  onSave: (input: SaveProfileInput, applyAfter: boolean) => Promise<void>;
}

function createEditorInput(profile?: Profile): SaveProfileInput {
  if (!profile) {
    return {
      ...BLANK_PROFILE_INPUT,
      endpoints: BLANK_PROFILE_INPUT.endpoints.map((endpoint) => ({ ...endpoint })),
      autoSwitch: { ...BLANK_PROFILE_INPUT.autoSwitch },
    };
  }
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    endpoints: profile.endpoints.map((endpoint) => ({ url: endpoint.url })),
    apiKey: "",
    model: profile.model,
    authMode: profile.authMode,
    targets: [...profile.targets],
    enableToolSearch: profile.enableToolSearch,
    autoSwitch: { ...profile.autoSwitch },
  };
}

/**
 * 在进入主进程前校验表单边界，提供面向用户的即时错误。
 *
 * @param form 当前表单值。
 * @param hasExistingKey 是否允许空 Key 表示保留原密文。
 * @returns 首个校验错误；通过时返回 undefined。
 */
function validateProfileInput(form: SaveProfileInput, hasExistingKey: boolean): string | undefined {
  if (!form.name.trim()) return "请输入方案名称";

  if (form.endpoints.length === 0) return "至少保留一个 API URL";
  const normalizedUrls: string[] = [];
  for (const endpoint of form.endpoints) {
    try {
      const value = endpoint.url.trim();
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "请输入有效的 HTTP(S) API URL";
      }
      if (parsed.username || parsed.password || parsed.hash) {
        return "API URL 不能包含凭据或片段";
      }
      normalizedUrls.push(normalizeHttpUrl(value));
    } catch {
      return "请输入有效的 HTTP(S) API URL";
    }
  }
  if (new Set(normalizedUrls).size !== normalizedUrls.length) return "API URL 不能重复";
  if (!form.endpoints.some((endpoint) => endpoint.url === form.baseUrl)) {
    return "请选择一个活动 URL";
  }

  if (!hasExistingKey && !form.apiKey?.trim()) return "请输入 API Key";
  if (form.targets.length === 0) return "至少选择一个适用客户端";
  return undefined;
}

function invalidFieldLabel(error: string): string | undefined {
  if (error.includes("方案名称")) return "方案名称";
  if (error.includes("API URL") || error.includes("活动 URL")) return "API URL 1";
  if (error.includes("API Key")) return "API Key";
  return undefined;
}

/**
 * 清理用户输入但不改变 URL 路径和 Key 内容。
 *
 * @param form 已通过校验的表单。
 * @returns 可提交主进程的规范化方案。
 */
function normalizeProfileInput(form: SaveProfileInput): SaveProfileInput {
  const activeIndex = form.endpoints.findIndex((endpoint) => endpoint.url === form.baseUrl);
  const endpoints = form.endpoints.map((endpoint) => ({
    url: normalizeHttpUrl(endpoint.url),
  }));
  return {
    ...form,
    name: form.name.trim(),
    baseUrl: endpoints[Math.max(0, activeIndex)].url,
    endpoints,
    apiKey: form.apiKey?.trim() || undefined,
    model: form.model.trim(),
  };
}

function endpointStatus(endpoint?: ProfileEndpoint): { text: string; className: string } {
  if (!endpoint?.health || endpoint.health.status === "unknown") {
    return { text: "未检测", className: "unknown" };
  }
  if (endpoint.health.status === "unhealthy") return { text: "不可用", className: "bad" };
  return { text: `${endpoint.health.latencyMs ?? 0} ms`, className: "good" };
}

/**
 * 新建或编辑连接方案，并在提交前完成客户端兼容性和必填项校验。
 *
 * 编辑已有方案时，空 Key 表示保留主进程中的原密文；组件不会读取已有明文。
 * 保存并使用会先保存方案，再由父级将它分配给本地网关。
 *
 * @param props 可选现有方案、保存状态及关闭/保存回调。
 * @returns 居中弹出的方案编辑对话框。
 */
export function ProfileEditor({
  profile,
  busy,
  discovering,
  onDiscoverModels,
  onClose,
  onSave,
}: ProfileEditorProps): ReactElement {
  const initialForm = useRef(createEditorInput(profile));
  const [form, setForm] = useState<SaveProfileInput>(() => initialForm.current);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [models, setModels] = useState<string[]>(() => profile?.availableModels ?? []);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  /** 用户在模型框里主动键入的搜索词；undefined 表示未搜索，此时列出全部模型。 */
  const [modelQuery, setModelQuery] = useState<string>();
  const dialogRef = useRef<HTMLFormElement>(null);
  const modelFieldRef = useRef<HTMLDivElement>(null);
  const compatibleTargets = PROTOCOL_META[form.protocol].compatible;
  const hasUnsavedChanges = JSON.stringify(form) !== JSON.stringify(initialForm.current);
  // 展开时始终列出全部模型；只有用户主动键入才按搜索词过滤，
  // 这样已选中的模型不会把列表过滤成只剩它自己。
  const modelOptions = modelQuery?.trim()
    ? models.filter((model) => (
        model.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase())
      ))
    : models;

  useEffect(() => {
    if (!modelMenuOpen) return undefined;
    function handlePointerDown(event: MouseEvent): void {
      if (!(event.target instanceof Node)) return;
      if (modelFieldRef.current?.contains(event.target)) return;
      setModelMenuOpen(false);
    }
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [modelMenuOpen]);

  async function discoverModels(): Promise<void> {
    if (!onDiscoverModels || discovering) return;
    const discovered = await onDiscoverModels();
    if (!discovered) return;
    setModels(discovered);
    setModelQuery(undefined);
    setModelMenuOpen(discovered.length > 0);
  }

  function requestClose(): void {
    if (busy) return;
    if (hasUnsavedChanges) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    const layer = dialog?.closest<HTMLElement>(".editor-layer");
    const backgroundState = layer?.parentElement
      ? [...layer.parentElement.children]
        .filter((element): element is HTMLElement => (
          element instanceof HTMLElement && element !== layer
        ))
        .map((element) => ({
          element,
          inert: element.inert,
          ariaHidden: element.getAttribute("aria-hidden"),
        }))
      : [];
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    for (const state of backgroundState) {
      state.element.inert = true;
      state.element.setAttribute("aria-hidden", "true");
    }

    function trapFocus(event: KeyboardEvent): void {
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    dialog?.addEventListener("keydown", trapFocus);
    dialog?.querySelector<HTMLElement>("[autofocus]")?.focus();
    return () => {
      dialog?.removeEventListener("keydown", trapFocus);
      for (const state of backgroundState) {
        state.element.inert = state.inert;
        if (typeof state.ariaHidden === "string") {
          state.element.setAttribute("aria-hidden", state.ariaHidden);
        } else {
          state.element.removeAttribute("aria-hidden");
        }
      }
      previousFocus?.focus();
    };
  }, []);

  function update<K extends keyof SaveProfileInput>(
    key: K,
    value: SaveProfileInput[K],
  ): void {
    setForm((current) => ({ ...current, [key]: value }));
    setError(undefined);
  }

  function changeProtocol(protocol: Protocol): void {
    const compatible = PROTOCOL_META[protocol].compatible;
    const retainedTargets = form.targets.filter((target) => compatible.includes(target));
    setForm((current) => ({
      ...current,
      protocol,
      targets: retainedTargets.length > 0 ? retainedTargets : [compatible[0]],
      authMode: protocol === "anthropic" ? current.authMode : "bearer",
      enableToolSearch: protocol === "anthropic" && current.enableToolSearch,
    }));
    setError(undefined);
  }

  function toggleTarget(target: ClientTarget): void {
    const selected = form.targets.includes(target);
    const targets = selected
      ? form.targets.filter((item) => item !== target)
      : [...form.targets, target];
    update("targets", targets);
  }

  function updateEndpoints(endpoints: Array<{ url: string }>, activeUrl: string): void {
    setForm((current) => ({ ...current, endpoints, baseUrl: activeUrl }));
    setError(undefined);
  }

  function updateUrl(index: number, url: string): void {
    const previousUrl = form.endpoints[index].url;
    const next = form.endpoints.map((endpoint, endpointIndex) => (
      endpointIndex === index ? { url } : endpoint
    ));
    updateEndpoints(next, form.baseUrl === previousUrl ? url : form.baseUrl);
  }

  function removeEndpoint(index: number): void {
    if (form.endpoints.length === 1) return;
    const removedUrl = form.endpoints[index].url;
    const next = form.endpoints.filter((_, endpointIndex) => endpointIndex !== index);
    updateEndpoints(next, form.baseUrl === removedUrl ? next[0].url : form.baseUrl);
  }

  async function submit(event: SyntheticEvent, applyAfter: boolean): Promise<void> {
    event.preventDefault();
    const validationError = validateProfileInput(form, Boolean(profile));
    if (validationError) {
      setError(validationError);
      const fieldLabel = invalidFieldLabel(validationError);
      if (fieldLabel) {
        requestAnimationFrame(() => {
          const field = dialogRef.current?.querySelector<HTMLElement>(
            `[aria-label="${fieldLabel}"]`,
          );
          field?.focus();
          field?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
      }
      return;
    }
    await onSave(normalizeProfileInput(form), applyAfter);
  }

  function handleContextBack(event: ReactMouseEvent<HTMLDivElement>): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const onScrim = Boolean(target.closest(".editor-scrim"));
    const interactive = Boolean(target.closest(
      "button, input, select, textarea, label, .mono",
    ));
    if (!onScrim && interactive) return;
    event.preventDefault();
    requestClose();
  }

  return (
    <div
      className="editor-layer"
      role="dialog"
      aria-modal="true"
      aria-label={profile ? "编辑方案" : "新建方案"}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || confirmDiscard) return;
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }}
      onMouseDown={(event) => {
        if (event.button !== 3) return;
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }}
      onContextMenu={handleContextBack}
    >
      <button
        type="button"
        className="editor-scrim"
        aria-label="关闭"
        disabled={busy}
        onClick={requestClose}
      />
      <form
        ref={dialogRef}
        className="editor-dialog"
        onSubmit={(event) => void submit(event, false)}
      >
        <header className="editor-head">
          <h2>{profile ? `编辑 · ${profile.name}` : "新建连接方案"}</h2>
          <button
            type="button"
            className="editor-close"
            aria-label="关闭"
            title="关闭"
            disabled={busy}
            onClick={requestClose}
          >
            <X size={15} />
          </button>
        </header>

        <div className="editor-body">
          {error && (
            <div className="editor-error" role="alert">
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}

          <div className="field-grid">
            <label className="field-block">
              <span className="field-name">方案名称</span>
              <input
                aria-label="方案名称"
                value={form.name}
                onChange={(event) => update("name", event.target.value)}
                placeholder="例如：主力中转"
                autoFocus
              />
            </label>
            <label className="field-block">
              <span className="field-name">API 协议</span>
              <select
                aria-label="API 协议"
                value={form.protocol}
                onChange={(event) => changeProtocol(event.target.value as Protocol)}
              >
                {(Object.keys(PROTOCOL_META) as Protocol[]).map((protocol) => (
                  <option value={protocol} key={protocol}>
                    {PROTOCOL_META[protocol].label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="editor-section">
            <span className="field-name">
              API URL
              <small>圆点标记活动 URL</small>
            </span>
            <div className="url-pool" role="group" aria-label="API URL 列表">
              {form.endpoints.map((endpoint, index) => {
                const known = profile?.endpoints.find((item) => item.url === endpoint.url);
                const active = endpoint.url === form.baseUrl;
                const status = endpointStatus(known);
                return (
                  <div className={`url-row ${active ? "active" : ""}`} key={index}>
                    <button
                      type="button"
                      className="url-radio"
                      title="设为活动 URL"
                      aria-label={`设为活动 URL ${index + 1}`}
                      aria-pressed={active}
                      onClick={() => updateEndpoints(form.endpoints, endpoint.url)}
                    >
                      {active ? <CheckCircle2 size={15} /> : <Circle size={15} />}
                    </button>
                    <input
                      aria-label={`API URL ${index + 1}`}
                      value={endpoint.url}
                      onChange={(event) => updateUrl(index, event.target.value)}
                      placeholder="https://api.example.com/v1"
                      spellCheck={false}
                    />
                    <span className={`url-status ${status.className}`}>{status.text}</span>
                    <button
                      type="button"
                      className="url-remove"
                      title="删除 URL"
                      aria-label={`删除 URL ${index + 1}`}
                      disabled={form.endpoints.length === 1}
                      onClick={() => removeEndpoint(index)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="url-pool-foot">
              <button
                type="button"
                className="add-url-pill"
                onClick={() => updateEndpoints([...form.endpoints, { url: "" }], form.baseUrl)}
              >
                <Plus size={13} />添加 URL
              </button>
              <label className="inline-switch">
                <span className="switch-label">自动择优</span>
                <input
                  type="checkbox"
                  className="switch-input"
                  aria-label="自动选择一小时可用率最高的 URL"
                  checked={form.autoSwitch.enabled}
                  onChange={(event) => update("autoSwitch", {
                    ...form.autoSwitch,
                    enabled: event.target.checked,
                    intervalMinutes: 2,
                  })}
                />
                <span
                  className={`kd-switch small ${form.autoSwitch.enabled ? "checked" : ""}`}
                  aria-hidden="true"
                >
                  <span />
                </span>
              </label>
            </div>
          </div>

          <div className="editor-section ruled">
            <div className="field-grid">
              <label className="field-block">
                <span className="field-name">
                  API Key
                  {profile && <small>留空保留 {profile.keyHint}</small>}
                </span>
                <div className="password-field">
                  <input
                    aria-label="API Key"
                    className="mono"
                    type={showKey ? "text" : "password"}
                    value={form.apiKey}
                    onChange={(event) => update("apiKey", event.target.value)}
                    placeholder={profile ? "保留现有密钥" : "sk-..."}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="icon-mini"
                    title={showKey ? "隐藏密钥" : "显示密钥"}
                    aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                    onClick={() => setShowKey((value) => !value)}
                  >
                    {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
              </label>
              <div className="field-block">
                <span className="field-name">
                  模型 ID
                  <button
                    type="button"
                    className="link-button"
                    title="用当前 Key 请求上游模型列表"
                    disabled={busy || discovering}
                    onClick={() => void discoverModels()}
                  >
                    {discovering
                      ? <LoaderCircle size={11} className="spin" />
                      : <RefreshCw size={11} />}
                    识别模型
                  </button>
                </span>
                <div className="model-field" ref={modelFieldRef}>
                  <input
                    aria-label="模型 ID"
                    className="mono"
                    role="combobox"
                    aria-expanded={modelMenuOpen}
                    aria-autocomplete="list"
                    value={form.model}
                    onChange={(event) => {
                      update("model", event.target.value);
                      setModelQuery(event.target.value);
                      setModelMenuOpen(true);
                    }}
                    onFocus={() => {
                      setModelQuery(undefined);
                      setModelMenuOpen(true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && modelMenuOpen) {
                        event.preventDefault();
                        event.stopPropagation();
                        setModelMenuOpen(false);
                      }
                    }}
                    placeholder="claude-sonnet-4-5"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="model-toggle"
                    aria-label={modelMenuOpen ? "收起模型列表" : "展开模型列表"}
                    title={models.length > 0 ? `${models.length} 个可用模型` : "先点击识别模型"}
                    onClick={() => {
                      setModelQuery(undefined);
                      setModelMenuOpen((open) => !open);
                    }}
                  >
                    <ChevronsUpDown size={13} />
                  </button>
                  {modelMenuOpen && (
                    <div className="model-menu" role="listbox" aria-label="可用模型">
                      {modelOptions.length > 0 ? modelOptions.map((model) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={model === form.model}
                          className={`model-option ${model === form.model ? "current" : ""}`}
                          key={model}
                          onClick={() => {
                            update("model", model);
                            setModelQuery(undefined);
                            setModelMenuOpen(false);
                          }}
                        >
                          <code>{model}</code>
                          {model === form.model && <Check size={12} />}
                        </button>
                      )) : (
                        <p className="model-menu-empty">
                          {models.length === 0
                            ? "还没有识别到模型，点击上方“识别模型”。"
                            : "没有匹配的模型，点右侧箭头查看全部。"}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
            {form.protocol === "anthropic" && (
              <div className="field-block" style={{ marginTop: 12 }}>
                <span className="field-name">认证方式</span>
                <div className="auth-segments" role="radiogroup" aria-label="认证方式">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={form.authMode === "bearer"}
                    className={form.authMode === "bearer" ? "active" : ""}
                    onClick={() => update("authMode", "bearer")}
                  >
                    Bearer Token
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={form.authMode === "api-key"}
                    className={form.authMode === "api-key" ? "active" : ""}
                    onClick={() => update("authMode", "api-key")}
                  >
                    x-api-key
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="editor-section ruled">
            <span className="field-name">适用客户端</span>
            <div className="target-grid">
              {CLIENT_TARGET_ORDER.map((target) => {
                const compatible = compatibleTargets.includes(target);
                const checked = form.targets.includes(target);
                const className = [
                  "target-option",
                  checked ? "checked" : "",
                  compatible ? "" : "incompatible",
                ].filter(Boolean).join(" ");
                return (
                  <label className={className} key={target}>
                    <input
                      type="checkbox"
                      className="switch-input"
                      checked={checked}
                      disabled={!compatible}
                      onChange={() => toggleTarget(target)}
                    />
                    <span className="target-check">{checked && <Check size={12} />}</span>
                    <span className="target-copy">
                      <strong>{CLIENT_META[target].label}</strong>
                      <small>{compatible ? "可由网关转发" : "协议不兼容"}</small>
                    </span>
                  </label>
                );
              })}
            </div>
            {form.protocol === "anthropic" && form.targets.includes("claude") && (
              <label className="tool-search-row">
                <span>
                  <strong>Claude Tool Search</strong>
                  <small>为非官方域名写入 ENABLE_TOOL_SEARCH</small>
                </span>
                <input
                  type="checkbox"
                  className="switch-input"
                  checked={Boolean(form.enableToolSearch)}
                  onChange={(event) => update("enableToolSearch", event.target.checked)}
                />
                <span
                  className={`kd-switch small ${form.enableToolSearch ? "checked" : ""}`}
                  aria-hidden="true"
                >
                  <span />
                </span>
              </label>
            )}
          </div>
        </div>

        <footer className="editor-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={requestClose}>
            取消
          </button>
          <button type="submit" className="btn-save" disabled={busy}>
            {busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
            {busy ? "正在保存" : "保存"}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={(event) => void submit(event, true)}
          >
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Zap size={14} fill="currentColor" />
            )}
            {busy ? "正在保存" : "保存并使用"}
          </button>
        </footer>
      </form>
      {confirmDiscard && (
        <ConfirmDialog
          title="放弃尚未保存的修改？"
          message="表单中的改动不会写入方案。"
          confirmLabel="放弃修改"
          danger
          onConfirm={() => {
            setConfirmDiscard(false);
            onClose();
          }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </div>
  );
}
