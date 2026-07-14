const fs = require('node:fs')
const readline = require('node:readline')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const writeFileAtomic = require('write-file-atomic')

/**
 * 本机 agent 的会话管理：列出、演练、删除。
 *
 * 三家把会话存在完全不同的地方，删一个会话的牵连面也完全不同：
 *
 * - Claude Code：纯文件。`projects/<编码过的工作区>/<uuid>.jsonl`，外加同名侧车目录、
 *   `tasks/<uuid>/`、`telemetry/*<uuid>*`、`history.jsonl` 里的行。
 * - Codex：SQLite 是唯一权威（3.67 GB 的 rollout 只是正文）。删一条要动 4 个库
 *   加一个 JSON 状态文件。**`attachments/` 是跨会话共享的，绝不能按会话删。**
 * - OpenCode：单库 SQLite。级联外键都声明了，但 `PRAGMA foreign_keys` 是**每连接**
 *   的开关且默认关闭——直接 DELETE 会静默留下几千行孤儿。
 *
 * 通用铁律：
 * 1. 只删白名单里算出来的路径，且每条都必须落在该客户端的根目录内（见 _within）。
 * 2. 凭据文件永不触碰：.codex/auth.json、.claude/.credentials.json、opencode/auth.json。
 * 3. JSON/JSONL 改写走原子写——这些 agent 可能正在跑，正在写同一个文件。
 * 4. 删之前先给 plan()：把要删的东西和**特意不删的东西**都摆出来。
 */

const CLIENTS = Object.freeze(['claude', 'codex', 'opencode'])

/** 一次读多少字节去找 cwd 和首条用户消息。够了——它们都在开头。 */
const HEAD_BYTES = 64 * 1024
/** 标题（ai-title / custom-title）是后写的，在尾巴上。 */
const TAIL_BYTES = 32 * 1024
const MAX_TITLE_LENGTH = 90

