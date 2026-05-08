// Tool registry. Two layers:
//   1. Built-in tools that always work (web_search, generate_artifact, slack_notify stub)
//   2. Connector-derived tools that only resolve when the user has credentials configured
//      for that connector.

import { CONNECTORS } from "./connectors";
import { getConnectorCredentialsForId } from "./db";

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
      const a = createArtifact({
        threadId: ctx.threadId, messageId: ctx.messageId,
        type: args.type, title: args.title, body: args.body,
      });
      ctx.artifactsCreated.push({ id: a.id, type: a.type, title: a.title });
      return `Artifact saved: id=${a.id} title="${a.title}"`;
    },
  },
  slack_notify: {
    name: "slack_notify",
    description: "Quick stub that logs a Slack notification (use slack_send_message after connecting Slack for the real thing).",
    input_schema: {
      type: "object",
      properties: { channel: { type: "string" }, message: { type: "string" } },
      required: ["channel","message"],
    },
    async execute(args) {
      console.log(`[slack_notify stub] ${args.channel}: ${args.message}`);
      return `[stub] would post to ${args.channel}: ${String(args.message).slice(0,200)}`;
    },
  },
};

// Connector-derived tools.
async function makeConnectorTool(toolName: string, connectorId: string, userId: string): Promise<ToolDef | null> {
  const conn = CONNECTORS[connectorId];
  if (!conn) return null;
  const creds = getConnectorCredentialsForId(userId, connectorId);
  if (!creds) return null;
  // Each tool has its own implementation. We define a generic stub for now;
  // in a real build each maps to the connector's actual API.
  const handlers: Record<string, ToolDef> = {
    slack_send_message: {
      name: "slack_send_message",
      description: "Send a message to a Slack channel using the connected Slack workspace.",
      input_schema: { type: "object", properties: { channel: { type: "string" }, text: { type: "string" } }, required: ["channel","text"] },
      async execute(args) {
        try {
          const r = await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${creds.credentials.botToken}` },
            body: JSON.stringify({ channel: args.channel, text: args.text }),
          });
          const j = await r.json();
          return j.ok ? `Posted to ${args.channel}` : `Slack error: ${j.error}`;
        } catch (e: any) { return `Slack error: ${e.message}`; }
      },
    },
    gmail_search: {
      name: "gmail_search",
      description: "Search Gmail using a Gmail query string (after Gmail is connected).",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async execute(args) {
        // For brevity we don't implement the real OAuth flow — return a structured stub.
        return `[gmail_search stub] would search "${args.query}" against ${creds.credentials.email}`;
      },
    },
    gmail_send: {
      name: "gmail_send",
      description: "Send an email via Gmail (stub).",
      input_schema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to","subject","body"] },
      async execute(args) { return `[gmail_send stub] would email ${args.to} subject="${args.subject}"`; },
    },
    linear_search_issues: {
      name: "linear_search_issues",
      description: "Search Linear issues by query.",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async execute(args) {
        try {
          const r = await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": creds.credentials.apiKey },
            body: JSON.stringify({ query: `query { issues(first:10, filter:{ title: { contains: "${String(args.query).replace(/"/g,'\\"')}" } }) { nodes { id title state { name } team { name } } } }` }),
          });
          const j = await r.json();
          return JSON.stringify(j?.data?.issues?.nodes || []).slice(0, 4000);
        } catch (e: any) { return `Linear error: ${e.message}`; }
      },
    },
    linear_create_issue: {
      name: "linear_create_issue",
      description: "Create a Linear issue.",
      input_schema: { type: "object", properties: { teamId: { type: "string" }, title: { type: "string" }, description: { type: "string" } }, required: ["teamId","title"] },
      async execute(args) { return `[linear_create_issue stub] team=${args.teamId} title="${args.title}"`; },
    },
    notion_search: {
      name: "notion_search",
      description: "Search Notion pages.",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async execute(args) { return `[notion_search stub] q="${args.query}"`; },
    },
    notion_append: {
      name: "notion_append", description: "Append a block to a Notion page.",
      input_schema: { type: "object", properties: { pageId: { type: "string" }, text: { type: "string" } }, required: ["pageId","text"] },
      async execute(args) { return `[notion_append stub] pageId=${args.pageId}`; },
    },
    stripe_list_charges: {
      name: "stripe_list_charges", description: "List recent Stripe charges.",
      input_schema: { type: "object", properties: { limit: { type: "number" } } },
      async execute(args) {
        try {
          const r = await fetch(`https://api.stripe.com/v1/charges?limit=${args.limit || 10}`, {
            headers: { "Authorization": `Bearer ${creds.credentials.apiKey}` },
          });
          const j = await r.json();
          return JSON.stringify((j.data || []).map((c: any) => ({ id: c.id, amount: c.amount, currency: c.currency, status: c.status, created: c.created })), null, 2);
        } catch (e: any) { return `Stripe error: ${e.message}`; }
      },
    },
    stripe_get_customer: {
      name: "stripe_get_customer", description: "Get a Stripe customer by ID.",
      input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async execute(args) {
        try {
          const r = await fetch(`https://api.stripe.com/v1/customers/${args.id}`, { headers: { "Authorization": `Bearer ${creds.credentials.apiKey}` } });
          return JSON.stringify(await r.json()).slice(0, 4000);
        } catch (e: any) { return `Stripe error: ${e.message}`; }
      },
    },
    github_search: {
      name: "github_search", description: "Search GitHub for repos or issues.",
      input_schema: { type: "object", properties: { q: { type: "string" }, type: { type: "string", enum: ["repos","issues"] } }, required: ["q","type"] },
      async execute(args) {
        try {
          const r = await fetch(`https://api.github.com/search/${args.type}?q=${encodeURIComponent(args.q)}`, {
            headers: { "Authorization": `Bearer ${creds.credentials.token}`, "Accept": "application/vnd.github+json" },
          });
          const j = await r.json();
          return JSON.stringify((j.items || []).slice(0, 8).map((i: any) => ({ name: i.full_name || i.title, url: i.html_url, desc: i.description || i.body?.slice(0, 200) })), null, 2);
        } catch (e: any) { return `GitHub error: ${e.message}`; }
      },
    },
    github_create_issue: {
      name: "github_create_issue", description: "Create a GitHub issue.",
      input_schema: { type: "object", properties: { repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["repo","title"] },
      async execute(args) { return `[github_create_issue stub] repo=${args.repo} title="${args.title}"`; },
    },
    airtable_list_records: {
      name: "airtable_list_records", description: "List records in an Airtable table.",
      input_schema: { type: "object", properties: { tableName: { type: "string" }, maxRecords: { type: "number" } }, required: ["tableName"] },
      async execute(args) {
        try {
          const r = await fetch(`https://api.airtable.com/v0/${creds.credentials.baseId}/${encodeURIComponent(args.tableName)}?maxRecords=${args.maxRecords||10}`, {
            headers: { "Authorization": `Bearer ${creds.credentials.apiKey}` },
          });
          return JSON.stringify(await r.json()).slice(0, 4000);
        } catch (e: any) { return `Airtable error: ${e.message}`; }
      },
    },
    airtable_create_record: {
      name: "airtable_create_record", description: "Create a record in an Airtable table.",
      input_schema: { type: "object", properties: { tableName: { type: "string" }, fields: { type: "object" } }, required: ["tableName","fields"] },
      async execute(args) {
        try {
          const r = await fetch(`https://api.airtable.com/v0/${creds.credentials.baseId}/${encodeURIComponent(args.tableName)}`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${creds.credentials.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ records: [{ fields: args.fields }] }),
          });
          return JSON.stringify(await r.json()).slice(0, 4000);
        } catch (e: any) { return `Airtable error: ${e.message}`; }
      },
    },
    hubspot_search_contacts: {
      name: "hubspot_search_contacts", description: "Search HubSpot contacts.",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async execute(args) { return `[hubspot_search_contacts stub] q="${args.query}"`; },
    },
    hubspot_create_deal: {
      name: "hubspot_create_deal", description: "Create a HubSpot deal.",
      input_schema: { type: "object", properties: { name: { type: "string" }, amount: { type: "number" } }, required: ["name"] },
      async execute(args) { return `[hubspot_create_deal stub] name="${args.name}"`; },
    },
    drive_search: {
      name: "drive_search", description: "Search Google Drive (stub).",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async execute(args) { return `[drive_search stub] q="${args.query}"`; },
    },
    drive_read: {
      name: "drive_read", description: "Read a Drive file (stub).",
      input_schema: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] },
      async execute(args) { return `[drive_read stub] file=${args.fileId}`; },
    },
    pg_query: {
      name: "pg_query", description: "Run a read-only Postgres query (stub — would need pg client).",
      input_schema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
      async execute(args) { return `[pg_query stub] sql="${String(args.sql).slice(0, 200)}"`; },
    },
  };
  return handlers[toolName] || null;
}

export async function resolveTools(toolNames: string[], userId: string): Promise<ToolDef[]> {
  const out: ToolDef[] = [];
  for (const name of toolNames) {
    if (BUILTIN_TOOLS[name]) { out.push(BUILTIN_TOOLS[name]); continue; }
    // Find which connector exposes this tool.
    for (const c of Object.values(CONNECTORS)) {
      if (c.tools.includes(name)) {
        const t = await makeConnectorTool(name, c.id, userId);
        if (t) out.push(t);
        break;
      }
    }
  }
  return out;
}

export function toolDefsForAnthropic(tools: ToolDef[]) {
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

export async function executeTool(tools: ToolDef[], name: string, args: any, ctx: ToolCtx): Promise<string> {
  const t = tools.find(x => x.name === name);
  if (!t) return `Unknown tool: ${name}`;
  return await t.execute(args, ctx);
}
