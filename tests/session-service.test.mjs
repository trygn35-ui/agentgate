import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
// Vite 5 的内建模块清单还不认 node:sqlite，静态 import 会被它当成裸模块去找文件
const { DatabaseSync } = require("node:sqlite");
const { SessionService, purgeId, stripExtendedPrefix } = require("../electron/services/session-service.cjs");

/**
 * 生产走 better-sqlite3（原生模块，编译给 Electron 的 ABI 130）；测试跑在系统
 * Node 的 ABI 上，根本加载不了它。所以库的打开方式是注进去的，这里换成 node:sqlite。
 */
function openDatabase(file, { readonly = false } = {}) {
  const db = new DatabaseSync(file, { readOnly: readonly });
  db.exec("PRAGMA foreign_keys = ON");
  return {
    all: (sql, ...params) => db.prepare(sql).all(...params),
    get: (sql, ...params) => db.prepare(sql).get(...params),
    run: (sql, ...params) => db.prepare(sql).run(...params),
    exec: (sql) => db.exec(sql),
    tables: () => db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map((row) => row.name),
    close: () => db.close(),
  };
}

let home;
let openCodePartBytes = 0;

function write(relative, content) {
  const full = path.join(home, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

const jsonl = (...records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

function seedClaude() {
  // 首行是命令桩子，不是人话——标题必须跳过它
  write("projects/D--AI-Keydeck/aaaa1111-2222-3333-4444-555566667777.jsonl", jsonl(
    { type: "user", cwd: "D:\\AI\\Keydeck", message: { content: "<command-name>/compact</command-name>" } },
    { type: "user", cwd: "D:\\AI\\Keydeck", message: { content: "把网关的首字延迟修一下" } },
    { type: "assistant", cwd: "D:\\AI\\Keydeck", message: { content: "好" } },
    // 会话中途 cd 进了子目录：cwd 变了。工作区必须认第一条，不是这条。
    { type: "user", cwd: "D:\\AI\\Keydeck\\deliverables", message: { content: "再看看这个" } },
  ));
  write("projects/D--AI-Keydeck/aaaa1111-2222-3333-4444-555566667777/subagents/agent-1.jsonl", "{}\n");
  write("tasks/aaaa1111-2222-3333-4444-555566667777/1.json", "{}");
  write("telemetry/1p_failed_events.aaaa1111-2222-3333-4444-555566667777.evt.json", "{}");
  write("history.jsonl", jsonl(
    { display: "别的会话的提问", sessionId: "zzzz9999-0000-0000-0000-000000000000" },
    { display: "这个会话的提问", sessionId: "aaaa1111-2222-3333-4444-555566667777" },
  ));
  // 绝不能碰的
  write(".credentials.json", '{"token":"绝密"}');
  write("projects/D--AI-Keydeck/memory/MEMORY.md", "# 记忆");
}

function seedCodex() {
  const rollout = write("sessions/2026/07/14/rollout-2026-07-14T17-01-55-cx1.jsonl", "x".repeat(500));
  const db = new DatabaseSync(path.join(home, ".codex-tmp"));
  db.close();
  fs.rmSync(path.join(home, ".codex-tmp"));

  fs.mkdirSync(path.join(home, "sqlite"), { recursive: true });
  const state = new DatabaseSync(path.join(home, "state_5.sqlite"));
  state.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT,
      preview TEXT, first_user_message TEXT, updated_at_ms INTEGER, created_at_ms INTEGER,
      archived INTEGER DEFAULT 0, thread_source TEXT, agent_nickname TEXT, agent_role TEXT);
    CREATE TABLE thread_dynamic_tools (thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE, tool TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
  `);
  state.prepare(`INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,0,?,?,?)`)
    .run("cx1", rollout, "\\\\?\\E:\\godot的游戏\\怪物区驿站", "探索项目", null, null,
      1_700_000_100_000, 1_700_000_000_000, "user", null, null);
  state.prepare(`INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,0,?,?,?)`)
    .run("cx2", "", "E:\\别的项目", null, "留着的会话", null,
      1_700_000_050_000, 1_700_000_000_000, "subagent", "Bacon", "reviewer");
  state.prepare("INSERT INTO thread_dynamic_tools VALUES (?,?)").run("cx1", "exec");
  state.prepare("INSERT INTO thread_spawn_edges VALUES (?,?)").run("cx1", "cx2");
  state.prepare("INSERT INTO thread_spawn_edges VALUES (?,?)").run("cx2", "child-of-cx2");
  state.close();

  const mem = new DatabaseSync(path.join(home, "memories_1.sqlite"));
  mem.exec("CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY, raw_memory TEXT)");
  mem.prepare("INSERT INTO stage1_outputs VALUES (?,?)").run("cx1", "蒸馏出来的记忆");
  mem.prepare("INSERT INTO stage1_outputs VALUES (?,?)").run("cx2", "别动我");
  mem.close();

  const dev = new DatabaseSync(path.join(home, "sqlite", "codex-dev.db"));
  dev.exec("CREATE TABLE local_thread_catalog (thread_id TEXT, cwd TEXT)");
  dev.prepare("INSERT INTO local_thread_catalog VALUES (?,?)").run("cx1", "E:\\x");
  dev.close();

  write(".codex-global-state.json", JSON.stringify({
    "projectless-thread-ids": ["cx1", "cx2"],
    "thread-workspace-root-hints": { cx1: "E:\\旧路径", cx2: "E:\\别的" },
    "electron-persisted-atom-state": {
      "thread-descriptions-v1": { cx1: "描述" },
      "thread-client-id-v1:local%3Acx1": "客户端 id",
      "thread-browser-tabs-v1:cx2": ["标签"],
    },
  }, null, 2));
  write("session_index.jsonl", jsonl({ id: "cx1", thread_name: "A" }, { id: "cx2", thread_name: "B" }));
  // 共享附件：cx1 和 cx2 都引用它，绝不能按会话删
  write("attachments/att-shared/pasted.txt", "共享附件");
  write("auth.json", '{"OPENAI_API_KEY":"sk-绝密"}');
}

function seedOpenCode() {
  const db = new DatabaseSync(path.join(home, "opencode.db"));
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
      time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      data TEXT, FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT,
      data TEXT, FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE);
    CREATE TABLE todo (id TEXT PRIMARY KEY, session_id TEXT,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE);
    CREATE TABLE permission (id TEXT PRIMARY KEY, session_id TEXT);
    CREATE TABLE session_share (id TEXT PRIMARY KEY, session_id TEXT);
    CREATE TABLE session_entry (id TEXT PRIMARY KEY, session_id TEXT);
  `);
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)")
    .run("ses_a", "E:\\留存资源\\放置游戏", "角色移速 bug", 1_700_000_000_000, 1_700_000_200_000);
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)")
    .run("ses_b", "E:\\别的", "留着的", 1_700_000_000_000, 1_700_000_010_000);
  // 真实的 OpenCode：message.data 里有 role，正文在 part.data 的 JSON 里
  db.prepare("INSERT INTO message VALUES (?,?,?)")
    .run("msg_a", "ses_a", JSON.stringify({ role: "user" }));
  db.prepare("INSERT INTO message VALUES (?,?,?)")
    .run("msg_tool", "ses_a", JSON.stringify({ role: "assistant" }));
  db.prepare("INSERT INTO message VALUES (?,?,?)")
    .run("msg_b", "ses_b", JSON.stringify({ role: "assistant" }));
  const textPart = JSON.stringify({ type: "text", text: "角色移速不对" });
  const secondTextPart = JSON.stringify({ type: "text", text: "第二段" });
  const toolPart = JSON.stringify({ type: "tool", tool: "bash" });
  db.prepare("INSERT INTO part VALUES (?,?,?,?)").run("prt_a", "msg_a", "ses_a", textPart);
  db.prepare("INSERT INTO part VALUES (?,?,?,?)").run("prt_b", "msg_b", "ses_b", textPart);
  // 纯工具的 part 不是发言：数条数时不该算，正文里也不显示
  db.prepare("INSERT INTO part VALUES (?,?,?,?)")
    .run("prt_tool", "msg_a", "ses_a", toolPart);
  db.prepare("INSERT INTO part VALUES (?,?,?,?)")
    .run("prt_a2", "msg_a", "ses_a", secondTextPart);
  db.prepare("INSERT INTO part VALUES (?,?,?,?)")
    .run("prt_tool_only", "msg_tool", "ses_a", toolPart);
  db.prepare("INSERT INTO todo VALUES (?,?)").run("td_a", "ses_a");
  openCodePartBytes = Buffer.byteLength(textPart, "utf8")
    + Buffer.byteLength(secondTextPart, "utf8")
    + Buffer.byteLength(toolPart, "utf8") * 2;
  db.close();
  write("storage/session_diff/ses_a.json", "[]");
  write("auth.json", '{"key":"绝密"}');
}

