import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  LOCAL_STATE_FILE,
  migrateLegacyUserData,
} = require("../electron/services/migration-service.cjs");

let root;
let current;
let legacy;

async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function read(filePath) {
  return fs.readFile(filePath, "utf8").catch(() => undefined);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "agentgate-migration-"));
  current = path.join(root, "agentgate");
  legacy = path.join(root, "Keydeck");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("旧版数据迁移", () => {
  it("同时迁移 Local State 与 data/，否则旧密文无法解密", async () => {
    await write(path.join(legacy, LOCAL_STATE_FILE), '{"os_crypt":{"encrypted_key":"LEGACY"}}');
    await write(path.join(legacy, "data", "profiles.json"), JSON.stringify({
      version: 2,
      profiles: [{ encryptedKey: "v10-ciphertext" }],
    }));
    await write(path.join(legacy, "data", "settings.json"), '{"version":1}');

    const result = await migrateLegacyUserData(current, ["Keydeck"]);

    expect(result).toEqual({ migratedFrom: legacy, keyMigrated: true });
    // safeStorage 的主密钥必须跟着密文一起搬，这是本次迁移的核心不变式。
    expect(await read(path.join(current, LOCAL_STATE_FILE)))
      .toBe('{"os_crypt":{"encrypted_key":"LEGACY"}}');
    expect(JSON.parse(await read(path.join(current, "data", "profiles.json"))).profiles[0])
      .toEqual({ encryptedKey: "v10-ciphertext" });
    expect(await read(path.join(current, "data", "settings.json"))).toBe('{"version":1}');
    // 旧目录保持不动，便于用户在迁移出问题时回退。
    expect(await read(path.join(legacy, "data", "profiles.json"))).toBeDefined();
  });

  it("当前目录已有数据时跳过迁移，不覆盖新数据", async () => {
    await write(path.join(current, "data", "profiles.json"), '{"version":2,"profiles":["new"]}');
    await write(path.join(legacy, LOCAL_STATE_FILE), '{"os_crypt":{"encrypted_key":"LEGACY"}}');
    await write(path.join(legacy, "data", "profiles.json"), '{"version":2,"profiles":["old"]}');

    expect(await migrateLegacyUserData(current, ["Keydeck"])).toBeUndefined();
    expect(await read(path.join(current, "data", "profiles.json")))
      .toBe('{"version":2,"profiles":["new"]}');
    expect(await read(path.join(current, LOCAL_STATE_FILE))).toBeUndefined();
  });

  it("没有旧目录时不做任何事", async () => {
    expect(await migrateLegacyUserData(current, ["Keydeck"])).toBeUndefined();
    expect(await read(path.join(current, "data", "profiles.json"))).toBeUndefined();
  });

  it("复制中断不提交半成品，下一次启动仍可重试", async () => {
    await write(path.join(legacy, LOCAL_STATE_FILE), '{"os_crypt":{"encrypted_key":"LEGACY"}}');
    await write(path.join(legacy, "data", "profiles.json"), '{"version":2,"profiles":[]}');
    await write(path.join(legacy, "data", "settings.json"), '{"version":1}');

    vi.spyOn(fs, "cp").mockImplementationOnce(async (source, destination) => {
      await fs.mkdir(destination, { recursive: true });
      await fs.copyFile(path.join(source, "settings.json"), path.join(destination, "settings.json"));
      throw new Error("模拟复制中断");
    });

    expect(await migrateLegacyUserData(current, ["Keydeck"])).toBeUndefined();
    expect(await read(path.join(current, "data", "settings.json"))).toBeUndefined();

    vi.restoreAllMocks();
    expect(await migrateLegacyUserData(current, ["Keydeck"])).toEqual({
      migratedFrom: legacy,
      keyMigrated: false,
    });
    expect(await read(path.join(current, "data", "profiles.json")))
      .toBe('{"version":2,"profiles":[]}');
    expect(await read(path.join(current, "data", "settings.json"))).toBe('{"version":1}');
  });

  it.each([
    ["已有当前 Local State", '{"os_crypt":{"encrypted_key":"CURRENT"}}'],
    ["当前 Local State 不存在", undefined],
  ])("data 提交失败时恢复%s", async (_label, currentLocalState) => {
    const currentLocalStateFile = path.join(current, LOCAL_STATE_FILE);
    if (currentLocalState !== undefined) await write(currentLocalStateFile, currentLocalState);
    await write(path.join(legacy, LOCAL_STATE_FILE), '{"os_crypt":{"encrypted_key":"LEGACY"}}');
    await write(path.join(legacy, "data", "profiles.json"), JSON.stringify({
      version: 2,
      profiles: [{ encryptedKey: "v10-ciphertext" }],
    }));
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("模拟 data 原子提交失败"));

    expect(await migrateLegacyUserData(current, ["Keydeck"])).toBeUndefined();

    expect(await read(currentLocalStateFile)).toBe(currentLocalState);
    expect(await read(path.join(current, "data", "profiles.json"))).toBeUndefined();
  });

  it("旧目录缺少 Local State 时仍迁移没有密钥的方案", async () => {
    const createdAt = new Date().toISOString();
    await write(path.join(legacy, "data", "profiles.json"), JSON.stringify({
      version: 1,
      profiles: [{
        id: "00000000-0000-4000-8000-000000000101",
        name: "无密钥方案",
        protocol: "anthropic",
        baseUrl: "https://legacy.example",
        model: "claude-sonnet-4-5",
        authMode: "bearer",
        targets: ["claude"],
        enableToolSearch: false,
        keyHint: "Not set",
        createdAt,
        updatedAt: createdAt,
      }],
    }));

    const result = await migrateLegacyUserData(current, ["Keydeck"]);

    expect(result).toEqual({ migratedFrom: legacy, keyMigrated: false });
    expect(JSON.parse(await read(path.join(current, "data", "profiles.json"))).profiles)
      .toHaveLength(1);
  });

  it("旧数据含加密密钥但缺少 Local State 时拒绝迁移", async () => {
    await write(path.join(legacy, "data", "profiles.json"), JSON.stringify({
      version: 2,
      profiles: [{ encryptedKey: "v10-ciphertext" }],
    }));

    expect(await migrateLegacyUserData(current, ["Keydeck"])).toBeUndefined();
    expect(await read(path.join(current, "data", "profiles.json"))).toBeUndefined();
    expect(await read(path.join(legacy, "data", "profiles.json"))).toBeDefined();
  });

  it("旧备份含加密内容但缺少 Local State 时拒绝迁移", async () => {
    await write(path.join(legacy, "data", "profiles.json"), '{"version":2,"profiles":[]}');
    await write(path.join(legacy, "data", "backups", "rollback.json"), JSON.stringify({
      version: 1,
      files: [{ path: "config.toml", existed: true, encryptedContent: "v10-backup" }],
    }));

    expect(await migrateLegacyUserData(current, ["Keydeck"])).toBeUndefined();
    expect(await read(path.join(current, "data", "profiles.json"))).toBeUndefined();
    expect(await read(path.join(legacy, "data", "backups", "rollback.json"))).toBeDefined();
  });

  it("旧网关令牌含密文但缺少 Local State 时拒绝迁移", async () => {
    await write(path.join(legacy, "data", "profiles.json"), '{"version":2,"profiles":[]}');
    await write(path.join(legacy, "data", "gateway.json"), JSON.stringify({
      version: 3,
      enabled: true,
      port: 17863,
      targets: ["codex"],
      engaged: ["codex"],
      routes: {},
      encryptedToken: "v10-local-token",
    }));

    expect(await migrateLegacyUserData(current, ["Keydeck"])).toBeUndefined();
    expect(await read(path.join(current, "data", "gateway.json"))).toBeUndefined();
  });

  it("回滚不覆盖 Local State 的并发修改", async () => {
    const currentLocalStateFile = path.join(current, LOCAL_STATE_FILE);
    const concurrentState = '{"os_crypt":{"encrypted_key":"CONCURRENT"}}';
    await write(currentLocalStateFile, '{"os_crypt":{"encrypted_key":"CURRENT"}}');
    await write(path.join(legacy, LOCAL_STATE_FILE), '{"os_crypt":{"encrypted_key":"LEGACY"}}');
    await write(path.join(legacy, "data", "profiles.json"), JSON.stringify({
      version: 2,
      profiles: [{ encryptedKey: "v10-ciphertext" }],
    }));
    vi.spyOn(fs, "rename").mockImplementationOnce(async () => {
      await fs.writeFile(currentLocalStateFile, concurrentState, "utf8");
      throw new Error("模拟提交窗口并发修改");
    });

    expect(await migrateLegacyUserData(current, ["Keydeck"])).toBeUndefined();
    expect(await read(currentLocalStateFile)).toBe(concurrentState);
  });
});
