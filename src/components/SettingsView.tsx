import {
  ArrowDownToLine,
  CheckCircle2,
  Download,
  LoaderCircle,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
  SunMoon,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import type { AppSettings, AppTheme, UpdateState } from "../types";

interface SettingToggleProps {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

function SettingToggle({
  title,
  description,
  checked,
  disabled,
  onChange,
}: SettingToggleProps): ReactElement {
  return (
    <label className={`settings-row ${disabled ? "disabled" : ""}`}>
      <span className="settings-row-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={`kd-switch ${checked ? "checked" : ""}`} aria-hidden="true"><span /></span>
    </label>
  );
}

const THEMES: Array<{ value: AppTheme; label: string; icon: ReactNode }> = [
  { value: "system", label: "SYSTEM", icon: <SunMoon size={12} /> },
  { value: "light", label: "α FIELD", icon: <Sun size={12} /> },
  { value: "dark", label: "β FIELD", icon: <Moon size={12} /> },
];

interface SettingsViewProps {
  settings: AppSettings;
  busy: boolean;
  update?: UpdateState;
  version: string;
  onChange: (patch: Partial<AppSettings>) => void;
  onCheckUpdate: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
}

/** 更新区块：显示当前版本、检查更新与下载安装入口。 */
function UpdateRow({
  update,
  version,
  onCheck,
  onDownload,
  onInstall,
}: {
  update?: UpdateState;
  version: string;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}): ReactElement {
  const state = update?.state ?? "idle";
  const checking = state === "checking";
  const downloading = state === "downloading";
  const description = state === "available"
    ? `发现新版本 ${update?.version}${update?.portable ? " · 便携版需手动下载" : ""}`
    : state === "downloading"
      ? `正在下载 ${update?.percent ?? 0}%`
      : state === "ready"
        ? `新版本 ${update?.version} 已就绪，重启即可安装`
        : state === "up-to-date"
          ? "已是最新版本"
          : state === "error"
            ? update?.message ?? "检查更新失败"
            : `当前版本 ${version}`;

  return (
    <div className="settings-theme-row">
      <span className="settings-row-copy">
        <strong>软件更新</strong>
        <small className={state === "error" ? "tier-bad" : state === "ready" ? "tier-good" : ""}>
          {description}
        </small>
      </span>
      {state === "ready" && !update?.portable ? (
        <button type="button" className="primary-pill" onClick={onInstall}>
          <ArrowDownToLine size={13} />重启并安装
        </button>
      ) : state === "available" ? (
        <button type="button" className="primary-pill" disabled={downloading} onClick={onDownload}>
          {downloading
            ? <LoaderCircle size={13} className="spin" />
            : <Download size={13} />}
          {update?.portable ? "前往下载" : downloading ? `${update?.percent ?? 0}%` : "下载更新"}
        </button>
      ) : (
        <button type="button" className="ghost-pill" disabled={checking} onClick={onCheck}>
          {checking
            ? <LoaderCircle size={13} className="spin" />
            : state === "up-to-date"
              ? <CheckCircle2 size={13} />
              : <RefreshCw size={13} />}
          检查更新
        </button>
      )}
    </div>
  );
}

/** 设置页：启动与后台开关、主题选择、软件更新和密钥安全说明。 */
export function SettingsView({
  settings,
  busy,
  update,
  version,
  onChange,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
}: SettingsViewProps): ReactElement {
  return (
    <main className="page-scroll" aria-label="设置">
      <div className="page-inner narrow">
        <div className="section-head rise">
          <h1>Config</h1>
        </div>
        <div className="settings-card rise-1">
          <SettingToggle
            title="开机自启（静默）"
            description="登录 Windows 后自动启动并直接驻留托盘，不弹出窗口；手动启动仍正常显示"
            checked={settings.launchAtLogin}
            disabled={busy}
            onChange={(launchAtLogin) => onChange({ launchAtLogin })}
          />
          <SettingToggle
            title="关闭时驻留托盘"
            description="网关运行时保持后台驻留，关闭网关后按此设置退出"
            checked={settings.closeToTray}
            disabled={busy}
            onChange={(closeToTray) => onChange({ closeToTray })}
          />
          <SettingToggle
            title="启动时恢复网关"
            description="启动后恢复上次的网关开关状态"
            checked={settings.startGatewayOnLaunch}
            disabled={busy}
            onChange={(startGatewayOnLaunch) => onChange({ startGatewayOnLaunch })}
          />
          <SettingToggle
            title="Codex 工具兼容模式（实验性）"
            description="只转换 Responses 的 exec 工具协议，不能修复上游裁剪上下文"
            checked={settings.experimentalToolBridge}
            disabled={busy}
            onChange={(experimentalToolBridge) => onChange({ experimentalToolBridge })}
          />
          <UpdateRow
            update={update}
            version={version}
            onCheck={onCheckUpdate}
            onDownload={onDownloadUpdate}
            onInstall={onInstallUpdate}
          />
          <div className="settings-theme-row" style={{ borderTop: "1px solid var(--line)" }}>
            <span className="settings-row-copy">
              <strong>Attractor Field</strong>
              <small>α 纸与墨 · β 分歧率显示器 · 立即生效</small>
            </span>
            <div className="theme-segments" role="radiogroup" aria-label="界面主题">
              {THEMES.map((theme) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={settings.theme === theme.value}
                  className={settings.theme === theme.value ? "active" : ""}
                  disabled={busy}
                  key={theme.value}
                  onClick={() => onChange({ theme: theme.value })}
                >
                  {theme.icon}{theme.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="security-note rise-2">
          <ShieldCheck size={14} />
          <span>
            真实 Key 由 Windows DPAPI 加密，只在本机交给网关；客户端不会保存上游 Key。
            方案中的 URL 与 Key 永不写入客户端配置文件。
          </span>
        </p>
      </div>
    </main>
  );
}
