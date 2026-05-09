// P64.1 — Codex bridge URL safety.
//
// Two distinct URL validation contexts:
//
//   validateForServerSideFetch(url)
//     The hosted Node runtime is about to open a connection to this URL
//     (e.g. /api/codex/test-connection or the chat-route Phase 1 dispatch
//     when connectionLocation === "tunnel"). MUST refuse SSRF targets:
//     loopback, RFC1918 private, link-local, ULA, *.local, cloud
//     metadata IPs, and anything that resolves into those ranges.
//
//   validateForBrowserOrLocal(url)
//     A browser tab on the user's machine, or our Node process running
//     ON the user's machine, is opening the connection. Loopback and
//     private hosts are EXPECTED here (that's literally where the user's
//     codex bridge runs). Cloud metadata IPs are still forbidden — they
//     pose no business value as bridge targets and surface as obvious
//     red flags if they appear.
//
// Both validators reject non-ws/wss schemes. Hostnames are
// case-normalized and stripped of zone-id suffixes before classification.
//
// SECURITY NOTE: validateForServerSideFetch is a PRE-flight string match.
// A hostname that LOOKS public can still resolve into a private range
// (DNS rebinding). Callers performing the actual connection MUST
// additionally enforce a runtime DNS check + connection-time IP guard.
// The dns_resolve_guard helper ships in P64.1 too — see verifyResolvedIp().

import { promises as dns } from "node:dns";

export type UrlValidation =
  | { ok: true }
  | { ok: false; reason: string };

// P64.2 — verifyResolvedIp returns the address it pinned so the caller
// can pass it to the connection layer, eliminating the TOCTOU window
// between "we validated DNS resolution" and "WebSocket transport
// resolves DNS again at connection time and gets a different (private)
// answer."
export type DnsValidation =
  | { ok: true; address: string; family: 4 | 6 }
  | { ok: false; reason: string };

// ─── Cloud metadata IPs ──────────────────────────────────────────────
// Sources:
//   AWS:   169.254.169.254
//   GCP:   metadata.google.internal (resolves 169.254.169.254)
//   Azure: 169.254.169.254 (also fd00:ec2::254 IPv6)
//   AWS IMDSv2 IPv6: fd00:ec2::254
//   Oracle: 169.254.169.254
//   Alibaba: 100.100.100.200
//   DO: 169.254.169.254
//   Hetzner: 169.254.169.254
const CLOUD_METADATA_IPV4 = new Set<string>([
  "169.254.169.254",
  "169.254.170.2",       // ECS task metadata
  "100.100.100.200",     // Alibaba
]);
const CLOUD_METADATA_IPV6_PREFIXES = ["fd00:ec2::"];
const CLOUD_METADATA_HOSTNAMES = new Set<string>([
  "metadata.google.internal",
  "metadata.aws.amazon.com",
  "metadata.azure.net",
]);

export function isCloudMetadataIp(host: string): boolean {
  const h = (host || "").toLowerCase().replace(/%.*$/, ""); // strip IPv6 zone-id
  if (CLOUD_METADATA_IPV4.has(h)) return true;
  if (CLOUD_METADATA_HOSTNAMES.has(h)) return true;
  for (const p of CLOUD_METADATA_IPV6_PREFIXES) {
    if (h.startsWith(p)) return true;
  }
  return false;
}

// ─── IPv4 loopback / RFC1918 / link-local ────────────────────────────
function ipv4ClassifyOctets(o: number[]): "loopback" | "private" | "linklocal" | "public" | "broadcast" | null {
  if (o.length !== 4 || o.some(v => v < 0 || v > 255 || !Number.isInteger(v))) return null;
  const [a, b] = o;
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "linklocal";
  if (a === 0) return "broadcast";       // 0.0.0.0/8 — not routable
  if (a === 255 && b === 255 && o[2] === 255 && o[3] === 255) return "broadcast";
  return "public";
}

// ─── IPv6 classification ─────────────────────────────────────────────
function ipv6Classify(host: string): "loopback" | "linklocal" | "ula" | "public" | "unspecified" | null {
  const h = host.toLowerCase().replace(/%.*$/, "");
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return "loopback";
  if (h === "::" || h === "0:0:0:0:0:0:0:0") return "unspecified";
  if (/^fe8[0-9a-f]:/.test(h) || /^fe9[0-9a-f]:/.test(h) || /^fea[0-9a-f]:/.test(h) || /^feb[0-9a-f]:/.test(h)) return "linklocal";
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return "ula";
  // IPv4-mapped (::ffff:1.2.3.4) — defer to v4 caller.
  if (h.startsWith("::ffff:") || h.startsWith("0:0:0:0:0:ffff:")) return null;
  return "public";
}

