const {
  assertValidJsonc,
  assertValidToml,
  hashText,
  parseJsoncValue,
  parseTomlValue,
  patchCodexToml,
  patchCodexGatewayBaseUrl,
  patchEnv,
  patchJsonc,
  readTextSnapshot,
  codexProviderState,
  restoreCodexGatewayBaseUrl,
} = require('./config-utils.cjs')
const { AUTH_MODE, PROTOCOL, TARGET } = require('./schemas.cjs')

const MANAGED_PROVIDER_ID = 'keydeck'
const GATEWAY_PROVIDER_ID = 'keydeck_gateway'
const GATEWAY_PROVIDER_NAME = 'Keydeck Local Gateway'
const GATEWAY_OWNERSHIP = Object.freeze({
  OWNED: 'owned',
  RELEASED: 'released',
  CONFLICT: 'conflict',
})
const OPEN_CODE_PACKAGE = Object.freeze({
  [PROTOCOL.ANTHROPIC]: '@ai-sdk/anthropic',
  [PROTOCOL.GEMINI]: '@ai-sdk/google',
  [PROTOCOL.OPENAI_RESPONSES]: '@ai-sdk/openai',
  [PROTOCOL.OPENAI_CHAT]: '@ai-sdk/openai-compatible',
})
const CLAUDE_ENV = Object.freeze({
  BASE_URL: 'ANTHROPIC_BASE_URL',
  API_KEY: 'ANTHROPIC_API_KEY',
  AUTH_TOKEN: 'ANTHROPIC_AUTH_TOKEN',
  MODEL: 'ANTHROPIC_MODEL',
  TOOL_SEARCH: 'ENABLE_TOOL_SEARCH',
})
const GEMINI_ENV = Object.freeze({
  API_KEY: 'GEMINI_API_KEY',
  BASE_URL: 'GOOGLE_GEMINI_BASE_URL',
  MODEL: 'GEMINI_MODEL',
})

async function draft(target, filePath, transform) {
  const snapshot = await readTextSnapshot(filePath)
  const content = transform(snapshot.content)
  return {
    target,
    path: filePath,
    before: snapshot,
    content,
    afterHash: hashText(content),
  }
}

async function restoreDraft(target, filePath, transform, suppliedSources) {
  if (!suppliedSources || !suppliedSources.has(filePath)) {
    return draft(target, filePath, transform)
  }
  const supplied = suppliedSources.get(filePath)
  const content = typeof supplied === 'string' ? supplied : supplied.content
  const before = typeof supplied === 'string'
    ? { path: filePath, existed: true, content, hash: hashText(content) }
    : supplied
  const restored = transform(content)
  return {
    target,
    path: filePath,
    before,
    content: restored,
    afterHash: hashText(restored),
  }
}

function assertProtocol(profile, supported, clientName) {
  if (!supported.includes(profile.protocol)) {
    throw new Error(`${clientName} does not support the ${profile.protocol} profile protocol`)
  }
}

function openCodePackage(protocol) {
  return OPEN_CODE_PACKAGE[protocol]
}

