import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  await fs.rm(root, { recursive: true, force: true });
});

describe("旧版数据迁移", () => {
  it("同时迁移 Local State 与 data/，否则旧密文无法解密", async () => {
    await write(path.join(legacy, LOCAL_STATE_FILE), '{"os_crypt":{"encrypted_key":"LEGACY"}}');
    await write(path.join(legacy, "data", "profiles.json"), '{"version":2,"profiles":[]}');
    await write(path.join(legacy, "data", "settings.json"), '{"version":1}');

    const result = await migrateLegacyUserData(current, ["Keydeck"]);

    expect(result).toEqual({ migratedFrom: legacy, keyMigrated: true });
    // safeStorage 的主密钥必须跟着密文一起搬，这是本次迁移的核心不变式。
    expect(await read(path.join(current, LOCAL_STATE_FILE)))
      .toBe('{"os_crypt":{"encrypted_key":"LEGACY"}}');
    expect(await read(path.join(current, "data", "profiles.json")))
      .toBe('{"version":2,"profiles":[]}');
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

  it("旧目录缺少 Local State 时仍迁移数据并如实报告", async () => {
    await write(path.join(legacy, "data", "profiles.json"), '{"version":2,"profiles":[]}');

    const result = await migrateLegacyUserData(current, ["Keydeck"]);

    expect(result).toEqual({ migratedFrom: legacy, keyMigrated: false });
    expect(await read(path.join(current, "data", "profiles.json")))
      .toBe('{"version":2,"profiles":[]}');
  });
});