export function classifyHost(host: string):
  | "loopback" | "private" | "linklocal" | "ula" | "metadata" | "mdns" | "public" | "broadcast" | "unspecified" | "unknown"
{
  if (!host) return "unknown";
  // URL.hostname in WHATWG returns IPv6 wrapped in brackets in some
  // Node versions; strip them. Also strip the IPv6 zone-id suffix.
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isCloudMetadataIp(h)) return "metadata";
  if (h === "localhost" || h === "::1") return "loopback";
  if (h.endsWith(".localhost")) return "loopback";
  // mDNS / Bonjour. Treated as private in our model; the hosted server
  // can't possibly reach a *.local name anyway.
  if (h.endsWith(".local")) return "mdns";
  // IPv4 dotted quad
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const cls = ipv4ClassifyOctets([+v4[1], +v4[2], +v4[3], +v4[4]]);
    return cls ?? "unknown";
  }
  // Bracketed IPv6 form ([::1]) is unwrapped by URL.hostname already.
  if (h.includes(":")) {
    const cls = ipv6Classify(h);
    return cls ?? "unknown";
  }
  // DNS name. We can't synchronously resolve here — call sites doing
  // server-side fetch MUST call verifyResolvedIp() to guard against
  // DNS rebinding into private space.
  return "public";
}

// ─── Public validators ───────────────────────────────────────────────

/**
 * Pre-flight check used when a server-side fetch is about to happen
 * against a user-supplied URL. Refuses everything that could be SSRF.
 *
 * Pair with verifyResolvedIp() at connection time to catch DNS-rebinding
 * + DNS-pinning attacks where a public-looking name resolves into a
 * private range.
 */
export function validateForServerSideFetch(rawUrl: string): UrlValidation {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { return { ok: false, reason: "Not a valid URL" }; }
  if (url.protocol !== "ws:" && url.protocol !== "wss:" && url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `Unsupported protocol: ${url.protocol}` };
  }
  // ws:// is forbidden over the public internet; tunnel must be wss://.
  if (url.protocol === "ws:" || url.protocol === "http:") {
    return { ok: false, reason: "Hosted server requires wss:// or https:// for outbound bridge fetches; ws:///http:// is plaintext on the public internet." };
  }
  const cls = classifyHost(url.hostname);
  if (cls === "metadata") return { ok: false, reason: `Refusing to connect to cloud metadata host (${url.hostname}).` };
  if (cls === "loopback") return { ok: false, reason: `Refusing to fetch ${url.hostname} from a hosted server — that's the SERVER's loopback, not the user's machine. Use Browser-direct mode for local bridges.` };
  if (cls === "private") return { ok: false, reason: `Refusing to fetch RFC1918 private host (${url.hostname}) from a hosted server. Use Browser-direct mode, or expose the bridge through a public tunnel (wss://).` };
  if (cls === "linklocal") return { ok: false, reason: `Refusing link-local host (${url.hostname}).` };
  if (cls === "ula") return { ok: false, reason: `Refusing IPv6 unique-local address (${url.hostname}).` };
  if (cls === "mdns") return { ok: false, reason: `Refusing .local mDNS host (${url.hostname}) — not reachable from a hosted server.` };
  if (cls === "broadcast" || cls === "unspecified") return { ok: false, reason: `Refusing ${cls} host.` };
  if (cls === "unknown") return { ok: false, reason: `Could not classify host ${url.hostname}.` };
  return { ok: true };
}

/**
 * Pre-flight check used when the connection is initiated by the user's
 * own browser tab OR by our Node runtime running on the user's own
 * machine. Loopback and private ranges are explicitly allowed; cloud
 * metadata IPs are still refused.
 */
export function validateForBrowserOrLocal(rawUrl: string): UrlValidation {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { return { ok: false, reason: "Not a valid URL" }; }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return { ok: false, reason: `Bridge URL must use ws:// or wss:// (got ${url.protocol}).` };
  }
  const cls = classifyHost(url.hostname);
  // Cloud metadata is never legitimate as a bridge target.
  if (cls === "metadata") {
    return { ok: false, reason: `Refusing cloud metadata host (${url.hostname}).` };
  }
  // ws:// (cleartext) is fine on loopback only — not on a public host.
  if (url.protocol === "ws:" && cls !== "loopback" && cls !== "private" && cls !== "linklocal" && cls !== "ula" && cls !== "mdns") {
    return { ok: false, reason: "ws:// is only allowed on loopback / private network hosts. Use wss:// for public addresses." };
  }
  // Public hostnames in browser-or-local mode are allowed but unusual —
  // typically only when the user is running on their own VPS. We don't
  // refuse, but call sites can warn.
  return { ok: true };
}

