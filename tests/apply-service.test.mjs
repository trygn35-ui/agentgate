import fs from "node:fs/promises";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestStores, testVault } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const TOML = require("@iarna/toml");
const { ProfileService } = require("../electron/services/profile-service.cjs");
const {
  ApplyService,
  GatewayBaselineStoreSchema,
  defaultGatewayBaselineStore,
} = require("../electron/services/apply-service.cjs");
const { createAdapters } = require("../electron/services/adapters.cjs");
const { JsonFileStore } = require("../electron/services/storage.cjs");
const {
  GatewayService,
  GatewayStoreSchema,
  defaultGatewayStore,
} = require("../electron/services/gateway-service.cjs");

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "keydeck-apply-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("transactional apply", () => {
  it("Codex URL-only 接管保存完整密文备份并在验证后删除基线", async () => {
    const codexPath = path.join(root, ".codex", "config.toml");
    const recoveryPath = path.join(root, "data", "gateway-recovery.json");
    const original = `model_provider = "custom"
model = "user-model"
approval_policy = "on-request"

[model_providers.custom]
name = "Custom"
base_url = "https://custom.example/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "user-auth"

[mcp_servers.demo]
command = "node"
`;
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, original, "utf8");

    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const gatewayStore = new JsonFileStore(
      path.join(root, "data", "gateway.json"),
      GatewayStoreSchema,
      defaultGatewayStore,
    );
    const gatewayBaselineStore = new JsonFileStore(
      recoveryPath,
      GatewayBaselineStoreSchema,
      defaultGatewayBaselineStore,
    );
    const gatewayService = new GatewayService({ profileService, store: gatewayStore, vault: testVault });
    const adapters = createAdapters({
      claude: { config: path.join(root, ".claude", "settings.json") },
      codex: { config: codexPath },
      opencode: {
        config: path.join(root, ".config", "opencode", "opencode.json"),
        auth: path.join(root, ".local", "share", "opencode", "auth.json"),
      },
      gemini: {
        config: path.join(root, ".gemini", "settings.json"),
        env: path.join(root, ".gemini", ".env"),
      },
    });
    const applyService = new ApplyService({
      profileService,
      adapters,
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
      gatewayService,
      gatewayBaselineStore,
    });
    const profileA = await profileService.save({
      name: "网关 A",
      protocol: "openai-responses",
      baseUrl: "https://relay-a.example/v1",
      apiKey: "sk-upstream-a",
      model: "ignored-model-a",
      authMode: "bearer",
      targets: ["codex"],
    });
    const profileB = await profileService.save({
      name: "网关 B",
      protocol: "openai-responses",
      baseUrl: "https://relay-b.example/v1",
      apiKey: "sk-upstream-b",
      model: "ignored-model-b",
      authMode: "bearer",
      targets: ["codex"],
    });
    await applyService.assignProfile(profileA.id, ["codex"]);

    try {
      await applyService.startGateway({ port: 0 });
      const localBaseUrl = gatewayService.getPublicState().localBaseUrls.codex;
      expect(localBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/codex\/[A-Za-z0-9_-]{40,}$/);
      const takenOver = await fs.readFile(codexPath, "utf8");
      const parsed = TOML.parse(takenOver);
      expect(parsed.model_provider).toBe("custom");
      expect(parsed.model).toBe("user-model");
      expect(parsed.model_providers.custom).toMatchObject({
        base_url: localBaseUrl,
        wire_api: "responses",
        requires_openai_auth: true,
        experimental_bearer_token: "user-auth",
      });
      expect(parsed.model_providers.keydeck_gateway).toBeUndefined();
      expect(takenOver).not.toContain("sk-upstream-a");

      const recovery = await gatewayBaselineStore.read();
      expect(recovery.version).toBe(2);
      const baseline = recovery.baselines.codex;
      expect(JSON.parse(testVault.decrypt(baseline.encryptedState))).toEqual({
        providerId: "custom",
        wireApi: "responses",
        baseUrl: { present: true, value: "https://custom.example/v1" },
      });
      expect(JSON.parse(testVault.decrypt(baseline.encryptedBackup))).toEqual({
        files: [{ path: codexPath, existed: true, content: original }],
      });
      expect(await fs.readFile(recoveryPath, "utf8")).not.toContain("https://custom.example/v1");

      const runtimeEdit = takenOver
        .replace('model = "user-model"', 'model = "runtime-model"')
        .replace('experimental_bearer_token = "user-auth"', 'experimental_bearer_token = "runtime-auth"');
      await fs.writeFile(codexPath, runtimeEdit, "utf8");
      await applyService.assignProfile(profileB.id, ["codex"]);
      expect(await fs.readFile(codexPath, "utf8")).toBe(runtimeEdit);

      const runtimeWireEdit = runtimeEdit.replace('wire_api = "responses"', 'wire_api = "chat"');
      await fs.writeFile(codexPath, runtimeWireEdit, "utf8");
      await expect(applyService.assignProfile(profileA.id, ["codex"]))
        .rejects.toThrow("wire_api=chat");

      await applyService.stopGateway();
      const restored = TOML.parse(await fs.readFile(codexPath, "utf8"));
      expect(restored.model_provider).toBe("custom");
      expect(restored.model).toBe("runtime-model");
      expect(restored.model_providers.custom).toMatchObject({
        base_url: "https://custom.example/v1",
        wire_api: "chat",
        experimental_bearer_token: "runtime-auth",
      });
      expect((await gatewayBaselineStore.read()).baselines).toEqual({});
    } finally {
      await gatewayService.stopAndWait().catch(() => {});
    }
  });

  it.skip("旧版多字段 Codex 接管生命周期（已由 URL-only 用例替代）", async () => {
    const codexPath = path.join(root, ".codex", "config.toml");
    const original = `# 用户自己的 Codex 配置\r\napproval_policy = "on-request"\r\nsandbox_mode = "workspace-write"\r\nmodel_provider = "custom"\r\n\r\n[features]\r\nweb_search_request = true\r\n\r\n[mcp_servers.demo]\r\ncommand = "node"\r\nargs = ["server.js"]\r\n\r\n[model_providers.custom]\r\nname = "Custom"\r\nbase_url = "https://custom.example/v1"\r\nwire_api = "responses"\r\n`;
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, original, "utf8");

    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const gatewayStore = new JsonFileStore(
      path.join(root, "data", "gateway.json"),
      GatewayStoreSchema,
      defaultGatewayStore,
    );
    const gatewayBaselineStore = new JsonFileStore(
      path.join(root, "data", "gateway-recovery.json"),
      GatewayBaselineStoreSchema,
      defaultGatewayBaselineStore,
    );
    const gatewayService = new GatewayService({
      profileService,
      store: gatewayStore,
      vault: testVault,
    });
    const adapters = createAdapters({
      claude: { config: path.join(root, ".claude", "settings.json") },
      codex: { config: codexPath },
      opencode: {
        config: path.join(root, ".config", "opencode", "opencode.json"),
        auth: path.join(root, ".local", "share", "opencode", "auth.json"),
      },
      gemini: {
        config: path.join(root, ".gemini", "settings.json"),
        env: path.join(root, ".gemini", ".env"),
      },
    });
    const applyService = new ApplyService({
      profileService,
      adapters,
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
      gatewayService,
      gatewayBaselineStore,
    });
    const profileA = await profileService.save({
      name: "网关 A",
      protocol: "openai-responses",
      baseUrl: "https://relay-a.example/v1",
      apiKey: "sk-upstream-a",
      model: "gpt-5.2-codex",
      authMode: "bearer",
      targets: ["codex"],
    });
    const profileB = await profileService.save({
      name: "网关 B",
      protocol: "openai-responses",
      baseUrl: "https://relay-b.example/v1",
      apiKey: "sk-upstream-b",
      model: "gpt-5.2-codex",
      authMode: "bearer",
      targets: ["codex"],
    });
    await applyService.assignProfile(profileA.id, ["codex"]);

    try {
      await applyService.startGateway({ port: 0 });
      const takenOver = await fs.readFile(codexPath, "utf8");
      expect(takenOver).toContain('model_provider = "keydeck_gateway"');
      expect(takenOver).toContain("[model_providers.keydeck_gateway]");
      expect(takenOver).not.toContain("sk-upstream-a");
      expect(takenOver).toContain("[mcp_servers.demo]");
      expect(takenOver).toContain('approval_policy = "on-request"');
      const encryptedRecovery = await fs.readFile(
        path.join(root, "data", "gateway-recovery.json"),
        "utf8",
      );
      expect(encryptedRecovery).not.toContain('model_provider = "custom"');
      expect(encryptedRecovery).not.toContain("https://custom.example/v1");

      const userEdit = `${takenOver}\r\n[projects."D:\\\\Work"]\r\ntrust_level = "trusted"\r\n`;
      await fs.writeFile(codexPath, userEdit, "utf8");
      const switched = await applyService.assignProfile(profileB.id, ["codex"]);
      expect(await fs.readFile(codexPath, "utf8")).toBe(userEdit);
      expect(switched.assignedTargets).toEqual(["codex"]);

      const userReleased = `${original.replace(
        'model_provider = "custom"',
        'model_provider = "custom"\r\nmodel = "user-selected-model"',
      )}\r\n[projects."D:\\\\Work"]\r\ntrust_level = "trusted"\r\n`;
      await fs.writeFile(codexPath, userReleased, "utf8");
      await applyService.assignProfile(profileB.id, ["codex"]);
      const reassignedGateway = await fs.readFile(codexPath, "utf8");
      expect(reassignedGateway).toContain('model_provider = "keydeck_gateway"');
      expect(reassignedGateway).not.toContain('model = "user-selected-model"');

      const gatewayWithExtensions = reassignedGateway
        .replace(
          'experimental_bearer_token = "',
          '# 用户添加的网关注释\r\nrequest_max_retries = 9\r\nexperimental_bearer_token = "',
        );
      await fs.writeFile(codexPath, gatewayWithExtensions, "utf8");

      await applyService.stopGateway();
      const direct = await fs.readFile(codexPath, "utf8");
      expect(direct).toContain('model_provider = "custom"');
      expect(direct).toContain('model = "user-selected-model"');
      expect(direct).toContain('base_url = "https://custom.example/v1"');
      expect(direct).not.toContain("[model_providers.keydeck_gateway]");
      expect(direct).not.toContain("sk-upstream-b");
      expect(direct).toContain('[projects."D:\\\\Work"]');
      expect(direct).toContain('trust_level = "trusted"');
      expect(direct).toContain("[mcp_servers.demo]");
      expect(direct).toContain('sandbox_mode = "workspace-write"');
      expect(gatewayService.getPublicState().status).toBe("stopped");

      await applyService.startGateway({ port: 0 });
      const gatewayAgain = await fs.readFile(codexPath, "utf8");
      const driftGatewayProvider = (pattern, replacement) => gatewayAgain.replace(
        /(\[model_providers\.keydeck_gateway\][\s\S]*?)(?=\r?\n\[|$)/,
        (section) => section.replace(pattern, replacement),
      );
      for (const conflicted of [
        gatewayAgain.replace('model = "gpt-5.2-codex"', 'model = "runtime-selected-model"'),
        driftGatewayProvider(
          /experimental_bearer_token = "[^"]+"/,
          'experimental_bearer_token = "changed-local-token"',
        ),
        driftGatewayProvider('wire_api = "responses"', 'wire_api = "chat"'),
      ]) {
        await fs.writeFile(codexPath, conflicted, "utf8");
        await expect(applyService.stopGateway())
          .rejects.toThrow("Local gateway configuration conflict for codex");
        expect(await fs.readFile(codexPath, "utf8")).toBe(conflicted);
        expect(gatewayService.getPublicState().status).toBe("running");
        expect(gatewayService.getPublicState().routes).toEqual([
          { target: "codex", profileId: profileB.id },
        ]);
        await fs.writeFile(codexPath, gatewayAgain, "utf8");
      }
      const userOwned = gatewayAgain.replace(
        'model_provider = "keydeck_gateway"',
        'model_provider = "custom"',
      );
      await fs.writeFile(codexPath, userOwned, "utf8");
      const skippedStop = await applyService.stopGateway();
      expect(skippedStop.skippedTargets).toEqual(["codex"]);
      expect(await fs.readFile(codexPath, "utf8")).toBe(userOwned);
      expect(gatewayService.getPublicState().routes).toEqual([
        { target: "codex", profileId: profileB.id },
      ]);

      await applyService.assignProfile(profileB.id, ["codex"]);
      await applyService.startGateway({ port: 0 });
      const [concurrentStop] = await Promise.all([
        applyService.stopGateway(),
        applyService.assignProfile(profileA.id, ["codex"]),
      ]);
      const afterConcurrentApply = await fs.readFile(codexPath, "utf8");
      expect(concurrentStop.skippedTargets).toEqual([]);
      expect(afterConcurrentApply).toContain('model_provider = "custom"');
      expect(afterConcurrentApply).toContain('base_url = "https://custom.example/v1"');
      expect(adapters.codex.inspect(new Map([[codexPath, afterConcurrentApply]])).baseUrl)
        .toBe("https://custom.example/v1");
      expect(gatewayService.getPublicState().status).toBe("stopped");

      await applyService.assignProfile(profileB.id, ["codex"]);
      await applyService.startGateway({ port: 0 });
      await gatewayService.shutdown();
      expect(gatewayService.getPublicState().routes).toEqual([
        { target: "codex", profileId: profileB.id },
      ]);
      const stoppedWithoutListener = await applyService.stopGateway();
      const recoveredWithoutListener = await fs.readFile(codexPath, "utf8");
      expect(stoppedWithoutListener.skippedTargets).toEqual([]);
      expect(adapters.codex.inspect(new Map([[codexPath, recoveredWithoutListener]])).baseUrl)
        .toBe("https://custom.example/v1");
      expect(gatewayService.getPublicState().routes).toEqual([
        { target: "codex", profileId: profileB.id },
      ]);

      await applyService.startGateway({ port: 0 });
      const originalOwnership = adapters.codex.gatewayOwnership.bind(adapters.codex);
      let injectedUnrelatedEdit = false;
      let ownershipChecks = 0;
      adapters.codex.gatewayOwnership = async (...args) => {
        const state = await originalOwnership(...args);
        ownershipChecks += 1;
        if (!injectedUnrelatedEdit && ownershipChecks === 1) {
          injectedUnrelatedEdit = true;
          await fs.appendFile(
            codexPath,
            "\r\n[projects.concurrent]\r\ntrust_level = \"trusted\" # ownership 检查后的用户注释\r\n",
            "utf8",
          );
        }
        return state;
      };
      const retriedStop = await applyService.stopGateway();
      const retriedDirect = await fs.readFile(codexPath, "utf8");
      expect(retriedStop.skippedTargets).toEqual([]);
      expect(retriedDirect).toContain('model_provider = "custom"');
      expect(retriedDirect).toContain("# ownership 检查后的用户注释");

      await applyService.startGateway({ port: 0 });
      adapters.codex.gatewayOwnership = async (...args) => {
        const state = await originalOwnership(...args);
        await fs.appendFile(codexPath, "\r\n# 持续并发修改\r\n", "utf8");
        return state;
      };
      await expect(applyService.stopGateway())
        .rejects.toThrow("Configuration kept changing while stopping the gateway: codex");
      expect(gatewayService.getPublicState().status).toBe("running");
      expect(adapters.codex.inspect(new Map([[codexPath, await fs.readFile(codexPath, "utf8")]])).baseUrl)
        .toMatch(/^http:\/\/127\.0\.0\.1:/);
      adapters.codex.gatewayOwnership = originalOwnership;
      await applyService.stopGateway();

      await applyService.startGateway({ port: 0 });
      let injectedConcurrentEdit = false;
      adapters.codex.gatewayOwnership = async (...args) => {
        const state = await originalOwnership(...args);
        if (!injectedConcurrentEdit) {
          injectedConcurrentEdit = true;
          const source = await fs.readFile(codexPath, "utf8");
          await fs.writeFile(
            codexPath,
            source.replace(
              'model_provider = "keydeck_gateway"',
              'model_provider = "custom"',
            ),
            "utf8",
          );
        }
        return state;
      };
      const racedStop = await applyService.stopGateway();
      const racedUserConfig = await fs.readFile(codexPath, "utf8");
      expect(racedStop.skippedTargets).toEqual(["codex"]);
      expect(racedUserConfig).toContain('model_provider = "custom"');
      expect(racedUserConfig).toContain('base_url = "http://127.0.0.1:');
      adapters.codex.gatewayOwnership = originalOwnership;

      await applyService.startGateway({ port: 0 });
      const orphanedGatewayConfig = await fs.readFile(codexPath, "utf8");
      await profileService.delete(profileB.id);
      await expect(applyService.stopGateway())
        .rejects.toThrow(`routed profile ${profileB.id} is unavailable`);
      expect(await fs.readFile(codexPath, "utf8")).toBe(orphanedGatewayConfig);
      expect(gatewayService.getPublicState().status).toBe("running");
      expect(gatewayService.getPublicState().routes).toEqual([
        { target: "codex", profileId: profileB.id },
      ]);
    } finally {
      await gatewayService.stopAndWait().catch(() => {});
    }
  });

  it("applies a profile, returns no secret, and restores the exact original on undo", async () => {
    const codexPath = path.join(root, ".codex", "config.toml");
    const original = `# 用户配置
approval_policy = "on-request"

[mcp_servers.demo]
command = "node"
`;
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, original, "utf8");

    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const adapters = createAdapters({
      claude: { config: path.join(root, ".claude", "settings.json") },
      codex: { config: codexPath },
      opencode: {
        config: path.join(root, ".config", "opencode", "opencode.json"),
        auth: path.join(root, ".local", "share", "opencode", "auth.json"),
      },
      gemini: {
        config: path.join(root, ".gemini", "settings.json"),
        env: path.join(root, ".gemini", ".env"),
      },
    });
    const applyService = new ApplyService({
      profileService,
      adapters,
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
    });

    const publicProfile = await profileService.save({
      name: "Codex fixture",
      protocol: "openai-responses",
      baseUrl: "https://codex-relay.example/v1",
      apiKey: "sk-super-secret",
      model: "gpt-5.2-codex",
      authMode: "bearer",
      targets: ["codex"],
    });
    expect(JSON.stringify(publicProfile)).not.toContain("sk-super-secret");
    expect(publicProfile.encryptedKey).toBeUndefined();

    const revision = (await profileService.getStored(publicProfile.id)).connectionRevision;
    const applied = await applyService.apply(
      publicProfile.id,
      undefined,
      { expectedRevision: revision },
    );
    const live = await fs.readFile(codexPath, "utf8");
    expect(live).toContain("sk-super-secret");
    expect(live).toContain("[mcp_servers.demo]");
    expect(JSON.stringify(applied.history)).not.toContain("sk-super-secret");
    expect(applied.history.canUndo).toBe(true);
    const verifiedState = await applyService.getVerifiedWriteState(publicProfile.id);
    expect(verifiedState.targets).toEqual(["codex"]);

    await fs.writeFile(
      codexPath,
      live.replace("sk-super-secret", "sk-external-secret"),
      "utf8",
    );
    expect(await applyService.listVerifiedTargets(publicProfile.id)).toEqual([]);
    await expect(applyService.apply(publicProfile.id, ["codex"], {
      source: "auto",
      expectedRevision: revision,
      expectedHashes: verifiedState.hashes,
    })).rejects.toThrow("no longer matches the last Keydeck write");
    await fs.writeFile(codexPath, live, "utf8");

    await applyService.undo(applied.history.id);
    expect(await fs.readFile(codexPath, "utf8")).toBe(original);
    const history = await applyService.listHistory();
    expect(history[0].canUndo).toBe(false);

    await profileService.save({
      id: publicProfile.id,
      name: publicProfile.name,
      protocol: publicProfile.protocol,
      baseUrl: publicProfile.baseUrl,
      endpoints: publicProfile.endpoints.map(({ url }) => ({ url })),
      model: "gpt-new-model",
      authMode: publicProfile.authMode,
      targets: publicProfile.targets,
      autoSwitch: publicProfile.autoSwitch,
    });
    await expect(applyService.apply(
      publicProfile.id,
      undefined,
      { expectedRevision: revision },
    )).rejects.toThrow("Profile connection changed before configuration could be written");
    expect(await fs.readFile(codexPath, "utf8")).toBe(original);
  });

  it("marks an older overlapping write as superseded", async () => {
    const { historyStore } = createTestStores(root);
    const applyService = new ApplyService({
      profileService: {},
      adapters: {},
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
    });
    const filePath = path.join(root, ".codex", "config.toml");
    const profileId = crypto.randomUUID();
    const createHistory = (source) => ({
      id: crypto.randomUUID(),
      profileId,
      profileName: "历史夹具",
      targets: ["codex"],
      createdAt: new Date().toISOString(),
      status: "applied",
      source,
      changes: [{
        target: "codex",
        path: filePath,
        existed: true,
        beforeHash: "before",
        afterHash: "after",
      }],
      backupFile: path.join(root, "data", "backups", `${crypto.randomUUID()}.json`),
    });
    const older = createHistory("manual");
    const latest = createHistory("auto");

    await applyService.saveHistory(older);
    await applyService.saveHistory(latest);
    await applyService.supersedeOlderHistory(latest.id, [filePath]);

    const history = await applyService.listHistory();
    expect(history[0]).toMatchObject({ id: latest.id, canUndo: true, source: "auto" });
    expect(history[1]).toMatchObject({ id: older.id, canUndo: false, success: true });
  });

  it("仅允许当前连接 revision 的成功历史授权自动写入", async () => {
    const codexPath = path.join(root, ".codex", "config.toml");
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, "model = \"fixture\"\n", "utf8");

    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const applyService = new ApplyService({
      profileService,
      adapters: createAdapters({
        claude: { config: path.join(root, ".claude", "settings.json") },
        codex: { config: codexPath },
        opencode: {
          config: path.join(root, ".config", "opencode", "opencode.json"),
          auth: path.join(root, ".local", "share", "opencode", "auth.json"),
        },
        gemini: {
          config: path.join(root, ".gemini", "settings.json"),
          env: path.join(root, ".gemini", ".env"),
        },
      }),
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
    });
    const created = await profileService.save({
      name: "revision 夹具",
      protocol: "openai-responses",
      baseUrl: "https://revision.example/v1",
      apiKey: "sk-revision-one",
      model: "gpt-revision-one",
      authMode: "bearer",
      targets: ["codex"],
    });
    const revisionN = (await profileService.getStored(created.id)).connectionRevision;
    await applyService.apply(created.id, ["codex"], { expectedRevision: revisionN });
    const appliedContent = await fs.readFile(codexPath, "utf8");
    expect((await applyService.getVerifiedWriteState(created.id)).targets).toEqual(["codex"]);

    await profileService.save({
      id: created.id,
      name: "revision 夹具（已启用自动择优）",
      protocol: created.protocol,
      baseUrl: created.baseUrl,
      endpoints: created.endpoints.map(({ url }) => ({ url })),
      model: created.model,
      authMode: created.authMode,
      targets: created.targets,
      enableToolSearch: created.enableToolSearch,
      autoSwitch: { enabled: true, intervalMinutes: 15 },
    });
    expect((await profileService.getStored(created.id)).connectionRevision).toBe(revisionN);
    expect((await applyService.getVerifiedWriteState(created.id)).targets).toEqual(["codex"]);

    const legacyData = await historyStore.read();
    delete legacyData.entries[0].appliedConnectionRevision;
    await historyStore.write(legacyData);
    expect((await applyService.getVerifiedWriteState(created.id)).targets).toEqual([]);

    legacyData.entries[0].appliedConnectionRevision = revisionN;
    await historyStore.write(legacyData);
    await profileService.save({
      id: created.id,
      name: "revision 夹具已更新",
      protocol: created.protocol,
      baseUrl: created.baseUrl,
      endpoints: created.endpoints.map(({ url }) => ({ url })),
      apiKey: "sk-revision-two",
      model: "gpt-revision-two",
      authMode: created.authMode,
      targets: created.targets,
      autoSwitch: created.autoSwitch,
    });

    const revisionNPlusOne = (await profileService.getStored(created.id)).connectionRevision;
    expect(revisionNPlusOne).toBe(revisionN + 1);
    expect(await fs.readFile(codexPath, "utf8")).toBe(appliedContent);
    expect((await applyService.getVerifiedWriteState(created.id)).targets).toEqual([]);
  });

  it("自动写入开始后收到停止信号会完整回滚已写文件", async () => {
    const firstPath = path.join(root, "configs", "first.txt");
    const secondPath = path.join(root, "configs", "second.txt");
    const firstOriginal = "第一份原配置\n";
    const secondOriginal = "第二份原配置\n";
    await fs.mkdir(path.dirname(firstPath), { recursive: true });
    await Promise.all([
      fs.writeFile(firstPath, firstOriginal, "utf8"),
      fs.writeFile(secondPath, secondOriginal, "utf8"),
    ]);

    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const snapshot = (filePath, content) => ({
      path: filePath,
      existed: true,
      content,
      hash: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
    });
    const replacement = (target, before, content) => ({
      target,
      path: before.path,
      before,
      content,
      afterHash: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
    });
    const adapters = {
      codex: {
        build: async () => [
          replacement("codex", snapshot(firstPath, firstOriginal), "第一份新配置\n"),
          replacement("codex", snapshot(secondPath, secondOriginal), "第二份新配置\n"),
        ],
      },
    };
    const applyService = new ApplyService({
      profileService,
      adapters,
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
    });
    const created = await profileService.save({
      name: "停止回滚夹具",
      protocol: "openai-responses",
      baseUrl: "https://rollback.example/v1",
      apiKey: "sk-rollback",
      model: "gpt-rollback",
      authMode: "bearer",
      targets: ["codex"],
    });
    const revision = (await profileService.getStored(created.id)).connectionRevision;
    let continuationChecks = 0;

    await expect(applyService.apply(created.id, ["codex"], {
      source: "auto",
      expectedRevision: revision,
      shouldContinue: () => {
        continuationChecks += 1;
        return continuationChecks < 6;
      },
    })).rejects.toThrow("Automatic configuration write was stopped");

    expect(await fs.readFile(firstPath, "utf8")).toBe(firstOriginal);
    expect(await fs.readFile(secondPath, "utf8")).toBe(secondOriginal);
    expect(await applyService.listHistory()).toEqual([
      expect.objectContaining({ success: false, canUndo: false }),
    ]);
  });
});
