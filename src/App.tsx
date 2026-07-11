import { Activity, KeyRound, LayoutDashboard, Minus, Settings, ShieldCheck, Square, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { ActivityView } from "./components/ActivityView";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { GatewaySwitch } from "./components/GatewaySwitch";
import { KeyringView } from "./components/KeyringView";
import { OverviewView } from "./components/OverviewView";
import { ProfileEditor } from "./components/ProfileEditor";
import { SettingsView } from "./components/SettingsView";
import { Toast } from "./components/Toast";
import { APP_VERSION, DEFAULT_SETTINGS } from "./config";
import { useKeydeckController } from "./hooks/useKeydeckController";
import { api, isDesktop } from "./lib/api";
import type { Profile, SaveProfileInput } from "./types";
import type { FeedTab, View } from "./ui-types";

interface EditorState {
  open: boolean;
  profile?: Profile;
}

const NAV_ITEMS: Array<{ view: View; label: string; icon: ReactElement }> = [
  { view: "overview", label: "概览", icon: <LayoutDashboard size={15} /> },
  { view: "keyring", label: "密钥", icon: <KeyRound size={15} /> },
  { view: "activity", label: "动态", icon: <Activity size={15} /> },
  { view: "settings", label: "设置", icon: <Settings size={15} /> },
];

function isContextMenuTargetInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    "button, input, select, textarea, label, a, [role='button'], [role='radio'], [role='menuitem'], .mono, code",
  ));
}

