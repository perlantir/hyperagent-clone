// P33b — Audit log query endpoint.
//
//   GET /api/audit?action=...&result=...&from=...&to=...&limit=N&offset=N
//        → { events, total, dlqDepth }
//
// Scoped to the requesting user (audit_log."userId" = me OR null for
// system-level events the operator should still see, e.g. cron.tick).
// Filters compose: every provided param adds an AND clause. Pagination
// via limit + offset; result rows include parsed metadata.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { ensureAuditSchema } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await ensureAuditSchema();

  const u = new URL(req.url);
  const action = u.searchParams.get("action");
  const result = u.searchParams.get("result");
  const resource = u.searchParams.get("resource");
  const fromQ = u.searchParams.get("from");
  const toQ = u.searchParams.get("to");
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(u.searchParams.get("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const offset = Math.max(0, parseInt(u.searchParams.get("offset") || "0", 10) || 0);

  // Always scope to the user; allow system events (userId IS NULL) so
  // operators see cron heartbeats and other infrastructure activity.
  const conds: string[] = [`("userId" = $1 OR "userId" IS NULL)`];
  const vals: any[] = [user.id];

  if (action) { vals.push(action); conds.push(`action = $${vals.length}`); }
  if (result) { vals.push(result); conds.push(`result = $${vals.length}`); }
  if (resource) { vals.push(resource); conds.push(`resource = $${vals.length}`); }
  if (fromQ) {
    const t = parseInt(fromQ, 10);
    if (!isNaN(t)) { vals.push(t); conds.push(`"ts" >= $${vals.length}`); }
  }
  if (toQ) {
    const t = parseInt(toQ, 10);
    if (!isNaN(t)) { vals.push(t); conds.push(`"ts" < $${vals.length}`); }
  }
  const where = conds.join(" AND ");

  const [rows, total, dlq] = await Promise.all([
    pool().query(
      `SELECT id, "userId", action, resource, result, metadata, ip, "userAgent", "ts"
       FROM audit_log WHERE ${where}
       ORDER BY "ts" DESC
       LIMIT ${limit} OFFSET ${offset}`,
      vals,
    ),
    pool().query(`SELECT COUNT(*)::int AS c FROM audit_log WHERE ${where}`, vals),
    pool().query(`SELECT COUNT(*)::int AS c FROM audit_log_dlq WHERE replayed = false`).catch(() => ({ rows: [{ c: 0 }] })),
  ]);

  // Distinct actions for the filter dropdown — bounded to those the user
  // has actually generated, so the dropdown is contextual rather than
  // listing every enum value.
  const distinctActions = await pool().query(
    `SELECT DISTINCT action FROM audit_log
     WHERE "userId" = $1 OR "userId" IS NULL
     ORDER BY action`,
    [user.id],
  );

  // P44 — CSV export. format=csv returns the same filtered rows as a
  // text/csv stream (no pagination — bounded by limit). Used by the
  // /audit page's "Export CSV" button for compliance review.
  const format = u.searchParams.get("format");
  if (format === "csv") {
    const headers = ["ts","action","result","resource","userId","ip","userAgent","metadata"];
    const lines = [headers.join(",")];
    for (const r of rows.rows) {
      const cells = [
        new Date(Number(r.ts)).toISOString(),
        r.action || "",
        r.result || "",
        r.resource || "",
        r.userId || "",
        r.ip || "",
        (r.userAgent || "").slice(0, 200),
        JSON.stringify(r.metadata || {}),
      ];
      lines.push(cells.map(csvEscape).join(","));
    }
    return new Response(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit-${new Date().toISOString().slice(0,10)}.csv"`,
      },
    });
  }

  return NextResponse.json({
    events: rows.rows.map((r: any) => ({
      ...r,
      ts: Number(r.ts),
    })),
    total: Number(total.rows[0]?.c || 0),
    dlqDepth: Number(dlq.rows[0]?.c || 0),
    distinctActions: distinctActions.rows.map((r: any) => r.action),
    limit, offset,
  });
}

// CSV-escape per RFC 4180: wrap in quotes if the value contains comma /
// quote / newline; double up internal quotes.
function csvEscape(s: any): string {
  const t = String(s ?? "");
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}
