import { useCallback, useEffect, useRef, useState } from "react";
import { CLIENT_META, DEFAULT_SETTINGS, EMPTY_BOOTSTRAP } from "../config";
import { api } from "../lib/api";
import { describeError, formatDuration, formatTokenCount } from "../lib/format";
import type {
  BootstrapData,
  ClientTarget,
  AppSettings,
  GatewayStartSettings,
  Profile,
  SaveProfileInput,
  StateChangedEvent,
} from "../types";
import type { BusyAction, ToastState } from "../ui-types";

const DEFAULT_TOAST_DURATION_MS = 4_200;
const UNDO_TOAST_DURATION_MS = 8_000;

export interface KeydeckController {
  data: BootstrapData;
  busy: BusyAction | null;
  busyId?: string;
  bootstrapError?: string;
  toast?: ToastState;
  setToast: (toast?: ToastState) => void;
  refresh: () => Promise<void>;
  saveProfile: (input: SaveProfileInput) => Promise<Profile | undefined>;
  duplicateProfile: (profile: Profile) => Promise<Profile | undefined>;
  reorderProfiles: (ids: string[]) => Promise<void>;
  applyProfile: (id: string, targets?: ClientTarget[]) => Promise<void>;
  testProfile: (id: string) => Promise<void>;
  checkProfileHealth: (id: string) => Promise<void>;
  probeProfile: (id: string) => Promise<void>;
  deleteProfile: (profile: Profile) => Promise<boolean>;
  copyKey: (profile: Profile) => Promise<void>;
  openConfig: (target: ClientTarget) => Promise<void>;
  undo: (historyId: string) => Promise<void>;
  startGateway: (settings: GatewayStartSettings) => Promise<void>;
  stopGateway: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

/**
 * 统一管理 Keydeck 主界面的异步数据与命令状态。
 *
 * Hook 负责调用受隔离的 preload API、合并返回数据、维护 loading 状态并将
 * 异常转换为提示条。所有写入副作用都由 Electron 主进程执行；失败时本地状态
 * 不会提前假定成功。
 *
 * @returns 主界面需要的数据、忙碌状态和操作函数。
 */
export function useKeydeckController(): KeydeckController {
  const [data, setData] = useState<BootstrapData>(EMPTY_BOOTSTRAP);

  /** 应用完整快照；缺失的可选字段沿用当前值，避免请求记录和设置被清空。 */
  const mergeBootstrap = useCallback((next: BootstrapData): void => {
    setData((current) => ({
      ...next,
      settings: next.settings ?? current.settings,
      activeRequests: next.activeRequests ?? current.activeRequests,
    }));
  }, []);
  const [busy, setBusy] = useState<BusyAction | null>("load");
  const [busyId, setBusyId] = useState<string>();
  const [bootstrapError, setBootstrapError] = useState<string>();
  const [toast, setToast] = useState<ToastState>();
  const requestSequence = useRef(0);
  const commandLock = useRef(false);

  const loadLatest = useCallback(async (): Promise<boolean> => {
    const requestId = ++requestSequence.current;
    const next = await api.getBootstrap();
    const isLatest = requestId === requestSequence.current;
    if (isLatest) mergeBootstrap(next);
    return isLatest;
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (commandLock.current) return;
    setBusy("load");
    setBootstrapError(undefined);
    try {
      await loadLatest();
    } catch (error) {
      const message = describeError(error);
      setBootstrapError(message);
      setToast({ kind: "error", message });
    } finally {
      setBusy(null);
    }
  }, [loadLatest]);

  /**
   * 静默同步完整主进程状态。
   *
   * @param completedMessage 可选的已完成操作说明；同步失败时用于明确区分
   * 操作结果与界面刷新结果，避免用户重复执行已经成功的写操作。
   * @returns 同步成功时返回 true；失败时显示错误并返回 false。
   */
  const refreshSilently = useCallback(async (completedMessage?: string): Promise<boolean> => {
    try {
      const isLatest = await loadLatest();
      if (!isLatest) return false;
      return true;
    } catch (error) {
      const refreshError = describeError(error);
      setToast({
        kind: "error",
        message: completedMessage
          ? `${completedMessage}，但界面刷新失败：${refreshError}`
          : refreshError,
      });
      return false;
    }
  }, [loadLatest]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => api.onStateChanged((event: StateChangedEvent) => {
    if (event.type === "active-requests-changed") {
      setData((current) => ({ ...current, activeRequests: event.activeRequests }));
      return;
    }
    if (event.type === "settings-changed") {
      setData((current) => ({ ...current, settings: event.settings }));
      return;
    }
    void refreshSilently();
    if (event.type === "gateway-state-changed") return;
    if (event.type === "auto-switch-error") {
      setToast({ kind: "error", message: event.message ?? "自动检测失败" });
      return;
    }
    if (event.switched && event.baseUrl) {
      setToast({ kind: "info", message: `已自动切换到 ${event.baseUrl}` });
    }
  }), [refreshSilently]);

  useEffect(() => {
    if (!toast) return undefined;

    const timeout = toast.undoId ? UNDO_TOAST_DURATION_MS : DEFAULT_TOAST_DURATION_MS;
    const timer = window.setTimeout(() => setToast(undefined), timeout);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function saveProfile(input: SaveProfileInput): Promise<Profile | undefined> {
    if (commandLock.current) return undefined;
    commandLock.current = true;
    setBusy("save");
    try {
      const saved = await api.saveProfile(input);
      const completedMessage = `已保存“${saved.name}”`;
      if (await refreshSilently(completedMessage)) {
        setToast({ kind: "success", message: completedMessage });
      }
      return saved;
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      return undefined;
    } finally {
      commandLock.current = false;
      setBusy(null);
    }
  }

  async function duplicateProfile(profile: Profile): Promise<Profile | undefined> {
    if (commandLock.current) return undefined;
    commandLock.current = true;
    setBusy("duplicate");
    setBusyId(profile.id);
    try {
      const duplicate = await api.duplicateProfile(profile.id);
      const completedMessage = `已复制为“${duplicate.name}”`;
      if (await refreshSilently(completedMessage)) {
        setToast({ kind: "success", message: completedMessage });
      }
      return duplicate;
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      return undefined;
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  async function reorderProfiles(ids: string[]): Promise<void> {
    if (commandLock.current) return;
    if (!api.reorderProfiles) {
      setToast({ kind: "error", message: "当前主进程版本尚不支持方案排序" });
      return;
    }
    const previous = data.profiles;
    const byId = new Map(previous.map((profile) => [profile.id, profile]));
    const optimistic = [
      ...ids.map((id) => byId.get(id)).filter((profile): profile is Profile => Boolean(profile)),
      ...previous.filter((profile) => !ids.includes(profile.id)),
    ];
    setData((current) => ({ ...current, profiles: optimistic }));
    try {
      await api.reorderProfiles(ids);
      await refreshSilently("排序已保存");
    } catch (error) {
      setData((current) => ({ ...current, profiles: previous }));
      setToast({ kind: "error", message: describeError(error) });
    }
  }

  async function applyProfile(id: string, targets?: ClientTarget[]): Promise<void> {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy("apply");
    setBusyId(id);
    try {
      const result = await api.applyProfile(id, targets);
      const labels = result.assignedTargets
        .map((target) => CLIENT_META[target].short)
        .join("、");
      const resultMessage = result.gateway.status === "running"
        ? `“${result.profile.name}”已成为 ${labels} 的当前网关方案`
        : `“${result.profile.name}”已设为 ${labels} 的下次启动方案`;
      if (await refreshSilently(resultMessage)) {
        setToast({
          kind: "success",
          message: resultMessage,
          ...(result.historyEntry?.canUndo ? { undoId: result.historyEntry.id } : {}),
        });
      }
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  async function testProfile(id: string): Promise<void> {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy("test");
    setBusyId(id);
    try {
      const tested = await api.testProfile(id);
      if (!await refreshSilently("模型识别已完成")) return;

      if (tested.availableModels.length > 0) {
        setToast({
          kind: "success",
          message: `已识别 ${tested.availableModels.length} 个可用模型`,
        });
      } else {
        setToast({ kind: "info", message: "请求已完成，但没有识别到模型" });
      }
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  async function checkProfileHealth(id: string): Promise<void> {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy("test");
    setBusyId(id);
    try {
      const tested = await api.checkProfileHealth(id);
      if (!await refreshSilently("端点检测已完成")) return;
      const reachable = tested.endpoints.filter((endpoint) => (
        endpoint.health?.status === "healthy" || endpoint.health?.status === "limited"
      )).length;
      setToast({
        kind: reachable > 0 ? "success" : "error",
        message: `端点检测完成：${reachable} / ${tested.endpoints.length} 可达`,
      });
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  async function probeProfile(id: string): Promise<void> {
    if (commandLock.current) return;
    if (!api.probeProfile) {
      setToast({ kind: "error", message: "当前主进程版本尚不支持渠道实测" });
      return;
    }
    commandLock.current = true;
    setBusy("probe");
    setBusyId(id);
    try {
      const result = await api.probeProfile(id);
      const usage = result.tokenUsage;
      const usageText = usage
        ? ` · ↓${formatTokenCount(usage.inputTokens)}${(usage.cachedTokens ?? 0) > 0 ? `（缓存 ${formatTokenCount(usage.cachedTokens)}）` : ""} ↑${formatTokenCount(usage.outputTokens)}`
        : "";
      setToast(result.ok
        ? {
            kind: "success",
            message: `实测通过 · ${result.model} · 首包 ${formatDuration(result.firstByteMs)} · 总耗时 ${formatDuration(result.totalMs)}${usageText}`,
          }
        : {
            kind: "error",
            message: `实测失败${result.statusCode !== undefined ? ` · HTTP ${result.statusCode}` : ""}${result.message ? ` · ${result.message}` : ""}`,
          });
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  async function deleteProfile(profile: Profile): Promise<boolean> {
    if (commandLock.current) return false;
    commandLock.current = true;
    setBusy("delete");
    setBusyId(profile.id);
    try {
      await api.deleteProfile(profile.id);
      const completedMessage = `已删除“${profile.name}”`;
      if (await refreshSilently(completedMessage)) {
        setToast({ kind: "success", message: completedMessage });
      }
      return true;
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      return false;
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  async function copyKey(profile: Profile): Promise<void> {
    try {
      await api.copyProfileKey(profile.id);
      setToast({ kind: "info", message: `“${profile.name}”的密钥已复制` });
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    }
  }

  async function openConfig(target: ClientTarget): Promise<void> {
    try {
      await api.openConfig(target);
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    }
  }

  async function undo(historyId: string): Promise<void> {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy("undo");
    setBusyId(historyId);
    try {
      const requestId = ++requestSequence.current;
      const next = await api.undoHistory(historyId);
      if (requestId === requestSequence.current) mergeBootstrap(next);
      setToast({ kind: "success", message: "已恢复切换前的配置" });
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  async function startGateway(settings: GatewayStartSettings): Promise<void> {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy("gateway-start");
    try {
      const requestId = ++requestSequence.current;
      const next = await api.startGateway(settings);
      if (requestId === requestSequence.current) mergeBootstrap(next);
      setToast({ kind: "success", message: "本地网关已启动，并接管已分配的客户端" });
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      await refreshSilently();
    } finally {
      commandLock.current = false;
      setBusy(null);
    }
  }

  async function stopGateway(): Promise<void> {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy("gateway-stop");
    try {
      const requestId = ++requestSequence.current;
      const next = await api.stopGateway();
      if (requestId === requestSequence.current) mergeBootstrap(next);
      const skipped = next.gatewayRecovery?.skippedTargets ?? [];
      const skippedLabels = skipped.map((target) => CLIENT_META[target].short).join("、");
      setToast({
        kind: skipped.length > 0 ? "info" : "success",
        message: skipped.length > 0
          ? `本地网关已停止；已跳过用户修改的 ${skippedLabels}`
          : "本地网关已停止",
      });
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      await refreshSilently();
    } finally {
      commandLock.current = false;
      setBusy(null);
    }
  }

  async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
    if (commandLock.current) return;
    if (!api.updateSettings) {
      setToast({ kind: "error", message: "当前主进程版本尚不支持保存应用设置" });
      return;
    }
    commandLock.current = true;
    setBusy("settings");
    const previous = data.settings ?? DEFAULT_SETTINGS;
    const optimistic = { ...previous, ...patch };
    setData((current) => ({ ...current, settings: optimistic }));
    try {
      const result = await api.updateSettings(patch);
      const nextSettings = "profiles" in result
        ? result.settings ?? optimistic
        : result;
      setData((current) => ({ ...current, settings: nextSettings }));
      setToast({ kind: "success", message: "设置已保存" });
    } catch (error) {
      setData((current) => ({ ...current, settings: previous }));
      setToast({ kind: "error", message: describeError(error) });
    } finally {
      commandLock.current = false;
      setBusy(null);
    }
  }

  return {
    data,
    busy,
    busyId,
    bootstrapError,
    toast,
    setToast,
    refresh,
    saveProfile,
    duplicateProfile,
    reorderProfiles,
    applyProfile,
    testProfile,
    checkProfileHealth,
    probeProfile,
    deleteProfile,
    copyKey,
    openConfig,
    undo,
    startGateway,
    stopGateway,
    updateSettings,
  };
}
