import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestStores, testVault } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { ProfileService } = require("../electron/services/profile-service.cjs");

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "keydeck-profile-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("方案服务", () => {
  it("仅在连接参数未变化时保留健康状态", async () => {
    const { profileStore } = createTestStores(root);
    const service = new ProfileService(profileStore, testVault);
    const created = await service.save({
      name: "健康状态夹具",
      protocol: "anthropic",
      baseUrl: "https://relay.example",
      apiKey: "sk-health-secret",
      model: "claude-sonnet-4-5",
      authMode: "bearer",
      targets: ["claude"],
    });
    const health = {
      status: "healthy",
      latencyMs: 120,
      checkedAt: new Date().toISOString(),
      statusCode: 200,
      message: "连接正常",
    };
    await service.updateHealth(created.id, health);

    const preserved = await service.save({
      id: created.id,
      name: "只改名称",
      protocol: "anthropic",
      baseUrl: "https://relay.example",
      model: "claude-opus-4-1",
      authMode: "bearer",
      targets: ["claude"],
    });
    expect(preserved.health).toEqual(health);

    const invalidated = await service.save({
      id: created.id,
      name: "切换端点",
      protocol: "anthropic",
      baseUrl: "https://another-relay.example",
      model: "claude-opus-4-1",
      authMode: "bearer",
      targets: ["claude"],
    });
    expect(invalidated.health).toBeUndefined();
  });

  it("修改名称或自动切换计划不会使已写配置的连接 revision 失效", async () => {
    const { profileStore } = createTestStores(root);
    const service = new ProfileService(profileStore, testVault);
    const created = await service.save({
      name: "计划前",
      protocol: "openai-responses",
      baseUrl: "https://relay.example/v1",
      endpoints: [
        { url: "https://relay.example/v1" },
        { url: "https://backup.example/v1" },
      ],
      apiKey: "sk-schedule-secret",
      model: "gpt-5.2-codex",
      authMode: "bearer",
      targets: ["codex"],
      autoSwitch: { enabled: false, intervalMinutes: 5 },
    });
    const before = await service.getStored(created.id);

    await service.save({
      id: created.id,
      name: "计划后",
      protocol: created.protocol,
      baseUrl: created.baseUrl,
      endpoints: created.endpoints.map(({ url }) => ({ url })),
      model: created.model,
      authMode: created.authMode,
      targets: created.targets,
      enableToolSearch: created.enableToolSearch,
      autoSwitch: { enabled: true, intervalMinutes: 15 },
    });

    const after = await service.getStored(created.id);
    expect(after.connectionRevision).toBe(before.connectionRevision);
    expect(after.name).toBe("计划后");
    expect(after.autoSwitch).toEqual({ enabled: true, intervalMinutes: 15 });
  });

  it("把旧版单 URL 存储安全迁移为 URL 池", async () => {
    const profilePath = path.join(root, "data", "profiles.json");
    const createdAt = new Date().toISOString();
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await fs.writeFile(profilePath, `${JSON.stringify({
      version: 1,
      profiles: [{
        id: "00000000-0000-4000-8000-000000000101",
        name: "旧版方案",
        protocol: "anthropic",
        baseUrl: "https://legacy.example",
        model: "claude-sonnet-4-5",
        authMode: "bearer",
        targets: ["claude"],
        enableToolSearch: true,
        keyHint: "****cret",
        encryptedKey: testVault.encrypt("sk-legacy-secret"),
        createdAt,
        updatedAt: createdAt,
      }],
    }, null, 2)}\n`, "utf8");

    const { profileStore } = createTestStores(root);
    const service = new ProfileService(profileStore, testVault);
    const [migrated] = await service.list();

    expect(migrated.endpoints).toEqual([{
      url: "https://legacy.example",
      models: [],
      healthHistory: [],
      healthTimeline: [],
    }]);
    expect(migrated.autoSwitch).toEqual({ enabled: false, intervalMinutes: 2 });
    expect(await service.getSecret(migrated.id)).toBe("sk-legacy-secret");

    await service.save({
      id: migrated.id,
      name: "迁移后方案",
      protocol: migrated.protocol,
      baseUrl: migrated.baseUrl,
      endpoints: migrated.endpoints.map(({ url }) => ({ url })),
      model: migrated.model,
      authMode: migrated.authMode,
      targets: migrated.targets,
      enableToolSearch: migrated.enableToolSearch,
      autoSwitch: migrated.autoSwitch,
    });
    expect(JSON.parse(await fs.readFile(profilePath, "utf8")).version).toBe(2);
  });

  it("在主进程内复制方案和 Key，并重置运行时状态", async () => {
    const { profileStore } = createTestStores(root);
    const service = new ProfileService(profileStore, testVault);
    const source = await service.save({
      name: "主方案",
      protocol: "openai-responses",
      baseUrl: "https://primary.example/v1",
      endpoints: [
        { url: "https://primary.example/v1" },
        { url: "https://backup.example/v1" },
      ],
      apiKey: "sk-copy-secret",
      model: "gpt-5.2-codex",
      authMode: "bearer",
      targets: ["codex"],
      autoSwitch: { enabled: true, intervalMinutes: 15 },
    });
    const stored = await service.getStored(source.id);
    await service.updateEndpointResults(source.id, stored.endpoints.map((endpoint, index) => ({
      url: endpoint.url,
      models: ["gpt-5.2-codex"],
      health: {
        status: "healthy",
        latencyMs: 100 + index * 50,
        checkedAt: new Date().toISOString(),
        statusCode: 200,
        message: "连接正常",
      },
    })), stored.connectionRevision);
    await service.markApplied(source.id, new Date().toISOString());

    const duplicate = await service.duplicate(source.id);
    expect(duplicate.name).toBe("主方案 副本");
    expect(duplicate.id).not.toBe(source.id);
    expect(duplicate.endpoints).toEqual([
      { url: "https://primary.example/v1", models: [], healthHistory: [], healthTimeline: [] },
      { url: "https://backup.example/v1", models: [], healthHistory: [], healthTimeline: [] },
    ]);
    expect(duplicate.autoSwitch).toEqual({ enabled: false, intervalMinutes: 15 });
    expect(duplicate.lastAppliedAt).toBeUndefined();
    expect(duplicate.health).toBeUndefined();
    expect(duplicate.encryptedKey).toBeUndefined();
    expect(await service.getSecret(duplicate.id)).toBe("sk-copy-secret");
    expect(await fs.readFile(path.join(root, "data", "profiles.json"), "utf8"))
      .not.toContain("sk-copy-secret");
  });

  it("规范化路径尾斜杠但保留查询参数和路径大小写", async () => {
    const { profileStore } = createTestStores(root);
    const service = new ProfileService(profileStore, testVault);
    const saved = await service.save({
      name: "URL 规范化",
      protocol: "openai-chat",
      baseUrl: "https://EXAMPLE.com/API/?prefix=/",
      endpoints: [
        { url: "https://EXAMPLE.com/API/?prefix=/" },
        { url: "https://example.com/api/?prefix=/" },
      ],
      apiKey: "sk-url-secret",
      model: "gpt-test",
      authMode: "bearer",
      targets: ["codex"],
    });

    expect(saved.baseUrl).toBe("https://example.com/API?prefix=/");
    expect(saved.endpoints.map((endpoint) => endpoint.url)).toEqual([
      "https://example.com/API?prefix=/",
      "https://example.com/api?prefix=/",
    ]);
    await expect(service.save({
      id: saved.id,
      name: saved.name,
      protocol: saved.protocol,
      baseUrl: "https://user:secret@example.com/API#fragment",
      endpoints: [{ url: "https://user:secret@example.com/API#fragment" }],
      model: saved.model,
      authMode: saved.authMode,
      targets: saved.targets,
    })).rejects.toThrow("cannot contain credentials or fragments");
  });
});

