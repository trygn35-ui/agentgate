import { Moon, ShieldCheck, Sun, SunMoon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import type { AppSettings, AppTheme } from "../types";

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
  { value: "system", label: "系统", icon: <SunMoon size={13} /> },
  { value: "light", label: "浅色", icon: <Sun size={13} /> },
  { value: "dark", label: "深色", icon: <Moon size={13} /> },
];

interface SettingsViewProps {
  settings: AppSettings;
  busy: boolean;
  onChange: (patch: Partial<AppSettings>) => void;
}

/** 设置页：启动与后台开关、主题选择和密钥安全说明。 */
export function SettingsView({ settings, busy, onChange }: SettingsViewProps): ReactElement {
  return (
    <main className="page-scroll" aria-label="设置">
      <div className="page-inner narrow">
        <div className="section-head rise">
          <h1>设置</h1>
        </div>
        <div className="settings-card rise-1">
          <SettingToggle
            title="开机自启"
            description="登录 Windows 后自动启动 Keydeck"
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
          <div className="settings-theme-row">
            <span className="settings-row-copy">
              <strong>主题</strong>
              <small>明暗外观立即生效</small>
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