/** Claude Code 的首条用户消息常常是命令桩子，不是人话，得跳过。 */
const COMMAND_STUB = /^\s*<(?:command-name|command-message|command-args|local-command-|user-prompt-submit-hook)/i
/** 工具注入进用户消息里的东西，不是用户说的话。 */
const INJECTED_BLOCK = /<(system-reminder|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/gi

/** 展开看发言：一次最多给这么多条、一条最长这些字。 */
const MAX_MESSAGES = 200
const MAX_MESSAGE_CHARS = 4000
/** 从尾巴上先截这么多，不够就翻倍，最多截到这么大。正文能有 279 MB。 */
const TAIL_SCAN_BYTES = 256 * 1024
const MAX_TAIL_BYTES = 8 * 1024 * 1024

function clampText(value) {
  const text = String(value).trim()
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text
}

/** 读文件末尾一段。@returns fromStart 表示这一段已经覆盖到文件开头了。 */
async function readTail(file, bytes) {
  let handle
  try {
    handle = await fsp.open(file, 'r')
    const { size } = await handle.stat()
    const length = Math.min(bytes, size)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return { text: buffer.toString('utf8'), fromStart: length >= size }
  } catch {
    return { text: '', fromStart: true }
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * 把 Claude 的一行变成一条发言。
 *
 * 只要真正说出口的话。工具调用、工具结果、思考过程一概不算——它们在正文里占了
 * 绝大多数，混进来的话整页就是 (Bash) (Write) (Read) 的流水账，看不到人话。
 * 一条 assistant 记录如果只有工具调用、没有文字，直接整条丢掉。
 */
function claudeMessage(record) {
  if (record.type !== 'user' && record.type !== 'assistant') return undefined
  const content = record.message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
  }
  // <system-reminder> 之类是工具塞进用户消息里的，不是用户说的话
  text = text.replace(INJECTED_BLOCK, '').trim()
  if (!text || COMMAND_STUB.test(text)) return undefined
  return { role: record.type, text: clampText(text), at: record.timestamp }
}

/**
 * 把 Codex 的一行变成一条发言。
 *
 * 只认 event_msg 里的 user_message / agent_message——那是最终说出口的话。
 * response_item 是同一轮的原始物料（推理、工具调用），认了就重了。
 */
function codexMessage(record) {
  if (record.type !== 'event_msg') return undefined
  const payload = record.payload
  const kind = payload?.type
  if (kind !== 'user_message' && kind !== 'agent_message') return undefined
  const text = typeof payload.message === 'string' ? payload.message.trim() : ''
  if (!text) return undefined
  return {
    role: kind === 'user_message' ? 'user' : 'assistant',
    text: clampText(text),
    at: record.timestamp,
  }
}

function defaultOpenDatabase(file, { readonly = false } = {}) {
  // 只在真要用的时候加载：这是原生模块，测试跑在系统 Node 的 ABI 上装不下它
  const Database = require('better-sqlite3')
  const db = new Database(file, { readonly, timeout: 8_000, fileMustExist: true })
  // better-sqlite3 默认**不开**外键。OpenCode 的级联全靠它，不开就是一地孤儿。
  db.pragma('foreign_keys = ON')
  return {
    all: (sql, ...params) => db.prepare(sql).all(...params),
    get: (sql, ...params) => db.prepare(sql).get(...params),
    run: (sql, ...params) => db.prepare(sql).run(...params),
    exec: (sql) => db.exec(sql),
    tables: () => db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map((row) => row.name),
    close: () => db.close(),
  }
}

function isoOrUndefined(value) {
  const time = Number(value)
  if (!Number.isFinite(time) || time <= 0) return undefined
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function trimTitle(value) {
  if (typeof value !== 'string') return ''
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > MAX_TITLE_LENGTH ? `${clean.slice(0, MAX_TITLE_LENGTH - 1)}…` : clean
}

/** Windows 的扩展长度前缀。同一个目录在库里两种写法并存，比对前必须抹平。 */
function stripExtendedPrefix(value) {
  if (typeof value !== 'string') return ''
  return value.startsWith('\\\\?\\') ? value.slice(4) : value
}

async function statOrUndefined(file) {
  try {
    return await fsp.stat(file)
  } catch {
    return undefined
  }
}

/** 读文件头尾各一段。会话正文能有 279 MB，绝不整个读进来。 */
async function readEnds(file, headBytes = HEAD_BYTES, tailBytes = TAIL_BYTES) {
  let handle
  try {
    handle = await fsp.open(file, 'r')
    const { size } = await handle.stat()
    if (size === 0) return { head: '', tail: '', size }
    const head = Buffer.alloc(Math.min(headBytes, size))
    await handle.read(head, 0, head.length, 0)
    if (size <= headBytes) return { head: head.toString('utf8'), tail: '', size }
    const tail = Buffer.alloc(Math.min(tailBytes, size))
    await handle.read(tail, 0, tail.length, size - tail.length)
    return { head: head.toString('utf8'), tail: tail.toString('utf8'), size }
  } catch {
    return { head: '', tail: '', size: 0 }
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** 逐行喂 JSON。头尾截断出来的半行直接丢掉，别让它毒到解析。 */
function* jsonLines(source, dropFirst = false) {
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    // 尾段的第一行八成是被截断的半行
    if (dropFirst && index === 0) continue
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    try {
      yield JSON.parse(line)
    } catch {
      // 半行/坏行，跳过
    }
  }
}

/**
 * 把 id 从一坨 JSON 里连根拔掉。
 *
 * Codex 的全局状态里，线程 id 既做数组元素，也做对象键，还做键的后缀
 * （`thread-client-id-v1:local%3A<uuid>`）。只认精确匹配和以 id 结尾的键——
 * uuid 足够独特，不会误伤。
 */
function purgeId(value, id) {
  if (Array.isArray(value)) {
    const kept = value.filter((item) => item !== id)
    const changed = kept.length !== value.length
    const inner = kept.map((item) => purgeId(item, id))
    return { value: inner.map((r) => r.value), changed: changed || inner.some((r) => r.changed) }
  }
  if (!value || typeof value !== 'object') return { value, changed: false }
  const result = {}
  let changed = false
  for (const [key, child] of Object.entries(value)) {
    if (key === id || key.endsWith(id)) {
      changed = true
      continue
    }
    const purged = purgeId(child, id)
    if (purged.changed) changed = true
    result[key] = purged.value
  }
  return { value: result, changed }
}

class SessionService {
  constructor({ home = os.homedir(), openDatabase = defaultOpenDatabase } = {}) {
    this.home = home
    this.openDatabase = openDatabase
    /** 发言条数缓存，键是 路径:大小:改动时间——文件没变就不重扫。 */
    this.counts = new Map()
    this.roots = {
      claude: path.join(home, '.claude'),
      codex: path.join(home, '.codex'),
      opencode: this._openCodeRoot(home),
    }
  }

  _openCodeRoot(home) {
    const candidates = [
      path.join(home, '.local', 'share', 'opencode'),
      path.join(home, 'AppData', 'Local', 'opencode'),
      path.join(home, 'AppData', 'Roaming', 'opencode'),
    ]
    return candidates.find((dir) => fs.existsSync(path.join(dir, 'opencode.db'))) ?? candidates[0]
  }

  /** 每一条要删的路径都得过这道闸：必须真的在该客户端的根目录里面。 */
  _within(client, target) {
    const root = path.resolve(this.roots[client])
    const resolved = path.resolve(target)
    const rel = path.relative(root, resolved)
    return resolved !== root && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  async list() {
    const results = await Promise.all([
      this._listClaude().catch(() => []),
      this._listCodex().catch(() => []),
      this._listOpenCode().catch(() => []),
    ])
    return results.flat().sort((left, right) => (
      (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
    ))
  }

  /** 演练：把要删的东西、和特意不删的东西，都摆出来。 */
  async plan(ids) {
    const sessions = await this.list()
    const index = new Map(sessions.map((session) => [session.id, session]))
    const plans = []
    for (const id of ids) {
      const session = index.get(id)
      if (!session) continue
      const plan = await this._plan(session)
      plans.push(plan)
    }
    return plans
  }

  async remove(ids) {
    const plans = await this.plan(ids)
    const removed = []
    const failed = []
    for (const plan of plans) {
      try {
        await this._execute(plan)
        removed.push(plan.id)
      } catch (error) {
        failed.push({ id: plan.id, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return { removed, failed }
  }

  // ————————————————————————————— Claude Code —————————————————————————————

  async _listClaude() {
    const projectsRoot = path.join(this.roots.claude, 'projects')
    const projects = await fsp.readdir(projectsRoot).catch(() => [])
    const sessions = []
    for (const project of projects) {
      const dir = path.join(projectsRoot, project)
      const files = await fsp.readdir(dir).catch(() => [])
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const full = path.join(dir, file)
        const stats = await statOrUndefined(full)
        if (!stats?.isFile()) continue
        const uuid = file.slice(0, -'.jsonl'.length)
        const { head, tail } = await readEnds(full)
        sessions.push({
          id: `claude:${uuid}`,
          client: 'claude',
          nativeId: uuid,
          title: this._claudeTitle(head, tail) || uuid.slice(0, 8),
          workspace: this._claudeWorkspace(head),
          updatedAt: stats.mtime.toISOString(),
          sizeBytes: stats.size,
        })
      }
    }
    return sessions
  }

  /**
   * 工作区取**第一条**带 cwd 的记录。
   *
   * 不能随便抓一条——会话中途 cd 进子目录，后面的行里 cwd 就变了。真按那个显示，
   * 界面会把 `E:\Vibe Coding\wedraw-pr\wedraw\wedraw-web` 说成这个会话的工作区。
   * 也不能从目录名反推：那个编码是有损的（非字母数字一律变横杠），实测这台机器上
   * 就有两个不同的项目撞进同一个文件夹。
   */
  _claudeWorkspace(head) {
    for (const record of jsonLines(head)) {
      if (typeof record.cwd === 'string' && record.cwd.trim()) return record.cwd.trim()
    }
    return ''
  }

  _claudeTitle(head, tail) {
    // 真标题（用户自己起的 > 模型起的）是后写的，在尾巴上；绝大多数会话根本没有
    let aiTitle = ''
    for (const record of jsonLines(tail, true)) {
      if (typeof record.customTitle === 'string' && record.customTitle.trim()) {
        return trimTitle(record.customTitle)
      }
      if (typeof record.aiTitle === 'string' && record.aiTitle.trim()) aiTitle = record.aiTitle
    }
    if (aiTitle) return trimTitle(aiTitle)

    // 退回首条真人消息。开头那几条常是 <command-name> 之类的桩子，得跳过。
    for (const record of jsonLines(head)) {
      if (record.type !== 'user') continue
      const content = record.message?.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.find((part) => part?.type === 'text')?.text ?? ''
          : ''
      if (!text || COMMAND_STUB.test(text)) continue
      return trimTitle(text)
    }
    return ''
  }

  async _planClaude(session) {
    const uuid = session.nativeId
    const root = this.roots.claude
    const files = []
    const rows = []

    const projectsRoot = path.join(root, 'projects')
    const projects = await fsp.readdir(projectsRoot).catch(() => [])
    for (const project of projects) {
      // 正文，以及同名的侧车目录（子代理、工具结果、工作流）
      for (const candidate of [
        path.join(projectsRoot, project, `${uuid}.jsonl`),
        path.join(projectsRoot, project, uuid),
      ]) {
        const stats = await statOrUndefined(candidate)
        if (stats) files.push({ path: candidate, bytes: stats.size })
      }
    }

    // 待办
    const tasks = path.join(root, 'tasks', uuid)
    const taskStats = await statOrUndefined(tasks)
    if (taskStats) files.push({ path: tasks, bytes: taskStats.size })

    // 遥测里按会话 id 命名的失败事件——官方的 purge 也不清它，正在这儿常年堆积
    const telemetryDir = path.join(root, 'telemetry')
    for (const name of await fsp.readdir(telemetryDir).catch(() => [])) {
      if (!name.includes(uuid)) continue
      const full = path.join(telemetryDir, name)
      const stats = await statOrUndefined(full)
      if (stats) files.push({ path: full, bytes: stats.size })
    }

    const history = path.join(root, 'history.jsonl')
    if (await statOrUndefined(history)) rows.push({ kind: 'jsonl-filter', file: history, id: uuid })

    return {
      id: session.id,
      client: 'claude',
      title: session.title,
      workspace: session.workspace,
      files: files.filter((entry) => this._within('claude', entry.path)),
      rows,
      kept: ['memory', 'settings', 'credentials'],
    }
  }

  // ——————————————————————————————— Codex ———————————————————————————————

  /** 权威库在根目录。`sqlite/` 子目录里还有一个同名的**陈旧副本**，读它会拿到六月的数据。 */
  _codexDb() {
    return path.join(this.roots.codex, 'state_5.sqlite')
  }

  async _listCodex() {
    const file = this._codexDb()
    if (!fs.existsSync(file)) return []
    const db = this.openDatabase(file, { readonly: true })
    try {
      const rows = db.all(`SELECT id, title, preview, first_user_message, cwd, rollout_path,
                                  updated_at_ms, created_at_ms, archived
                           FROM threads`)
      const sessions = []
      for (const row of rows) {
        const rollout = typeof row.rollout_path === 'string' ? row.rollout_path : ''
        const stats = rollout ? await statOrUndefined(rollout) : undefined
        sessions.push({
          id: `codex:${row.id}`,
          client: 'codex',
          nativeId: String(row.id),
          title: trimTitle(row.title || row.preview || row.first_user_message)
            || String(row.id).slice(0, 8),
          workspace: stripExtendedPrefix(row.cwd),
          updatedAt: isoOrUndefined(row.updated_at_ms ?? row.created_at_ms),
          sizeBytes: stats?.size ?? 0,
          archived: row.archived === 1,
        })
      }
      return sessions
    } finally {
      db.close()
    }
  }

  async _planCodex(session) {
    const id = session.nativeId
    const root = this.roots.codex
    const files = []
    const rows = []

    const db = this.openDatabase(this._codexDb(), { readonly: true })
    let rollout = ''
    try {
      const row = db.get('SELECT rollout_path FROM threads WHERE id = ?', id)
      rollout = typeof row?.rollout_path === 'string' ? row.rollout_path : ''
    } finally {
      db.close()
    }
    // 正文路径只从库里取，绝不按日期自己拼——归档过的会话躺在 archived_sessions/ 里，
    // 是平铺的；而且文件名上的时间戳是本地时间，文件内部却全是 UTC。
    if (rollout) {
      const stats = await statOrUndefined(rollout)
      if (stats) files.push({ path: rollout, bytes: stats.size })
    }

    rows.push({
      kind: 'sqlite',
      file: this._codexDb(),
      statements: [
        // thread_dynamic_tools 靠外键级联；spawn_edges 没有外键，得自己动手，
        // 否则删掉父线程会把子代理树整棵孤儿化。
        ['DELETE FROM threads WHERE id = ?', id],
        ['DELETE FROM thread_spawn_edges WHERE child_thread_id = ? OR parent_thread_id = ?', id, id],
      ],
    })
    // 会话删了，它蒸馏出来的记忆不能留着——那是隐私泄漏。
    rows.push({
      kind: 'sqlite',
      file: path.join(root, 'memories_1.sqlite'),
      statements: [['DELETE FROM stage1_outputs WHERE thread_id = ?', id]],
    })
    rows.push({
      kind: 'sqlite',
      file: path.join(root, 'goals_1.sqlite'),
      statements: [['DELETE FROM thread_goals WHERE thread_id = ?', id]],
    })
    rows.push({
      kind: 'sqlite',
      file: path.join(root, 'sqlite', 'codex-dev.db'),
      statements: [
        ['DELETE FROM local_thread_catalog WHERE thread_id = ?', id],
        ['DELETE FROM inbox_items WHERE thread_id = ?', id],
        ['DELETE FROM automation_runs WHERE thread_id = ?', id],
      ],
    })
    // 桌面端读的是这个：线程 id 在里面既做数组元素、又做对象键、还做键的后缀
    rows.push({ kind: 'json-purge', file: path.join(root, '.codex-global-state.json'), id })
    rows.push({ kind: 'jsonl-filter', file: path.join(root, 'session_index.jsonl'), id })

    for (const dir of ['computer-use-turn-ended', 'generated_images']) {
      const full = path.join(root, dir, id)
      const stats = await statOrUndefined(full)
      if (stats) files.push({ path: full, bytes: stats.size })
    }

    return {
      id: session.id,
      client: 'codex',
      title: session.title,
      workspace: session.workspace,
      files: files.filter((entry) => this._within('codex', entry.path)),
      rows,
      // attachments/ 是按附件 id 存的，同一份附件会被多个会话（fork / resume 出来的）
      // 一起引用。按会话删它，会毁掉别的会话的数据。
      kept: ['attachments', 'auth', 'config'],
    }
  }

  // ————————————————————————————— OpenCode —————————————————————————————

  _openCodeDb() {
    return path.join(this.roots.opencode, 'opencode.db')
  }

  async _listOpenCode() {
    const file = this._openCodeDb()
    if (!fs.existsSync(file)) return []
    const db = this.openDatabase(file, { readonly: true })
    try {
      // 发言条数不在这儿算：口径统一交给 countMessages，免得列表和正文各说各的
      const rows = db.all(`SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
                                  (SELECT COALESCE(SUM(LENGTH(p.data)), 0) FROM part p
                                    WHERE p.session_id = s.id) AS bytes
                           FROM session s`)
      return rows.map((row) => ({
        id: `opencode:${row.id}`,
        client: 'opencode',
        nativeId: String(row.id),
        title: trimTitle(row.title) || String(row.id).slice(0, 12),
        workspace: typeof row.directory === 'string' ? row.directory : '',
        updatedAt: isoOrUndefined(row.time_updated ?? row.time_created),
        sizeBytes: Number(row.bytes) || 0,
      }))
    } finally {
      db.close()
    }
  }

  async _planOpenCode(session) {
    const id = session.nativeId
    const files = []
    const diff = path.join(this.roots.opencode, 'storage', 'session_diff', `${id}.json`)
    const stats = await statOrUndefined(diff)
    if (stats) files.push({ path: diff, bytes: stats.size })

    return {
      id: session.id,
      client: 'opencode',
      title: session.title,
      workspace: session.workspace,
      files: files.filter((entry) => this._within('opencode', entry.path)),
      rows: [{
        kind: 'sqlite',
        file: this._openCodeDb(),
        statements: [
          /*
           * part 的外键指向 message，不是 session——级联只能顺着 message 走下去。
           * 而且 PRAGMA foreign_keys 是每连接的开关，better-sqlite3 默认关。
           * 这里显式按顺序删，不指望级联：级联没打开的话，一条 DELETE FROM session
           * 会静默留下几千行孤儿（OpenCode 自己的删除就在这么漏）。
           */
          ['DELETE FROM part WHERE session_id = ?', id],
          ['DELETE FROM message WHERE session_id = ?', id],
          ['DELETE FROM todo WHERE session_id = ?', id],
          ['DELETE FROM permission WHERE session_id = ?', id],
          ['DELETE FROM session_share WHERE session_id = ?', id],
          ['DELETE FROM session_entry WHERE session_id = ?', id],
          ['DELETE FROM session WHERE id = ?', id],
        ],
      }],
      // snapshot/ 是按 项目 + 工作目录哈希 存的，跨会话共享；它还是个 git 仓库，
      // core.worktree 指着用户真实的代码目录——删它可能把用户的工作区搞坏。
      kept: ['snapshot', 'auth'],
    }
  }

  // ————————————————————————————— 数发言 —————————————————————————————

  /**
   * 数每个会话有多少条真发言。
   *
   * 三家都没在索引里存这个数，要算就得扫全文——而正文合计 3.8 GB，最大的单个文件
   * 279 MB。好在中位数只有 0.55 MB：只数「界面上看得见的那几十行」，再按
   * 路径+大小+改动时间缓存，文件没变就不重扫。
   *
   * 数的是和正文里显示的**同一种东西**（真发言，不含工具调用），否则列表说 137 条、
   * 点开只有 12 条人话，那个数就是在骗人。
   */
  async countMessages(ids) {
    const sessions = await this.list()
    const index = new Map(sessions.map((session) => [session.id, session]))
    const counts = {}
    for (const id of ids) {
      const session = index.get(id)
      if (!session) continue
      try {
        counts[id] = await this._count(session)
      } catch {
        // 数不出来就不显示，别拿一个假数糊弄
      }
    }
    return counts
  }

  async _count(session) {
    if (session.client === 'opencode') return this._countOpenCode(session)

    const file = session.client === 'claude'
      ? await this._claudeFile(session.nativeId)
      : await this._codexFile(session.nativeId)
    if (!file) return 0
    const stats = await statOrUndefined(file)
    if (!stats) return 0

    const key = `${file}:${stats.size}:${stats.mtimeMs}`
    const cached = this.counts.get(key)
    if (cached !== undefined) return cached

    const pick = session.client === 'claude' ? claudeMessage : codexMessage
    // 先做廉价的子串预筛，命中了才 JSON.parse——279 MB 的文件里只有 449 行是候选
    const hint = session.client === 'claude'
      ? (line) => line.includes('"type":"user"') || line.includes('"type":"assistant"')
      : (line) => line.includes('"user_message"') || line.includes('"agent_message"')

    let total = 0
    const reader = readline.createInterface({
      input: fs.createReadStream(file, { highWaterMark: 1 << 20 }),
      crlfDelay: Infinity,
    })
    try {
      for await (const line of reader) {
        if (!hint(line)) continue
        let record
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        if (pick(record)) total += 1
      }
    } finally {
      reader.close()
    }
    this.counts.set(key, total)
    return total
  }

  _countOpenCode(session) {
    const db = this.openDatabase(this._openCodeDb(), { readonly: true })
    try {
      // 只数有正文的消息。纯工具/步骤的 part 不是发言，正文里也不显示。
      const row = db.get(
        `SELECT COUNT(*) AS total FROM message m
          WHERE m.session_id = ?
            AND EXISTS (SELECT 1 FROM part p
                         WHERE p.message_id = m.id
                           AND json_extract(p.data, '$.type') = 'text')`,
        session.nativeId,
      )
      return Number(row?.total) || 0
    } finally {
      db.close()
    }
  }

  // ————————————————————————————— 读发言 —————————————————————————————

  /**
   * 读某个会话最后的若干条发言。
   *
   * 正文能有 279 MB，绝不整个读。从尾巴上截一段，切掉开头那半行，只解析完整的行；
   * 截出来的发言不够数就把窗口翻倍再来一次，直到够了或者撞上上限。
   *
   * @param limit 要几条。0 表示尽量多（仍受 MAX_MESSAGES 与 MAX_TAIL_BYTES 限制）。
   */
  async readMessages(id, { limit = 30 } = {}) {
    const sessions = await this.list()
    const session = sessions.find((item) => item.id === id)
    if (!session) return { messages: [], truncated: false }
    const want = limit > 0 ? Math.min(limit, MAX_MESSAGES) : MAX_MESSAGES

    if (session.client === 'opencode') return this._readOpenCodeMessages(session, want)

    const file = session.client === 'claude'
      ? await this._claudeFile(session.nativeId)
      : await this._codexFile(session.nativeId)
    if (!file) return { messages: [], truncated: false }

    const pick = session.client === 'claude' ? claudeMessage : codexMessage
    let window = TAIL_SCAN_BYTES
    let messages = []
    let reachedStart = false
    while (true) {
      const { text, fromStart } = await readTail(file, window)
      reachedStart = fromStart
      messages = []
      // 从头开始的那次才敢信第一行是完整的
      for (const record of jsonLines(text, !fromStart)) {
        const message = pick(record)
        if (message) messages.push(message)
      }
      if (messages.length >= want || reachedStart || window >= MAX_TAIL_BYTES) break
      window = Math.min(window * 4, MAX_TAIL_BYTES)
    }
    return {
      messages: messages.slice(-want),
      // 还有更早的没读到：要么截断了，要么条数被 want 卡住了
      truncated: !reachedStart || messages.length > want,
    }
  }

  async _claudeFile(uuid) {
    const projectsRoot = path.join(this.roots.claude, 'projects')
    for (const project of await fsp.readdir(projectsRoot).catch(() => [])) {
      const candidate = path.join(projectsRoot, project, `${uuid}.jsonl`)
      if (await statOrUndefined(candidate)) return candidate
    }
    return undefined
  }

  async _codexFile(id) {
    const db = this.openDatabase(this._codexDb(), { readonly: true })
    try {
      const row = db.get('SELECT rollout_path FROM threads WHERE id = ?', id)
      const file = typeof row?.rollout_path === 'string' ? row.rollout_path : ''
      return file && await statOrUndefined(file) ? file : undefined
    } finally {
      db.close()
    }
  }

  _readOpenCodeMessages(session, want) {
    const db = this.openDatabase(this._openCodeDb(), { readonly: true })
    try {
      const rows = db.all(
        `SELECT m.id, m.data AS message, m.time_created,
                (SELECT COUNT(*) FROM message x WHERE x.session_id = ?) AS total
           FROM message m WHERE m.session_id = ?
          ORDER BY m.time_created DESC LIMIT ?`,
        session.nativeId, session.nativeId, want,
      )
      const messages = []
      for (const row of [...rows].reverse()) {
        let role = 'assistant'
        try {
          role = JSON.parse(row.message)?.role === 'user' ? 'user' : 'assistant'
        } catch {}
        // 正文在 part 里，只要 text 那种；tool / step-start 之类不是发言
        const parts = db.all(
          `SELECT data FROM part WHERE message_id = ? ORDER BY time_created`,
          row.id,
        )
        const text = parts.map((part) => {
          try {
            const data = JSON.parse(part.data)
            return data?.type === 'text' && typeof data.text === 'string' ? data.text : ''
          } catch {
            return ''
          }
        }).filter(Boolean).join('\n').trim()
        if (!text) continue
        messages.push({ role, text: clampText(text), at: isoOrUndefined(row.time_created) })
      }
      const total = rows[0]?.total ?? messages.length
      return { messages, truncated: total > messages.length }
    } finally {
      db.close()
    }
  }

  // ————————————————————————————— 执行 —————————————————————————————

  async _plan(session) {
    if (session.client === 'claude') return this._planClaude(session)
    if (session.client === 'codex') return this._planCodex(session)
    return this._planOpenCode(session)
  }

  async _execute(plan) {
    for (const row of plan.rows) {
      if (row.kind === 'sqlite') this._applySqlite(row)
      else if (row.kind === 'json-purge') await this._applyJsonPurge(row)
      else if (row.kind === 'jsonl-filter') await this._applyJsonlFilter(row)
    }
    for (const entry of plan.files) {
      if (!this._within(plan.client, entry.path)) continue
      await fsp.rm(entry.path, { recursive: true, force: true })
    }
  }

  /**
   * 库或表不在就跳过——各家版本不同，少一张表是常态，不是错误。
   * 一次事务包住：要么这个库全改，要么一行不动。
   */
  _applySqlite(row) {
    if (!fs.existsSync(row.file)) return
    let db
    try {
      db = this.openDatabase(row.file)
    } catch {
      return
    }
    try {
      const tables = new Set(db.tables())
      const runnable = row.statements.filter(([sql]) => {
        const table = /\bFROM\s+([A-Za-z_][\w]*)/i.exec(sql)?.[1]
        return table ? tables.has(table) : false
      })
      if (runnable.length === 0) return
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const [sql, ...params] of runnable) db.run(sql, ...params)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } finally {
      db.close()
    }
  }

  async _applyJsonPurge(row) {
    const raw = await fsp.readFile(row.file, 'utf8').catch(() => undefined)
    if (raw === undefined) return
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return // 解不开就别动它，宁可留下一条陈迹也不能把状态文件写坏
    }
    const purged = purgeId(parsed, row.id)
    if (!purged.changed) return
    await writeFileAtomic(row.file, `${JSON.stringify(purged.value, null, 2)}\n`)
  }

  async _applyJsonlFilter(row) {
    const raw = await fsp.readFile(row.file, 'utf8').catch(() => undefined)
    if (raw === undefined) return
    const kept = []
    let dropped = 0
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        kept.push(line) // 解不开的行原样留着，不是我们的行就别碰
        continue
      }
      const owner = record.sessionId ?? record.session_id ?? record.id ?? record.thread_id
      if (owner === row.id) {
        dropped += 1
        continue
      }
      kept.push(line)
    }
    if (dropped === 0) return
    await writeFileAtomic(row.file, kept.length ? `${kept.join('\n')}\n` : '')
  }
}

module.exports = {
  CLIENTS,
  SessionService,
  defaultOpenDatabase,
  purgeId,
  stripExtendedPrefix,
}