describe("Token 用量统计", () => {
  it("按请求累计总量、输入与缓存命中", async () => {
    const { profileStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const created = await profileService.save({
      name: "统计方案",
      protocol: "openai-responses",
      baseUrl: "https://usage.example/v1",
      apiKey: "sk-usage-secret",
      model: "gpt-5-codex",
      authMode: "bearer",
      targets: ["codex"],
    });

    await profileService.addTokenUsage(created.id, {
      totalTokens: 1_000,
      inputTokens: 900,
      cachedTokens: 700,
    });
    await profileService.addTokenUsage(created.id, {
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 50,
    });
    await profileService.addTokenUsage(created.id, undefined);
    await profileService.addTokenUsage("not-a-uuid", { totalTokens: 5 });

    const [profile] = await profileService.list();
    expect(profile.tokenUsageTotal).toBe(1_120);
    expect(profile.tokenInputTotal).toBe(1_000);
    expect(profile.tokenCachedTotal).toBe(750);
  });
});

describe("当日 Token 统计", () => {
  it("同日累加，跨日归零", async () => {
    const { profileStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const created = await profileService.save({
      name: "当日统计",
      protocol: "openai-responses",
      baseUrl: "https://day.example/v1",
      apiKey: "sk-day-secret",
      model: "gpt-5-codex",
      authMode: "bearer",
      targets: ["codex"],
    });

    await profileService.addTokenUsage(created.id, { totalTokens: 1_000 });
    await profileService.addTokenUsage(created.id, { totalTokens: 500 });

    let [profile] = await profileService.list();
    expect(profile.tokenUsageToday).toBe(1_500);
    expect(profile.tokenUsageTotal).toBe(1_500);

    // 模拟跨日：把日期键改成昨天，下一次记账应从 0 起算
    const data = await profileStore.read();
    data.profiles[0].tokenDayKey = "2020-01-01";
    await profileStore.write(data);

    await profileService.addTokenUsage(created.id, { totalTokens: 200 });

    [profile] = await profileService.list();
    expect(profile.tokenUsageToday).toBe(200);
    expect(profile.tokenUsageTotal).toBe(1_700);
  });
});
