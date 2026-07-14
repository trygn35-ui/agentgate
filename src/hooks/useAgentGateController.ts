import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CLIENT_META, DEFAULT_SETTINGS, EMPTY_BOOTSTRAP } from "../config";
import { MESSAGES, fill, resolveLocale } from "../i18n";
import { api } from "../lib/api";
import { describeError, formatDuration, formatTokenCount } from "../lib/format";
import { mergeActiveRequests } from "../lib/requests";
import type {
  BootstrapData,
  ClientTarget,
  AppSettings,
  GatewayStartSettings,
  GatewayStopSettings,
  Profile,
  SaveProfileInput,
  StateChangedEvent,
} from "../types";
import type { BusyAction, ToastState } from "../ui-types";

const DEFAULT_TOAST_DURATION_MS = 4_200;

export interface AgentGateController {
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
  testProfile: (id: string) => Promise<string[] | undefined>;
  checkProfileHealth: (id: string) => Promise<void>;
  checkAllProfilesHealth: () => Promise<void>;
  /** 正在后台检测端点的方案 ID 集合；检测不锁定其他操作。 */
  testingIds: ReadonlySet<string>;
  probeProfile: (id: string) => Promise<void>;
  deleteProfile: (profile: Profile) => Promise<boolean>;
  copyKey: (profile: Profile) => Promise<void>;
  openConfig: (target: ClientTarget) => Promise<void>;
  startGateway: (settings: GatewayStartSettings) => Promise<void>;
  stopGateway: (settings?: GatewayStopSettings) => Promise<void>;
  reassignPort: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  checkForUpdate: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
}

/**
 * 统一管理 Agent;Gate 主界面的异步数据与命令状态。
 *
 * Hook 负责调用受隔离的 preload API、合并返回数据、维护 loading 状态并将
 * 异常转换为提示条。所有写入副作用都由 Electron 主进程执行；失败时本地状态
 * 不会提前假定成功。
 *
 * @returns 主界面需要的数据、忙碌状态和操作函数。
 */
