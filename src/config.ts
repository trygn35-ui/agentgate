import packageJson from "../package.json";
import type {
  BootstrapData,
  ClientTarget,
  Protocol,
  SaveProfileInput,
} from "./types";
import type { AppSettings } from "./types";

export const APP_VERSION = packageJson.version;

export interface ProtocolMeta {
  label: string;
  short: string;
  tone: string;
  compatible: ClientTarget[];
}

export interface ClientMeta {
  label: string;
  short: string;
}

export const PROTOCOL_META: Record<Protocol, ProtocolMeta> = {
  anthropic: {
    label: "Anthropic Messages",
    short: "Anthropic",
    tone: "accent",
    compatible: ["claude", "opencode"],
  },
  "openai-responses": {
    label: "OpenAI Responses",
    short: "Responses",
    tone: "good",
    compatible: ["codex", "opencode"],
  },
  "openai-chat": {
    label: "OpenAI Chat Completions",
    short: "Chat",
    tone: "warn",
    compatible: ["codex", "opencode"],
  },
  gemini: {
    label: "Google Gemini",
    short: "Gemini",
    tone: "violet",
    compatible: ["gemini", "opencode"],
  },
};

export const CLIENT_META: Record<ClientTarget, ClientMeta> = {
  claude: { label: "Claude Code", short: "Claude" },
  codex: { label: "Codex", short: "Codex" },
  opencode: { label: "OpenCode", short: "OpenCode" },
  gemini: { label: "Gemini CLI", short: "Gemini" },
};

export const CLIENT_TARGET_ORDER: ClientTarget[] = [
  "claude",
  "codex",
  "opencode",
  "gemini",
];

export const DEFAULT_SETTINGS: AppSettings = {
  launchAtLogin: false,
  closeToTray: true,
  startGatewayOnLaunch: true,
  theme: "system",
  experimentalToolBridge: false,
};

export const EMPTY_BOOTSTRAP: BootstrapData = {
  profiles: [],
  clients: [],
  history: [],
  gateway: {
    status: "stopped",
    host: "127.0.0.1",
    port: 17863,
    targets: [],
    routes: [],
  },
  settings: DEFAULT_SETTINGS,
  activeRequests: [],
};

export const BLANK_PROFILE_INPUT: SaveProfileInput = {
  name: "",
  protocol: "anthropic",
  baseUrl: "",
  endpoints: [{ url: "" }],
  apiKey: "",
  model: "",
  authMode: "bearer",
  targets: ["claude"],
  enableToolSearch: true,
  autoSwitch: {
    enabled: false,
    intervalMinutes: 2,
  },
};
