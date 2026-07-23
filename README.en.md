<div align="center">

<img src="docs/images/logo.svg" width="112" alt="Agent;Gate">

# Agent;Gate

[简体中文](README.md) · [繁體中文](README.zh-TW.md) · **English** · [日本語](README.ja.md)

**Local-only API profile manager & loopback gateway**

Switch providers without touching client configs · Keys encrypted, never written to disk in plaintext · Live request observability

[![Release](https://img.shields.io/github/v/release/trygn35-ui/agentgate?style=flat-square&color=D97757)](https://github.com/trygn35-ui/agentgate/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/trygn35-ui/agentgate/total?style=flat-square&color=3E9067&label=downloads&cacheSeconds=3600)](https://github.com/trygn35-ui/agentgate/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-2F78D0?style=flat-square)](#download--install)
[![License](https://img.shields.io/github/license/trygn35-ui/agentgate?style=flat-square)](LICENSE)

[Download & Install](#download--install) · [Quick Start](#quick-start) · [How It Works](#how-it-works) · [Security & Privacy](#security--privacy) · [FAQ](#faq)

<img src="docs/images/overview.png" width="820" alt="Agent;Gate overview">

</div>

---

## Why Agent;Gate

If you run Claude Code, Codex, OpenCode, or Gemini CLI with more than one API provider or relay, you've probably hit all of these:

- **Switching providers means editing config files.** `settings.json`, `config.toml`, environment variables — one slip and you're rolling back.
- **API keys in plaintext everywhere.** Client configs, `.env` files, shell history — your keys are scattered across all of them.
- **The same key, entered four times.** Four clients, four config formats; adding one provider means repeating yourself four times.
- **No visibility when requests fail.** Misconfiguration? Expired key? Upstream rate limit? You're left guessing.

Agent;Gate collapses all of this into one place: **profiles live locally, clients only ever see one fixed loopback address, and switching is a single click in the UI.**

|  | Editing configs by hand | Env-var scripts | **Agent;Gate** |
| --- | --- | --- | --- |
| Switching providers | Multiple files, error-prone | Restart your terminal | **One click, clients untouched** |
| Key storage | Plaintext everywhere | Plaintext in scripts | **DPAPI-encrypted, never written to clients** |
| Multi-client sync | Edit each one | Export for each | **Assign once, applies everywhere** |
| Request observability | None | None | **Live TTFT, tokens, cache hit rate** |
| Upstream failures | Diagnose & switch by hand | Switch by hand | **Auto-failover to the best healthy route** |

## Features

- **One-click profile switching** — While the gateway is running, switching only updates in-memory routes. Client configs stay byte-for-byte identical; in-flight requests are unaffected.
- **Local loopback gateway** — Listens on `127.0.0.1` only, with a dedicated path slot per client. Not an open proxy to arbitrary destinations.
- **Keys never reach clients** — Real URLs and keys are known only to the gateway; clients get a local address and a random local token.
- **Live request monitoring** — TTFT/TTFB latency, token usage, cache hit rate, reasoning effort — color-graded so anomalies stand out at a glance.
- **URL pools with auto-failover** — Up to 20 endpoints per profile, ranked by 1-hour availability and mean latency; a failing route yields immediately.
- **Real probes** — Send one minimal message with your actual key to measure real availability and latency, echoing the upstream's token accounting.
- **Session manager** — Local sessions from Claude Code / Codex / OpenCode in one place: read transcripts (speech only, tool calls filtered out), search by workspace, and dry-run every deletion before it happens.
- **Four languages** — Simplified Chinese / Traditional Chinese (Taiwan) / Japanese / English; follows the system or set manually, switches instantly.
- **Fully local** — No server, no account, no telemetry. Works offline.

## How It Works

```text
Claude Code ─┐                                        ┌─ Profile A: primary relay
Codex ───────┤                                        ├─ Profile B: backup relay
OpenCode ────┼──▶  127.0.0.1:17863 (Agent;Gate) ──────┼─ Profile C: official API
Gemini CLI ──┘      injects real URL & key            └─ …
```

1. Clients are configured with `http://127.0.0.1:17863/...` **once** — and never again.
2. The gateway strips the local token, injects the real upstream URL and key for the current profile, and forwards the request unchanged.
3. Switching profiles in the UI = swapping the gateway's in-memory route. **Clients never notice; no restart needed.**
4. When the gateway disengages, Agent;Gate restores only the fields it took over. MCP servers, plugins, and comments you added in the meantime are preserved.

## Screenshots

<details open>
<summary><b>Keyring</b> — drag to reorder, cumulative usage, health timeline, one-click switch & probe</summary>
<br>
<img src="docs/images/keyring.png" width="820" alt="Keyring page">
</details>

<details>
<summary><b>Request monitor</b> — TTFT, tokens, cache rate, refreshed live</summary>
<br>
<img src="docs/images/activity.png" width="820" alt="Activity page">
</details>

<details>
<summary><b>Settings</b> — launch at login, tray, language, theme, auto-update</summary>
<br>
<img src="docs/images/settings.png" width="820" alt="Settings page">
</details>

<details>
<summary><b>Dark theme</b></summary>
<br>
<img src="docs/images/overview-dark.png" width="820" alt="Dark theme">
</details>

## Download & Install

Grab it from **[Releases](https://github.com/trygn35-ui/agentgate/releases/latest)**:

| File | Notes |
| --- | --- |
| `AgentGate-Setup-<version>-x64.exe` | Installer, **auto-updates**, recommended |
| `AgentGate-Portable-<version>-x64.exe` | Portable, no install, no auto-update |
| `SHA256SUMS-<version>.txt` | Checksums for verifying the download |

**Requirements**: Windows 10 (1809+) or Windows 11, x64. No extra runtime needed.

> [!NOTE]
> These builds are not signed with a commercial code-signing certificate, so Windows SmartScreen will warn about an "unknown publisher" on first launch.
> Click **More info → Run anyway**. If that bothers you, verify against `SHA256SUMS` first, or build from source.

## Quick Start

1. **Create a profile** — On the Keys page, click New and fill in a name, API protocol, upstream URL, and key. The key is encrypted the moment you save.
2. **Pick compatible clients** — One profile can serve every client that speaks its protocol.
3. **Assign it** — On the Overview page, click **Select key** under a client card and pick the profile.
4. **Click the card to engage** — The gateway starts and takes over *that client only*; every other client stays byte-for-byte untouched. Click again to disengage and restore.
5. **Use your clients as usual** — Requests flow through the gateway; watch latency and usage live on the Activity page.

From then on, switching providers is just step 3 again — **no config files, no client restarts.**

## Client Support

| Client | Config location | Fields managed by Agent;Gate |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | Local base URL, local auth, optional model & Tool Search |
| Codex | `~/.codex/config.toml` | With an existing provider: its `base_url` only. Fresh config: creates a gateway provider, removed cleanly on disengage |
| OpenCode | `~/.config/opencode/opencode.json(c)` | `provider.agentgate_gateway`, model selection, local auth |
| Gemini CLI | `~/.gemini/.env`, `~/.gemini/settings.json` | Local base URL, local auth, optional model & auth type |

Path overrides via `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `OPENCODE_CONFIG`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME` are respected.

<details>
<summary>How Agent;Gate protects your existing configs</summary>
<br>

- JSON/JSONC files are edited surgically and structurally — comments, unknown fields, plugins, hooks, and permission settings are preserved.
- With an existing active Codex provider, only its `base_url` is changed — `model`, `wire_api`, auth fields, and `auth.json` are never touched. For a brand-new user with no provider configured, a gateway provider is created whole and removed whole on disengage; your `mcp_servers` and other content stay exactly as they were.
- On first takeover, a field-level baseline is captured, plus a DPAPI-encrypted copy of the full original file as a disaster-recovery fallback.
- Disengaging restores only the managed fields — **no whole-file rollback** — so MCP servers, projects, and comments added in the meantime survive.
- If you manually switch the provider away, Agent;Gate treats that as a release and skips restoration.
- Multi-file writes are pre-checked and committed atomically, with rollback on failure.

</details>

## Security & Privacy

This tool handles API keys, so each claim below is written as a **verifiable fact**, not a promise:

- **No server, no account, no telemetry.** Network requests go only to your configured upstreams and, when you explicitly check or download an update in Settings, GitHub Releases. You can confirm this with a packet capture.
- **Keys are encrypted with Windows DPAPI** (Electron `safeStorage`, bound to your Windows user), stored as ciphertext in `%APPDATA%\agentgate\data\profiles.json`. A different user or machine cannot decrypt them.
- **Real keys are never written to client configs.** Clients only see a `127.0.0.1` address and a random local token. List/state IPC never returns plaintext keys; the copy action writes to the system clipboard directly from the main process.
- **Request bodies are never stored.** Monitoring records latency, token counts, and model names — request and response content never touches disk.
- **The gateway binds to loopback only**, never the LAN, and serves fixed path slots for four clients — it is not a general-purpose proxy.
- **Verifiable artifacts** — every release ships with `SHA256SUMS`, and the source is fully open for building your own.

> [!IMPORTANT]
> You are responsible for obtaining API keys legitimately and complying with your providers' terms of service and local law.
> Agent;Gate is a local tool only; it provides no API service and takes no responsibility for the upstreams you use.

## Data Directory

```text
%APPDATA%\agentgate\data\
├── profiles.json           Profiles & DPAPI-encrypted key ciphertext
├── gateway.json            Listener settings, persisted routes, encrypted local token
├── gateway-recovery.json   Pre-takeover managed-field baselines (DPAPI-encrypted)
├── settings.json           Autostart, tray, theme, experimental flags
├── requests.json           Metadata for recent requests (no bodies)
└── window-state.json       Window position & size
```

To fully clean up after uninstalling, delete this directory.

## Auto-Update

The installer edition updates through GitHub Releases: check on the Settings page, download in the background, restart to apply.
**The gateway is stopped and client configs are restored before installing**, so an update never strands clients on a dead local address.
The portable edition can't replace itself in place; it notifies you and links to the download page.

## FAQ

<details>
<summary><b>Windows says "unknown publisher" / my antivirus flags it</b></summary>
<br>

There's no commercial code-signing certificate (they cost hundreds of dollars a year); every unsigned Electron app triggers this.
Click **More info → Run anyway**. If in doubt, verify `SHA256SUMS` or build from source.

</details>

<details>
<summary><b>What if port 17863 is taken?</b></summary>
<br>

Nothing to do. If the first takeover hits a port conflict, Agent;Gate **automatically moves to a free port** and writes the new port into the client configs.
While no client is engaged, you can also click the port number in the top bar to re-roll it manually.
Once clients are engaged the port is locked — their configs reference it, so it will never change silently.

</details>

<details>
<summary><b>Do I need to restart clients after switching profiles?</b></summary>
<br>

No. While the gateway runs, switching only changes in-memory routes — client configs stay byte-for-byte identical.
Requests already in flight keep their original upstream; new requests use the new profile.

</details>

<details>
<summary><b>Where are keys stored? How do I migrate to a new machine?</b></summary>
<br>

In `%APPDATA%\agentgate\data\profiles.json`, DPAPI-encrypted and **bound to your Windows user**.
That binding is the point — copying the file to another machine **cannot be decrypted**. Re-enter your keys after moving.

</details>

<details>
<summary><b>Does request monitoring store my conversations?</b></summary>
<br>

No. Only metadata — latency, token counts, model names. Request and response bodies never touch disk.

</details>

<details>
<summary><b>Do client configs revert when I stop the gateway?</b></summary>
<br>

Yes. Agent;Gate restores exactly the fields it changed at takeover; everything else — including MCP servers, plugins, and comments you added since — is left alone.
If managed fields were modified externally, it refuses to stop rather than overwrite your changes.

</details>

<details>
<summary><b>How is this different from one-api / new-api / claude-code-router?</b></summary>
<br>

Those are **server-side** relay/dispatch platforms: deployed, with databases, built for multiple users.
Agent;Gate is a **single-user desktop tool**: nothing to deploy and no telemetry; only explicit update checks contact GitHub, and the gateway serves your own CLI clients.
Its core value is "switch providers without touching client configs" and "keys encrypted, never on disk in plaintext".

</details>

## Development

Requires Node.js 22 and pnpm.

```powershell
pnpm install --frozen-lockfile
pnpm test        # unit tests (temp dirs only, never touches real configs)
pnpm dev         # development mode
pnpm dist        # package Windows installer & portable builds
pnpm release     # collect deliverables & checksums
```

Stack: Electron + React + TypeScript. The main process owns all file writes and key handling; the renderer has no filesystem access.

<details>
<summary><code>pnpm dist</code> fails with <code>Cannot create symbolic link</code></summary>

electron-builder downloads and extracts the `winCodeSign` toolkit (its `rcedit` is what stamps the icon and version info into the exe).
The archive contains macOS dylib **symlinks**, and non-admin Windows accounts can't create symlinks by default, so extraction aborts the build.

Two fixes, either works:

- Enable Windows **Developer Mode** (Settings → System → For developers) so regular accounts can create symlinks;
- Or extract the toolkit into the cache manually, skipping the darwin parts:

  ```powershell
  $cache = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
  # after downloading winCodeSign-2.6.0.7z from electron-builder-binaries:
  7za x winCodeSign-2.6.0.7z "-o$cache\winCodeSign-2.6.0" '-x!darwin*' -y
  ```

Do **not** work around it with `signAndEditExecutable: false` — that switch also disables `rcedit`,
leaving the exe with Electron's stock icon, `ProductName: Electron`, and a 33.x version number.

</details>

## Credits

- [Electron](https://www.electronjs.org/) · [electron-builder](https://www.electron.build/) · [electron-updater](https://www.electron.build/auto-update)
- Icons by [Lucide](https://lucide.dev/)
- Inspired by the community's many LLM gateway and relay-management tools

## License

[MIT](LICENSE)