/** 三家的根目录名字是写死的，所以假 home 里按真名建。 */
function service() {
  return new SessionService({ home, openDatabase });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ag-sessions-"));
  const claude = path.join(home, ".claude");
  const codex = path.join(home, ".codex");
  const opencode = path.join(home, ".local", "share", "opencode");
  for (const dir of [claude, codex, opencode]) fs.mkdirSync(dir, { recursive: true });

  const realHome = home;
  home = claude; seedClaude();
  home = codex; seedCodex();
  home = opencode; seedOpenCode();
  home = realHome;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("会话清单", () => {
  it("三家都列出来，按最近活动倒序", async () => {
    const sessions = await service().list();
    expect(sessions.map((s) => s.client).sort()).toEqual(["claude", "codex", "codex", "opencode", "opencode"]);
    const times = sessions.map((s) => s.updatedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("单个客户端扫描失败时保留其余会话，并把错误交给调用方", async () => {
    const stateFile = path.join(home, ".codex", "state_5.sqlite");
    const brokenCodex = (file, options = {}) => {
      if (options.readonly && path.resolve(file) === path.resolve(stateFile)) {
        throw new Error("模拟 Codex 索引损坏");
      }
      return openDatabase(file, options);
    };
    const svc = new SessionService({ home, openDatabase: brokenCodex });

    const detailed = await svc.listDetailed();
    expect(detailed.sessions.some((session) => session.client === "codex")).toBe(false);
    expect(detailed.sessions.map((session) => session.client).sort())
      .toEqual(["claude", "opencode", "opencode"]);
    expect(detailed.errors).toEqual([{
      client: "codex",
      reason: "模拟 Codex 索引损坏",
    }]);

    const compatible = await svc.list();
    expect(Array.isArray(compatible)).toBe(true);
    expect(compatible.scanErrors).toEqual(detailed.errors);
    await expect(svc.plan(["codex:missing"])).rejects.toThrow("codex: 模拟 Codex 索引损坏");
  });

  it("Claude 的工作区取第一条 cwd，不取中途 cd 过去的", async () => {
    const claude = (await service().list()).find((s) => s.client === "claude");
    // 会话后半段 cwd 变成了 deliverables 子目录；认那条就会把工作区说错
    expect(claude.workspace).toBe("D:\\AI\\Keydeck");
  });

  it("Claude 的标题跳过命令桩子，取首条真人消息", async () => {
    const claude = (await service().list()).find((s) => s.client === "claude");
    expect(claude.title).toBe("把网关的首字延迟修一下");
  });

  it("Claude 小文件也读取最后一个有效自定义标题", async () => {
    const file = path.join(home, ".claude", "projects", "D--AI-Keydeck",
      "aaaa1111-2222-3333-4444-555566667777.jsonl");
    fs.writeFileSync(file, jsonl(
      { type: "user", message: { content: "<command-name>/compact</command-name>" } },
      { type: "user", message: { content: "首条真人消息" } },
      { aiTitle: "模型标题" },
      { customTitle: "旧手动标题" },
      { customTitle: "最新手动标题" },
    ), "utf8");

    const claude = (await service().list()).find((s) => s.client === "claude");
    expect(claude.title).toBe("最新手动标题");
  });

  it("Claude 跨 project 重复 UUID 使用唯一 ID，并按 project 读取与删除", async () => {
    const uuid = "bbbb1111-2222-3333-4444-555566667777";
    const firstProject = "D--AI-Keydeck";
    const secondProject = "E--Other-Project";
    write(`.claude/projects/${firstProject}/${uuid}.jsonl`, jsonl(
      { type: "user", message: { content: "第一个项目的问题" } },
      { type: "assistant", message: { content: "第一个项目的回复" } },
    ));
    write(`.claude/projects/${firstProject}/${uuid}/subagents/agent.jsonl`, "{}\n");
    write(`.claude/projects/${secondProject}/${uuid}.jsonl`, jsonl(
      { type: "user", message: { content: "第二个项目的问题" } },
      { type: "assistant", message: { content: "第二个项目的回复" } },
    ));
    write(`.claude/projects/${secondProject}/${uuid}/subagents/agent.jsonl`, "{}\n");

    const svc = service();
    const matches = (await svc.list()).filter((session) => session.nativeId === uuid);
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((session) => session.id)).size).toBe(2);
    expect(matches.every((session) => session.nativeId === uuid)).toBe(true);
    expect(matches.every((session) => session.id.endsWith(`:${uuid}`))).toBe(true);
    expect(matches.every((session) => /^claude:[0-9a-f]{64}:/.test(session.id))).toBe(true);
    expect(matches.every((session) => session.id.length < 200)).toBe(true);

    const first = matches.find((session) => session.project === firstProject);
    const second = matches.find((session) => session.project === secondProject);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect((await svc.readMessages(first.id)).messages.map((message) => message.text))
      .toEqual(["第一个项目的问题", "第一个项目的回复"]);
    expect((await svc.readMessages(second.id)).messages.map((message) => message.text))
      .toEqual(["第二个项目的问题", "第二个项目的回复"]);
    expect(await svc.countMessages([first.id, second.id])).toEqual({
      [first.id]: 2,
      [second.id]: 2,
    });

    const [plan] = await svc.plan([first.id]);
    expect(plan.project).toBe(firstProject);
    expect(plan.files.map((entry) => entry.path).every((file) => file.includes(firstProject)))
      .toBe(true);
    expect(plan.files.map((entry) => entry.path).some((file) => file.includes(secondProject)))
      .toBe(false);
    expect(plan.rows).toEqual([]);
    expect(plan.kept).toEqual(expect.arrayContaining(["tasks", "telemetry", "history"]));

    const result = await svc.remove([first.id]);
    expect(result).toEqual({ removed: [first.id], failed: [] });
    expect(fs.existsSync(path.join(home, ".claude", "projects", firstProject, `${uuid}.jsonl`)))
      .toBe(false);
    expect(fs.existsSync(path.join(home, ".claude", "projects", firstProject, uuid)))
      .toBe(false);
    expect(fs.existsSync(path.join(home, ".claude", "projects", secondProject, `${uuid}.jsonl`)))
      .toBe(true);
    expect(fs.existsSync(path.join(home, ".claude", "projects", secondProject, uuid)))
      .toBe(true);
  });

  it("Codex 的工作区抹掉 \\\\?\\ 扩展前缀", async () => {
    const codex = (await service().list()).find((s) => s.nativeId === "cx1");
    expect(codex.workspace).toBe("E:\\godot的游戏\\怪物区驿站");
    expect(codex.title).toBe("探索项目");
  });

  it("Codex 没有 title 时退回 preview", async () => {
    const codex = (await service().list()).find((s) => s.nativeId === "cx2");
    expect(codex.title).toBe("留着的会话");
  });

  it("Codex 报出主任务与子代理的来源、代理信息和直接父会话", async () => {
    const sessions = await service().list();
    const main = sessions.find((s) => s.nativeId === "cx1");
    const child = sessions.find((s) => s.nativeId === "cx2");

    expect(main).toMatchObject({ threadSource: "user" });
    expect(main.parentNativeId).toBeUndefined();
    expect(child).toMatchObject({
      threadSource: "subagent",
      agentNickname: "Bacon",
      agentRole: "reviewer",
      parentNativeId: "cx1",
    });
  });

  it("旧版 Codex 缺少代理字段和父边表时仍能列出会话", async () => {
    const state = new DatabaseSync(path.join(home, ".codex", "state_5.sqlite"));
    state.exec(`
      DROP TABLE thread_spawn_edges;
      ALTER TABLE threads DROP COLUMN thread_source;
      ALTER TABLE threads DROP COLUMN agent_nickname;
      ALTER TABLE threads DROP COLUMN agent_role;
    `);
    state.close();

    const codex = (await service().list()).filter((session) => session.client === "codex");
    expect(codex.map((session) => session.nativeId).sort()).toEqual(["cx1", "cx2"]);
    expect(codex.every((session) => session.threadSource === undefined
      && session.agentNickname === undefined
      && session.agentRole === undefined
      && session.parentNativeId === undefined)).toBe(true);
  });

  it("OpenCode 报出正文字节", async () => {
    const oc = (await service().list()).find((s) => s.nativeId === "ses_a");
    expect(oc).toMatchObject({ title: "角色移速 bug", sizeBytes: openCodePartBytes });
    expect(oc.workspace).toBe("E:\\留存资源\\放置游戏");
    // 条数不在清单里算——要扫全文，交给 countMessages 按需数
    expect(oc.messages).toBeUndefined();
  });

  it("多个 OpenCode 数据库选择最近活动的候选库", async () => {
    const firstRoot = path.join(home, ".local", "share", "opencode");
    const latestRoot = path.join(home, "AppData", "Local", "opencode");
    const firstDb = path.join(firstRoot, "opencode.db");
    const latestDb = path.join(latestRoot, "opencode.db");
    fs.mkdirSync(latestRoot, { recursive: true });
    fs.copyFileSync(firstDb, latestDb);
    fs.utimesSync(firstDb, new Date("2024-01-01T00:00:00Z"), new Date("2024-01-01T00:00:00Z"));
    fs.utimesSync(latestDb, new Date("2025-01-01T00:00:00Z"), new Date("2025-01-01T00:00:00Z"));

    const svc = service();
    expect(svc.roots.opencode).toBe(latestRoot);
    expect((await svc.list()).filter((session) => session.client === "opencode")
      .map((session) => session.nativeId).sort()).toEqual(["ses_a", "ses_b"]);
  });

  it("OpenCode 正文只取合法文本消息并按 part rowid 稳定拼接", async () => {
    const result = await service().readMessages("opencode:ses_a");
    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      role: "user",
      text: "角色移速不对\n第二段",
    });
    // fixture 的 message/part 都没有 time_created，仍应能读取。
    expect(result.messages[0].at).toBeUndefined();
  });

  it("OpenCode 正文在有 part.time_created 时按时间再按 rowid 排序", async () => {
    const db = new DatabaseSync(path.join(home, ".local", "share", "opencode", "opencode.db"));
    db.exec("ALTER TABLE part ADD COLUMN time_created INTEGER");
    db.prepare("UPDATE part SET time_created = ? WHERE id = ?").run(20, "prt_a");
    db.prepare("UPDATE part SET time_created = ? WHERE id = ?").run(10, "prt_a2");
    db.close();

    const result = await service().readMessages("opencode:ses_a");
    expect(result.messages[0].text).toBe("第二段\n角色移速不对");
  });

  it("读取正文复用列表扫描拿到的安全路径，不再二次查询索引", async () => {
    const stateFile = path.join(home, ".codex", "state_5.sqlite");
    let stateReads = 0;
    const countedDatabase = (file, options = {}) => {
      if (options.readonly && path.resolve(file) === path.resolve(stateFile)) stateReads += 1;
      return openDatabase(file, options);
    };
    const svc = new SessionService({ home, openDatabase: countedDatabase });
    const claudeLookup = vi.spyOn(svc, "_claudeFile");
    const codexLookup = vi.spyOn(svc, "_codexFile");

    const claude = await svc.readMessages("claude:aaaa1111-2222-3333-4444-555566667777");
    expect(claude.messages).toHaveLength(3);
    expect(claudeLookup).not.toHaveBeenCalled();

    const codex = await svc.readMessages("codex:cx1");
    expect(codex.messages).toEqual([]);
    expect(codexLookup).not.toHaveBeenCalled();
    // 两次 readMessages 各扫描一次 Codex 索引；旧实现第二次还会再开库定位 rollout。
    expect(stateReads).toBe(2);
  });
});

