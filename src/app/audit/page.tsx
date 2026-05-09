"use client";
// P33b — Audit log query UI.
//
// Per-user audit log viewer with:
//   - filters: action (dropdown of values seen for this user), result, time
//     window (1h/24h/7d/30d/all), free-text resource match
//   - paginated rows (50 per page) with click-to-expand metadata
//   - DLQ depth banner when there are unreplayed primary-write failures
//
// System-level events (userId IS NULL) like cron heartbeats are visible to
// every operator so infrastructure activity isn't hidden behind a per-user
// filter. Application-level events (memory writes, secret rotations) are
// strictly scoped to the requesting user.

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { Skeleton, SkeletonRow } from "@/components/Skeleton";

interface AuditEvent {
  id: number;
  userId: string | null;
  action: string;
  resource: string | null;
  result: "success" | "failure" | "denied";
  metadata: any;
  ip: string | null;
  userAgent: string | null;
  ts: number;
}

interface AuditResponse {
  events: AuditEvent[];
  total: number;
  dlqDepth: number;
  distinctActions: string[];
  limit: number;
  offset: number;
}

type WindowKey = "1h" | "24h" | "7d" | "30d" | "all";

const RESULT_BADGE: Record<string, { color: string; bg: string }> = {
  success: { color: "#22c55e", bg: "rgba(34,197,94,0.10)" },
  failure: { color: "#dc2626", bg: "rgba(220,38,38,0.10)" },
  denied:  { color: "#d97706", bg: "rgba(217,119,6,0.10)" },
};