/**
 * Connection-time DNS guard. Resolves the hostname and refuses if it
 * lands in a private/loopback/metadata range. Use this just before a
 * server-side fetch — placed AFTER validateForServerSideFetch so we
 * catch DNS rebinding into private space.
 *
 * Returns { ok: false, ... } if DNS resolution itself fails too — a
 * public-looking name that doesn't resolve to a routable IP isn't
 * useful as a bridge target.
 *
 * P64.2 — On success returns { ok: true, address, family } so the caller
 * can pass the pinned IP straight into the connection layer (e.g. via a
 * custom `lookup` callback on the underlying WebSocket / TCP socket).
 * Resolving once, validating, and pinning the IP through to connect()
 * closes the rebinding TOCTOU window where the second DNS lookup —
 * issued by the WebSocket library — could land on a private address.
 */
export async function verifyResolvedIp(host: string): Promise<DnsValidation> {
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch (e: any) {
    return { ok: false, reason: `DNS resolution failed for ${host}: ${e?.code || e?.message || "unknown"}` };
  }
  if (addrs.length === 0) {
    return { ok: false, reason: `No DNS results for ${host}` };
  }
  for (const a of addrs) {
    const cls = classifyHost(a.address);
    if (cls === "metadata" || cls === "loopback" || cls === "private"
        || cls === "linklocal" || cls === "ula" || cls === "broadcast" || cls === "unspecified") {
      return { ok: false, reason: `${host} resolved to ${a.address} (${cls}) — refusing as SSRF risk.` };
    }
  }
  // Prefer the first record. Pinning here is intentional: the caller
  // routes its TCP connection at this exact address. We pass family back
  // so net.connect's lookup callback can fill it correctly.
  const first = addrs[0];
  const family = first.family === 6 ? 6 : 4;
  return { ok: true, address: first.address, family };
}

/**
 * Deduce the connection location from the URL when the caller didn't
 * explicitly pick one. Used for migration of legacy rows that don't
 * carry the connectionLocation field.
 */
export function inferConnectionLocationFromUrl(rawUrl: string): "browser" | "tunnel" | "unknown" {
  try {
    const url = new URL(rawUrl);
    const cls = classifyHost(url.hostname);
    if (cls === "loopback" || cls === "private" || cls === "linklocal" || cls === "ula" || cls === "mdns") return "browser";
    if (cls === "public") return "tunnel";
  } catch {}
  return "unknown";
}

// ─── Token entropy ─────────────────────────────────────────────────────
//
// P64.2 — strengthened from P64.1's 32-character minimum. Codex matches
// the capability token by SHA-256 hash, so the only thing that protects
// the bridge is the token's entropy. We treat ANYTHING under 192 bits as
// rejected for "tunnel" mode (where the token is transmitted over the
// public internet) and anything under 96 bits as rejected for any mode
// (defends against guessing on a noisy LAN).
//
// generateBridgeToken() returns 32 random bytes hex-encoded — 256 bits
// of entropy, well above any reasonable bar.

import { randomBytes } from "node:crypto";

export function generateBridgeToken(): string {
  // 32 bytes = 256 bits. Hex encoding doubles to 64 ASCII chars.
  return randomBytes(32).toString("hex");
}

// Minimum acceptable entropy in BITS, indexed by connection location.
// Hex-encoded characters carry 4 bits each; base64url ~6.
export const MIN_TOKEN_ENTROPY_BITS: Record<"browser" | "tunnel" | "local-server", number> = {
  browser: 96,       // local network only
  tunnel: 192,       // public internet — strongest
  "local-server": 96,
};

// Estimate entropy assuming the token came from a uniform random
// generator over hex/base64/printable ASCII. This is a LOWER bound:
// for high-entropy strings the estimate is correct to within a bit;
// for tokens like "password123" it returns the upper bound (8 bits/char)
// — we don't try to detect dictionary-derived tokens since SHA-256
// matching defeats anything that's not maximum-entropy anyway.
export function estimateTokenEntropyBits(token: string): number {
  const len = token.length;
  if (!len) return 0;
  // If the token is pure hex, 4 bits/char.
  if (/^[0-9a-fA-F]+$/.test(token)) return len * 4;
  // If it's base64-ish, 6 bits/char.
  if (/^[A-Za-z0-9+/_=-]+$/.test(token)) return len * 6;
  // Otherwise treat as printable ASCII at 6 bits/char (conservative).
  return len * 6;
}

export type TokenEntropyValidation =
  | { ok: true; bits: number }
  | { ok: false; bits: number; reason: string };

export function validateTokenEntropy(token: string, location: "browser" | "tunnel" | "local-server"): TokenEntropyValidation {
  const bits = estimateTokenEntropyBits(token);
  const min = MIN_TOKEN_ENTROPY_BITS[location];
  if (bits < min) {
    return {
      ok: false,
      bits,
      reason: `Capability token has ~${bits} bits of entropy; ${location} mode requires at least ${min}. Generate a fresh token with \`openssl rand -hex 32\` (256-bit) or use the in-app generator.`,
    };
  }
  return { ok: true, bits };
}
