// P57 — Codex provider types.
//
// Aligns with the Codex app-server JSON-RPC schema:
//   account/read, account/login/start, account/logout,
//   account/rateLimits/read, thread/start, turn/start.
//
// We deliberately keep our types lean — only the fields we render or
// branch on. The full upstream schema is treated as forward-compatible
// JSON; unknown fields pass through without strict typing.

// ─── Provider mode ───────────────────────────────────────────────────

// Three explicit modes. Selection is always user-driven; we never
// silently switch between billing models or accounts.
//
// P58 — collapsed the platform-vs-BYOK split. resolveSecret already
// falls back from user_secrets to env, so a single "openaiApiKey" mode
// covers both. The three modes the UI exposes are now:
//
//   anthropicApiKey   — Anthropic Claude (default)
//   openaiApiKey      — OpenAI Chat Completions API
//   codexChatGPT      — EXPERIMENTAL Codex via ChatGPT Sign-In bridge
export type CodexProviderMode =
  | "anthropicApiKey"
  | "openaiApiKey"
  | "codexChatGPT";

export const CODEX_PROVIDER_MODES: readonly CodexProviderMode[] = [
  "anthropicApiKey",
  "openaiApiKey",
  "codexChatGPT",
] as const;

// P58 — defensive normalization for legacy values stored in the DB.
// Pre-rework rows might say "openaiUserApiKey"; collapse to "openaiApiKey".
// Anything outside the enum becomes the default mode.
export function normalizeProviderMode(raw: any): CodexProviderMode {
  if (raw === "openaiUserApiKey") return "openaiApiKey";
  if (CODEX_PROVIDER_MODES.includes(raw)) return raw as CodexProviderMode;
  return "anthropicApiKey";
}

// ─── JSON-RPC 2.0 wire types ─────────────────────────────────────────

export interface JsonRpcRequest<P = any> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: P;
}

export interface JsonRpcResponse<R = any> {
  jsonrpc: "2.0";
  id: number | string;
  result?: R;
  error?: JsonRpcError;
}

export interface JsonRpcNotification<P = any> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}

// ─── account/* method shapes ────────────────────────────────────────

// account/read result. Returns whichever auth mode is currently active
// inside app-server, plus optional user metadata when ChatGPT auth.
export interface AccountReadResult {
  authMode: "none" | "chatgpt" | "apiKey";
  email?: string;
  plan?: string;          // "free" | "plus" | "team" | "enterprise" | etc.
  accountId?: string;     // present but never logged
  experimentalApi?: boolean;
}

// account/login/start params. Three login flavors.
export type AccountLoginStartParams =
  | { type: "chatgpt" }                // Browser PKCE — opens login URL
  | { type: "chatgptDeviceCode" }      // Polling device-code flow
  | { type: "apiKey"; apiKey: string }; // BYOK delegation to app-server

// account/login/start result. For "chatgpt" we get a loginUrl (open in
// browser); for device code we get user_code + verification_uri.
export interface AccountLoginStartResult {
  loginUrl?: string;
  userCode?: string;
  verificationUri?: string;
  expiresAt?: number;
  // Internal correlation handle so we can poll/cancel the login flow.
  loginHandle?: string;
}

// account/rateLimits/read result. Surface with caution — never assume
// these fields exist; app-server may return a partial.
export interface AccountRateLimitsResult {
  // Tokens / requests remaining in the user's current ChatGPT plan window.
  tokensRemaining?: number;
  tokensLimit?: number;
  requestsRemaining?: number;
  requestsLimit?: number;
  resetsAt?: number;     // unix ms
  windowSeconds?: number;
  // Free-form per-plan messages app-server passes through (e.g. "5h cooldown").
  message?: string;
}

// ─── thread / turn shapes ───────────────────────────────────────────

export interface ThreadStartParams {
  // Optional title for the Codex thread. Surfaces in the user's Codex
  // history under their ChatGPT account.
  title?: string;
}
export interface ThreadStartResult {
  threadId: string;
}

export interface TurnStartParams {
  threadId: string;
  // The user message + any prior context the app-server should consider.
  // Apps pass minimal payload; app-server retrieves prior turns from its
  // own thread store.
  input: string;
}
export interface TurnStartResult {
  turnId: string;
}

// ─── streamed events from app-server ─────────────────────────────────
//
// app-server emits notifications (no id, has method) on long-running
// turns. We forward these to the chat UI. The full upstream catalogue
// is wider; we only branch on the subset we render today.

export type AppServerNotification =
  | { method: "turn/itemAdded";       params: { turnId: string; item: TurnItem } }
  | { method: "turn/itemUpdated";     params: { turnId: string; item: TurnItem } }
  | { method: "turn/finished";        params: { turnId: string; reason?: string } }
  | { method: "tool/call";            params: { turnId: string; toolName: string; arguments: any; callId: string } }
  | { method: "tool/result";          params: { turnId: string; callId: string; output: string; error?: string } }
  | { method: "command/executionRequested";
      params: { turnId: string; commandId: string; command: string; cwd?: string } }
  | { method: "file/changeRequested";
      params: { turnId: string; changeId: string; path: string; diff: string } }
  | { method: "approval/required";
      params: ApprovalRequest }
  | { method: "log";                  params: { level: "info" | "warn" | "error"; message: string } };

export interface TurnItem {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  content?: string;
  // Free-form for forward-compat.
  [k: string]: any;
}

// ─── approval ───────────────────────────────────────────────────────
//
// app-server pauses turns when the agent wants to do something the user
// must approve. Our UI shows an Accept / Accept-for-session / Decline /
// Cancel chooser; the response method is approval/respond.

export type ApprovalKind = "command" | "file" | "network" | "tool";

export interface ApprovalRequest {
  approvalId: string;
  turnId: string;
  kind: ApprovalKind;
  // Human-readable summary the UI shows above the choice buttons.
  summary: string;
  // Optional detail the UI may render in a collapsible section.
  detail?: string;
  // For command approvals: the command string + cwd. For file: path + diff.
  command?: string;
  cwd?: string;
  path?: string;
  diff?: string;
}

export type ApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export interface ApprovalRespondParams {
  approvalId: string;
  decision: ApprovalDecision;
}

// ─── DB row for the bridge connection ────────────────────────────────
//
// In hosted mode (Vercel), users run codex app-server locally and expose
// it on a loopback WebSocket with a capability token. We store the URL
// + token (encrypted) so our serverless routes can connect on demand.

export interface CodexBridgeConfig {
  // ws://127.0.0.1:8345 or wss://relay.example.com (with TLS).
  url: string;
  // Capability/bearer token the bridge expects via Authorization header.
  capabilityToken: string;
  // Set when the user has explicitly enabled the experimental
  // chatgptAuthTokens flow inside their bridge. We do NOT persist tokens
  // here — only the flag, so the UI can warn the user.
  experimentalApi?: boolean;
}