describe("发言条数", () => {
  it("三家都数得出来，数的是真发言不是工具调用", async () => {
    const svc = service();
    const list = await svc.list();
    const ids = ["claude", "codex", "opencode"].map(
      (client) => list.find((s) => s.client === client).id,
    );
    const counts = await svc.countMessages(ids);

    /*
     * Claude 那条正文里有 4 行记录：命令桩子、一句真话、一句回复、cd 之后的一句。
     * 桩子不算发言，所以是 3 条——列表说几条，点开就该看到几条，不能各说各的。
     */
    expect(counts[ids[0]]).toBe(3);
    expect(counts[ids[1]]).toBeGreaterThanOrEqual(0);
    expect(counts[ids[2]]).toBe(1);
  });

  it("同一个文件不重扫：结果按 路径+大小+改动时间 缓存", async () => {
    const svc = service();
    const claude = (await svc.list()).find((s) => s.client === "claude");
    const first = await svc.countMessages([claude.id]);
    expect(svc.counts.size).toBe(1);
    // 再数一次不该再开一条读流——正文能有 279 MB，扫一遍不便宜
    const again = await svc.countMessages([claude.id]);
    expect(again).toEqual(first);
    expect(svc.counts.size).toBe(1);
  });

  it("不存在的会话安静跳过", async () => {
    expect(await service().countMessages(["claude:没这个"])).toEqual({});
  });
});

