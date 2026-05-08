// MCP server endpoint (P17 stub).
// Implements the JSON-RPC 2.0 surface that MCP clients (Claude Desktop, etc.)
// expect. Currently exposes our built-in tools as MCP tools.
//
// Request shape: { jsonrpc:"2.0", method:"tools/list" | "tools/call", params, id }

import { NextResponse } from "next/server";
import { BUILTIN_TOOLS } from "@/lib/tools";

export const runtime = "nodejs";

async function authenticate(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(hak_[A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const crypto = await import("node:crypto");
  const { pool } = await import("@/lib/db");
  const hash = crypto.createHash("sha256").update(m[1]).digest("hex");
  const r = await pool().query(`SELECT "userId" FROM api_keys WHERE "keyHash"=$1`, [hash]);
  return r.rows[0]?.userId || null;
}

export async function POST(req: Request) {
  const userId = await authenticate(req);
  if (!userId) return NextResponse.json({ jsonrpc: "2.0", error: { code: -32001, message: "auth required" } });

  const body = await req.json().catch(() => ({}));
  const { id, method, params } = body;

  if (method === "initialize") {
    return NextResponse.json({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "hyperagent-clone", version: "0.4.0" },
        capabilities: { tools: {} },
      },
    });
  }

  if (method === "tools/list") {
    const tools = Object.values(BUILTIN_TOOLS).map(t => ({
      name: t.name, description: t.description, inputSchema: t.input_schema,
    }));
    return NextResponse.json({ jsonrpc: "2.0", id, result: { tools } });
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    const tool = BUILTIN_TOOLS[name];
    if (!tool) return NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    const ctx = { userId, threadId: "mcp_session", messageId: "mcp_msg", artifactsCreated: [] };
    const result = await tool.execute(args, ctx);
    return NextResponse.json({
      jsonrpc: "2.0", id,
      result: { content: [{ type: "text", text: result }] },
    });
  }

  return NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
}
