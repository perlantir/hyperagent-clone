// P66c — Vercel → relay HMAC client.
//
// Tiny helper Vercel server-side code uses to call the relay's
// /dispatch + /cancel + /connections/:id endpoints. Signs every
// request with HMAC-SHA-256 over the body (or, for GET, over the
// method+path string). The shared secret is RELAY_SHARED_SECRET.

import { createHmac } from "node:crypto";

const RELAY_BASE = process.env.CODEX_RELAY_URL || "";
const RELAY_SHARED_SECRET = process.env.RELAY_SHARED_SECRET || "";

export class RelayNotConfiguredError extends Error {
  constructor() {
    super("Codex relay is not configured (CODEX_RELAY_URL + RELAY_SHARED_SECRET)");
  }
}

function hmacHex(content: string): string {
  return createHmac("sha256", RELAY_SHARED_SECRET).update(content).digest("hex");
}

export interface DispatchPacket {
  runId: string;
  companionId: string;
  kind: "run_dispatch" | "approval_decision" | "cancel";
  payload: any;
}

export async function relayDispatch(packet: DispatchPacket): Promise<{ delivered: boolean; reason?: string }> {
  if (!RELAY_BASE || !RELAY_SHARED_SECRET) throw new RelayNotConfiguredError();
  const path = packet.kind === "cancel" ? "/cancel" : "/dispatch";
  const body = JSON.stringify(packet);
  const res = await fetch(RELAY_BASE.replace(/\/+$/, "") + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-relay-signature": hmacHex(body),
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 200 && json?.ok) return { delivered: true };
  if (res.status === 202 || json?.reason === "companion_offline") {
    return { delivered: false, reason: "companion_offline" };
  }
  return { delivered: false, reason: json?.reason || `relay_${res.status}` };
}

export async function relayConnectionStatus(companionId: string): Promise<{ online: boolean; since?: number }> {
  if (!RELAY_BASE || !RELAY_SHARED_SECRET) throw new RelayNotConfiguredError();
  const path = `/connections/${encodeURIComponent(companionId)}`;
  const res = await fetch(RELAY_BASE.replace(/\/+$/, "") + path, {
    headers: { "x-relay-signature": hmacHex(`GET ${path}`) },
  });
  if (!res.ok) return { online: false };
  const j = await res.json().catch(() => ({}));
  return { online: !!j.online, since: j.since ?? undefined };
}

// Verifies a relay → Vercel HMAC on /api/codex/relay/inbox &
// /api/codex/relay/dispatch-receipt.
export function verifyRelayHmac(rawBody: string, signatureHeader: string | null): boolean {
  if (!RELAY_SHARED_SECRET) return false;
  if (!signatureHeader) return false;
  const expected = hmacHex(rawBody);
  if (expected.length !== signatureHeader.length) return false;
  // timingSafeEqual on hex strings via Buffer.
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signatureHeader, "hex");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