describe("删除演练", () => {
  it("列出要删的文件，也列出特意不删的", async () => {
    const plans = await service().plan(["codex:cx1"]);
    expect(plans.map((plan) => plan.nativeId)).toEqual(["cx2", "cx1"]);
    const plan = plans.find((item) => item.nativeId === "cx1");
    expect(plan.nativeId).toBe("cx1");
    const paths = plan.files.map((f) => path.basename(f.path));
    expect(paths).toContain("rollout-2026-07-14T17-01-55-cx1.jsonl");
    // 附件是跨会话共享的，按会话删会毁掉别人的数据
    expect(plan.kept).toContain("attachments");
    expect(plan.kept).toContain("auth");
  });

  it("Codex 删除计划先断开子代理边，再删除线程", async () => {
    const plan = (await service().plan(["codex:cx1"])).find((item) => item.nativeId === "cx1");
    const statements = plan.rows.find((row) => row.kind === "sqlite" && row.required).statements;
    expect(statements.map(([sql]) => sql)).toEqual([
      "DELETE FROM thread_spawn_edges WHERE child_thread_id = ? OR parent_thread_id = ?",
      "DELETE FROM threads WHERE id = ?",
    ]);
  });

  it("Claude 的演练涵盖侧车目录、待办、遥测与历史", async () => {
    const [plan] = await service().plan(["claude:aaaa1111-2222-3333-4444-555566667777"]);
    expect(plan.nativeId).toBe("aaaa1111-2222-3333-4444-555566667777");
    const names = plan.files.map((f) => f.path);
    expect(names.some((p) => p.endsWith(".jsonl"))).toBe(true);
    expect(names.some((p) => p.includes("tasks"))).toBe(true);
    expect(names.some((p) => p.includes("telemetry"))).toBe(true);
    expect(plan.rows.some((r) => r.kind === "jsonl-filter" && r.file.endsWith("history.jsonl"))).toBe(true);
  });

  it("OpenCode 的演练带原生会话 ID", async () => {
    const [plan] = await service().plan(["opencode:ses_a"]);
    expect(plan.nativeId).toBe("ses_a");
  });
});

