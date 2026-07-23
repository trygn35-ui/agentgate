import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  RELEASE_DOWNLOAD_URL,
  UpdateService,
} = require("../electron/services/update-service.cjs");

function createUpdater() {
  const updater = new EventEmitter();
  updater.checkForUpdates = vi.fn(async () => undefined);
  updater.downloadUpdate = vi.fn(async () => undefined);
  updater.quitAndInstall = vi.fn();
  return updater;
}

function createService({ portable = false, updater = createUpdater(), shell } = {}) {
  const app = { getVersion: () => "1.6.4", isPackaged: true };
  return {
    service: new UpdateService({ app, portable, updater, shell }),
    updater,
  };
}

describe("UpdateService", () => {
  it("便携版始终打开官方 Releases 页面", async () => {
    const shell = { openExternal: vi.fn(async () => undefined) };
    const { service, updater } = createService({ portable: true, shell });
    updater.emit("update-available", { version: "1.7.0" });

    await expect(service.download()).resolves.toMatchObject({
      state: "available",
      releaseUrl: RELEASE_DOWNLOAD_URL,
    });
    expect(shell.openExternal).toHaveBeenCalledWith(RELEASE_DOWNLOAD_URL);
  });

  it("下载期间拒绝重复下载和重新检查", async () => {
    let finishDownload;
    const updater = createUpdater();
    updater.downloadUpdate.mockImplementation(() => new Promise((resolve) => {
      finishDownload = resolve;
    }));
    const { service } = createService({ updater });
    updater.emit("update-available", { version: "1.7.0" });

    const first = service.download();
    await expect(service.download()).resolves.toMatchObject({ state: "downloading" });
    await expect(service.check()).resolves.toMatchObject({ state: "downloading" });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();

    finishDownload();
    await first;
  });

  it("安装器抛错时回报失败，让主进程走普通退出兜底", () => {
    const updater = createUpdater();
    updater.quitAndInstall.mockImplementation(() => {
      throw new Error("installer unavailable");
    });
    const { service } = createService({ updater });

    updater.emit("update-downloaded", { version: "1.7.0" });
    expect(service.quitAndInstall()).toBe(false);
  });
});
