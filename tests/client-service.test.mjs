import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { ClientService } = require("../electron/services/client-service.cjs");

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "keydeck-client-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("客户端方案匹配", () => {
  it("通过本地地址和持久化路由识别网关接管方案", async () => {
    const configPath = path.join(root, "gateway-client.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    const adapters = {
      codex: {
        id: "codex",
        name: "Codex",
        command: "codex-not-used-in-test",
        paths: [configPath],
        primaryPath: configPath,
        validate() {},
        inspect() {
          return { baseUrl: "http://127.0.0.1:17863/codex", model: "gpt-current" };
        },
      },
    };
    const gatewayService = {
      matchesLocalBase: () => true,
      getPublicState: () => ({
        routes: [{ target: "codex", profileId: "gateway-profile" }],
      }),
    };
    const service = new ClientService(adapters, {}, gatewayService);
    const [client] = await service.scan([{
      id: "gateway-profile",
      name: "网关方案",
      model: "gpt-current",
      targets: ["codex"],
      endpoints: [{ url: "https://upstream.example/v1" }],
      lastAppliedAt: new Date().toISOString(),
    }]);

    expect(client).toMatchObject({
      activeProfileId: "gateway-profile",
      activeProfileName: "网关方案",
      viaGateway: true,
      baseUrl: "http://127.0.0.1:17863/codex",
    });
  });

  it("匹配 URL 池中的非活动地址，并优先最近写入的方案", async () => {
    const configPath = path.join(root, "client.json");
    await fs.writeFile(configPath, "{}\n", "utf8");
    const adapters = {
      codex: {
        id: "codex",
        name: "Codex",
        command: "codex-not-used-in-test",
        paths: [configPath],
        primaryPath: configPath,
        validate() {},
        inspect() {
          return { baseUrl: "https://backup.example/v1", model: "gpt-5.2-codex" };
        },
      },
    };
    const service = new ClientService(adapters, {});
    const older = new Date(Date.now() - 60_000).toISOString();
    const latest = new Date().toISOString();
    const profiles = [
      {
        id: "copy",
        name: "副本",
        baseUrl: "https://primary.example/v1",
        endpoints: [
          { url: "https://primary.example/v1" },
          { url: "https://backup.example/v1" },
        ],
        model: "gpt-5.2-codex",
        targets: ["codex"],
        lastAppliedAt: older,
      },
      {
        id: "source",
        name: "当前方案",
        baseUrl: "https://primary.example/v1",
        endpoints: [
          { url: "https://primary.example/v1" },
          { url: "https://backup.example/v1" },
        ],
        model: "gpt-5.2-codex",
        targets: ["codex"],
        lastAppliedAt: latest,
      },
    ];

    const [client] = await service.scan(profiles);
    expect(client.activeProfileId).toBe("source");
    expect(client.activeProfileName).toBe("当前方案");
  });
});
