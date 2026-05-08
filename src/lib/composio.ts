// Composio integration layer.
//
// Composio handles OAuth + credential storage + API execution for 500+
// third-party services. We use:
//   - @composio/core for the main client
//   - @composio/anthropic for the provider that emits Anthropic-format tools
//
// Each Hyperagent user (u_xxx) maps directly to a Composio userId.
// When a user "connects" a toolkit (Slack, Gmail, etc.) they go through
// Composio's hosted OAuth flow and we get back a connectedAccountId.

import { Composio } from "@composio/core";
import { AnthropicProvider } from "@composio/anthropic";

let _composio: any = null;

export function composio() {
  if (_composio) return _composio;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is required");
  _composio = new Composio({ apiKey, provider: new AnthropicProvider() });
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

// Cached toolkit catalog (refreshed on demand).
let _toolkitCache: ToolkitInfo[] | null = null;
let _toolkitCacheAt = 0;

export async function listToolkits(force = false): Promise<ToolkitInfo[]> {
  const now = Date.now();
  if (!force && _toolkitCache && now - _toolkitCacheAt < 1000 * 60 * 30) return _toolkitCache;
  try {
    const result = await composio().toolkits.list();
    const items: any[] = Array.isArray(result) ? result : (result?.items || result?.toolkits || []);
    _toolkitCache = items.map((t: any) => ({
      slug: t.slug || t.name?.toLowerCase()?.replace(/\s+/g, "_") || "",
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

// Initiate a connection. Returns an OAuth URL the user needs to visit.
export async function initiateConnection(userId: string, toolkitSlug: string, callbackUrl?: string) {
  const conn = await composio().connectedAccounts.initiate(userId, toolkitSlug, {
    callbackUrl,
  } as any);
  return {
    redirectUrl: conn?.redirectUrl || conn?.redirect_url || conn?.connectionUrl,
    connectedAccountId: conn?.id || conn?.connectedAccountId,
    status: conn?.status,
  };
}

// List the user's connected accounts.
export async function listConnectedAccounts(userId: string) {
  try {
    const result = await composio().connectedAccounts.list({ userIds: [userId] } as any);
    const items: any[] = Array.isArray(result) ? result : (result?.items || []);
    return items;
  } catch (e: any) {
    console.error("[composio] connectedAccounts.list failed", e?.message);
    return [];
  }
}

// Disconnect (delete) a connection.
export async function deleteConnection(connectedAccountId: string) {
  try {
    await composio().connectedAccounts.delete(connectedAccountId);
    return true;
  } catch (e: any) {
    console.error("[composio] delete failed", e?.message);
    return false;
  }
}

// Get tools (Anthropic format) for a user across the requested toolkits.
export async function getComposioTools(userId: string, toolkits: string[]) {
  if (!toolkits.length) return [];
  try {
    const tools = await composio().tools.get(userId, { toolkits });
    return Array.isArray(tools) ? tools : [];
  } catch (e: any) {
    console.error("[composio] tools.get failed", e?.message);
    return [];
  }
}

// Execute a Composio tool call (when Claude invokes one).
export async function executeComposioTool(userId: string, name: string, input: any): Promise<string> {
  try {
    const result = await composio().provider.executeToolCall(
      userId,
      { id: `tu_${Date.now()}`, type: "tool_use", name, input } as any,
      {} as any,
    );
    if (typeof result === "string") return result;
    return JSON.stringify(result).slice(0, 6000);
  } catch (e: any) {
    return `Composio error: ${e?.message || String(e)}`;
  }
}
