# Keydeck

Keydeck 是一个纯本地的 API 方案与回环网关管理器。方案中的真实 URL 和 Key 只交给 Keydeck 网关；客户端连接固定的 `127.0.0.1` 地址，因此切换兼容方案时无需反复改写客户端配置。

## 工作方式

1. 创建方案，保存协议、URL 池、Key、模型和适用客户端。
2. 在方案列表把方案分配给一个或多个客户端。网关关闭时，这只是保存下次启动要使用的路由，不修改客户端文件。
3. 打开顶部“本地网关”开关。Keydeck 启动回环监听，并定点写入本地 URL。
4. 网关运行时再次分配方案：
   - URL 和 Key 切换只更新内存路由，客户端配置字节不变。
   - 已经发出的请求固定使用开始时的上游；新请求使用新方案。
5. 关闭网关时，Keydeck 只恢复首次接管前的受管字段；已分配路由会保留，供下次开启继续使用。

方案不会把真实上游 URL 或 Key 直接写入客户端。真实上游 Key 只存在于 DPAPI 密文和网关运行期间的主进程内存中。

## 客户端

| 客户端 | 接入位置 | Keydeck 管理的字段 |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | 本地 Base URL、本地认证、可选模型与 Tool Search |
| Codex | `~/.codex/config.toml` | 仅当前 provider 的 `base_url` |
| OpenCode | `~/.config/opencode/opencode.json(c)`、`~/.local/share/opencode/auth.json` | `provider.keydeck_gateway`、模型选择与本地认证 |
| Gemini CLI | `~/.gemini/.env`、`~/.gemini/settings.json` | 本地 Base URL、本地认证、可选模型与认证类型 |

