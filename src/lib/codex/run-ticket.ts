// P65 — Run tickets for Codex Companion runs.
//
// Before the browser opens a Codex turn against the local companion,
// it asks the hosted server for a "run ticket". The ticket is a
// signed token that:
//
//   - identifies the user, agent, run id, provider mode
//   - declares the budget cap (advisory in P65 alpha)
//   - declares the approval policy
//   - carries an expiration timestamp + nonce
//   - is signed with HMAC-SHA-256 using a server-side secret
//
// The browser passes the ticket to the companion when starting a
// turn. The companion includes the ticket in every event mirrored
// back to the server. The /api/codex/events endpoint verifies the
// ticket signature + expiry before persisting the event so a stale
// or foreign event can't poison a run's trace.
//
// Why HMAC and not a session-bound id? The companion sees the ticket
// in plaintext. We don't want to give the companion the ability to
// forge tickets, so the secret stays on the server and the ticket
// itself is a verifiable bundle. HMAC-SHA-256 with a 32-byte key is
// solid for a tag of this scope.
//
// Storage: the ticket is NOT stored server-side as a row. It's
// stateless. We do log issuance to the trace store (so audits show
// who started a run with what policy), but verification runs purely
// on the cryptographic envelope.
//
// The server-side secret is sourced from APP_SECRET / CODEX_RUN_TICKET_KEY
// (with fallback to the first available secret). If no secret is
// configured, we generate a process-local one — that means tickets
// don't survive a server restart, which is acceptable for a 30-min
// alpha ticket TTL.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ─── Tunables ──────────────────────────────────────────────────────────

// Default ticket lifetime. Long enough for a reasonable Codex run,
// short enough to limit damage if a ticket leaks.
export const RUN_TICKET_TTL_MS = 30 * 60_000; // 30 minutes

// ─── Server-side signing key ──────────────────────────────────────────
//
// Single source of secret bytes for HMAC. Initialized lazily so import
// order doesn't matter and tests can stub via setRunTicketKeyForTest.

let _key: Buffer | null = null;

function loadKey(): Buffer {
  if (_key) return _key;
  const sources = [
    process.env.CODEX_RUN_TICKET_KEY,
    process.env.APP_SECRET,
    process.env.NEXTAUTH_SECRET,
    process.env.SESSION_SECRET,
  ].filter((s): s is string => typeof s === "string" && s.length >= 16);
  if (sources.length > 0) {
    // Hash whichever secret we picked into a 32-byte HMAC key.
    // Same env var across all serverless instances → same derived key.
    _key = createHmac("sha256", "codex-run-ticket-v1").update(sources[0], "utf8").digest();
    return _key;
  }
  // P65.1 — no env secret configured. On Vercel/production this would
  // mean tickets issued by lambda A are unverifiable by lambda B (each
  // gets its own per-process random key). Refuse to operate in that
  // mode in any non-development environment.
  const inProd =
    process.env.VERCEL === "1" ||
    process.env.VERCEL === "true" ||
    !!process.env.VERCEL_ENV ||
    process.env.NODE_ENV === "production";
  if (inProd) {
    throw new Error(
      "CODEX_RUN_TICKET_KEY (or APP_SECRET / NEXTAUTH_SECRET / SESSION_SECRET) must be configured for production. Run-ticket signing requires a stable cross-instance secret of at least 16 chars.",
    );
  }
  // Local dev / unit tests fall back to a random per-process key.
  _key = randomBytes(32);
  return _key;
}

export function setRunTicketKeyForTest(secret: string): void {
  _key = createHmac("sha256", "codex-run-ticket-v1").update(secret, "utf8").digest();
}

// ─── Ticket payload ────────────────────────────────────────────────────

export interface RunTicketPayload {
  v: 1;
  runId: string;
  userId: string;
  orgId: string | null;
  agentId: string | null;
  threadId: string;
  // Codex companion is the only consumer today; we keep this field so
  // a future relay (P66) can reuse the same ticket shape.
  providerMode: "codexChatGPTCompanion" | "codexChatGPTLocal" | "codexChatGPTBridge";
  // Allowed top-level action for this run. Currently only "chat-turn"
  // is recognized; richer policies arrive with P66.
  allowedAction: "chat-turn";
  // Pairing session id this run is bound to (when companion mode).
  pairSessionId: string | null;
  // Approval policy summary the companion must enforce.
  approvalPolicy: {
    require: ("command" | "file" | "network" | "tool")[];
    autoApprove: ("command" | "file" | "network" | "tool")[];
  };
  // Budget cap in micro-USD. Companion mode treats this as ADVISORY
  // only (the user's ChatGPT plan handles real billing). Direct
  // dispatch paths CAN enforce this hard, so the field is shaped the
  // same here for forward compat.
  budgetMicroUsd: number;
  budgetEnforcement: "advisory" | "hard";
  // Where mirrored events should be POSTed. Always our hosted
  // /api/codex/events when we issue the ticket; we still encode it so
  // the companion knows where to send.
  traceTarget: string;
  // Expiry as unix-ms.
  expiresAt: number;
  // Issued-at timestamp.
  iat: number;
  // 32-byte nonce; prevents two tickets that happen to land at the same
  // millisecond from sharing a signature.
  nonce: string;
}