function App(): ReactElement {
  const controller = useKeydeckController();
  const [view, setView] = useState<View>("overview");
  const [feedTab, setFeedTab] = useState<FeedTab>("requests");
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [pendingDelete, setPendingDelete] = useState<Profile>();
  const settings = controller.data.settings ?? DEFAULT_SETTINGS;
  const requestRecords = controller.data.activeRequests ?? [];
  const activeRequests = requestRecords.filter((request) => (
    !request.completedAt
    && ["connecting", "waiting-first-token", "streaming"].includes(request.state)
  ));
  const gateway = controller.data.gateway;
  const gatewayOn = gateway.status === "running" || gateway.status === "starting";
  const routeCount = gateway.routes
    .filter((route) => controller.data.profiles.some((profile) => profile.id === route.profileId))
    .length;
  const toastUndoId = controller.toast?.undoId;

  useEffect(() => {
    if (settings.theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    function goBack(): void {
      if (editor.open) return;
      if (view !== "overview") setView("overview");
    }

    function handleKey(event: KeyboardEvent): void {
      if (event.ctrlKey && event.key.toLowerCase() === "n") {
        if (controller.busy || editor.open) return;
        event.preventDefault();
        setView("keyring");
        setEditor({ open: true });
        return;
      }
      if (event.key === "F5" && !controller.busy && !editor.open) {
        event.preventDefault();
        void controller.refresh();
        return;
      }
      if (event.key === "Escape" && !editor.open && view !== "overview") {
        event.preventDefault();
        goBack();
      }
    }

    function handleMouseBack(event: MouseEvent): void {
      if (event.button !== 3 || editor.open) return;
      if (view !== "overview") {
        event.preventDefault();
        goBack();
      }
    }

    window.addEventListener("keydown", handleKey);
    window.addEventListener("mousedown", handleMouseBack);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("mousedown", handleMouseBack);
    };
  }, [controller.busy, controller.refresh, editor.open, view]);

  async function handleSave(input: SaveProfileInput, useAfter: boolean): Promise<void> {
    const saved = await controller.saveProfile(input);
    if (!saved) return;
    setView("keyring");
    setEditor({ open: false });
    if (useAfter) await controller.applyProfile(saved.id);
  }

  async function confirmDelete(): Promise<void> {
    const profile = pendingDelete;
    setPendingDelete(undefined);
    if (profile) await controller.deleteProfile(profile);
  }

  function handleContextBack(event: ReactMouseEvent<HTMLElement>): void {
    if (editor.open || isContextMenuTargetInteractive(event.target)) return;
    if (view === "overview") return;
    event.preventDefault();
    setView("overview");
  }

  function goActivity(tab: FeedTab): void {
    setFeedTab(tab);
    setView("activity");
  }

  const statusText = gateway.status === "starting"
    ? `网关正在启动 · 127.0.0.1:${gateway.port}`
    : gateway.status === "stopping"
      ? `网关正在停止 · 127.0.0.1:${gateway.port}`
      : gateway.status === "error"
        ? `网关需要处理${gateway.error ? ` · ${gateway.error}` : ""}`
        : gatewayOn
          ? `网关运行中 · ${routeCount} 条路由 · 127.0.0.1:${gateway.port}`
          : `网关已关闭 · 127.0.0.1:${gateway.port}`;
  const statusDot = gateway.status === "error"
    ? "var(--bad)"
    : gateway.status === "running"
      ? "var(--good)"
      : "var(--warn)";

  return (
    <div className="app-shell" onContextMenu={handleContextBack}>
      <header className="topbar">
        <div className="brand-mark" aria-label="Key Core">
          <span className="brand-glyph"><Zap size={15} strokeWidth={2.5} fill="currentColor" /></span>
          <strong>Key Core</strong>
        </div>
        <nav className="top-nav" aria-label="功能导航">
          {NAV_ITEMS.map((item) => (
            <button
              type="button"
              key={item.view}
              className={view === item.view ? "active" : ""}
              aria-current={view === item.view ? "page" : undefined}
              onClick={() => setView(item.view)}
            >
              {item.icon}
              {item.label}
              {item.view === "activity" && activeRequests.length > 0 && (
                <em>{activeRequests.length}</em>
              )}
              <i aria-hidden="true" />
            </button>
          ))}
        </nav>
        <div className="topbar-side">
          <code className="port-chip">127.0.0.1:{gateway.port || 17863}</code>
          <GatewaySwitch
            gateway={gateway}
            busy={Boolean(controller.busy)}
            onStart={() => void controller.startGateway({ port: gateway.port || 17863 })}
            onStop={() => void controller.stopGateway()}
          />
          {isDesktop && api.windowControl && (
            <div className="win-controls">
              <button
                type="button"
                title="最小化"
                aria-label="最小化"
                onClick={() => void api.windowControl?.("minimize")}
              >
                <Minus size={14} />
              </button>
              <button
                type="button"
                title="最大化 / 还原"
                aria-label="最大化或还原"
                onClick={() => void api.windowControl?.("maximize")}
              >
                <Square size={12} />
              </button>
              <button
                type="button"
                className="win-close"
                title="关闭"
                aria-label="关闭窗口"
                onClick={() => void api.windowControl?.("close")}
              >
                <X size={15} />
              </button>
            </div>
          )}
        </div>
      </header>

      {view === "overview" && (
        <OverviewView
          profiles={controller.data.profiles}
          clients={controller.data.clients}
          gateway={gateway}
          activeRequestCount={activeRequests.length}
          history={controller.data.history}
          busy={Boolean(controller.busy)}
          onApply={(id, target) => void controller.applyProfile(id, [target])}
          onGoActivity={goActivity}
        />
      )}
      {view === "keyring" && (
        <KeyringView
          profiles={controller.data.profiles}
          gateway={gateway}
          busy={controller.busy}
          busyId={controller.busyId}
          loading={controller.busy === "load"}
          error={controller.bootstrapError}
          onCreate={() => setEditor({ open: true })}
          onEdit={(profile) => setEditor({ open: true, profile })}
          onDuplicate={(profile) => void controller.duplicateProfile(profile)}
          onDelete={setPendingDelete}
          onApply={(id, targets) => void controller.applyProfile(id, targets)}
          onTest={(id) => void controller.checkProfileHealth(id)}
          onProbe={(id) => void controller.probeProfile(id)}
          onCopyKey={(profile) => void controller.copyKey(profile)}
          onReorder={(ids) => void controller.reorderProfiles(ids)}
          onRetry={() => void controller.refresh()}
        />
      )}
      {view === "activity" && (
        <ActivityView
          requests={requestRecords}
          history={controller.data.history}
          busy={Boolean(controller.busy)}
          busyId={controller.busyId}
          feedTab={feedTab}
          onFeedTabChange={setFeedTab}
          onUndo={(id) => void controller.undo(id)}
        />
      )}
      {view === "settings" && (
        <SettingsView
          settings={settings}
          busy={controller.busy === "settings"}
          onChange={(patch) => void controller.updateSettings(patch)}
        />
      )}

      <footer className="status-footer" aria-live="polite">
        <span><i className="status-dot" style={{ background: statusDot }} />{statusText}</span>
        <span><ShieldCheck size={12} />DPAPI 本机加密</span>
        <span className="footer-right">
          {controller.data.profiles.length} 方案 / 4 客户端 · Key Core {APP_VERSION}
          {!isDesktop && " · 界面预览"}
        </span>
      </footer>

      {editor.open && (
        <ProfileEditor
          profile={editor.profile}
          busy={controller.busy === "save"}
          onClose={() => setEditor({ open: false })}
          onSave={handleSave}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`删除“${pendingDelete.name}”？`}
          message="指向它的路由也会一并移除。此操作不修改已写入客户端的配置。"
          confirmLabel="删除"
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(undefined)}
        />
      )}

      {controller.toast && (
        <Toast
          toast={controller.toast}
          onClose={() => controller.setToast(undefined)}
          onUndo={toastUndoId ? () => void controller.undo(toastUndoId) : undefined}
        />
      )}
    </div>
  );
}

export default App;