支持 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GEMINI_CLI_HOME`、`OPENCODE_CONFIG`、`XDG_CONFIG_HOME` 和 `XDG_DATA_HOME` 路径覆盖。

## URL 池与自动择优

- 一个方案最多保存 20 个 API URL。
- 后台每 2 分钟对原 URL 发起不带 Key 的 `HEAD` 探测，不访问 `/models`。
- 每个 URL 持久保存最近 1 小时、最多 30 个统计样本；另保留最近 60 次检测用于红黄绿时间线展示。
- `2xx` 至 `4xx` 视为可达，`429` 显示受限；`5xx`、超时、TLS 和网络错误视为失败。
- 自动择优先比较 1 小时可用率，再比较可达样本的中位延迟；新 URL 至少预热 3 个样本。
- 当前 URL 失败时立即选择可达线路，不等待预热完成。
- 模型列表只在用户点击“识别模型”时请求，不会被后台检测改写。
- 方案卡主体用于立即切换网关路由，右下角“配置”进入详情；“检测端点”只检查 URL 可达性，不识别模型。
- 密钥行的“实测”按钮会用方案真实 Key 按协议发送一条最小消息（hi），报告 HTTP 状态、首包、总耗时和上游计量的 Token 用量；实测流量直连上游，不经过本地网关。实测请求本身只有约 10 个输入 Token，若结果显示大量输入或缓存 Token，说明中转在转发前注入了自己的前缀。
- OpenAI/Anthropic 兼容接口读取 `data[].id`，Gemini 接口读取 `models[].name`。
- 自动切换只更新方案活动 URL 和网关连接缓存，不把真实 URL/Key 写入客户端。

复制方案会复制协议、URL 池、模型、适用客户端、检测周期和同一 Key；副本默认关闭自动切换，并清空运行时健康状态。

## 本地网关

- 默认端口 `17863`，只绑定 `127.0.0.1`，不会监听局域网地址。
- Claude、Codex、OpenCode 和 Gemini 使用独立路径槽，不是任意目标的开放代理。
- 默认请求正文、工具字段、二进制内容和 SSE 响应使用 Node 流式管道原样转发。
- 入站使用随机本地令牌；网关移除本地认证后，再按当前方案注入真实上游 Key。
- Codex 使用随机且持久的 URL 路径令牌，本地网关忽略传入凭据并注入当前方案 Key。
- 路由分配与监听状态分离：关闭网关不会丢失下次启动方案。
- 真实 Key 的内存缓存只包含当前活动路由，路由切换、停止或退出时会清理。
- “动态”页显示当前请求与最近 100 条记录，包括首字/首包、Token、模型、推理强度和实时耗时；记录持久保存在本地 `requests.json`，新请求顶掉最旧记录，任何时候都不保存请求正文。

设置中的“Codex 工具兼容模式”是默认关闭的实验功能。它只在 Codex Responses 请求中将 `custom exec` 与标准 `function exec` 双向转换，不能修复上游裁剪上下文，也不会把正文中的伪工具语法当作命令执行。

## 配置保护

- JSON/JSONC 使用结构化定点编辑，保留注释、未知字段、插件、Hooks 和权限设置。
- Codex 只修改接管时活跃 provider 的 `base_url`，不创建 `keydeck_gateway` provider。
- Codex 的 `model_provider`、`model`、`wire_api`、认证字段和 `auth.json` 均不修改。
- 不读取或覆盖 Codex `auth.json`、MCP、审批策略、沙箱、features、projects、其他 provider 或未知字段。
- 首次接管时捕获字段级基线，并保存一份 DPAPI 加密的完整原文件作为紧急恢复依据。
- 关闭网关时只恢复这些受管字段，不整文件回滚，因此运行期间新增的 MCP、project、注释和其他设置继续保留。
- 如果用户主动切走 provider 或本地 URL，Keydeck 视为已解除接管并跳过恢复。
- 如果客户端仍选择本地网关但受管 URL 被外部修改，Keydeck 会拒绝停止并保持网关运行。
- 多文件配置写入先预检再原子替换，失败时恢复已写文件；启停、分配和自动切换共用同一生命周期锁。

## 密钥安全

方案 Key 使用 Electron `safeStorage` 加密，Windows 下由当前用户的 DPAPI 保护。列表、历史和状态 IPC 不返回明文 Key；复制操作直接由主进程写入系统剪贴板。

接管前的字段基线和完整文件备份保存在 `gateway-recovery.json`，内容使用 DPAPI 加密。正常关闭只执行字段级恢复；完整文件只作为紧急恢复依据。恢复验证成功后，对应备份会被销毁。

## 后台与设置

- 默认关闭 Windows 开机自启，可在设置中开启；开机自启的实例直接驻留托盘，不弹出窗口。
- 默认关闭窗口后驻留托盘；网关运行时始终驻留，防止请求被意外中断。
- 可选择是否在 Keydeck 启动时恢复上次启用的网关。
- 支持跟随系统、浅色和深色主题。

## 开发

需要 Node.js 22 和 pnpm。

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm dist
```

自动测试使用临时目录，不读取或修改真实用户配置。

## 数据目录

```text
%APPDATA%\Keydeck\data\
```

- `profiles.json`：方案与 DPAPI Key 密文。
- `gateway.json`：监听设置、持久化路由和加密本地令牌。
- `gateway-recovery.json`：DPAPI 加密的接管前受管字段基线。
- `settings.json`：自启、托盘、主题和实验功能设置。
- `requests.json`：最近 100 条请求记录摘要（不含请求正文）。
- `window-state.json`：窗口位置、大小与最大化状态。
- `backups/`：旧版事务写入的加密回滚快照。

## Windows 产物

执行 `pnpm dist` 后，最终交付文件整理在 `deliverables/`：

```text
Keydeck-Portable-0.7.8-x64.exe
Keydeck-Setup-0.7.8-x64.exe
Keydeck-0.7.8-source.zip
SHA256SUMS-0.7.8.txt
```

当前构建没有商业代码签名证书，Windows SmartScreen 首次运行可能显示未知发布者。
