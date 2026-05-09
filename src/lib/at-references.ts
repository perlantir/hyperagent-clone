// P42 — @-reference resolution.
//
// The composer add-menu (P38) inserts tokens like @memory:mem_abc /
// @artifact:art_abc / @skill:sk_abc / @asset:art_abc / @integration:slug
// into user messages. These need to be expanded into actual content
// before the chat route hands the message to the LLM, otherwise the model
// sees the literal string and has no idea what was referenced.
//
// This module owns the token grammar + the per-kind resolver. It returns
// a replacement string that can drop into the message in place of the
// token, plus a list of "expansion blocks" the chat route can append to
// the prompt as a single labeled context section.

import { pool } from "./db";

const TOKEN_RE = /@(memory|artifact|skill|asset|integration):([a-zA-Z0-9_-]+)/g;

export interface ResolvedReference {
  kind: "memory" | "artifact" | "skill" | "asset" | "integration";
  id: string;
  // Short label that replaces the @token inline in the user message.
  inlineLabel: string;
  // Full content surfaced as a separate block at the top of the user
  // message (e.g. memory content, artifact body, skill prompt).
  expansion: string | null;
}

// Scan a message for @tokens and resolve each one. Failed lookups
// fall through with inlineLabel preserving the token text + a "(not
// found)" suffix so the model knows to ignore.
export async function resolveReferences(
  text: string,
  ctx: { userId: string; threadId: string },
): Promise<{ resolvedText: string; expansions: ResolvedReference[] }> {
  if (!text || !text.includes("@")) return { resolvedText: text, expansions: [] };

  // Reset regex state.
  TOKEN_RE.lastIndex = 0;
  const tokens: Array<{ kind: string; id: string; raw: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text))) {
    tokens.push({ kind: m[1], id: m[2], raw: m[0], start: m.index, end: m.index + m[0].length });
  }
  if (tokens.length === 0) return { resolvedText: text, expansions: [] };

  // Resolve in parallel, deduped by (kind, id).
  const seen = new Set<string>();
  const unique = tokens.filter(t => {
    const k = `${t.kind}:${t.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const resolved = await Promise.all(unique.map(t => resolveOne(t.kind as any, t.id, ctx)));
  const byKey = new Map<string, ResolvedReference>();
  for (let i = 0; i < unique.length; i++) {
    const r = resolved[i];
    if (r) byKey.set(`${unique[i].kind}:${unique[i].id}`, r);
  }

  // Replace tokens in text. Scan back-to-front so indices stay valid.
  let out = text;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i];
    const ref = byKey.get(`${tok.kind}:${tok.id}`);
    const replacement = ref ? ref.inlineLabel : `${tok.raw} (reference not found)`;
    out = out.slice(0, tok.start) + replacement + out.slice(tok.end);
  }

  // De-dup expansions by key for the prompt.
  const expansions = Array.from(byKey.values()).filter(r => r.expansion);
  return { resolvedText: out, expansions };
}

async function resolveOne(
  kind: ResolvedReference["kind"],
  id: string,
  ctx: { userId: string; threadId: string },
): Promise<ResolvedReference | null> {
  try {
    switch (kind) {
      case "memory": {
        const r = await pool().query(
          `SELECT content, importance, "agentId" FROM memories WHERE id=$1 AND "userId"=$2`,
          [id, ctx.userId],
        );
        const row = r.rows[0];
        if (!row) return null;
        const preview = String(row.content).slice(0, 60).replace(/\s+/g, " ");
        return {
          kind, id,
          inlineLabel: `[memory: "${preview}…"]`,
          expansion: `MEMORY (${id}): ${row.content}`,
        };
      }
      case "artifact":
      case "asset": {
        const r = await pool().query(
          `SELECT a.id, a.title, a.type, a.body, a."threadId"
           FROM artifacts a
           JOIN threads t ON t.id = a."threadId"
           WHERE a.id=$1 AND t."userId"=$2`,
          [id, ctx.userId],
        );
        const row = r.rows[0];
        if (!row) return null;
        // Truncate body for the model — full content can be large. The
        // model can call generate_artifact for the full version if it
        // needs to edit.
        const bodyPreview = String(row.body || "").slice(0, 4000);
        return {
          kind, id,
          inlineLabel: `[${row.type}: "${row.title}"]`,
          expansion: `${row.type.toUpperCase()} ARTIFACT (${id}) "${row.title}":\n${bodyPreview}${row.body.length > 4000 ? "\n…[truncated]" : ""}`,
        };
      }
      case "skill": {
        const r = await pool().query(
          `SELECT name, description, "systemPromptAddition" FROM skills WHERE id=$1 AND ("userId"=$2 OR "isTemplate"=1)`,
          [id, ctx.userId],
        );
        const row = r.rows[0];
        if (!row) return null;
        return {
          kind, id,
          inlineLabel: `[skill: ${row.name}]`,
          expansion: `SKILL "${row.name}" (${id}):\n${row.systemPromptAddition}`,
        };
      }
      case "integration": {
        // Integration tokens scope this turn's tool selection. We don't
        // expand into prompt content — the chat route reads the kind and
        // limits which Composio toolkits get included.
        return {
          kind, id,
          inlineLabel: `[integration: ${id}]`,
          expansion: null,
        };
      }
    }
  } catch (e) {
    console.error("[at-references resolveOne]", kind, id, e);
    return null;
  }
}

// Render an "EXPANSIONS" block to inject above the user's message so the
// model sees the resolved content as context. Returns null when there's
// nothing to inject.
export function formatExpansions(expansions: ResolvedReference[]): string | null {
  const interesting = expansions.filter(r => r.expansion);
  if (interesting.length === 0) return null;
  const lines = ["[REFERENCED CONTENT — the user's message references the following items by @id. Treat these as authoritative context for what they're talking about.]"];
  for (const r of interesting) {
    lines.push("\n---");
    lines.push(r.expansion!);
  }
  lines.push("---\n");
  return lines.join("\n");
}

// Pull the list of integrations referenced via @integration:slug so the
// chat route can scope tools accordingly.
export function extractIntegrationSlugs(expansions: ResolvedReference[]): string[] {
  return expansions.filter(r => r.kind === "integration").map(r => r.id);
}
