const fs = require('node:fs')
const readline = require('node:readline')
const fsp = require('node:fs/promises')
const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const { SerialExecutor } = require('./storage.cjs')

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
const FILE_REWRITE_ATTEMPTS = 3
const SESSION_SOURCE = Symbol('sessionSource')

function hashText(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

async function readUtf8IfExists(file) {
  try {
    return await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function replaceTextIfUnchanged(file, expectedHash, content) {
  const stats = await fsp.stat(file)
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  const claimed = `${file}.agentgate-claim-${crypto.randomUUID()}`
  let handle
  let claimedExists = false
  try {
    handle = await fsp.open(temporary, 'wx', stats.mode)
    await handle.writeFile(content, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined

    try {
      await fsp.rename(file, claimed)
      claimedExists = true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }

    const claimedContent = await readUtf8IfExists(claimed)
    if (claimedContent === undefined) return false
    if (hashText(claimedContent) !== expectedHash) {
      try {
        await fsp.link(claimed, file)
        await fsp.unlink(claimed)
        claimedExists = false
        return false
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        throw new Error(
          `Session state changed during atomic commit; recovery copy kept as ${path.basename(claimed)}`,
        )
      }
    }

    try {
      await fsp.link(temporary, file)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      throw new Error(
        `Session state changed during atomic commit; recovery copy kept as ${path.basename(claimed)}`,
      )
    }

    if (hashText(await fsp.readFile(claimed, 'utf8')) !== expectedHash) {
      throw new Error(
        `Session state changed during atomic commit; recovery copy kept as ${path.basename(claimed)}`,
      )
    }
    await fsp.unlink(claimed)
    claimedExists = false
    return true
  } finally {
    await handle?.close().catch(() => {})
    await fsp.unlink(temporary).catch(() => {})
    if (claimedExists && !await existsPath(file)) {
      await fsp.rename(claimed, file).then(() => {
        claimedExists = false
      }).catch(() => {})
    }
  }
}

async function existsPath(file) {
  try {
    await fsp.access(file)
    return true
  } catch (error) {
    // 无法确认不存在时按“仍存在”处理，绝不冒险把 recovery 覆盖回去。
    return error.code !== 'ENOENT'
  }
}

/** 基于最新文本快照重算内容；文件持续变化时拒绝覆盖。 */
async function rewriteTextWithRetry(file, transform) {
  for (let attempt = 0; attempt < FILE_REWRITE_ATTEMPTS; attempt += 1) {
    const source = await readUtf8IfExists(file)
    if (source === undefined) return
    const next = transform(source)
    const sourceHash = hashText(source)

    if (next === undefined || next === source) {
      const current = await readUtf8IfExists(file)
      if (current === undefined || hashText(current) === sourceHash) return
      continue
    }

    if (!await replaceTextIfUnchanged(file, sourceHash, next)) continue
    const committed = await readUtf8IfExists(file)
    if (committed === undefined || hashText(committed) === hashText(next)) return
  }
  throw new Error(`Session state kept changing while it was being updated: ${path.basename(file)}`)
}

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

async function readDirOrEmpty(dir) {
  try {
    return await fsp.readdir(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function attachSessionSource(session, source) {
  if (source) {
    Object.defineProperty(session, SESSION_SOURCE, {
      configurable: false,
      enumerable: false,
      value: source,
      writable: false,
    })
  }
  return session
}

function statFileOrAbsent(file) {
  try {
    return fs.statSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
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

/** 逐行喂 JSON。头尾截断出来的半行会因解析失败被丢掉，完整边界行保留。 */
function* jsonLines(source, _dropFirst = false) {
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
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
    this.serial = new SerialExecutor()
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
    const existing = candidates.map((dir, index) => {
      const file = path.join(dir, 'opencode.db')
      try {
        const database = fs.statSync(file)
        let activeAt = database.mtimeMs
        try {
          activeAt = Math.max(activeAt, fs.statSync(`${file}-wal`).mtimeMs)
        } catch {
          // 没有 WAL 时以主数据库的改动时间为准。
        }
        return {
          dir,
          index,
          activeAt,
        }
      } catch {
        return undefined
      }
    }).filter(Boolean)
    existing.sort((left, right) => right.activeAt - left.activeAt || left.index - right.index)
    return existing[0]?.dir ?? candidates[0]
  }

  /** 每一条要删的路径都得过这道闸：必须真的在该客户端的根目录里面。 */
  _within(client, target) {
    const root = path.resolve(this.roots[client])
    const resolved = path.resolve(target)
    const rel = path.relative(root, resolved)
    return resolved !== root && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  /** 路径本身和符号链接的最终目标都必须留在客户端根目录内。 */
  async _withinReal(client, target) {
    if (!this._within(client, target)) return false
    try {
      const [root, resolved] = await Promise.all([
        fsp.realpath(this.roots[client]),
        fsp.realpath(target),
      ])
      const rel = path.relative(root, resolved)
      return resolved !== root && !rel.startsWith('..') && !path.isAbsolute(rel)
    } catch {
      return false
    }
  }

  async _codexRollout(target) {
    if (typeof target !== 'string' || !target || !await this._withinReal('codex', target)) {
      return undefined
    }
    const stats = await statOrUndefined(target)
    return stats?.isFile() ? { path: path.resolve(target), stats } : undefined
  }

  /**
   * 扫描三家的会话，并保留“哪一家扫描失败”的信息。
   *
   * `list()` 仍返回旧版数组，供现有 IPC/渲染端直接使用；新调用方可使用这个
   * 明确的结果对象，不再把损坏数据库或权限错误误认成空列表。
   */
  async listDetailed() {
    const sources = [
      ['claude', () => this._listClaude()],
      ['codex', () => this._listCodex()],
      ['opencode', () => this._listOpenCode()],
    ]
    const settled = await Promise.allSettled(sources.map(([, scan]) => scan()))
    const sessions = []
    const errors = []
    for (let index = 0; index < settled.length; index += 1) {
      const [client] = sources[index]
      const result = settled[index]
      if (result.status === 'fulfilled') {
        sessions.push(...result.value)
        continue
      }
      const error = result.reason
      errors.push({
        client,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    sessions.sort((left, right) => (
      (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
    ))
    return { sessions, errors }
  }

  async list() {
    const { sessions, errors } = await this.listDetailed()
    // Keep the historical `AgentSession[]` shape while making scan failures
    // observable to callers that know to inspect the optional property.
    Object.defineProperty(sessions, 'scanErrors', {
      configurable: false,
      enumerable: true,
      value: errors,
      writable: false,
    })
    return sessions
  }

  /** 演练：把要删的东西、和特意不删的东西，都摆出来。 */
  async plan(ids) {
    const sessions = await this.list()
    const requestedClients = new Set(ids.map((id) => String(id).split(':', 1)[0]))
    const scanErrors = (sessions.scanErrors ?? [])
      .filter((error) => requestedClients.has(error.client))
    if (scanErrors.length > 0) {
      throw new Error(scanErrors.map((error) => `${error.client}: ${error.reason}`).join('; '))
    }
    const index = new Map(sessions.map((session) => [session.id, session]))
    const expandedIds = this._expandCodexDescendants(ids, index)
    const plans = []
    for (const id of expandedIds) {
      const session = index.get(id)
      if (!session) continue
      const plan = await this._plan(session)
      plans.push(plan)
    }
    return plans
  }

  _expandCodexDescendants(ids, index) {
    if (!ids.some((id) => index.get(id)?.client === 'codex')) return [...new Set(ids)]

    const children = new Map()
    // _listCodex 已经从 thread_spawn_edges 取出每个实际线程的直接父级；
    // 复用这份快照，避免删除前再次打开可能正在被 Codex 更新的数据库。
    for (const session of index.values()) {
      if (session.client !== 'codex' || !session.parentNativeId) continue
      const parent = `codex:${session.parentNativeId}`
      if (!index.has(parent) || parent === session.id) continue
      const siblings = children.get(parent) ?? []
      siblings.push(session.id)
      children.set(parent, siblings)
    }

    const visiting = new Set()
    const included = new Set()
    const result = []
    const append = (id) => {
      if (included.has(id) || visiting.has(id)) return
      visiting.add(id)
      for (const child of children.get(id) ?? []) append(child)
      visiting.delete(id)
      included.add(id)
      result.push(id)
    }
    for (const id of ids) append(id)
    return result
  }

  async remove(ids) {
    return this.serial.run(async () => {
      let plans
      try {
        plans = await this.plan(ids)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return {
          removed: [],
          failed: ids.map((id) => ({ id, reason })),
        }
      }
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
    })
  }

  // ————————————————————————————— Claude Code —————————————————————————————

  async _listClaude() {
    const projectsRoot = path.join(this.roots.claude, 'projects')
    const projects = await readDirOrEmpty(projectsRoot)
    const sessions = []
    for (const project of projects) {
      const dir = path.join(projectsRoot, project)
      // Claude projects may contain junctions.  Never follow one outside .claude.
      if (!await this._withinReal('claude', dir)) continue
      const files = await readDirOrEmpty(dir)
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const full = path.join(dir, file)
        if (!await this._withinReal('claude', full)) continue
        const stats = await statOrUndefined(full)
        if (!stats?.isFile()) continue
        const uuid = file.slice(0, -'.jsonl'.length)
        const { head, tail } = await readEnds(full)
        sessions.push(attachSessionSource({
          project,
          uuid,
          client: 'claude',
          nativeId: uuid,
          title: this._claudeTitle(head, tail) || uuid.slice(0, 8),
          workspace: this._claudeWorkspace(head),
          updatedAt: stats.mtime.toISOString(),
          sizeBytes: stats.size,
        }, full))
      }
    }
    const occurrences = new Map()
    for (const session of sessions) {
      occurrences.set(session.uuid, (occurrences.get(session.uuid) ?? 0) + 1)
    }
    return sessions.map((source) => {
      const { uuid, ...session } = source
      return attachSessionSource({
        ...session,
        // Keep the historic id for the common case.  A UUID is only unique
        // within a Claude project, so include a fixed-length project digest
        // when it is repeated (the IPC session-id schema caps ids at 200 chars).
        id: occurrences.get(uuid) === 1
          ? `claude:${uuid}`
          : `claude:${hashText(session.project)}:${uuid}`,
      }, source[SESSION_SOURCE])
    })
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
    // 标题可能写在头部（短会话），也可能写在尾部；按文件顺序保留最后一个有效值。
    let customTitle = ''
    let aiTitle = ''
    const scanTitles = (source, dropFirst) => {
      for (const record of jsonLines(source, dropFirst)) {
        if (typeof record.customTitle === 'string' && record.customTitle.trim()) {
          customTitle = record.customTitle
        }
        if (typeof record.aiTitle === 'string' && record.aiTitle.trim()) aiTitle = record.aiTitle
      }
    }
    scanTitles(head, false)
    if (tail) scanTitles(tail, true)
    if (customTitle) return trimTitle(customTitle)
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
    let project = typeof session.project === 'string' && session.project
      ? session.project
      : undefined
    // All listed sessions carry their project.  Keep a narrow fallback for
    // callers holding an older session object, without scanning every project
    // (which could delete another project sharing this UUID).
    if (!project) {
      const file = await this._claudeFile(uuid)
      project = file ? path.basename(path.dirname(file)) : undefined
    }
    if (project) {
      const projectDir = path.join(projectsRoot, project)
      if (await this._withinReal('claude', projectDir)) {
        // 正文，以及同名的侧车目录（子代理、工具结果、工作流）
        for (const candidate of [
          path.join(projectDir, `${uuid}.jsonl`),
          path.join(projectDir, uuid),
        ]) {
          if (!await this._withinReal('claude', candidate)) continue
          const stats = await statOrUndefined(candidate)
          if (stats) files.push({ path: candidate, bytes: stats.size })
        }
      }
    }

    // tasks, telemetry and history are keyed only by UUID.  When the UUID is
    // repeated across projects they are ambiguous, so leave them untouched.
    const sharedUuid = session.id !== `claude:${uuid}`
    if (!sharedUuid) {
      const tasks = path.join(root, 'tasks', uuid)
      if (await this._withinReal('claude', tasks)) {
        const taskStats = await statOrUndefined(tasks)
        if (taskStats) files.push({ path: tasks, bytes: taskStats.size })
      }

      // 遥测里按会话 id 命名的失败事件——官方的 purge 也不清它，正在这儿常年堆积
      const telemetryDir = path.join(root, 'telemetry')
      if (await this._withinReal('claude', telemetryDir)) {
        for (const name of await fsp.readdir(telemetryDir).catch(() => [])) {
          if (!name.includes(uuid)) continue
          const full = path.join(telemetryDir, name)
          if (!await this._withinReal('claude', full)) continue
          const stats = await statOrUndefined(full)
          if (stats) files.push({ path: full, bytes: stats.size })
        }
      }

      const history = path.join(root, 'history.jsonl')
      if (await this._withinReal('claude', history)
        && await statOrUndefined(history)) {
        rows.push({ kind: 'jsonl-filter', file: history, id: uuid })
      }
    }

    return {
      id: session.id,
      nativeId: session.nativeId,
      client: 'claude',
      title: session.title,
      workspace: session.workspace,
      project,
      files,
      rows,
      kept: sharedUuid
        ? ['memory', 'settings', 'credentials', 'tasks', 'telemetry', 'history']
        : ['memory', 'settings', 'credentials'],
    }
  }

  // ——————————————————————————————— Codex ———————————————————————————————

  /** 权威库在根目录。`sqlite/` 子目录里还有一个同名的**陈旧副本**，读它会拿到六月的数据。 */
  _codexDb() {
    return path.join(this.roots.codex, 'state_5.sqlite')
  }

  async _listCodex() {
    const file = this._codexDb()
    if (!statFileOrAbsent(file)?.isFile()) return []
    const db = this.openDatabase(file, { readonly: true })
    try {
      const threadColumns = new Set(
        db.all('PRAGMA table_info(threads)').map((column) => column.name),
      )
      const metadataColumns = ['thread_source', 'agent_nickname', 'agent_role']
        .map((column) => threadColumns.has(column) ? `t.${column}` : `NULL AS ${column}`)
        .join(', ')
      const hasSpawnEdges = new Set(db.tables()).has('thread_spawn_edges')
      const parentColumn = hasSpawnEdges
        ? 'edge.parent_native_id'
        : 'NULL AS parent_native_id'
      const parentJoin = hasSpawnEdges
        ? `LEFT JOIN (
             SELECT child_thread_id, MIN(parent_thread_id) AS parent_native_id
             FROM thread_spawn_edges
             GROUP BY child_thread_id
           ) edge ON edge.child_thread_id = t.id`
        : ''
      const rows = db.all(`SELECT t.id, t.title, t.preview, t.first_user_message, t.cwd,
                                  t.rollout_path, t.updated_at_ms, t.created_at_ms, t.archived,
                                  ${metadataColumns}, ${parentColumn}
                           FROM threads t
                           ${parentJoin}`)
      const sessions = []
      for (const row of rows) {
        const rollout = await this._codexRollout(row.rollout_path)
        sessions.push(attachSessionSource({
          id: `codex:${row.id}`,
          client: 'codex',
          nativeId: String(row.id),
          title: trimTitle(row.title || row.preview || row.first_user_message)
            || String(row.id).slice(0, 8),
          workspace: stripExtendedPrefix(row.cwd),
          updatedAt: isoOrUndefined(row.updated_at_ms ?? row.created_at_ms),
          sizeBytes: rollout?.stats.size ?? 0,
          archived: row.archived === 1,
          threadSource: typeof row.thread_source === 'string' ? row.thread_source : undefined,
          agentNickname: typeof row.agent_nickname === 'string' ? row.agent_nickname : undefined,
          agentRole: typeof row.agent_role === 'string' ? row.agent_role : undefined,
          parentNativeId: typeof row.parent_native_id === 'string'
            ? row.parent_native_id
            : undefined,
        }, rollout?.path))
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

    const stateFile = this._codexDb()
    if (!fs.existsSync(stateFile)) {
      throw new Error(`Required session database is missing: ${path.basename(stateFile)}`)
    }
    let db
    try {
      db = this.openDatabase(stateFile, { readonly: true })
    } catch (error) {
      if (!fs.existsSync(stateFile)) {
        throw new Error(`Required session database is missing: ${path.basename(stateFile)}`)
      }
      throw error
    }
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
      const safeRollout = await this._codexRollout(rollout)
      if (safeRollout) files.push({ path: safeRollout.path, bytes: safeRollout.stats.size })
    }

    rows.push({
      kind: 'sqlite',
      file: this._codexDb(),
      required: true,
      requiredTables: ['threads'],
      statements: [
        // thread_dynamic_tools 靠外键级联；spawn_edges 没有外键，得自己动手，
        // 否则删掉父线程会把子代理树整棵孤儿化。
        ['DELETE FROM thread_spawn_edges WHERE child_thread_id = ? OR parent_thread_id = ?', id, id],
        // 先断边再删线程：某些版本给 spawn_edges 加了 RESTRICT 外键，顺序反过来会失败。
        ['DELETE FROM threads WHERE id = ?', id],
      ],
    })
    // 会话删了，它蒸馏出来的记忆不能留着——那是隐私泄漏。
    rows.push({
      kind: 'sqlite',
      file: path.join(root, 'memories_1.sqlite'),
      required: false,
      statements: [['DELETE FROM stage1_outputs WHERE thread_id = ?', id]],
    })
    rows.push({
      kind: 'sqlite',
      file: path.join(root, 'goals_1.sqlite'),
      required: false,
      statements: [['DELETE FROM thread_goals WHERE thread_id = ?', id]],
    })
    rows.push({
      kind: 'sqlite',
      file: path.join(root, 'sqlite', 'codex-dev.db'),
      required: false,
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
      nativeId: session.nativeId,
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
    if (!statFileOrAbsent(file)?.isFile()) return []
    const db = this.openDatabase(file, { readonly: true })
    try {
      // 发言条数不在这儿算：口径统一交给 countMessages，免得列表和正文各说各的
      const rows = db.all(`SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
                                  (SELECT COALESCE(SUM(LENGTH(CAST(p.data AS BLOB))), 0) FROM part p
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
      nativeId: session.nativeId,
      client: 'opencode',
      title: session.title,
      workspace: session.workspace,
      files: files.filter((entry) => this._within('opencode', entry.path)),
      rows: [{
        kind: 'sqlite',
        file: this._openCodeDb(),
        required: true,
        requiredTables: ['session'],
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

    const file = await this._sessionSourceFile(session)
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
                           AND CASE WHEN json_valid(p.data)
                                    THEN json_extract(p.data, '$.type') END = 'text'
                           AND typeof(CASE WHEN json_valid(p.data)
                                           THEN json_extract(p.data, '$.text') END) = 'text'
                           AND trim(CASE WHEN json_valid(p.data)
                                         THEN json_extract(p.data, '$.text') END) <> '')`,
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
    const { sessions } = await this.listDetailed()
    const session = sessions.find((item) => item.id === id)
    if (!session) return { messages: [], truncated: false }
    const want = limit > 0 ? Math.min(limit, MAX_MESSAGES) : MAX_MESSAGES

    if (session.client === 'opencode') return this._readOpenCodeMessages(session, want)

    const file = await this._sessionSourceFile(session)
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

  async _claudeFile(uuid, project) {
    const projectsRoot = path.join(this.roots.claude, 'projects')
    const projects = project
      ? [project]
      : await fsp.readdir(projectsRoot).catch(() => [])
    for (const name of projects) {
      const projectDir = path.join(projectsRoot, name)
      const candidate = path.join(projectDir, `${uuid}.jsonl`)
      if (!await this._withinReal('claude', projectDir)
        || !await this._withinReal('claude', candidate)) continue
      const stats = await statOrUndefined(candidate)
      if (stats?.isFile()) return candidate
    }
    return undefined
  }

  /**
   * 列表扫描已经拿到了正文路径；读取时只再次确认边界和文件类型，不重新查索引。
   * 这既避免切换会话时重复全量 I/O，也保留符号链接越界保护。
   */
  async _sessionSourceFile(session) {
    const source = session?.[SESSION_SOURCE]
    if (typeof source !== 'string') return undefined
    const client = session.client
    if (client !== 'claude' && client !== 'codex') return undefined
    if (!await this._withinReal(client, source)) return undefined
    const stats = await statOrUndefined(source)
    return stats?.isFile() ? source : undefined
  }

  async _codexFile(id) {
    const db = this.openDatabase(this._codexDb(), { readonly: true })
    try {
      const row = db.get('SELECT rollout_path FROM threads WHERE id = ?', id)
      return (await this._codexRollout(row?.rollout_path))?.path
    } finally {
      db.close()
    }
  }

  _readOpenCodeMessages(session, want) {
    const db = this.openDatabase(this._openCodeDb(), { readonly: true })
    try {
      const messageColumns = new Set(
        db.all('PRAGMA table_info(message)').map((column) => column.name),
      )
      const partColumns = new Set(
        db.all('PRAGMA table_info(part)').map((column) => column.name),
      )
      const messageTime = messageColumns.has('time_created') ? 'm.time_created' : 'NULL'
      const partTime = partColumns.has('time_created') ? 'p.time_created' : 'NULL'
      const rows = db.all(
        `WITH parsed_parts AS (
                SELECT p.message_id,
                       CASE WHEN json_valid(p.data)
                            THEN json_extract(p.data, '$.type') END AS part_type,
                       CASE WHEN json_valid(p.data)
                            THEN json_extract(p.data, '$.text') END AS text,
                       ${partTime} AS part_time,
                       p.rowid AS part_rowid
                  FROM part p
                 WHERE p.session_id = ?
              ), valid_parts AS (
                SELECT message_id, text, part_time, part_rowid
                  FROM parsed_parts
                 WHERE part_type = 'text'
                   AND typeof(text) = 'text'
                   AND trim(text) <> ''
              ), combined_parts AS (
                SELECT message_id,
                       group_concat(text, char(10)) OVER (
                         PARTITION BY message_id
                         ORDER BY part_time, part_rowid
                         ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
                       ) AS text,
                       ROW_NUMBER() OVER (
                         PARTITION BY message_id
                         ORDER BY part_time DESC, part_rowid DESC
                       ) AS final_part
                  FROM valid_parts
              ), text_messages AS (
                SELECT m.id, m.data AS message, ${messageTime} AS time_created,
                       m.rowid AS message_rowid, c.text
                  FROM message m
                  JOIN combined_parts c
                    ON c.message_id = m.id
                   AND c.final_part = 1
                 WHERE m.session_id = ?
              ), ranked_messages AS (
                SELECT id, message, time_created, text,
                       COUNT(*) OVER () AS total,
                       ROW_NUMBER() OVER (
                         ORDER BY time_created DESC, message_rowid DESC
                       ) AS recency
                  FROM text_messages
              )
              SELECT id, message, time_created, text, total
                FROM ranked_messages
               WHERE recency <= ?
               ORDER BY recency DESC`,
        session.nativeId, session.nativeId, want,
      )
      const messages = []
      for (const row of rows) {
        let role = 'assistant'
        try {
          role = JSON.parse(row.message)?.role === 'user' ? 'user' : 'assistant'
        } catch {}
        messages.push({
          role,
          text: clampText(row.text),
          at: isoOrUndefined(row.time_created),
        })
      }
      const total = Number(rows[0]?.total) || 0
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
      if (row.kind === 'sqlite' && !row.required && fs.existsSync(row.file)) {
        this._preflightSqlite(row)
      }
    }
    const authority = []
    let failure
    let failed = false
    try {
      // 先用最终提交会使用的同一个连接拿到写锁并准备删除。清理阶段任何一步失败，
      // 这个事务都会回滚；也不再存在“正文删完后才发现权威库打不开”的窗口。
      for (const row of plan.rows) {
        if (row.kind === 'sqlite' && row.required) authority.push(this._stageSqlite(row))
      }
      for (const row of plan.rows) {
        if (row.kind === 'sqlite' && !row.required) this._applySqlite(row)
        else if (row.kind === 'json-purge') await this._applyJsonPurge(row)
        else if (row.kind === 'jsonl-filter') await this._applyJsonlFilter(row)
      }
      for (const entry of plan.files) {
        if (!await this._withinReal(plan.client, entry.path)) continue
        await fsp.rm(entry.path, { recursive: true, force: true })
      }
      for (const transaction of authority) transaction.commit()
    } catch (error) {
      failure = error
      failed = true
      for (let index = authority.length - 1; index >= 0; index -= 1) {
        try {
          authority[index].rollback()
        } catch {}
      }
    } finally {
      for (const transaction of authority) {
        try {
          transaction.close()
        } catch (error) {
          if (!failed) {
            failure = error
            failed = true
          }
        }
      }
    }
    if (failed) throw failure
  }

  /**
   * 库或表不在就跳过——各家版本不同，少一张表是常态，不是错误。
   * 一次事务包住：要么这个库全改，要么一行不动。
   */
  _applySqlite(row) {
    if (!fs.existsSync(row.file)) {
      if (row.required) throw new Error(`Required session database is missing: ${path.basename(row.file)}`)
      return
    }
    let db
    let active = false
    let failure
    let failed = false
    try {
      db = this.openDatabase(row.file)
      const runnable = this._runnableSqlite(row, db)
      if (runnable.length > 0) {
        db.exec('BEGIN IMMEDIATE')
        active = true
        for (const [sql, ...params] of runnable) db.run(sql, ...params)
        db.exec('COMMIT')
        active = false
      }
    } catch (error) {
      failure = error
      failed = true
      if (active) {
        try {
          db.exec('ROLLBACK')
        } catch {} finally {
          active = false
        }
      }
    } finally {
      try {
        db?.close()
      } catch (error) {
        if (!failed) {
          failure = error
          failed = true
        }
      }
    }
    if (failed) throw failure
  }

  _stageSqlite(row) {
    if (!fs.existsSync(row.file)) {
      throw new Error(`Required session database is missing: ${path.basename(row.file)}`)
    }
    const db = this.openDatabase(row.file)
    let active = false
    try {
      const runnable = this._runnableSqlite(row, db)
      if (runnable.length > 0) {
        db.exec('BEGIN IMMEDIATE')
        active = true
        for (const [sql, ...params] of runnable) db.run(sql, ...params)
      }
      return {
        commit: () => {
          if (!active) return
          db.exec('COMMIT')
          active = false
        },
        rollback: () => {
          if (!active) return
          try {
            db.exec('ROLLBACK')
          } finally {
            active = false
          }
        },
        close: () => db.close(),
      }
    } catch (error) {
      if (active) {
        try {
          db.exec('ROLLBACK')
        } catch {}
      }
      try {
        db.close()
      } catch {}
      throw error
    }
  }

  _runnableSqlite(row, db) {
    const tables = new Set(db.tables())
    this._assertRequiredTables(row, tables)
    return row.statements.filter(([sql]) => {
      const table = /\bFROM\s+([A-Za-z_][\w]*)/i.exec(sql)?.[1]
      return table ? tables.has(table) : false
    })
  }

  _preflightSqlite(row) {
    if (!fs.existsSync(row.file)) {
      if (row.required) {
        throw new Error(`Required session database is missing: ${path.basename(row.file)}`)
      }
      return
    }
    const db = this.openDatabase(row.file)
    try {
      this._assertRequiredTables(row, new Set(db.tables()))
      db.exec('BEGIN IMMEDIATE')
      db.exec('ROLLBACK')
    } finally {
      db.close()
    }
  }

  _assertRequiredTables(row, tables) {
    for (const table of row.requiredTables || []) {
      if (!tables.has(table)) {
        throw new Error(`Required session table is missing: ${table}`)
      }
    }
  }

  async _applyJsonPurge(row) {
    await rewriteTextWithRetry(row.file, (raw) => {
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return undefined // 解不开就别动它，宁可留下一条陈迹也不能把状态文件写坏
      }
      const purged = purgeId(parsed, row.id)
      return purged.changed ? `${JSON.stringify(purged.value, null, 2)}\n` : raw
    })
  }

  async _applyJsonlFilter(row) {
    await rewriteTextWithRetry(row.file, (raw) => {
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
      if (dropped === 0) return raw
      return kept.length ? `${kept.join('\n')}\n` : ''
    })
  }
}

module.exports = {
  CLIENTS,
  SessionService,
  defaultOpenDatabase,
  purgeId,
  stripExtendedPrefix,
}