export interface SignedRunTicket {
  // base64url-encoded JSON of the payload.
  payload: string;
  // base64url-encoded HMAC-SHA-256 tag over payload.
  sig: string;
}

// ─── Issue / verify ────────────────────────────────────────────────────

export interface IssueRunTicketOptions {
  runId?: string;
  userId: string;
  orgId?: string | null;
  agentId?: string | null;
  threadId: string;
  providerMode: RunTicketPayload["providerMode"];
  pairSessionId?: string | null;
  approvalPolicy?: Partial<RunTicketPayload["approvalPolicy"]>;
  budgetMicroUsd?: number;
  budgetEnforcement?: "advisory" | "hard";
  traceTarget?: string;
  ttlMs?: number;
  now?: number;
}

export function issueRunTicket(opts: IssueRunTicketOptions): { ticket: SignedRunTicket; payload: RunTicketPayload } {
  const now = opts.now ?? Date.now();
  // For companion mode, budget enforcement defaults to advisory because
  // the cap fires on the user's ChatGPT subscription, not on our
  // direct API spend. We still mirror token usage when codex emits it.
  const budgetEnforcement: "advisory" | "hard" =
    opts.budgetEnforcement ?? (opts.providerMode === "codexChatGPTCompanion" ? "advisory" : "advisory");
  const payload: RunTicketPayload = {
    v: 1,
    runId: opts.runId || `run_${randomBytes(12).toString("hex")}`,
    userId: opts.userId,
    orgId: opts.orgId ?? null,
    agentId: opts.agentId ?? null,
    threadId: opts.threadId,
    providerMode: opts.providerMode,
    pairSessionId: opts.pairSessionId ?? null,
    allowedAction: "chat-turn",
    approvalPolicy: {
      require: opts.approvalPolicy?.require ?? ["command", "file", "network", "tool"],
      autoApprove: opts.approvalPolicy?.autoApprove ?? [],
    },
    budgetMicroUsd: opts.budgetMicroUsd ?? 0,
    budgetEnforcement,
    traceTarget: opts.traceTarget ?? "/api/codex/events",
    expiresAt: now + (opts.ttlMs ?? RUN_TICKET_TTL_MS),
    iat: now,
    nonce: randomBytes(16).toString("hex"),
  };
  const ticket = signTicket(payload);
  return { ticket, payload };
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const std = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(std, "base64");
}

function signTicket(payload: RunTicketPayload): SignedRunTicket {
  const json = JSON.stringify(payload);
  const payloadB64 = base64UrlEncode(Buffer.from(json, "utf8"));
  const sig = createHmac("sha256", loadKey()).update(payloadB64, "utf8").digest();
  return { payload: payloadB64, sig: base64UrlEncode(sig) };
}

export type RunTicketVerification =
  | { ok: true; payload: RunTicketPayload }
  | { ok: false; reason: string };

export function verifyRunTicket(ticket: SignedRunTicket, opts: { now?: number } = {}): RunTicketVerification {
  if (!ticket || typeof ticket.payload !== "string" || typeof ticket.sig !== "string") {
    return { ok: false, reason: "malformed" };
  }
  const expected = createHmac("sha256", loadKey()).update(ticket.payload, "utf8").digest();
  let provided: Buffer;
  try {
    provided = base64UrlDecode(ticket.sig);
  } catch {
    return { ok: false, reason: "bad_signature_encoding" };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: RunTicketPayload;
  try {
    payload = JSON.parse(base64UrlDecode(ticket.payload).toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (payload.v !== 1) return { ok: false, reason: "unsupported_version" };
  const now = opts.now ?? Date.now();
  if (typeof payload.expiresAt !== "number" || payload.expiresAt < now) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}

// Encode for transport over a JSON body or query param.
export function encodeRunTicket(t: SignedRunTicket): string {
  return `${t.payload}.${t.sig}`;
}

export function decodeRunTicket(s: string): SignedRunTicket | null {
  if (typeof s !== "string") return null;
  const ix = s.indexOf(".");
  if (ix < 0) return null;
  const payload = s.slice(0, ix);
  const sig = s.slice(ix + 1);
  if (!payload || !sig) return null;
  return { payload, sig };
}