describe("删除", () => {
  it("Claude：正文、侧车、待办、遥测全清，历史只掉自己那行，记忆与凭据不动", async () => {
    const claudeRoot = path.join(home, ".claude");
    const uuid = "aaaa1111-2222-3333-4444-555566667777";
    const result = await service().remove([`claude:${uuid}`]);
    expect(result.failed).toEqual([]);

    expect(fs.existsSync(path.join(claudeRoot, "projects/D--AI-Keydeck", `${uuid}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(claudeRoot, "projects/D--AI-Keydeck", uuid))).toBe(false);
    expect(fs.existsSync(path.join(claudeRoot, "tasks", uuid))).toBe(false);
    expect(fs.readdirSync(path.join(claudeRoot, "telemetry"))).toEqual([]);

    const history = fs.readFileSync(path.join(claudeRoot, "history.jsonl"), "utf8");
    expect(history).toContain("别的会话的提问");
    expect(history).not.toContain("这个会话的提问");

    // 官方的 project purge 会把这两样一起端掉。我们绝不。
    expect(fs.existsSync(path.join(claudeRoot, "projects/D--AI-Keydeck/memory/MEMORY.md"))).toBe(true);
    expect(fs.existsSync(path.join(claudeRoot, ".credentials.json"))).toBe(true);
  });

  it("Codex：四个库、全局状态、索引一起清，共享附件与凭据不动", async () => {
    const codexRoot = path.join(home, ".codex");
    const result = await service().remove(["codex:cx1"]);
    expect(result.failed).toEqual([]);
    expect(result.removed).toEqual(["codex:cx2", "codex:cx1"]);

    const state = new DatabaseSync(path.join(codexRoot, "state_5.sqlite"));
    expect(state.prepare("SELECT id FROM threads").all().map((r) => r.id)).toEqual([]);
    // spawn_edges 没有外键，父任务删除也必须把子代理边清掉
    expect(state.prepare("SELECT parent_thread_id p FROM thread_spawn_edges").all()).toEqual([]);
    state.close();

    // 蒸馏记忆必须跟着走，否则会话删了它还在——那是隐私泄漏
    const mem = new DatabaseSync(path.join(codexRoot, "memories_1.sqlite"));
    expect(mem.prepare("SELECT thread_id t FROM stage1_outputs").all().map((r) => r.t)).toEqual([]);
    mem.close();

    const dev = new DatabaseSync(path.join(codexRoot, "sqlite", "codex-dev.db"));
    expect(dev.prepare("SELECT COUNT(*) c FROM local_thread_catalog").get().c).toBe(0);
    dev.close();

    const global = JSON.parse(fs.readFileSync(path.join(codexRoot, ".codex-global-state.json"), "utf8"));
    expect(global["projectless-thread-ids"]).toEqual([]);
    expect(global["thread-workspace-root-hints"]).toEqual({});
    const atoms = global["electron-persisted-atom-state"];
    expect(atoms["thread-descriptions-v1"]).toEqual({});
    // 后缀式的键（thread-client-id-v1:local%3A<id>）也得拔掉
    expect(Object.keys(atoms)).not.toContain("thread-client-id-v1:local%3Acx1");
    expect(Object.keys(atoms)).not.toContain("thread-browser-tabs-v1:cx2");

    const index = fs.readFileSync(path.join(codexRoot, "session_index.jsonl"), "utf8");
    expect(index).not.toContain('"cx1"');
    expect(index).not.toContain('"cx2"');

    expect(fs.existsSync(path.join(codexRoot, "attachments/att-shared/pasted.txt"))).toBe(true);
    expect(fs.existsSync(path.join(codexRoot, "auth.json"))).toBe(true);
  });

  it("Codex：权威库无法写入时报告失败且保留正文", async () => {
    const codexRoot = path.join(home, ".codex");
    const stateFile = path.join(codexRoot, "state_5.sqlite");
    const state = new DatabaseSync(stateFile, { readOnly: true });
    const rollout = state.prepare("SELECT rollout_path FROM threads WHERE id = ?").get("cx1").rollout_path;
    state.close();

    const writeRefused = (file, options = {}) => {
      if (!options.readonly && path.resolve(file) === path.resolve(stateFile)) {
        throw new Error("模拟数据库写连接打开失败");
      }
      return openDatabase(file, options);
    };
    const svc = new SessionService({ home, openDatabase: writeRefused });

    const result = await svc.remove(["codex:cx1"]);

    expect(result).toEqual({
      removed: [],
      failed: [
        { id: "codex:cx2", reason: "模拟数据库写连接打开失败" },
        { id: "codex:cx1", reason: "模拟数据库写连接打开失败" },
      ],
    });
    expect(fs.existsSync(rollout)).toBe(true);
    const verify = new DatabaseSync(stateFile, { readOnly: true });
    expect(verify.prepare("SELECT id FROM threads WHERE id = ?").get("cx1")).toBeDefined();
    verify.close();
  });

  it("Codex：清理阶段复用已准备的权威事务，不在删除正文后重新开库", async () => {
    const codexRoot = path.join(home, ".codex");
    const stateFile = path.join(codexRoot, "state_5.sqlite");
    const rollout = path.join(codexRoot,
      "sessions/2026/07/14/rollout-2026-07-14T17-01-55-cx1.jsonl");
    let stateWriteOpens = 0;
    const rejectSecondStateWrite = (file, options = {}) => {
      if (!options.readonly && path.resolve(file) === path.resolve(stateFile)) {
        stateWriteOpens += 1;
        if (stateWriteOpens > 1) throw new Error("不应再次打开权威库");
      }
      return openDatabase(file, options);
    };
    const svc = new SessionService({ home, openDatabase: rejectSecondStateWrite });
    const plan = (await svc.plan(["codex:cx1"]))
      .find((item) => item.nativeId === "cx1");

    await svc._execute(plan);

    expect(stateWriteOpens).toBe(1);
    expect(fs.existsSync(rollout)).toBe(false);
    const state = new DatabaseSync(stateFile, { readOnly: true });
    expect(state.prepare("SELECT id FROM threads WHERE id = ?").get("cx1")).toBeUndefined();
    state.close();
  });

  it("执行失败时即使回滚或关闭报错，也保留原错误并处理所有权威连接", async () => {
    const files = [path.join(home, "authority-a.sqlite"), path.join(home, "authority-b.sqlite")];
    for (const file of files) fs.writeFileSync(file, "placeholder", "utf8");
    const events = [];
    const original = new Error("模拟正文清理失败");
    const svc = new SessionService({
      home,
      openDatabase: (file) => ({
        tables: () => ["sessions"],
        run: () => {},
        exec: (sql) => {
          const name = path.basename(file);
          events.push(`${name}:${sql}`);
          if (name === "authority-b.sqlite" && sql === "ROLLBACK") {
            throw new Error("模拟回滚失败");
          }
        },
        close: () => {
          const name = path.basename(file);
          events.push(`${name}:CLOSE`);
          if (name === "authority-a.sqlite") throw new Error("模拟关闭失败");
        },
      }),
    });
    svc._applyJsonPurge = async () => { throw original; };
    const required = files.map((file) => ({
      kind: "sqlite",
      file,
      required: true,
      statements: [["DELETE FROM sessions WHERE id = ?", "target"]],
    }));

    await expect(svc._execute({
      client: "codex",
      rows: [...required, { kind: "json-purge", file: "unused", id: "target" }],
      files: [],
    })).rejects.toBe(original);

    expect(events.filter((event) => event.endsWith(":ROLLBACK"))).toEqual([
      "authority-b.sqlite:ROLLBACK",
      "authority-a.sqlite:ROLLBACK",
    ]);
    expect(events.filter((event) => event.endsWith(":CLOSE"))).toEqual([
      "authority-a.sqlite:CLOSE",
      "authority-b.sqlite:CLOSE",
    ]);
  });

  it("权威库提交失败时不被后续回滚或关闭错误覆盖", async () => {
    const file = path.join(home, "authority-commit.sqlite");
    fs.writeFileSync(file, "placeholder", "utf8");
    const original = new Error("模拟提交失败");
    const events = [];
    const svc = new SessionService({
      home,
      openDatabase: () => ({
        tables: () => ["sessions"],
        run: () => {},
        exec: (sql) => {
          events.push(sql);
          if (sql === "COMMIT") throw original;
          if (sql === "ROLLBACK") throw new Error("模拟回滚失败");
        },
        close: () => {
          events.push("CLOSE");
          throw new Error("模拟关闭失败");
        },
      }),
    });

    await expect(svc._execute({
      client: "codex",
      rows: [{
        kind: "sqlite",
        file,
        required: true,
        statements: [["DELETE FROM sessions WHERE id = ?", "target"]],
      }],
      files: [],
    })).rejects.toBe(original);
    expect(events).toEqual(["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK", "CLOSE"]);
  });

  it("可选库 SQL 失败时不被回滚或关闭错误覆盖", () => {
    const file = path.join(home, "optional.sqlite");
    fs.writeFileSync(file, "placeholder", "utf8");
    const original = new Error("模拟 DELETE 失败");
    const events = [];
    const svc = new SessionService({
      home,
      openDatabase: () => ({
        tables: () => ["sessions"],
        run: () => { throw original; },
        exec: (sql) => {
          events.push(sql);
          if (sql === "ROLLBACK") throw new Error("模拟回滚失败");
        },
        close: () => {
          events.push("CLOSE");
          throw new Error("模拟关闭失败");
        },
      }),
    });
    let thrown;

    try {
      svc._applySqlite({
        kind: "sqlite",
        file,
        required: false,
        statements: [["DELETE FROM sessions WHERE id = ?", "target"]],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(original);
    expect(events).toEqual(["BEGIN IMMEDIATE", "ROLLBACK", "CLOSE"]);
  });

  it("权威库准备失败时不被连接关闭错误覆盖", () => {
    const file = path.join(home, "authority-stage.sqlite");
    fs.writeFileSync(file, "placeholder", "utf8");
    const original = new Error("模拟读取表结构失败");
    const svc = new SessionService({
      home,
      openDatabase: () => ({
        tables: () => { throw original; },
        close: () => { throw new Error("模拟关闭失败"); },
      }),
    });
    let thrown;

    try {
      svc._stageSqlite({
        kind: "sqlite",
        file,
        required: true,
        statements: [],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(original);
  });

  it("Codex：权威库在演练后消失时报告失败且保留正文", async () => {
    const codexRoot = path.join(home, ".codex");
    const stateFile = path.join(codexRoot, "state_5.sqlite");
    const missingStateFile = `${stateFile}.missing`;
    const rollout = path.join(codexRoot, "sessions/2026/07/14/rollout-2026-07-14T17-01-55-cx1.jsonl");
    let readonlyOpens = 0;
    const disappearingDatabase = (file, options = {}) => {
      const db = openDatabase(file, options);
      if (options.readonly && path.resolve(file) === path.resolve(stateFile)) {
        readonlyOpens += 1;
        if (readonlyOpens === 2) {
          const close = db.close;
          db.close = () => {
            close();
            fs.renameSync(stateFile, missingStateFile);
          };
        }
      }
      return db;
    };
    const svc = new SessionService({ home, openDatabase: disappearingDatabase });

    const result = await svc.remove(["codex:cx1"]);

    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([{
      id: "codex:cx1",
      reason: "Required session database is missing: state_5.sqlite",
    }]);
    expect(fs.existsSync(rollout)).toBe(true);
  });

  it("Codex：可选数据库存在但无法写入时拒绝假报删除成功", async () => {
    const codexRoot = path.join(home, ".codex");
    const stateFile = path.join(codexRoot, "state_5.sqlite");
    const memoryFile = path.join(codexRoot, "memories_1.sqlite");
    const rollout = path.join(codexRoot, "sessions/2026/07/14/rollout-2026-07-14T17-01-55-cx1.jsonl");
    const optionalWriteRefused = (file, options = {}) => {
      if (!options.readonly && path.resolve(file) === path.resolve(memoryFile)) {
        throw new Error("模拟可选数据库写连接失败");
      }
      return openDatabase(file, options);
    };
    const svc = new SessionService({ home, openDatabase: optionalWriteRefused });

    const result = await svc.remove(["codex:cx1"]);

    expect(result).toEqual({
      removed: [],
      failed: [
        { id: "codex:cx2", reason: "模拟可选数据库写连接失败" },
        { id: "codex:cx1", reason: "模拟可选数据库写连接失败" },
      ],
    });
    expect(fs.existsSync(rollout)).toBe(true);
    const state = new DatabaseSync(stateFile, { readOnly: true });
    expect(state.prepare("SELECT id FROM threads WHERE id = ?").get("cx1")).toBeDefined();
    state.close();
    const memory = new DatabaseSync(memoryFile, { readOnly: true });
    expect(memory.prepare("SELECT thread_id FROM stage1_outputs WHERE thread_id = ?").get("cx1"))
      .toBeDefined();
    memory.close();
  });

  it("Codex：正文清理失败时权威记录保留以便重试", async () => {
    const codexRoot = path.join(home, ".codex");
    const stateFile = path.join(codexRoot, "state_5.sqlite");
    const rollout = path.join(codexRoot, "sessions/2026/07/14/rollout-2026-07-14T17-01-55-cx1.jsonl");
    const originalRm = fsp.rm.bind(fsp);
    vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(rollout)) {
        throw new Error("模拟正文仍被占用");
      }
      return originalRm(target, options);
    });

    const result = await service().remove(["codex:cx1"]);

    expect(result).toEqual({
      removed: ["codex:cx2"],
      failed: [{ id: "codex:cx1", reason: "模拟正文仍被占用" }],
    });
    const state = new DatabaseSync(stateFile, { readOnly: true });
    expect(state.prepare("SELECT id FROM threads WHERE id = ?").get("cx1")).toBeDefined();
    expect(state.prepare("SELECT id FROM threads WHERE id = ?").get("cx2")).toBeUndefined();
    state.close();
  });

  it("Codex：删除时保留其他进程在读取后写入的 JSON 与 JSONL 状态", async () => {
    const codexRoot = path.join(home, ".codex");
    const globalFile = path.join(codexRoot, ".codex-global-state.json");
    const indexFile = path.join(codexRoot, "session_index.jsonl");
    const originalReadFile = fsp.readFile.bind(fsp);
    const injected = new Set();

    vi.spyOn(fsp, "readFile").mockImplementation(async (file, ...args) => {
      const source = await originalReadFile(file, ...args);
      const resolved = path.resolve(String(file));
      if (injected.has(resolved)) return source;

      if (resolved === path.resolve(globalFile)) {
        injected.add(resolved);
        const concurrent = JSON.parse(await originalReadFile(globalFile, "utf8"));
        concurrent["concurrent-writer-state"] = { keep: true };
        await fsp.writeFile(globalFile, `${JSON.stringify(concurrent, null, 2)}\n`, "utf8");
      } else if (resolved === path.resolve(indexFile)) {
        injected.add(resolved);
        await fsp.appendFile(indexFile, jsonl({ id: "cx-concurrent", thread_name: "并发新增" }), "utf8");
      }
      return source;
    });

    const result = await service().remove(["codex:cx1"]);

    expect(result.failed).toEqual([]);
    const global = JSON.parse(await originalReadFile(globalFile, "utf8"));
    expect(global["concurrent-writer-state"]).toEqual({ keep: true });
    const index = await originalReadFile(indexFile, "utf8");
    expect(index).toContain("cx-concurrent");
    expect(index).not.toContain('"cx1"');
  });

  it("Claude：原子提交窗口出现外部写入时安全失败且不覆盖", async () => {
    const claudeRoot = path.join(home, ".claude");
    const uuid = "aaaa1111-2222-3333-4444-555566667777";
    const historyFile = path.join(claudeRoot, "history.jsonl");
    const sessionFile = path.join(claudeRoot, "projects/D--AI-Keydeck", `${uuid}.jsonl`);
    const originalRename = fsp.rename.bind(fsp);
    const originalLink = fsp.link.bind(fsp);
    const originalReadFile = fsp.readFile.bind(fsp);
    const historyBeforeCommit = await originalReadFile(historyFile, "utf8");
    let injected = false;
    const injectConcurrentWrite = async () => {
      if (injected) return;
      injected = true;
      await fsp.writeFile(
        historyFile,
        `${historyBeforeCommit}${jsonl({ display: "并发新增", sessionId: "concurrent-session" })}`,
        "utf8",
      );
    };

    vi.spyOn(fsp, "rename").mockImplementation(async (source, destination) => {
      if (path.resolve(String(destination)) === path.resolve(historyFile)
        && String(source).endsWith(".tmp")) await injectConcurrentWrite();
      return originalRename(source, destination);
    });
    vi.spyOn(fsp, "link").mockImplementation(async (source, destination) => {
      if (path.resolve(String(destination)) === path.resolve(historyFile)) {
        await injectConcurrentWrite();
      }
      return originalLink(source, destination);
    });

    const result = await service().remove([`claude:${uuid}`]);

    expect(result.removed).toEqual([]);
    expect(result.failed[0]).toMatchObject({ id: `claude:${uuid}` });
    expect(result.failed[0].reason).toContain("changed during atomic commit");
    expect(fs.existsSync(sessionFile)).toBe(true);
    const history = await originalReadFile(historyFile, "utf8");
    expect(history).toContain("并发新增");
    expect(history).toContain(uuid);
  });

  it("OpenCode：消息与 part 一起走，不留孤儿", async () => {
    const ocRoot = path.join(home, ".local", "share", "opencode");
    const result = await service().remove(["opencode:ses_a"]);
    expect(result.failed).toEqual([]);

    const db = new DatabaseSync(path.join(ocRoot, "opencode.db"));
    expect(db.prepare("SELECT id FROM session").all().map((r) => r.id)).toEqual(["ses_b"]);
    /*
     * 这就是 OpenCode 自己在漏的那个洞：级联外键都声明了，但 PRAGMA foreign_keys
     * 是每连接的开关且默认关。不显式删，这里会剩下 msg_a 和 prt_a 两条孤儿。
     */
    expect(db.prepare("SELECT id FROM message").all().map((r) => r.id)).toEqual(["msg_b"]);
    expect(db.prepare("SELECT id FROM part").all().map((r) => r.id)).toEqual(["prt_b"]);
    expect(db.prepare("SELECT COUNT(*) c FROM todo").get().c).toBe(0);
    db.close();

    expect(fs.existsSync(path.join(ocRoot, "storage/session_diff/ses_a.json"))).toBe(false);
    expect(fs.existsSync(path.join(ocRoot, "auth.json"))).toBe(true);
  });

  it("删掉一个会话不影响另一个", async () => {
    await service().remove(["codex:cx1", "claude:aaaa1111-2222-3333-4444-555566667777"]);
    const left = await service().list();
    expect(left.map((s) => s.nativeId).sort()).toEqual(["ses_a", "ses_b"]);
  });

  it("不存在的会话安静跳过，不炸", async () => {
    const result = await service().remove(["codex:根本没有这个"]);
    expect(result).toEqual({ removed: [], failed: [] });
  });
});

describe("安全闸", () => {
  it("越出客户端根目录的路径一律不删", () => {
    const svc = service();
    expect(svc._within("claude", path.join(home, ".claude", "projects", "x.jsonl"))).toBe(true);
    // 目录穿越、以及根目录本身
    expect(svc._within("claude", path.join(home, ".claude", "..", ".codex", "auth.json"))).toBe(false);
    expect(svc._within("claude", path.join(home, ".claude"))).toBe(false);
    expect(svc._within("codex", "C:\\Windows\\System32\\config\\SAM")).toBe(false);
  });

  it("Codex rollout_path 越出根目录时不读取、不计数、不列入删除计划", async () => {
    const codexRoot = path.join(home, ".codex");
    const outside = write("outside-rollout.jsonl", jsonl({
      type: "event_msg",
      payload: { type: "agent_message", message: "不应被读取" },
    }));
    const state = new DatabaseSync(path.join(codexRoot, "state_5.sqlite"));
    state.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(outside, "cx1");
    state.close();

    const svc = service();
    const listed = (await svc.list()).find((session) => session.nativeId === "cx1");
    expect(listed.sizeBytes).toBe(0);
    expect((await svc.plan(["codex:cx1"])).find((plan) => plan.nativeId === "cx1").files)
      .toEqual([]);
    expect(await svc.countMessages(["codex:cx1"])).toEqual({ "codex:cx1": 0 });
    expect((await svc.readMessages("codex:cx1")).messages).toEqual([]);
  });

  it("Codex rollout_path 通过 symlink 越界时也被拒绝", async () => {
    const codexRoot = path.join(home, ".codex");
    const outsideDir = path.join(home, "outside-rollouts");
    const outside = path.join(outsideDir, "rollout.jsonl");
    const linkDir = path.join(codexRoot, "linked-rollouts");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outside, "不应被读取\n", "utf8");
    fs.symlinkSync(outsideDir, linkDir, "junction");

    const state = new DatabaseSync(path.join(codexRoot, "state_5.sqlite"));
    state.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?")
      .run(path.join(linkDir, "rollout.jsonl"), "cx1");
    state.close();

    const listed = (await service().list()).find((session) => session.nativeId === "cx1");
    expect(listed.sizeBytes).toBe(0);
    expect((await service().readMessages("codex:cx1")).messages).toEqual([]);
  });

  it("Claude projects 下指向根目录外的 junction 不列出、不读取", async () => {
    const claudeRoot = path.join(home, ".claude");
    const uuid = "cccc1111-2222-3333-4444-555566667777";
    const outsideDir = path.join(home, "outside-claude-project");
    const linkedProject = path.join(claudeRoot, "projects", "linked-outside");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, `${uuid}.jsonl`), jsonl(
      { type: "user", message: { content: "不应被读取" } },
    ), "utf8");
    fs.symlinkSync(outsideDir, linkedProject, "junction");

    const svc = service();
    expect((await svc.list()).some((session) => session.nativeId === uuid)).toBe(false);
    expect(await svc.readMessages(`claude:${uuid}`)).toEqual({ messages: [], truncated: false });
    expect(await svc.countMessages([`claude:${uuid}`])).toEqual({});
    expect(await svc.plan([`claude:${uuid}`])).toEqual([]);
  });

  it("Codex 删除展开后代时遇到环也只处理一次", async () => {
    const state = new DatabaseSync(path.join(home, ".codex", "state_5.sqlite"));
    state.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?)").run("cx2", "cx1");
    state.close();

    const plans = await service().plan(["codex:cx1"]);
    expect(plans.map((plan) => plan.nativeId)).toEqual(["cx2", "cx1"]);
  });

  it("purgeId 认数组元素、对象键、以及以 id 结尾的键", () => {
    const { value, changed } = purgeId({
      list: ["keep", "target"],
      "target": 1,
      "prefix:local%3Atarget": 2,
      "keep-me": { "target": 3, nested: ["target", "other"] },
    }, "target");
    expect(changed).toBe(true);
    expect(value).toEqual({ list: ["keep"], "keep-me": { nested: ["other"] } });
  });

  it("stripExtendedPrefix 抹掉 \\\\?\\，别的原样", () => {
    expect(stripExtendedPrefix("\\\\?\\E:\\a")).toBe("E:\\a");
    expect(stripExtendedPrefix("E:\\a")).toBe("E:\\a");
    expect(stripExtendedPrefix(undefined)).toBe("");
  });
});
