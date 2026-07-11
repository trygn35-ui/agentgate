import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestStores, testVault } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const {
  HealthService,
} = require("../electron/services/health-service.cjs");
const {
  candidateEndpoints,
} = require("../electron/services/auto-switch-service.cjs");
const { ProfileService } = require("../electron/services/profile-service.cjs");

const PRIMARY_URL = "https://primary.example/v1";
const SECONDARY_URL = "https://secondary.example/v1";
let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "keydeck-health-monitor-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function createProfile(profileService) {
  return profileService.save({
    name: "无凭据测速",
    protocol: "openai-responses",
    baseUrl: PRIMARY_URL,
    endpoints: [{ url: PRIMARY_URL }, { url: SECONDARY_URL }],
    apiKey: "must-not-leave-vault",
    model: "",
    authMode: "bearer",
    targets: ["codex"],
    autoSwitch: { enabled: true, intervalMinutes: 2 },
  });
}

describe("无凭据 URL 健康监测", () => {
  it("只 HEAD 原始 URL，不访问模型列表或发送 Key", async () => {
    const { profileStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const created = await createProfile(profileService);
    const fetchMock = vi.fn(async (requestUrl) => (
      new URL(requestUrl).hostname === "primary.example"
        ? new Response(null, { status: 401 })
        : new Response(null, { status: 429 })
    ));
    const healthService = new HealthService(profileService, fetchMock);
    const secretSpy = vi.spyOn(profileService, "getConnection");

    const checked = await healthService.testHealth(created.id);

    expect(secretSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [requestUrl, options] of fetchMock.mock.calls) {
      expect(String(requestUrl)).not.toContain("/models");
      expect(options.method).toBe("HEAD");
      expect(options.headers).toBeUndefined();
    }
    expect(checked.endpoints[0].health).toMatchObject({
      status: "healthy",
      reachable: true,
      statusCode: 401,
    });
    expect(checked.endpoints[1].health).toMatchObject({
      status: "limited",
      reachable: true,
      statusCode: 429,
    });
    expect(checked.endpoints.every((endpoint) => endpoint.models.length === 0)).toBe(true);
    expect(checked.endpoints.every((endpoint) => endpoint.healthHistory.length === 1)).toBe(true);
  });

  it("决策历史保留 30 点且展示时间线保留 60 点", async () => {
    const { profileStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const created = await createProfile(profileService);
    const stored = await profileService.getStored(created.id);

    for (let index = 0; index < 65; index += 1) {
      await profileService.commitEndpointHealthResults(created.id, [{
        url: PRIMARY_URL,
        health: {
          status: "healthy",
          reachable: true,
          latencyMs: index,
          checkedAt: new Date(Date.now() - (64 - index) * 1_000).toISOString(),
          statusCode: 204,
          message: "Endpoint is reachable",
        },
      }], stored.connectionRevision);
    }

    const persisted = await profileService.getStored(created.id);
    expect(persisted.endpoints[0].healthHistory).toHaveLength(30);
    expect(persisted.endpoints[0].healthHistory[0].latencyMs).toBe(35);
    expect(persisted.endpoints[0].healthHistory.at(-1).latencyMs).toBe(64);
    expect(persisted.endpoints[0].healthTimeline).toHaveLength(60);
    expect(persisted.endpoints[0].healthTimeline[0].latencyMs).toBe(5);
    expect(persisted.endpoints[0].healthTimeline.at(-1).latencyMs).toBe(64);
  });
});

describe("一小时健康排名", () => {
  it("可用率优先于延迟，并阻止不足三个样本的新 URL 竞争", () => {
    const now = Date.now();
    const sample = (reachable, latencyMs, offset) => ({
      status: reachable ? "healthy" : "unhealthy",
      reachable,
      latencyMs,
      checkedAt: new Date(now - offset).toISOString(),
      message: reachable ? "reachable" : "failed",
    });
    const profile = {
      baseUrl: PRIMARY_URL,
      endpoints: [
        {
          url: PRIMARY_URL,
          health: sample(true, 300, 0),
          healthHistory: [
            sample(true, 300, 4_000),
            sample(true, 320, 2_000),
            sample(true, 310, 0),
          ],
        },
        {
          url: SECONDARY_URL,
          health: sample(true, 20, 0),
          healthHistory: [
            sample(true, 20, 4_000),
            sample(false, 20, 2_000),
            sample(true, 20, 0),
          ],
        },
        {
          url: "https://new.example/v1",
          health: sample(true, 1, 0),
          healthHistory: [sample(true, 1, 1_000), sample(true, 1, 0)],
        },
      ],
    };

    const ranked = candidateEndpoints(profile, { now });

    expect(ranked.map((endpoint) => endpoint.url)).toEqual([
      PRIMARY_URL,
      SECONDARY_URL,
    ]);
    expect(ranked[0].metrics.availability).toBe(1);
  });
});
