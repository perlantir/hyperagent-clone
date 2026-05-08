// Tool registry. Two layers:
//   1. Built-in tools that always work (web_search, generate_artifact, slack_notify stub)
//   2. Composio-managed tools for connected toolkits (Slack, Gmail, Linear, GitHub, etc.)
//      Composio handles OAuth + execution. We just merge the tool schemas in.

import { getComposioTools, executeComposioTool, listConnectedAccounts } from "./composio";

export interface ToolDef {
  name: string;
  description: string;
  input_schema: any;
  execute: (args: any, ctx: ToolCtx) => Promise<string>;
}

export interface ToolCtx {
  userId: string;
  threadId: string;
  messageId: string;
  artifactsCreated: { id: string; type: string; title: string }[];
}

async function ddgSearch(query: string): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    });
    const html = await res.text();
    const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const links: { title: string; url: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html))) {
      const decoded = m[1].startsWith("//duckduckgo.com/l/?uddg=")
        ? decodeURIComponent(m[1].split("uddg=")[1].split("&")[0])
        : m[1];
      links.push({ url: decoded, title: stripTags(m[2]) });
    }
    const snips: string[] = [];
    while ((m = snipRe.exec(html))) snips.push(stripTags(m[1]));
    const out: string[] = [];
    for (let i = 0; i < Math.min(links.length, 6); i++) {
      out.push(`${i+1}. ${links[i].title}\n   ${links[i].url}\n   ${snips[i] || ""}`);
    }
    return out.length ? out.join("\n\n") : "No results.";
  } catch (e: any) {
    return `Search failed: ${e.message}`;
  }
}

function stripTags(s: string) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
}

export const BUILTIN_TOOLS: Record<string, ToolDef> = {
  web_search: {
    name: "web_search",
    description: "Search the public web. Returns up to 6 results with titles, URLs, and snippets.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async execute(args) {
      const q = String(args?.query || "").trim();
      if (!q) return "Empty query.";
      return await ddgSearch(q);
    },
  },
  generate_artifact: {
    name: "generate_artifact",
    description: "Create a persistent artifact (webpage, document, table, image) saved to this thread. Body should be HTML body content.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["webpage","document","table","image"] },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["type","title","body"],
    },
    async execute(args, ctx) {
      const { createArtifact } = await import("./db");
      const a = await createArtifact({
        threadId: ctx.threadId, messageId: ctx.messageId,
        type: args.type, title: args.title, body: args.body,
      });
      ctx.artifactsCreated.push({ id: a.id, type: a.type, title: a.title });
      return `Artifact saved: id=${a.id} title="${a.title}"`;
    },
  },
};

// Anthropic-format tool spec
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: any;
}

// Resolve all tools for a chat turn:
//   - Always includes BUILTIN_TOOLS that match the agent's tool list
//   - Adds Composio tools for any toolkits the user has connected
export async function resolveAllTools(
  userId: string,
  agentToolNames: string[],
): Promise<{ tools: AnthropicTool[]; composioToolNames: Set<string>; builtinTools: ToolDef[] }> {
  // Built-ins requested by the agent
  const builtinTools: ToolDef[] = [];
  for (const name of agentToolNames) {
    if (BUILTIN_TOOLS[name]) builtinTools.push(BUILTIN_TOOLS[name]);
  }

  // Discover the user's connected Composio toolkits
  const connected = await listConnectedAccounts(userId);
  const connectedToolkits = Array.from(
    new Set(connected.map((c: any) => c.toolkit?.slug || c.appName || c.app_name).filter(Boolean)),
  ) as string[];

  // Pull Anthropic-format tool defs for those toolkits
  const composioTools = await getComposioTools(userId, connectedToolkits);

  const tools: AnthropicTool[] = [
    ...builtinTools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    ...composioTools.map((t: any) => ({
      name: t.name,
      description: t.description || "",
      input_schema: t.input_schema || t.inputSchema || { type: "object", properties: {} },
    })),
  ];
  const composioToolNames = new Set(composioTools.map((t: any) => t.name));
  return { tools, composioToolNames, builtinTools };
}

export async function executeAnyTool(
  name: string,
  args: any,
  ctx: ToolCtx,
  composioToolNames: Set<string>,
  builtinTools: ToolDef[],
): Promise<string> {
  const builtin = builtinTools.find(t => t.name === name);
  if (builtin) return await builtin.execute(args, ctx);
  if (composioToolNames.has(name)) return await executeComposioTool(ctx.userId, name, args);
  return `Unknown tool: ${name}`;
}