function parseEnv(source) {
  const values = {}
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value)
      } catch {
        continue
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

async function adapterSources(filePaths, supplied) {
  if (supplied) return supplied
  const snapshots = await Promise.all(filePaths.map((filePath) => readTextSnapshot(filePath)))
  return new Map(snapshots.map((snapshot) => [snapshot.path, snapshot.content]))
}

function sourceText(sources, filePath, fallback) {
  const value = sources.get(filePath)
  const content = typeof value === 'string' ? value : value?.content
  return typeof content === 'string' && content.trim() ? content : fallback
}

function ownership(managed, matches) {
  return managed
    ? (matches ? GATEWAY_OWNERSHIP.OWNED : GATEWAY_OWNERSHIP.CONFLICT)
    : GATEWAY_OWNERSHIP.RELEASED
}

function fieldState(container, key) {
  const present = container !== null
    && typeof container === 'object'
    && Object.prototype.hasOwnProperty.call(container, key)
  return {
    present,
    value: present ? container[key] : null,
  }
}

function restoredValue(state) {
  return state.present ? state.value : undefined
}

/**
 * 为已解析的配置路径创建客户端适配器。
 *
 * 每个适配器只生成待写入草稿，不直接修改磁盘；事务服务会统一执行并发检查、
 * 原子替换和失败回滚。`inspect` 永远不返回 Key。
 *
 * @param {object} paths `resolveClientPaths` 返回的路径集合。
 * @returns {object} 以客户端 ID 为键的适配器注册表。
 */
function createAdapters(paths) {
  const adapters = {
    [TARGET.CLAUDE]: {
      id: TARGET.CLAUDE,
      name: 'Claude Code',
      command: 'claude',
      primaryPath: paths.claude.config,
      paths: [paths.claude.config],
      async build(profile, apiKey, _options = {}) {
        assertProtocol(profile, [PROTOCOL.ANTHROPIC], 'Claude Code')
        const operations = [
          { path: ['env', CLAUDE_ENV.BASE_URL], value: profile.baseUrl },
          {
            path: ['env', CLAUDE_ENV.API_KEY],
            value: profile.authMode === AUTH_MODE.API_KEY ? apiKey : undefined,
          },
          {
            path: ['env', CLAUDE_ENV.AUTH_TOKEN],
            value: profile.authMode === AUTH_MODE.BEARER ? apiKey : undefined,
          },
          {
            path: ['env', CLAUDE_ENV.TOOL_SEARCH],
            value: profile.enableToolSearch ? 'true' : undefined,
          },
        ]
        if (profile.model) {
          operations.push({ path: ['env', CLAUDE_ENV.MODEL], value: profile.model })
        }
        return [await draft(TARGET.CLAUDE, paths.claude.config, (source) => (
          patchJsonc(source, operations, 'Claude settings.json')
        ))]
      },
      validate(source) {
        if (source.trim()) assertValidJsonc(source, 'Claude settings.json')
      },
      inspect(sources) {
        const data = parseJsoncValue(sources.get(paths.claude.config) || '{}', 'Claude settings.json')
        return {
          baseUrl: data?.env?.[CLAUDE_ENV.BASE_URL],
          model: data?.env?.[CLAUDE_ENV.MODEL],
        }
      },
      async captureManagedState(suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const data = parseJsoncValue(
          sourceText(sources, paths.claude.config, '{}'),
          'Claude settings.json',
        )
        const env = data?.env
        return {
          baseUrl: fieldState(env, CLAUDE_ENV.BASE_URL),
          apiKey: fieldState(env, CLAUDE_ENV.API_KEY),
          authToken: fieldState(env, CLAUDE_ENV.AUTH_TOKEN),
          model: fieldState(env, CLAUDE_ENV.MODEL),
          toolSearch: fieldState(env, CLAUDE_ENV.TOOL_SEARCH),
        }
      },
      async buildRestore(state, suppliedSources) {
        return [await restoreDraft(TARGET.CLAUDE, paths.claude.config, (source) => (
          patchJsonc(source, [
            { path: ['env', CLAUDE_ENV.BASE_URL], value: restoredValue(state.baseUrl) },
            { path: ['env', CLAUDE_ENV.API_KEY], value: restoredValue(state.apiKey) },
            { path: ['env', CLAUDE_ENV.AUTH_TOKEN], value: restoredValue(state.authToken) },
            { path: ['env', CLAUDE_ENV.MODEL], value: restoredValue(state.model) },
            { path: ['env', CLAUDE_ENV.TOOL_SEARCH], value: restoredValue(state.toolSearch) },
          ], 'Claude settings.json')
        ), suppliedSources)]
      },
      async gatewayOwnership(profile, apiKey, suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const data = parseJsoncValue(
          sourceText(sources, paths.claude.config, '{}'),
          'Claude settings.json',
        )
        const env = data?.env || {}
        const selected = env[CLAUDE_ENV.BASE_URL] === profile.baseUrl
        const expectedApiKey = profile.authMode === AUTH_MODE.API_KEY ? apiKey : undefined
        const expectedAuthToken = profile.authMode === AUTH_MODE.BEARER ? apiKey : undefined
        return ownership(selected,
          env[CLAUDE_ENV.API_KEY] === expectedApiKey
          && env[CLAUDE_ENV.AUTH_TOKEN] === expectedAuthToken
          && (!profile.model || env[CLAUDE_ENV.MODEL] === profile.model)
          && env[CLAUDE_ENV.TOOL_SEARCH] === (profile.enableToolSearch ? 'true' : undefined))
      },
    },

    [TARGET.CODEX]: {
      id: TARGET.CODEX,
      name: 'Codex',
      command: 'codex',
      primaryPath: paths.codex.config,
      paths: [paths.codex.config],
      async build(profile, apiKey, options = {}) {
        assertProtocol(
          profile,
          [PROTOCOL.OPENAI_CHAT, PROTOCOL.OPENAI_RESPONSES],
          'Codex',
        )
        if (options.gateway) {
          return [await draft(TARGET.CODEX, paths.codex.config, (source) => {
            const current = codexProviderState(source)
            if (options.baseline?.providerId
              && current.providerId !== options.baseline.providerId) {
              throw new Error(
                'Codex active model_provider changed while the gateway owns its previous base_url',
              )
            }
            return patchCodexGatewayBaseUrl(source, profile.baseUrl)
          })]
        }
        return [await draft(TARGET.CODEX, paths.codex.config, (source) => (
          patchCodexToml(source, profile, apiKey, {
            providerId: MANAGED_PROVIDER_ID,
          })
        ))]
      },
      validate(source) {
        assertValidToml(source, 'Codex config.toml')
      },
      inspect(sources) {
        const data = parseTomlValue(sources.get(paths.codex.config) || '', 'Codex config.toml')
        const providerId = data.model_provider
        const provider = providerId ? data.model_providers?.[providerId] : undefined
        return {
          baseUrl: provider?.base_url,
          model: data.model,
        }
      },
      async captureManagedState(suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        return codexProviderState(sourceText(
          sources,
          paths.codex.config,
          '',
        ))
      },
      async buildRestore(state, suppliedSources) {
        return [await restoreDraft(TARGET.CODEX, paths.codex.config, (source) => (
          restoreCodexGatewayBaseUrl(source, state)
        ), suppliedSources)]
      },
      async verifyManagedState(state, suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const current = codexProviderState(sourceText(
          sources,
          paths.codex.config,
          '',
        ), state.providerId)
        return current.providerId === state.providerId
          && JSON.stringify(current.baseUrl) === JSON.stringify(state.baseUrl)
      },
      async gatewayOwnership(profile, _apiKey, suppliedSources, options = {}) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const data = parseTomlValue(sourceText(sources, paths.codex.config, ''), 'Codex config.toml')
        const baselineProviderId = options?.baseline?.providerId
        const providerId = baselineProviderId || data.model_provider
        const provider = providerId ? data.model_providers?.[providerId] : undefined
        const currentBaseUrl = provider?.base_url
        const selected = typeof currentBaseUrl === 'string' && currentBaseUrl === profile.baseUrl
        if (selected) return GATEWAY_OWNERSHIP.OWNED
        if (typeof currentBaseUrl === 'string') {
          try {
            const url = new URL(currentBaseUrl)
            const segments = url.pathname.split('/').filter(Boolean)
            if (url.protocol === 'http:'
              && url.hostname === '127.0.0.1'
              && segments[0] === 'codex'
              && segments.length >= 2) {
              return GATEWAY_OWNERSHIP.CONFLICT
            }
          } catch {
            // A non-URL value is treated as a user release below.
          }
        }
        return GATEWAY_OWNERSHIP.RELEASED
      },
    },

    [TARGET.OPENCODE]: {
      id: TARGET.OPENCODE,
      name: 'OpenCode',
      command: 'opencode',
      primaryPath: paths.opencode.config,
      paths: [paths.opencode.config, paths.opencode.auth],
      async build(profile, apiKey, options = {}) {
        if (!profile.model) throw new Error('OpenCode profiles require a model ID')
        const providerId = options.gateway ? GATEWAY_PROVIDER_ID : MANAGED_PROVIDER_ID
        const provider = {
          npm: openCodePackage(profile.protocol),
          name: options.gateway ? GATEWAY_PROVIDER_NAME : `Keydeck - ${profile.name}`,
          options: { baseURL: profile.baseUrl },
          models: {
            [profile.model]: { name: profile.model },
          },
        }
        return Promise.all([
          draft(TARGET.OPENCODE, paths.opencode.config, (source) => patchJsonc(source, [
            { path: ['provider', providerId], value: provider },
            { path: ['model'], value: `${providerId}/${profile.model}` },
          ], 'OpenCode configuration')),
          draft(TARGET.OPENCODE, paths.opencode.auth, (source) => patchJsonc(source, [
            {
              path: [providerId],
              value: { type: 'api', key: apiKey },
            },
          ], 'OpenCode auth.json')),
        ])
      },
      validate(source, filePath) {
        if (source.trim()) assertValidJsonc(source, `OpenCode ${filePath}`)
      },
      inspect(sources) {
        const data = parseJsoncValue(
          sources.get(paths.opencode.config) || '{}',
          'OpenCode configuration',
        )
        const selectedProviderId = [MANAGED_PROVIDER_ID, GATEWAY_PROVIDER_ID].find(
          (providerId) => typeof data?.model === 'string' && data.model.startsWith(`${providerId}/`),
        )
        const modelPrefix = selectedProviderId ? `${selectedProviderId}/` : undefined
        const selectedModel = modelPrefix ? data.model.slice(modelPrefix.length) : undefined
        return {
          baseUrl: selectedProviderId
            ? data?.provider?.[selectedProviderId]?.options?.baseURL
            : undefined,
          model: selectedModel,
        }
      },
      async captureManagedState(suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const data = parseJsoncValue(
          sourceText(sources, paths.opencode.config, '{}'),
          'OpenCode configuration',
        )
        const auth = parseJsoncValue(
          sourceText(sources, paths.opencode.auth, '{}'),
          'OpenCode auth.json',
        )
        return {
          model: fieldState(data, 'model'),
          provider: fieldState(data?.provider, GATEWAY_PROVIDER_ID),
          auth: fieldState(auth, GATEWAY_PROVIDER_ID),
        }
      },
      async buildRestore(state, suppliedSources) {
        return Promise.all([
          restoreDraft(TARGET.OPENCODE, paths.opencode.config, (source) => patchJsonc(source, [
            { path: ['model'], value: restoredValue(state.model) },
            {
              path: ['provider', GATEWAY_PROVIDER_ID],
              value: restoredValue(state.provider),
            },
          ], 'OpenCode configuration'), suppliedSources),
          restoreDraft(TARGET.OPENCODE, paths.opencode.auth, (source) => patchJsonc(source, [
            { path: [GATEWAY_PROVIDER_ID], value: restoredValue(state.auth) },
          ], 'OpenCode auth.json'), suppliedSources),
        ])
      },
      async gatewayOwnership(profile, apiKey, suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const data = parseJsoncValue(
          sourceText(sources, paths.opencode.config, '{}'),
          'OpenCode configuration',
        )
        const auth = parseJsoncValue(
          sourceText(sources, paths.opencode.auth, '{}'),
          'OpenCode auth.json',
        )
        const provider = data?.provider?.[GATEWAY_PROVIDER_ID]
        const selected = typeof data?.model === 'string'
          && data.model.startsWith(`${GATEWAY_PROVIDER_ID}/`)
          && provider?.options?.baseURL === profile.baseUrl
        return ownership(selected,
          data.model === `${GATEWAY_PROVIDER_ID}/${profile.model}`
          && provider?.npm === openCodePackage(profile.protocol)
          && provider?.name === GATEWAY_PROVIDER_NAME
          && provider?.models?.[profile.model]?.name === profile.model
          && auth?.[GATEWAY_PROVIDER_ID]?.type === 'api'
          && auth?.[GATEWAY_PROVIDER_ID]?.key === apiKey)
      },
    },

    [TARGET.GEMINI]: {
      id: TARGET.GEMINI,
      name: 'Gemini CLI',
      command: 'gemini',
      primaryPath: paths.gemini.env,
      paths: [paths.gemini.config, paths.gemini.env],
      async build(profile, apiKey, _options = {}) {
        assertProtocol(profile, [PROTOCOL.GEMINI], 'Gemini CLI')
        const envValues = {
          [GEMINI_ENV.API_KEY]: apiKey,
          [GEMINI_ENV.BASE_URL]: profile.baseUrl,
        }
        if (profile.model) envValues[GEMINI_ENV.MODEL] = profile.model
        return Promise.all([
          draft(TARGET.GEMINI, paths.gemini.env, (source) => patchEnv(source, envValues)),
          draft(TARGET.GEMINI, paths.gemini.config, (source) => patchJsonc(source, [
            { path: ['security', 'auth', 'selectedType'], value: 'gemini-api-key' },
          ], 'Gemini settings.json')),
        ])
      },
      validate(source, filePath) {
        if (filePath.endsWith('.json') && source.trim()) {
          assertValidJsonc(source, 'Gemini settings.json')
        }
      },
      inspect(sources) {
        const values = parseEnv(sources.get(paths.gemini.env) || '')
        return {
          baseUrl: values[GEMINI_ENV.BASE_URL],
          model: values[GEMINI_ENV.MODEL],
        }
      },
      async captureManagedState(suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const values = parseEnv(sourceText(sources, paths.gemini.env, ''))
        const data = parseJsoncValue(
          sourceText(sources, paths.gemini.config, '{}'),
          'Gemini settings.json',
        )
        return {
          apiKey: fieldState(values, GEMINI_ENV.API_KEY),
          baseUrl: fieldState(values, GEMINI_ENV.BASE_URL),
          model: fieldState(values, GEMINI_ENV.MODEL),
          selectedType: fieldState(data?.security?.auth, 'selectedType'),
        }
      },
      async buildRestore(state, suppliedSources) {
        return Promise.all([
          restoreDraft(TARGET.GEMINI, paths.gemini.env, (source) => patchEnv(source, {
            [GEMINI_ENV.API_KEY]: restoredValue(state.apiKey),
            [GEMINI_ENV.BASE_URL]: restoredValue(state.baseUrl),
            [GEMINI_ENV.MODEL]: restoredValue(state.model),
          }), suppliedSources),
          restoreDraft(TARGET.GEMINI, paths.gemini.config, (source) => patchJsonc(source, [
            {
              path: ['security', 'auth', 'selectedType'],
              value: restoredValue(state.selectedType),
            },
          ], 'Gemini settings.json'), suppliedSources),
        ])
      },
      async gatewayOwnership(profile, apiKey, suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const values = parseEnv(sourceText(sources, paths.gemini.env, ''))
        const data = parseJsoncValue(
          sourceText(sources, paths.gemini.config, '{}'),
          'Gemini settings.json',
        )
        const selected = data?.security?.auth?.selectedType === 'gemini-api-key'
          && values[GEMINI_ENV.BASE_URL] === profile.baseUrl
        return ownership(selected,
          values[GEMINI_ENV.API_KEY] === apiKey
          && (!profile.model || values[GEMINI_ENV.MODEL] === profile.model))
      },
    },
  }

  return adapters
}

module.exports = {
  GATEWAY_OWNERSHIP,
  createAdapters,
}
