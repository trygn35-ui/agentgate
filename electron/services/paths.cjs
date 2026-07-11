const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function resolveUserPath(value, homeDir) {
  if (!value) return undefined
  if (value === '~') return homeDir
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.resolve(homeDir, value.slice(2))
  }
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(homeDir, value)
}

function chooseOpenCodeConfig(directory) {
  const jsonPath = path.join(directory, 'opencode.json')
  const jsoncPath = path.join(directory, 'opencode.jsonc')
  // OpenCode 在 JSON 之后合并 JSONC，因此已有 JSONC 时必须写入更高优先级文件。
  if (fs.existsSync(jsoncPath)) return jsoncPath
  if (fs.existsSync(jsonPath)) return jsonPath
  return jsonPath
}

/**
 * 根据客户端环境变量和用户目录解析所有受支持的配置路径。
 *
 * @param {NodeJS.ProcessEnv} env 当前进程环境变量。
 * @param {string} homeDir 用户主目录；测试可注入临时目录。
 * @returns {object} Claude、Codex、OpenCode 和 Gemini 的配置文件路径。
 */
function resolveClientPaths(env = process.env, homeDir = os.homedir()) {
  const claudeDirectory = resolveUserPath(env.CLAUDE_CONFIG_DIR, homeDir)
    || path.join(homeDir, '.claude')
  const codexDirectory = resolveUserPath(env.CODEX_HOME, homeDir)
    || path.join(homeDir, '.codex')
  const geminiDirectory = resolveUserPath(env.GEMINI_CLI_HOME, homeDir)
    || path.join(homeDir, '.gemini')

  let openCodeConfig
  if (env.OPENCODE_CONFIG) {
    const override = resolveUserPath(env.OPENCODE_CONFIG, homeDir)
    try {
      openCodeConfig = fs.statSync(override).isDirectory()
        ? chooseOpenCodeConfig(override)
        : override
    } catch {
      openCodeConfig = override
    }
  } else {
    const configHome = resolveUserPath(env.XDG_CONFIG_HOME, homeDir)
      || path.join(homeDir, '.config')
    openCodeConfig = chooseOpenCodeConfig(path.join(configHome, 'opencode'))
  }

  const dataHome = resolveUserPath(env.XDG_DATA_HOME, homeDir)
    || path.join(homeDir, '.local', 'share')

  return {
    claude: {
      config: path.join(claudeDirectory, 'settings.json'),
    },
    codex: {
      config: path.join(codexDirectory, 'config.toml'),
    },
    opencode: {
      config: openCodeConfig,
      auth: path.join(dataHome, 'opencode', 'auth.json'),
    },
    gemini: {
      config: path.join(geminiDirectory, 'settings.json'),
      env: path.join(geminiDirectory, '.env'),
    },
  }
}

module.exports = {
  resolveClientPaths,
}
