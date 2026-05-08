// Composio integration layer.
//
// Composio handles OAuth + credential storage + API execution for 500+
// third-party services. We use `@composio/core` directly (no provider
// package) and manually convert Composio's tool schemas to Anthropic format.
//
// Each Hyperagent user (u_xxx) maps directly to a Composio userId.

import { Composio } from "@composio/core";

let _composio: any = null;

function client() {
  if (_composio) return _composio;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is required");
  _composio = new Composio({ apiKey });
  return _composio;
}

export interface ToolkitInfo {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  authSchemes: string[];
  noAuth: boolean;
}

let _toolkitCache: ToolkitInfo[] | null = null;
let _toolkitCacheAt = 0;

export async function listToolkits(force = false): Promise<ToolkitInfo[]> {
  const now = Date.now();
  if (!force && _toolkitCache && now - _toolkitCacheAt < 1000 * 60 * 30) return _toolkitCache;
  try {
    const c = client();
    const result = await (c.toolkits?.list?.() ?? c.apps?.list?.());
    const items: any[] = Array.isArray(result) ? result : (result?.items || result?.toolkits || result?.apps || []);
    _toolkitCache = items.map((t: any) => ({
      slug: t.slug || t.key || t.name?.toLowerCase()?.replace(/\s+/g, "_") || "",
      name: t.meta?.name || t.name || t.slug,
      description: t.meta?.description || t.description || "",
      logo: t.meta?.logo || t.logo || null,
      categories: t.meta?.categories || t.categories || [],
      authSchemes: t.auth_schemes || t.authSchemes || [],
      noAuth: t.no_auth || t.noAuth || false,
    })).filter(t => t.slug);
    _toolkitCacheAt = now;
    return _toolkitCache;
  } catch (e: any) {
    console.error("[composio] toolkits.list failed", e?.message);
    return [];
  }
}

export async function initiateConnection(userId: string, toolkitSlug: string, callbackUrl?: string) {
  try {
    const c = client();
    const fn = c.connectedAccounts?.initiate || c.connections?.initiate;
    const conn = await fn.call(c.connectedAccounts || c.connections, userId, toolkitSlug, { callbackUrl });
    return {
      redirectUrl: conn?.redirectUrl || conn?.redirect_url || conn?.connectionUrl,
      connectedAccountId: conn?.id || conn?.connectedAccountId,
      status: conn?.status,
    };
  } catch (e: any) {
    console.error("[composio] initiate failed", e?.message);
    throw e;
  }
}

export async function listConnectedAccounts(userId: string) {
  try {
    const c = client();
    const fn = c.connectedAccounts?.list || c.connections?.list;
    const result = await fn.call(c.connectedAccounts || c.connections, { userIds: [userId] });
    const items: any[] = Array.isArray(result) ? result : (result?.items || []);
    return items;
  } catch (e: any) {
    console.error("[composio] connectedAccounts.list failed", e?.message);
    return [];
  }
}

export async function deleteConnection(connectedAccountId: string) {
  try {
    const c = client();
    const fn = c.connectedAccounts?.delete || c.connections?.delete;
    await fn.call(c.connectedAccounts || c.connections, connectedAccountId);
    return true;
  } catch (e: any) {
    console.error("[composio] delete failed", e?.message);
    return false;
  }
}

// Returns raw tool list, normalized to Anthropic format.
export async function getComposioTools(userId: string, toolkits: string[]) {
  if (!toolkits.length) return [];
  try {
    const c = client();
    const fn = c.tools?.get || c.actions?.list;
    const raw = await fn.call(c.tools || c.actions, { toolkits, apps: toolkits, userId });
    const items: any[] = Array.isArray(raw) ? raw : (raw?.items || raw?.tools || raw?.actions || []);
    return items.map((t: any) => ({
      name: t.name || t.slug || t.key,
      description: t.description || "",
      input_schema: t.input_schema || t.parameters || t.inputSchema || { type: "object", properties: {} },
    })).filter(t => t.name);
  } catch (e: any) {
    console.error("[composio] tools.get failed", e?.message);
    return [];
  }
}

export async function executeComposioTool(userId: string, name: string, input: any): Promise<string> {
  try {
    const c = client();
    const fn = c.tools?.execute || c.actions?.execute;
    const res = await fn.call(c.tools || c.actions, name, { userId, arguments: input, params: input });
    if (typeof res === "string") return res;
    if (res?.data) return JSON.stringify(res.data).slice(0, 6000);
    return JSON.stringify(res).slice(0, 6000);
  } catch (e: any) {
    return `Composio error: ${e?.message || String(e)}`;
  }
}