export default function AuditPage() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [filterAction, setFilterAction] = useState<string>("all");
  const [filterResult, setFilterResult] = useState<string>("all");
  const [filterWindow, setFilterWindow] = useState<WindowKey>("24h");
  const [searchResource, setSearchResource] = useState<string>("");
  const [page, setPage] = useState<number>(0);
  const [expanded, setExpanded] = useState<number | null>(null);

  const PAGE_SIZE = 50;

  const fromTs = useMemo(() => {
    const now = Date.now();
    const map: Record<WindowKey, number | undefined> = {
      "1h":  now - 1 * 3600_000,
      "24h": now - 24 * 3600_000,
      "7d":  now - 7 * 24 * 3600_000,
      "30d": now - 30 * 24 * 3600_000,
      "all": undefined,
    };
    return map[filterWindow];
  }, [filterWindow]);

  async function load() {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (filterAction !== "all") params.set("action", filterAction);
    if (filterResult !== "all") params.set("result", filterResult);
    if (fromTs) params.set("from", String(fromTs));
    if (searchResource.trim()) params.set("resource", searchResource.trim());
    const r = await fetch(`/api/audit?${params}`);
    if (r.ok) setData(await r.json());
  }
  useEffect(() => { load(); }, [filterAction, filterResult, filterWindow, page]);
  useEffect(() => { setPage(0); }, [filterAction, filterResult, filterWindow, searchResource]);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <AppShell>
      <Topbar title="Audit log" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 8 }}>
            <h1 className="h-display" style={{ fontSize: 44 }}>Audit log</h1>
            {/* P44 — Export the currently-filtered set as CSV. Re-uses the
                same query params; format=csv triggers the streaming download. */}
            <button className="btn" style={{ fontSize: 12, padding: "6px 14px" }}
              onClick={() => {
                const params = new URLSearchParams({ limit: "200", format: "csv" });
                if (filterAction !== "all") params.set("action", filterAction);
                if (filterResult !== "all") params.set("result", filterResult);
                if (fromTs) params.set("from", String(fromTs));
                if (searchResource.trim()) params.set("resource", searchResource.trim());
                window.location.href = `/api/audit?${params}`;
              }}>
              ↓ Export CSV
            </button>
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 24, maxWidth: 640 }}>
            Append-only record of security-relevant actions: auth events, secret writes, agent edits, run cancellations, and more. Scoped to your account plus system-level events.
          </div>

          {/* DLQ banner */}
          {data && data.dlqDepth > 0 && (
            <div style={{
              padding: "10px 14px", marginBottom: 16,
              background: "rgba(220,38,38,0.06)",
              border: "1px solid rgba(220,38,38,0.20)",
              borderRadius: 8, fontSize: 13, color: "#dc2626",
            }}>
              ⚠ Audit DLQ has {data.dlqDepth} unreplayed event{data.dlqDepth === 1 ? "" : "s"}. Primary writes are being deferred — investigate via Command Center.
            </div>
          )}

          {/* Filters */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
            <FilterSelect label="Action" value={filterAction} onChange={setFilterAction}
              options={[["all","All actions"], ...((data?.distinctActions || []).map(a => [a, a] as [string, string]))]} />
            <FilterSelect label="Result" value={filterResult} onChange={setFilterResult}
              options={[["all","All results"],["success","Success"],["failure","Failure"],["denied","Denied"]]} />
            <FilterSelect label="Window" value={filterWindow} onChange={(v) => setFilterWindow(v as WindowKey)}
              options={[["1h","Last hour"],["24h","Last 24h"],["7d","Last 7d"],["30d","Last 30d"],["all","All time"]]} />
            <input
              value={searchResource}
              onChange={e => setSearchResource(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") load(); }}
              placeholder="resource id (exact match)…"
              style={{
                padding: "6px 12px", borderRadius: 7,
                border: "1px solid var(--border)", background: "var(--bg-elev)",
                color: "var(--text)", fontSize: 13, outline: "none", minWidth: 240,
              }} />
            <button className="btn" onClick={load} style={{ fontSize: 12, padding: "6px 14px" }}>Search</button>
          </div>

          {/* Results count */}
          {data && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
              {data.total.toLocaleString()} event{data.total === 1 ? "" : "s"} match
              {totalPages > 1 && <> · page {page + 1} of {totalPages}</>}
            </div>
          )}

          {/* Events table */}
          {!data ? (
            <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
              {Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} cols={5} />)}
            </div>
          ) : data.events.length === 0 ? (
            <div style={{ padding: 64, textAlign: "center", color: "var(--text-faint)", border: "1px solid var(--border)", borderRadius: 10 }}>
              No matching events.
            </div>
          ) : (
            <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
              {data.events.map(e => (
                <AuditRow key={e.id} event={e}
                  expanded={expanded === e.id}
                  onToggle={() => setExpanded(expanded === e.id ? null : e.id)} />
              ))}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "center" }}>
              <button className="btn" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}
                style={{ fontSize: 12, padding: "6px 14px" }}>← Prev</button>
              <span style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", padding: "0 12px" }}>
                {page + 1} / {totalPages}
              </span>
              <button className="btn" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}
                style={{ fontSize: 12, padding: "6px 14px" }}>Next →</button>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function AuditRow({ event, expanded, onToggle }: {
  event: AuditEvent; expanded: boolean; onToggle: () => void;
}) {
  const badge = RESULT_BADGE[event.result] || RESULT_BADGE.success;
  const isSystem = event.userId === null;
  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      <div onClick={onToggle} style={{
        padding: "10px 14px", cursor: "pointer",
        display: "grid", gridTemplateColumns: "100px 200px 1fr 80px 140px 16px",
        alignItems: "center", gap: 12, fontSize: 13,
      }}>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
          background: badge.bg, color: badge.color, letterSpacing: 0.5,
          textAlign: "center",
        }}>{event.result.toUpperCase()}</span>
        <span style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} className="mono">
          {event.action}
        </span>
        <span style={{ minWidth: 0, color: "var(--text-muted)", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} className="mono">
          {event.resource || (isSystem ? <em style={{ color: "var(--text-faint)" }}>(system)</em> : <em style={{ color: "var(--text-faint)" }}>—</em>)}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
          {isSystem ? "system" : "you"}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-faint)", textAlign: "right", fontFamily: "JetBrains Mono, monospace" }}>
          {new Date(event.ts).toLocaleString()}
        </span>
        <span style={{ fontSize: 10, opacity: 0.5, transform: expanded ? "none" : "rotate(-90deg)" }}>▾</span>
      </div>
      {expanded && (
        <div style={{ padding: "12px 14px", background: "var(--bg-subtle)", fontSize: 12, color: "var(--text-muted)" }}>
          {event.ip && <div><span style={{ fontWeight: 600, color: "var(--text)" }}>IP:</span> <code className="mono">{event.ip}</code></div>}
          {event.userAgent && <div style={{ marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><span style={{ fontWeight: 600, color: "var(--text)" }}>UA:</span> <code className="mono">{event.userAgent}</code></div>}
          {event.metadata && Object.keys(event.metadata).length > 0 && (
            <details style={{ marginTop: 8 }} open>
              <summary style={{ cursor: "pointer", color: "var(--text)", fontSize: 11.5, fontWeight: 600 }}>Metadata</summary>
              <pre style={{
                marginTop: 8, padding: "10px 12px", background: "var(--bg)",
                border: "1px solid var(--border)", borderRadius: 6,
                fontSize: 11.5, fontFamily: "JetBrains Mono, monospace",
                color: "var(--text-muted)", whiteSpace: "pre-wrap",
                overflow: "auto", maxHeight: 280,
              }}>{JSON.stringify(event.metadata, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
      <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{
          padding: "5px 10px", borderRadius: 7, fontSize: 12.5,
          border: "1px solid var(--border)", background: "var(--bg-elev)",
          color: "var(--text)", outline: "none", minWidth: 140,
        }}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
