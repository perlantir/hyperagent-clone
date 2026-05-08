// Composio integration (P19) — real REST client, no SDK dependency.
//
// Uses raw fetch against api.composio.dev v3 / v3.1 endpoints. Avoids the
// SDK version churn that broke us in earlier rounds. Each user can save
// their own COMPOSIO_API_KEY in Settings → API Keys; we fall back to the
// platform env var if they haven't.
//
// Surface area:
//   - listToolkits(userId)            → catalog of available integrations
//   - listConnectedAccounts(userId)   → what THIS user has authenticated
//   - initiateConnection(userId,slug,callbackUrl?) → returns redirect_url
//   - deleteConnection(userId,id)     → revoke a connected account
//   - getComposioTools(userId, toolkits[]) → JSON-schema'd tools for chat loop
//   - executeComposioTool(userId, name, args) → run a tool on user's behalf

import { resolveSecret } from "./secrets";

const COMPOSIO_BASE = "https://backend.composio.dev";

async function key(userId: string | null | undefined): Promise<string | null> {
  return resolveSecret(userId, "composio");
}

async function composioFetch(
  userId: string | null | undefined,
  path: string,
  init: RequestInit = {},
): Promise<any> {
  const k = await key(userId);
  if (!k) throw new Error("Composio API key not configured. Add one in Settings → API Keys.");
  const url = path.startsWith("http") ? path : `${COMPOSIO_BASE}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": k,
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Composio ${path} ${r.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// =================== TOOLKITS (apps) ===================

export interface ToolkitInfo {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  authSchemes: string[];
  noAuth: boolean;
}

// In-memory cache. Toolkit catalog rarely changes — refresh once per cold start.
let _toolkitCache: { ts: number; data: ToolkitInfo[] } | null = null;
const TOOLKIT_TTL_MS = 10 * 60 * 1000;

export async function listToolkits(userId: string | null = null): Promise<ToolkitInfo[]> {
  if (_toolkitCache && Date.now() - _toolkitCache.ts < TOOLKIT_TTL_MS) return _toolkitCache.data;
  try {
    // v3 returns { items: [{ slug, name, meta: { description, logo, categories }, auth_schemes, ... }] }
    const j = await composioFetch(userId, "/api/v3/toolkits?limit=200");
    const items: any[] = j.items || [];
    const out: ToolkitInfo[] = items.map(t => ({
      slug: t.slug,
      name: t.name || t.slug,
      description: t.meta?.description || t.description || "",
      logo: t.meta?.logo || null,
      categories: t.meta?.categories || [],
      authSchemes: t.auth_schemes || t.authSchemes || [],
      noAuth: !!t.no_auth,
    }));
    _toolkitCache = { ts: Date.now(), data: out };
    return out;
  } catch (e: any) {
    console.error("[listToolkits]", e.message);
    return [];
  }
}

// =================== CONNECTED ACCOUNTS ===================

export interface ConnectedAccount {
  id: string;
  toolkit: { slug: string };
  status: string;
  user_id?: string;
  createdAt: number;
}

export async function listConnectedAccounts(userId: string): Promise<ConnectedAccount[]> {
  try {
    const params = new URLSearchParams({ user_ids: userId, limit: "100" });
    const j = await composioFetch(userId, `/api/v3.1/connected_accounts?${params}`);
    const items: any[] = j.items || [];
    return items.map(a => ({
      id: a.id,
      toolkit: { slug: a.toolkit?.slug || a.toolkit_slug || "" },
      status: a.status,
      user_id: a.user_id,
      createdAt: a.created_at ? Date.parse(a.created_at) : Date.now(),
    }));
  } catch (e: any) {
    console.error("[listConnectedAccounts]", e.message);
    return [];
  }
}

// =================== AUTH CONFIG LOOKUP ===================

// To initiate a connection we need an auth_config_id. For Composio-managed
// auth configs (the default for popular toolkits), one already exists per
// toolkit. We look it up at runtime and cache the toolkit→auth_config_id map.

let _authConfigCache: Map<string, string> | null = null;

async function findAuthConfigForToolkit(userId: string, toolkitSlug: string): Promise<string | null> {
  if (_authConfigCache?.has(toolkitSlug)) return _authConfigCache.get(toolkitSlug)!;
  if (!_authConfigCache) _authConfigCache = new Map();
  try {
    // GET /api/v3/auth_configs?toolkit_slugs=<slug>
    const params = new URLSearchParams({ toolkit_slugs: toolkitSlug, limit: "10" });
    const j = await composioFetch(userId, `/api/v3/auth_configs?${params}`);
    const items: any[] = j.items || [];
    // Prefer composio-managed; fall back to first.
    const composioManaged = items.find(c => c.is_composio_managed);
    const chosen = composioManaged || items[0];
    if (chosen?.id) {
      _authConfigCache.set(toolkitSlug, chosen.id);
      return chosen.id;
    }
  } catch (e: any) {
    console.error("[findAuthConfigForToolkit]", toolkitSlug, e.message);
  }
  return null;
}

// =================== INITIATE / LINK ===================

export interface InitiateResult {
  redirectUrl: string | null;
  connectedAccountId: string | null;
  status: string;
}

export async function initiateConnection(
  userId: string,
  toolkitSlug: string,
  callbackUrl?: string,
): Promise<InitiateResult> {
  const authConfigId = await findAuthConfigForToolkit(userId, toolkitSlug);
  if (!authConfigId) {
    return {
      redirectUrl: null, connectedAccountId: null,
      status: `no_auth_config_for_${toolkitSlug}`,
    };
  }
  try {
    // POST /api/v3/connected_accounts with { auth_config: { id }, connection: { user_id, callback_url? } }
    // The shape evolved in v3 — try the spec'd body first, fall back if rejected.
    const body: any = {
      auth_config: { id: authConfigId },
      connection: { user_id: userId },
    };
    if (callbackUrl) body.connection.callback_url = callbackUrl;
    const j = await composioFetch(userId, `/api/v3/connected_accounts`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return {
      redirectUrl: j.redirect_url || j.connectionData?.redirect_url || null,
      connectedAccountId: j.id || null,
      status: j.status || "pending",
    };
  } catch (e: any) {
    console.error("[initiateConnection]", e.message);
    return { redirectUrl: null, connectedAccountId: null, status: "error" };
  }
}

export async function deleteConnection(userId: string, connectedAccountId: string): Promise<boolean> {
  try {
    await composioFetch(userId, `/api/v3/connected_accounts/${connectedAccountId}`, { method: "DELETE" });
    return true;
  } catch (e: any) {
    console.error("[deleteConnection]", e.message);
    return false;
  }
}

// =================== TOOLS ===================

export interface ComposioToolSchema {
  name: string;
  description: string;
  input_schema: any;
  toolkit_slug: string;
}

// Cache tool schemas per toolkit. JSON-schema definitions are static enough
// to cache for the lambda lifetime.
const _toolsCache = new Map<string, { ts: number; data: ComposioToolSchema[] }>();
const TOOLS_TTL_MS = 30 * 60 * 1000;

async function listToolsForToolkit(userId: string | null, toolkitSlug: string): Promise<ComposioToolSchema[]> {
  const cached = _toolsCache.get(toolkitSlug);
  if (cached && Date.now() - cached.ts < TOOLS_TTL_MS) return cached.data;
  try {
    const params = new URLSearchParams({ toolkit_slugs: toolkitSlug, limit: "50" });
    const j = await composioFetch(userId, `/api/v3/tools?${params}`);
    const items: any[] = j.items || [];
    const out: ComposioToolSchema[] = items.map(t => ({
      // Composio tool slugs are uppercase like GITHUB_CREATE_ISSUE — keep as-is for the LLM.
      name: t.slug || t.name,
      description: t.description || "",
      input_schema: t.input_parameters || t.input_schema || { type: "object", properties: {} },
      toolkit_slug: t.toolkit?.slug || toolkitSlug,
    }));
    _toolsCache.set(toolkitSlug, { ts: Date.now(), data: out });
    return out;
  } catch (e: any) {
    console.error(`[listToolsForToolkit ${toolkitSlug}]`, e.message);
    return [];
  }
}

// Resolve all tools for the given toolkits (only those the user has connected).
// Returns Anthropic-shaped tool defs ready to pass into the chat tool loop.
export async function getComposioTools(
  userId: string,
  toolkitSlugs: string[],
): Promise<{ name: string; description: string; input_schema: any }[]> {
  if (!toolkitSlugs.length) return [];
  const arrays = await Promise.all(toolkitSlugs.map(s => listToolsForToolkit(userId, s)));
  return arrays.flat().map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

// Execute a Composio tool on behalf of the user. Returns a string result
// (JSON-stringified data or error message) suitable for feeding back to the
// chat tool loop.
export async function executeComposioTool(
  userId: string,
  toolName: string,
  args: any,
): Promise<string> {
  try {
    const j = await composioFetch(userId, `/api/v3.1/tools/execute/${toolName}`, {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        arguments: args || {},
      }),
    });
    // Common shapes: { successful, data, error }
    if (j.successful === false) {
      return `Tool error: ${j.error || "unknown"}`;
    }
    const payload = j.data ?? j;
    const str = typeof payload === "string" ? payload : JSON.stringify(payload);
    // Truncate to keep tool output sane in the chat context window.
    return str.length > 8000 ? str.slice(0, 8000) + "\n…[truncated]" : str;
  } catch (e: any) {
    return `Tool execution failed: ${e.message}`;
  }
}