export function useAgentGateController(): AgentGateController {
  const [data, setData] = useState<BootstrapData>(EMPTY_BOOTSTRAP);

  // 提示条文案要跟随语言，但把 m 塞进每个 useCallback 的依赖会让回调身份随语言
  // 变化、连带重挂事件监听。用 ref 持有最新文案，回调身份保持稳定。
  const language = data.settings?.language;
  const messages = useMemo(() => MESSAGES[resolveLocale(language)], [language]);
  const m = useRef(messages);
  m.current = messages;

  /** 应用完整快照；缺失的可选字段沿用当前值，避免请求记录和设置被清空。 */
  const mergeBootstrap = useCallback((next: BootstrapData): void => {
    setData((current) => ({
      ...next,
      settings: next.settings ?? current.settings,
      activeRequests: next.activeRequests ?? current.activeRequests,
      update: next.update ?? current.update,
    }));
  }, []);
  const [busy, setBusy] = useState<BusyAction | null>("load");
  const [busyId, setBusyId] = useState<string>();
  const [bootstrapError, setBootstrapError] = useState<string>();
  const [toast, setToast] = useState<ToastState>();
  const [testingIds, setTestingIds] = useState<ReadonlySet<string>>(() => new Set());
  const requestSequence = useRef(0);
  const commandLock = useRef(false);
  const testingRef = useRef(new Set<string>());

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
          ? fill(m.current.toast.refreshFailed, { message: completedMessage, error: refreshError })
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
      /*
       * patch = 只带了还在跑的那几条的最新状态。
       *
       * 传输途中每 200ms 一次的进度通知，原本推的是整部历史（最多 2000 条）。那部分
       * 根本没变，白白序列化过来——主进程那边实测吃掉了转发路径八成六的 CPU。
       * 现在只推活跃的那几条，这里按 id 就地更新。
       */
      if (event.patch) {
        setData((current) => ({
          ...current,
          activeRequests: mergeActiveRequests(current.activeRequests ?? [], event.activeRequests),
        }));
        return;
      }
      setData((current) => ({ ...current, activeRequests: event.activeRequests }));
      return;
    }
    if (event.type === "settings-changed") {
      setData((current) => ({ ...current, settings: event.settings }));
      return;
    }
    if (event.type === "update-state-changed") {
      setData((current) => ({ ...current, update: event.update }));
      return;
    }
    void refreshSilently();
    if (event.type === "gateway-state-changed") return;
    if (event.type === "auto-switch-error") {
      setToast({ kind: "error", message: event.message ?? m.current.toast.autoSwitchFailed });
      return;
    }
    if (event.switched && event.baseUrl) {
      setToast({
        kind: "info",
        message: fill(m.current.toast.autoSwitched, { url: event.baseUrl }),
      });
    }
  }), [refreshSilently]);

  useEffect(() => {
    if (!toast) return undefined;

    const timer = window.setTimeout(() => setToast(undefined), DEFAULT_TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function saveProfile(input: SaveProfileInput): Promise<Profile | undefined> {
    if (commandLock.current) return undefined;
    commandLock.current = true;
    setBusy("save");
    try {
      const saved = await api.saveProfile(input);
      const completedMessage = fill(m.current.toast.saved, { name: saved.name });
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
      const completedMessage = fill(m.current.toast.duplicated, { name: duplicate.name });
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
      setToast({ kind: "error", message: m.current.toast.orderFailed });
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
      await refreshSilently(m.current.toast.reordered);
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
      const targetLabels = result.assignedTargets
        .map((target) => CLIENT_META[target].short)
        .join(", ");
      const resultMessage = fill(
        result.gateway.status === "running"
          ? m.current.toast.assignedRunning
          : m.current.toast.assignedStopped,
        { name: result.profile.name, targets: targetLabels },
      );
      if (await refreshSilently(resultMessage)) {
        setToast({ kind: "success", message: resultMessage });
      }
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  /**
   * 识别模型：请求上游模型列表并保存。
   *
   * @returns 识别到的模型列表；失败或被其他命令阻塞时返回 undefined。
   */
  async function testProfile(id: string): Promise<string[] | undefined> {
    if (commandLock.current) return undefined;
    commandLock.current = true;
    setBusy("test");
    setBusyId(id);
    try {
      const tested = await api.testProfile(id);
      await refreshSilently(m.current.keys.discoverModels);

      if (tested.availableModels.length > 0) {
        setToast({
          kind: "success",
          message: fill(m.current.toast.modelsFound, { count: tested.availableModels.length }),
        });
      } else {
        setToast({ kind: "info", message: m.current.toast.noModels });
      }
      return tested.availableModels;
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      return undefined;
    } finally {
      commandLock.current = false;
      setBusy(null);
      setBusyId(undefined);
    }
  }

  /**
   * 执行单个方案的无凭据端点检测，维护行级检测状态。
   *
   * 检测是只读探测，不占用全局命令锁；检测期间的保存/删除由主进程的
   * revision 校验兜底，过期结果会被拒绝提交。
   *
   * @returns 可达与总端点数；该方案已在检测中时返回 undefined。
   */
  async function runHealthCheck(id: string): Promise<{ reachable: number; total: number } | undefined> {
    if (testingRef.current.has(id)) return undefined;
    testingRef.current.add(id);
    setTestingIds(new Set(testingRef.current));
    try {
      const tested = await api.checkProfileHealth(id);
      const reachable = tested.endpoints.filter((endpoint) => (
        endpoint.health?.status === "healthy" || endpoint.health?.status === "limited"
      )).length;
      return { reachable, total: tested.endpoints.length };
    } finally {
      testingRef.current.delete(id);
      setTestingIds(new Set(testingRef.current));
    }
  }

  async function checkProfileHealth(id: string): Promise<void> {
    try {
      const result = await runHealthCheck(id);
      if (!result) return;
      if (!await refreshSilently(m.current.keys.testEndpoints)) return;
      setToast({
        kind: result.reachable > 0 ? "success" : "error",
        message: fill(m.current.toast.healthDone, {
          reachable: result.reachable,
          total: result.total,
        }),
      });
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    }
  }

  async function checkAllProfilesHealth(): Promise<void> {
    const ids = data.profiles
      .map((profile) => profile.id)
      .filter((id) => !testingRef.current.has(id));
    if (ids.length === 0) return;
    const results = await Promise.allSettled(ids.map((id) => runHealthCheck(id)));
    await refreshSilently(m.current.keys.testEndpoints);
    const settled = results
      .map((result) => (result.status === "fulfilled" ? result.value : undefined));
    const reachableProfiles = settled
      .filter((value) => value !== undefined && value.reachable > 0).length;
    setToast({
      kind: reachableProfiles > 0 ? "success" : "error",
      message: fill(m.current.toast.healthAllDone, {
        reachable: reachableProfiles,
        total: ids.length,
      }),
    });
  }

  async function probeProfile(id: string): Promise<void> {
    if (commandLock.current) return;
    if (!api.probeProfile) {
      setToast({ kind: "error", message: m.current.toast.unsupported });
      return;
    }
    commandLock.current = true;
    setBusy("probe");
    setBusyId(id);
    try {
      const result = await api.probeProfile(id);
      const usage = result.tokenUsage;
      const cached = (usage?.cachedTokens ?? 0) > 0
        ? ` (${m.current.keys.cache} ${formatTokenCount(usage?.cachedTokens)})`
        : "";
      const usageText = usage
        ? ` · ↓${formatTokenCount(usage.inputTokens)}${cached} ↑${formatTokenCount(usage.outputTokens)}`
        : "";
      setToast(result.ok
        ? {
            kind: "success",
            message: fill(m.current.toast.probePass, {
              model: result.model ?? "",
              ttfb: formatDuration(result.firstByteMs),
              total: formatDuration(result.totalMs),
              usage: usageText,
            }),
          }
        : {
            kind: "error",
            message: fill(m.current.toast.probeFail, {
              status: result.statusCode !== undefined ? ` · HTTP ${result.statusCode}` : "",
              message: result.message ? ` · ${result.message}` : "",
            }),
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
      const completedMessage = fill(m.current.toast.deleted, { name: profile.name });
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
      setToast({
        kind: "info",
        message: fill(m.current.toast.keyCopied, { name: profile.name }),
      });
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

  async function startGateway(settings: GatewayStartSettings): Promise<void> {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy("gateway-start");
    try {
      const requestId = ++requestSequence.current;
      const next = await api.startGateway(settings);
      if (requestId === requestSequence.current) mergeBootstrap(next);
      setToast({ kind: "success", message: m.current.toast.gatewayStarted });
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
      await refreshSilently();
    } finally {
      commandLock.current = false;
      setBusy(null);
    }
  }

  async function reassignPort(): Promise<void> {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy("gateway-start");
    try {
      const next = await api.reassignPort();
      mergeBootstrap(next);
      setToast({
        kind: "success",
        message: fill(m.current.toast.portReassigned, { port: next.gateway.port }),
      });
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    } finally {
      commandLock.current = false;
      setBusy(null);
    }
  }

  async function stopGateway(settings?: GatewayStopSettings): Promise<void> {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy("gateway-stop");
    try {
      const requestId = ++requestSequence.current;
      const next = await api.stopGateway(settings);
      if (requestId === requestSequence.current) mergeBootstrap(next);
      const skipped = next.gatewayRecovery?.skippedTargets ?? [];
      const targets = skipped.map((target) => CLIENT_META[target].short).join(", ");
      setToast({
        kind: skipped.length > 0 ? "info" : "success",
        message: skipped.length > 0
          ? fill(m.current.toast.gatewaySkipped, { targets })
          : m.current.toast.gatewayStopped,
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
      setToast({ kind: "error", message: m.current.toast.unsupported });
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
      setToast({ kind: "success", message: m.current.toast.settingsSaved });
    } catch (error) {
      setData((current) => ({ ...current, settings: previous }));
      setToast({ kind: "error", message: describeError(error) });
    } finally {
      commandLock.current = false;
      setBusy(null);
    }
  }

  async function checkForUpdate(): Promise<void> {
    if (!api.checkForUpdate) {
      setToast({ kind: "error", message: m.current.toast.unsupported });
      return;
    }
    try {
      const state = await api.checkForUpdate();
      setData((current) => ({ ...current, update: state }));
      if (state.state === "up-to-date") {
        setToast({
          kind: "success",
          message: fill(m.current.toast.upToDate, { version: state.currentVersion ?? "" }),
        });
      } else if (state.state === "error") {
        setToast({ kind: "error", message: state.message ?? m.current.toast.updateCheckFailed });
      }
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    }
  }

  async function downloadUpdate(): Promise<void> {
    if (!api.downloadUpdate) return;
    try {
      const state = await api.downloadUpdate();
      setData((current) => ({ ...current, update: state }));
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
    }
  }

  async function installUpdate(): Promise<void> {
    if (!api.installUpdate) return;
    try {
      await api.installUpdate();
    } catch (error) {
      setToast({ kind: "error", message: describeError(error) });
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
    checkAllProfilesHealth,
    testingIds,
    probeProfile,
    deleteProfile,
    copyKey,
    openConfig,
    startGateway,
    stopGateway,
    reassignPort,
    updateSettings,
    checkForUpdate,
    downloadUpdate,
    installUpdate,
  };
}
