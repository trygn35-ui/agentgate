<div align="center">

<img src="docs/images/logo.svg" width="112" alt="Agent;Gate">

# Agent;Gate

[简体中文](README.md) · **繁體中文** · [English](README.en.md) · [日本語](README.ja.md)

**純本機的 API 設定檔管理器與回送閘道**

換中繼服務不必動用戶端設定 · Key 加密存放、絕不落地明文 · 請求即時可觀測

[![Release](https://img.shields.io/github/v/release/trygn35-ui/agentgate?style=flat-square&color=D97757)](https://github.com/trygn35-ui/agentgate/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/trygn35-ui/agentgate/total?style=flat-square&color=3E9067&label=downloads&cacheSeconds=3600)](https://github.com/trygn35-ui/agentgate/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-2F78D0?style=flat-square)](#下載與安裝)
[![License](https://img.shields.io/github/license/trygn35-ui/agentgate?style=flat-square)](LICENSE)

[下載與安裝](#下載與安裝) · [快速上手](#快速上手) · [運作原理](#運作原理) · [安全與隱私](#安全與隱私) · [FAQ](#faq)

<img src="docs/images/overview.png" width="820" alt="Agent;Gate 總覽">

</div>

---

## 為什麼需要 Agent;Gate

如果你同時在用 Claude Code、Codex、OpenCode 或 Gemini CLI，手上又不只一家中繼服務，這些事大概都遇過：

- **換一家服務就得翻設定檔**。`settings.json`、`config.toml`、環境變數各改一輪，改錯還得復原。
- **API Key 明文四散**。用戶端設定、`.env`、shell 歷史紀錄裡到處都是你的 Key。
- **同一把 Key 填好幾遍**。四個用戶端四種設定格式，加一個服務就要重複四次。
- **請求出狀況看不到現場**。是自己設錯、Key 過期，還是上游在限流？只能用猜的。

Agent;Gate 把這些收攏到一個地方：**設定檔存在本機，用戶端只認一個固定的回送位址，換線路在介面上點一下就好。**

|  | 手動改設定 | 環境變數指令碼 | **Agent;Gate** |
| --- | --- | --- | --- |
| 切換線路 | 改多個檔案，容易出錯 | 得重開終端機 | **點一下，用戶端零更動** |
| Key 存放 | 明文四散 | 明文寫在指令碼裡 | **DPAPI 加密，不寫入用戶端** |
| 多用戶端同步 | 每個都要改 | 每個都要匯入 | **指派一次，同時生效** |
| 請求可觀測 | 無 | 無 | **即時首字、Token、快取命中率** |
| 上游故障 | 手動排查再切 | 手動切 | **自動切到可用的最佳線路** |

## 核心特色

- **一鍵切換線路** — Gateway 運作中切換只更新記憶體路由，用戶端設定一個位元組都不動，已送出的請求不受影響。
- **本機回送閘道** — 只監聽 `127.0.0.1`，為四個用戶端各留獨立路徑，不是任意目標的開放 Proxy。
- **Key 不進用戶端** — 真實 URL 與 Key 只交給 Gateway；用戶端裡只有本機位址和一組隨機本機權杖。
- **請求即時監控** — 首字/首位元組延遲、Token 用量、快取命中率、推理強度，色階標示，一眼看出異常。
- **URL 池與自動擇優** — 一個設定檔最多 20 條線路，依 1 小時可用率與平均延遲自動選最佳；當前線路故障立即讓位。
- **線路實測** — 用真實 Key 發一則最小訊息，量真實可用性與延遲，並回顯上游計量的 Token 用量。
- **Session 管理** — 把 Claude Code / Codex / OpenCode 存在本機的 session 攤在同一頁：看對話內容（只留發言，不顯示工具呼叫）、依工作目錄搜尋、刪除前先演練列出會動到的每一處。
- **四種語言** — 簡體中文 / 繁體中文（台灣）/ 日本語 / English，可跟隨系統或手動指定，切換即時生效。
- **純本機執行** — 沒有伺服器、不用帳號、沒有遙測，離線也能管理設定檔。

## 運作原理

```text
Claude Code ─┐                                       ┌─ 設定檔 A：主力中繼
Codex ───────┤                                       ├─ 設定檔 B：備援中繼
OpenCode ────┼──▶  127.0.0.1:17863（Agent;Gate）──────┼─ 設定檔 C：官方直連
Gemini CLI ──┘        注入真實 URL 與 Key            └─ …
```

1. 用戶端裡**只設定一次** `http://127.0.0.1:17863/...`，之後再也不用改。
2. Gateway 收到請求後剝除本機權杖，依當前設定檔注入真實的上游位址與 Key，再原樣轉送。
3. 在介面上換設定檔 = 換 Gateway 的記憶體路由。**用戶端毫無察覺，不必重啟。**
4. 關閉 Gateway 時，Agent;Gate 只把接管前的那幾個欄位還原回去；你在這段期間新增的 MCP、外掛、註解全部保留。

## 螢幕截圖

<details open>
<summary><b>Key 管理</b> — 拖曳排序、累計用量、健康時間線、一鍵切換與實測</summary>
<br>
<img src="docs/images/keyring.png" width="820" alt="Key 頁面">
</details>

<details>
<summary><b>請求監控</b> — 首字延遲、Token、快取率即時更新</summary>
<br>
<img src="docs/images/activity.png" width="820" alt="動態頁面">
</details>

<details>
<summary><b>設定</b> — 開機自動啟動、系統匣常駐、語言、佈景主題與自動更新</summary>
<br>
<img src="docs/images/settings.png" width="820" alt="設定頁面">
</details>

<details>
<summary><b>深色主題</b></summary>
<br>
<img src="docs/images/overview-dark.png" width="820" alt="深色主題">
</details>

## 下載與安裝

前往 **[Releases](https://github.com/trygn35-ui/agentgate/releases/latest)** 下載：

| 檔案 | 說明 |
| --- | --- |
| `AgentGate-Setup-<版本>-x64.exe` | 安裝版，**支援自動更新**，建議使用 |
| `AgentGate-Portable-<版本>-x64.exe` | 免安裝版，不支援自動更新 |
| `SHA256SUMS-<版本>.txt` | 總和檢查碼，可核對安裝檔完整性 |

**系統需求**：Windows 10 (1809+) 或 Windows 11，x64。不需要額外的執行環境。

> [!NOTE]
> 目前的組建沒有商業程式碼簽章憑證，第一次執行時 Windows SmartScreen 會顯示「發行者不明」。
> 點 **其他資訊 → 仍要執行** 即可。介意的話可以先用 `SHA256SUMS` 核對安裝檔，或直接從原始碼建置。

## 快速上手

1. **建立設定檔** — 在「Key」頁點「新增」，填入名稱、API 協定、上游 URL 和 Key。Key 輸入後立即加密儲存。
2. **勾選適用的用戶端** — 一個設定檔可以同時給多個協定相容的用戶端使用。
3. **指派給用戶端** — 在「總覽」頁每張用戶端卡片下方點「選擇 Key」，挑一個設定檔。
4. **點卡片接管** — 點用戶端卡片本體，Gateway 啟動並只接管這一個用戶端；其他用戶端一個位元組都不動。再點一下即斷開還原。
5. **照常使用用戶端** — 請求經 Gateway 轉送，在「動態」頁即時查看延遲與用量。

之後再換線路只要重複第 3 步——**不必碰任何設定檔，不必重啟用戶端。**

## 用戶端支援

| 用戶端 | 設定位置 | Agent;Gate 管理的欄位 |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | 本機 Base URL、本機驗證、選用的模型與 Tool Search |
| Codex | `~/.codex/config.toml` | 已有 provider 時只改它的 `base_url`；全新設定則整段建立 Gateway provider，斷開時整段移除 |
| OpenCode | `~/.config/opencode/opencode.json(c)` | `provider.agentgate_gateway`、模型選擇與本機驗證 |
| Gemini CLI | `~/.gemini/.env`、`~/.gemini/settings.json` | 本機 Base URL、本機驗證、選用的模型與驗證類型 |

支援 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GEMINI_CLI_HOME`、`OPENCODE_CONFIG`、`XDG_CONFIG_HOME` 與 `XDG_DATA_HOME` 路徑覆寫。

<details>
<summary>Agent;Gate 如何保護你既有的設定</summary>
<br>

- JSON/JSONC 採結構化定點編輯，保留註解、未知欄位、外掛、Hooks 與權限設定。
- Codex 已有作用中 provider 時只改它的 `base_url`，不碰 `model`、`wire_api`、驗證欄位和 `auth.json`；從沒設定過 provider 的全新使用者則整段建立、斷開時整段移除，原有的 `mcp_servers` 等內容原樣保留。
- 首次接管時擷取欄位層級的基準，並保存一份 DPAPI 加密的完整原始檔，作為緊急復原依據。
- 關閉 Gateway 時只還原這些受管欄位，**不做整檔回滾**，期間新增的 MCP、project、註解繼續保留。
- 如果你手動把 provider 切走了，Agent;Gate 視為已解除接管並跳過還原。
- 多檔寫入先預檢再原子替換，失敗時回滾已寫入的檔案。

</details>

## 安全與隱私

這是一個經手 API Key 的工具，所以下面每一條都寫成**可驗證的事實**，而不是承諾：

- **沒有伺服器、不用帳號、沒有遙測。** 網路請求只會送往你設定的上游；當你在設定頁主動檢查或下載更新時，也會存取 GitHub Releases。可以用封包擷取工具自行確認。
- **Key 以 Windows DPAPI 加密**（Electron `safeStorage`，繫結目前的 Windows 使用者），密文存在 `%APPDATA%\agentgate\data\profiles.json`。換使用者或換機器都解不開。
- **真實 Key 絕不寫入用戶端設定檔。** 用戶端裡只有 `127.0.0.1` 位址和一組隨機本機權杖。清單與狀態 IPC 不回傳明文 Key；複製動作由主行程直接寫入系統剪貼簿。
- **不保存請求內文。** 請求監控只記錄延遲、Token 計數、模型名稱等中繼資料，任何時候都不把請求或回應內容寫入磁碟。
- **Gateway 只繫結回送位址**，不監聽區域網路，且只為四個用戶端提供固定路徑，不是通用 Proxy。
- **可驗證的安裝檔** — 每個 Release 附 `SHA256SUMS`，原始碼完全公開，可自行建置比對。

> [!IMPORTANT]
> 你需要自行以合法方式取得上游或中繼服務的 API Key，並遵守其服務條款與所在地的法規。
> Agent;Gate 只是本機工具，不提供任何 API 服務，也不對你使用的上游服務負責。

## 資料目錄

```text
%APPDATA%\agentgate\data\
├── profiles.json           設定檔與 DPAPI 加密的 Key 密文
├── gateway.json            監聽設定、持久化路由與加密本機權杖
├── gateway-recovery.json   接管前的受管欄位基準（DPAPI 加密）
├── settings.json           自動啟動、系統匣、佈景主題與實驗功能
├── requests.json           最近的請求中繼資料（不含內文）
└── window-state.json       視窗位置與大小
```

解除安裝後如需徹底清理，刪除上面整個目錄即可。

## 自動更新

安裝版透過 GitHub Releases 自動更新：在設定頁檢查更新、背景下載，重啟即安裝。
**安裝前會先停止 Gateway 並還原用戶端設定**，所以更新不會把用戶端留在失效的本機位址上。
免安裝版無法就地取代自身，只會提示新版本並引導到下載頁。

## FAQ

<details>
<summary><b>Windows 顯示「發行者不明」或被防毒軟體攔截？</b></summary>
<br>

沒有購買程式碼簽章憑證（一年要價數百美元），所有未簽章的 Electron 應用程式都會這樣。
點 **其他資訊 → 仍要執行**。介意的話請核對 `SHA256SUMS`，或從原始碼自行建置。

</details>

<details>
<summary><b>連接埠 17863 被占用了怎麼辦？</b></summary>
<br>

不用管。首次接管撞上連接埠占用時會**自動換一個空閒的連接埠**，並把新連接埠寫進用戶端設定；
尚未接管任何用戶端時，點右上角的連接埠號碼也可以手動隨機換一個。
已有用戶端在接管中時連接埠會鎖定——它們的設定裡寫著目前的連接埠，不會被悄悄改掉。

</details>

<details>
<summary><b>切換線路需要重啟用戶端嗎？</b></summary>
<br>

不需要。Gateway 運作中切換只改記憶體路由，用戶端設定位元組不變。
已送出的請求繼續走原本的上游，新請求走新線路。

</details>

<details>
<summary><b>Key 存在哪裡？換電腦怎麼搬？</b></summary>
<br>

存在 `%APPDATA%\agentgate\data\profiles.json`，以 DPAPI 加密並**繫結目前的 Windows 使用者**。
正因如此，直接把這個檔案複製到另一台機器是**解不開的**——換機後需要重新輸入 Key。

</details>

<details>
<summary><b>請求紀錄會保存我的對話內容嗎？</b></summary>
<br>

不會。只記錄延遲、Token 數量、模型名稱等中繼資料，請求與回應內文任何時候都不寫入磁碟。

</details>

<details>
<summary><b>關閉 Gateway 後，用戶端設定會變回去嗎？</b></summary>
<br>

會。Agent;Gate 只把首次接管時改動的那幾個欄位還原回去，其他內容（包括你在這段期間新增的 MCP、外掛、註解）原樣保留。
如果偵測到受管欄位被外部修改，會拒絕停止 Gateway，以免覆蓋你的變更。

</details>

<details>
<summary><b>跟 one-api / new-api / claude-code-router 有什麼不同？</b></summary>
<br>

那些是**伺服器端**的中繼分發平台：要部署、有資料庫、面向多使用者。
Agent;Gate 是**桌面單機工具**：不用部署、沒有遙測，只有主動檢查更新時會連到 GitHub，並只服務你自己的幾個 CLI 用戶端，
核心價值在「換線路不必動用戶端設定」和「Key 加密、絕不落地明文」。

</details>

## 開發

需要 Node.js 22 與 pnpm。

```powershell
pnpm install --frozen-lockfile
pnpm test        # 單元測試（使用暫存目錄，不讀寫真實設定）
pnpm dev         # 開發模式
pnpm dist        # 打包 Windows 安裝版與免安裝版
pnpm release     # 整理交付檔案與總和檢查碼
```

技術堆疊：Electron + React + TypeScript。主行程負責全部檔案寫入與金鑰處理，轉譯行程沒有檔案系統存取權。

<details>
<summary><code>pnpm dist</code> 報 <code>Cannot create symbolic link</code></summary>

electron-builder 會下載並解壓 `winCodeSign` 工具包（圖示與版本資訊要靠裡面的 `rcedit` 寫進 exe）。
這個壓縮檔含 macOS 的 dylib **符號連結**，而 Windows 上非系統管理員帳戶預設沒有建立符號連結的權限，
解壓失敗會直接中止建置。

兩種解法，擇一即可：

- 開啟 Windows 的**開發人員模式**（設定 → 系統 → 開發人員選項），一般帳戶即可建立符號連結；
- 或手動把工具包解壓到快取目錄，跳過 darwin 部分：

  ```powershell
  $cache = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
  # 從 electron-builder-binaries 下載 winCodeSign-2.6.0.7z 後：
  7za x winCodeSign-2.6.0.7z "-o$cache\winCodeSign-2.6.0" '-x!darwin*' -y
  ```

不要用 `signAndEditExecutable: false` 繞過——那個開關會連 `rcedit` 一起關掉，
打出來的 exe 會留著 Electron 內建的圖示、`ProductName: Electron` 和 33.x 的版本號。

</details>

## 致謝

- [Electron](https://www.electronjs.org/) · [electron-builder](https://www.electron.build/) · [electron-updater](https://www.electron.build/auto-update)
- [Lucide](https://lucide.dev/) 圖示
- 靈感來自社群中各式 LLM Gateway 與中繼管理工具

## License

[MIT](LICENSE)
