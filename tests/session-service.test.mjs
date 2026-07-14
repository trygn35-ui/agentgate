import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
      archived INTEGER DEFAULT 0);
    CREATE TABLE thread_dynamic_tools (thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE, tool TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
  `);
  state.prepare(`INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,0)`)
    .run("cx1", rollout, "\\\\?\\E:\\godot的游戏\\怪物区驿站", "探索项目", null, null, 1_700_000_100_000, 1_700_000_000_000);
  state.prepare(`INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,0)`)
    .run("cx2", "", "E:\\别的项目", null, "留着的会话", null, 1_700_000_050_000, 1_700_000_000_000);
  state.prepare("INSERT INTO thread_dynamic_tools VALUES (?,?)").run("cx1", "exec");
  state.prepare("INSERT INTO thread_spawn_edges VALUES (?,?)").run("cx1", "child-of-cx1");
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
  db.prepare("INSERT INTO message VALUES (?,?,?)").run("msg_a", "ses_a", "hello");
  db.prepare("INSERT INTO message VALUES (?,?,?)").run("msg_b", "ses_b", "keep");
  db.prepare("INSERT INTO part VALUES (?,?,?,?)").run("prt_a", "msg_a", "ses_a", "1234567890");
  db.prepare("INSERT INTO part VALUES (?,?,?,?)").run("prt_b", "msg_b", "ses_b", "keep");
  db.prepare("INSERT INTO todo VALUES (?,?)").run("td_a", "ses_a");
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
  fs.rmSync(home, { recursive: true, force: true });
});

describe("会话清单", () => {
  it("三家都列出来，按最近活动倒序", async () => {
    const sessions = await service().list();
    expect(sessions.map((s) => s.client).sort()).toEqual(["claude", "codex", "codex", "opencode", "opencode"]);
    const times = sessions.map((s) => s.updatedAt);
    expect([...times].sort().reverse()).toEqual(times);
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

  it("Codex 的工作区抹掉 \\\\?\\ 扩展前缀", async () => {
    const codex = (await service().list()).find((s) => s.nativeId === "cx1");
    expect(codex.workspace).toBe("E:\\godot的游戏\\怪物区驿站");
    expect(codex.title).toBe("探索项目");
  });

  it("Codex 没有 title 时退回 preview", async () => {
    const codex = (await service().list()).find((s) => s.nativeId === "cx2");
    expect(codex.title).toBe("留着的会话");
  });

  it("OpenCode 报出消息数与正文字节", async () => {
    const oc = (await service().list()).find((s) => s.nativeId === "ses_a");
    expect(oc).toMatchObject({ title: "角色移速 bug", messages: 1, sizeBytes: 10 });
    expect(oc.workspace).toBe("E:\\留存资源\\放置游戏");
  });
});

describe("删除演练", () => {
  it("列出要删的文件，也列出特意不删的", async () => {
    const [plan] = await service().plan(["codex:cx1"]);
    const paths = plan.files.map((f) => path.basename(f.path));
    expect(paths).toContain("rollout-2026-07-14T17-01-55-cx1.jsonl");
    // 附件是跨会话共享的，按会话删会毁掉别人的数据
    expect(plan.kept).toContain("attachments");
    expect(plan.kept).toContain("auth");
  });

  it("Claude 的演练涵盖侧车目录、待办、遥测与历史", async () => {
    const [plan] = await service().plan(["claude:aaaa1111-2222-3333-4444-555566667777"]);
    const names = plan.files.map((f) => f.path);
    expect(names.some((p) => p.endsWith(".jsonl"))).toBe(true);
    expect(names.some((p) => p.includes("tasks"))).toBe(true);
    expect(names.some((p) => p.includes("telemetry"))).toBe(true);
    expect(plan.rows.some((r) => r.kind === "jsonl-filter" && r.file.endsWith("history.jsonl"))).toBe(true);
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

    const state = new DatabaseSync(path.join(codexRoot, "state_5.sqlite"));
    expect(state.prepare("SELECT id FROM threads").all().map((r) => r.id)).toEqual(["cx2"]);
    // spawn_edges 没有外键，不显式删就会把子代理树整棵孤儿化
    expect(state.prepare("SELECT parent_thread_id p FROM thread_spawn_edges").all()
      .map((r) => r.p)).toEqual(["cx2"]);
    state.close();

    // 蒸馏记忆必须跟着走，否则会话删了它还在——那是隐私泄漏
    const mem = new DatabaseSync(path.join(codexRoot, "memories_1.sqlite"));
    expect(mem.prepare("SELECT thread_id t FROM stage1_outputs").all().map((r) => r.t)).toEqual(["cx2"]);
    mem.close();

    const dev = new DatabaseSync(path.join(codexRoot, "sqlite", "codex-dev.db"));
    expect(dev.prepare("SELECT COUNT(*) c FROM local_thread_catalog").get().c).toBe(0);
    dev.close();

    const global = JSON.parse(fs.readFileSync(path.join(codexRoot, ".codex-global-state.json"), "utf8"));
    expect(global["projectless-thread-ids"]).toEqual(["cx2"]);
    expect(global["thread-workspace-root-hints"]).toEqual({ cx2: "E:\\别的" });
    const atoms = global["electron-persisted-atom-state"];
    expect(atoms["thread-descriptions-v1"]).toEqual({});
    // 后缀式的键（thread-client-id-v1:local%3A<id>）也得拔掉
    expect(Object.keys(atoms)).not.toContain("thread-client-id-v1:local%3Acx1");
    expect(Object.keys(atoms)).toContain("thread-browser-tabs-v1:cx2");

    const index = fs.readFileSync(path.join(codexRoot, "session_index.jsonl"), "utf8");
    expect(index).not.toContain('"cx1"');
    expect(index).toContain('"cx2"');

    expect(fs.existsSync(path.join(codexRoot, "attachments/att-shared/pasted.txt"))).toBe(true);
    expect(fs.existsSync(path.join(codexRoot, "auth.json"))).toBe(true);
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
    expect(left.map((s) => s.nativeId).sort()).toEqual(["cx2", "ses_a", "ses_b"]);
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
