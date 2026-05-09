"use client";
// P28b — Visual trace viewer.
// Renders a single run's event timeline with parent/child indentation
// (tool_call → tool_result joined via parentClientId), expandable payloads,
// and replay/fork actions.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Skeleton, SkeletonStatGrid, SkeletonRow } from "@/components/Skeleton";

interface Event {
  id: number;
  ts: number;
  eventType: string;
  payload: any;
  durationMs: number | null;
  clientId: string | null;
  parentClientId: string | null;
  metadata: any;
}

interface Run {
  id: string;
  userId: string;
  threadId: string | null;
  agentId: string | null;
  parentRunId: string | null;
  kind: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCacheReadTokens: number | null;
  totalCacheWriteTokens: number | null;
  totalCostCredits: number | null;
  budgetCapCredits: number | null;
  spentCredits: number | null;
  errorMessage: string | null;
  metadata: any;
}

const EVENT_COLORS: Record<string, string> = {
  prompt_compiled: "#a855f7",
  llm_call: "#3b82f6",
  tool_call: "#22c55e",
  tool_result: "#22c55e",
  memory_read: "#06b6d4",
  memory_write: "#06b6d4",
  cache_hit: "#10b981",
  cache_miss: "#f97316",
  retry: "#eab308",
  error: "#dc2626",
  budget_reserved: "#94a3b8",
  budget_committed: "#94a3b8",
  budget_rolled_back: "#94a3b8",
  section_drop: "#64748b",
  subagent_dispatch: "#8b5cf6",
  subagent_complete: "#8b5cf6",
};

export default function TraceViewerPage() {
  const params = useParams();
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const id = params?.id as string;
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState<string>("");
  const [actionBusy, setActionBusy] = useState(false);

  async function load() {
    const r = await fetch(`/api/traces/${id}`).then(r => r.json());
    if (r.error) { setError(r.error); return; }
    setRun(r.run);
    setEvents(r.events || []);
  }
  useEffect(() => { if (id) load(); }, [id]);

  async function replay() {
    const ok = await confirm({
      title: "Replay this run?",
      body: "A new thread will be created with the same input. The agent runs against its current configuration — not the version that was live at the original run.",
      confirmLabel: "Replay",
    });
    if (!ok) return;
    setActionBusy(true);
    const r = await fetch(`/api/traces/${id}/replay`, { method: "POST" });
    setActionBusy(false);
    const j = await r.json();
    if (j.threadId) {
      const hash = j.seed ? `#seed=${encodeURIComponent(j.seed)}` : "";
      router.push(`/threads/${j.threadId}${hash}`);
    } else toast.error("Replay failed", j.error || undefined);
  }

  async function fork() {
    setActionBusy(true);
    const r = await fetch(`/api/traces/${id}/fork`, { method: "POST" });
    setActionBusy(false);
    const j = await r.json();
    if (j.threadId) {
      const hash = j.seed ? `#seed=${encodeURIComponent(j.seed)}` : "";
      router.push(`/threads/${j.threadId}${hash}`);
    } else toast.error("Fork failed", j.error || undefined);
  }

  if (error) {
    return (
      <AppShell>
        <Topbar title="Trace" />
        <div style={{ padding: 40, color: "var(--text-muted)" }}>{error}</div>
      </AppShell>
    );
  }

  if (!run) {
    return (
      <AppShell>
        <Topbar title="Trace" />
        <div style={{ overflowY: "auto", padding: "32px 48px" }}>
          <div style={{ maxWidth: 1100, margin: "0 auto" }}>
            <Skeleton width={120} height={11} style={{ marginBottom: 8 }} />
            <Skeleton width={280} height={28} style={{ marginBottom: 24 }} />
            <SkeletonStatGrid count={6} />
            <div style={{ height: 24 }} />
            <Skeleton width={140} height={12} style={{ marginBottom: 12 }} />
            <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
              {Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} cols={4} />)}
            </div>
          </div>
        </div>
      </AppShell>
    );
  }

  const duration = run.endedAt ? run.endedAt - run.startedAt : null;
  const cacheRead = run.totalCacheReadTokens || 0;
  const totalIn = run.totalInputTokens || 0;
  const cacheRate = (totalIn + cacheRead) > 0 ? cacheRead / (totalIn + cacheRead) : 0;

  return (
    <AppShell>
      <Topbar title="Trace" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          {/* Header */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
              <a href="/" style={{ color: "var(--accent)", textDecoration: "none" }}>← Threads</a>
              {run.threadId && <> · <a href={`/threads/${run.threadId}`} style={{ color: "var(--accent)", textDecoration: "none" }}>thread</a></>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <h1 className="h-display" style={{ fontSize: 28, margin: 0 }}>Run {run.id}</h1>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 4,
                background: run.status === "succeeded" ? "rgba(34,197,94,0.10)" : run.status === "failed" ? "rgba(220,38,38,0.10)" : "rgba(234,179,8,0.10)",
                color: run.status === "succeeded" ? "#22c55e" : run.status === "failed" ? "#dc2626" : "#eab308",
                letterSpacing: 0.5,
              }}>{run.status.toUpperCase()}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{run.kind}</span>
            </div>
            {run.errorMessage && (
              <div style={{
                marginTop: 8, padding: 12, borderRadius: 6,
                background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.20)",
                fontSize: 12, color: "#dc2626",
              }}>
                Error: {run.errorMessage}
              </div>
            )}
          </div>

          {/* Stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 24 }}>
            <Stat label="Duration" value={duration ? `${(duration / 1000).toFixed(1)}s` : "—"} />
            <Stat label="Cost"
              value={run.totalCostCredits ? `${run.totalCostCredits.toLocaleString()}` : "—"}
              sub={run.totalCostCredits ? `$${(run.totalCostCredits * 0.001).toFixed(3)}` : undefined}
              warn={run.budgetCapCredits ? (run.totalCostCredits || 0) >= run.budgetCapCredits : false} />
            <Stat label="Input tokens" value={(run.totalInputTokens || 0).toLocaleString()} />
            <Stat label="Output tokens" value={(run.totalOutputTokens || 0).toLocaleString()} />
            <Stat label="Cache hit rate" value={`${(cacheRate * 100).toFixed(0)}%`}
              sub={`${cacheRead.toLocaleString()} cached`} />
            <Stat label="Events" value={events.length.toLocaleString()} />
            {events[0]?.metadata?.agentVersion != null && (
              <Stat label="Agent version" value={`v${events[0].metadata.agentVersion}`}
                sub={run.agentId ? "at run time" : undefined} />
            )}
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
            <button className="btn btn-primary" disabled={actionBusy} onClick={replay}
              style={{ fontSize: 12, padding: "6px 14px" }}>↺ Replay</button>
            <button className="btn" disabled={actionBusy} onClick={fork}
              style={{ fontSize: 12, padding: "6px 14px" }}>⑂ Fork to new thread</button>
            <a className="btn" href={`/api/traces/${id}`} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 12, padding: "6px 14px", textDecoration: "none" }}>Raw JSON</a>
          </div>

          {/* Event timeline */}
          <div className="h-section" style={{ marginBottom: 12 }}>Event timeline · {events.length}</div>
          <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            {events.length === 0 ? (
              <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>No events recorded.</div>
            ) : events.map((e, i) => (
              <EventRow key={e.id} event={e} previousTs={i > 0 ? events[i-1].ts : run.startedAt} />
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: 0.5, fontWeight: 600, textTransform: "uppercase" }}>{label}</div>
      <div className="h-display" style={{ fontSize: 18, marginTop: 4, color: warn ? "#dc2626" : undefined }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function EventRow({ event, previousTs }: { event: Event; previousTs: number }) {
  const [expanded, setExpanded] = useState(false);
  const color = EVENT_COLORS[event.eventType] || "#94a3b8";
  const dt = event.ts - previousTs;
  const isChild = !!event.parentClientId;

  return (
    <div style={{
      borderTop: "1px solid var(--border)",
      paddingLeft: isChild ? 28 : 0,
      cursor: "pointer",
    }} onClick={() => setExpanded(!expanded)}>
      <div style={{
        padding: "8px 14px", display: "flex", alignItems: "center", gap: 10,
        fontSize: 12.5,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: 99, background: color,
          boxShadow: `0 0 0 3px ${color}22`, flexShrink: 0,
        }} />
        <span style={{ fontWeight: 600, minWidth: 130 }}>{event.eventType}</span>
        <span style={{ flex: 1, color: "var(--text-muted)", fontSize: 11.5,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {summarizePayload(event.eventType, event.payload)}
        </span>
        {event.durationMs != null && (
          <span style={{ fontSize: 10.5, color: "var(--text-faint)" }} className="mono">
            {(event.durationMs / 1000).toFixed(2)}s
          </span>
        )}
        <span style={{ fontSize: 10.5, color: "var(--text-faint)" }} className="mono">
          +{(dt / 1000).toFixed(2)}s
        </span>
        <span style={{ fontSize: 10, color: "var(--text-faint)", transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}>▾</span>
      </div>
      {expanded && (
        <pre style={{
          padding: "10px 14px", margin: 0, background: "var(--bg-elevated)",
          fontSize: 11, color: "var(--text-muted)", whiteSpace: "pre-wrap",
          fontFamily: "JetBrains Mono, monospace", overflow: "auto",
          maxHeight: 320,
        }}>{JSON.stringify(event.payload, null, 2)}</pre>
      )}
    </div>
  );
}

function summarizePayload(type: string, p: any): string {
  if (!p) return "";
  switch (type) {
    case "prompt_compiled": return `${p.totalTokens || 0} tokens, ${p.blockCount || 0} blocks (${p.cacheBoundaries || 0} cached)`;
    case "llm_call": return `${p.model || ""} · in ${p.inputTokens || 0} / out ${p.outputTokens || 0}${p.cacheReadTokens ? ` · cache ${p.cacheReadTokens}` : ""}`;
    case "tool_call": return `${p.name}(${truncate(JSON.stringify(p.args || {}), 80)})`;
    case "tool_result": return `${p.name} ${p.success ? "✓" : "✗"} · ${truncate(p.resultPreview || "", 80)}`;
    case "memory_read": return `${p.count || 0} memories (${p.pinnedCount || 0} pinned, ${p.contextualCount || 0} contextual)`;
    case "cache_hit": return `${p.tokens || 0} tokens cached`;
    case "cache_miss": return `${p.reason || ""} · created ${p.createTokens || 0}`;
    case "retry": return `attempt ${p.attempt} · ${p.errorClass} · ${p.reason}`;
    case "error": return `[${p.source}] ${p.message || p.reason || ""}`;
    case "budget_reserved": return `${p.capCredits || 0} credits reserved · ${p.scope}`;
    case "subagent_dispatch": return `depth ${p.depth} · "${truncate(p.goal || "", 60)}"`;
    case "subagent_complete": return `${p.status} · ${p.iterations || 0} iters · ${p.costCredits || 0} credits`;
    case "section_drop": return `${p.kind || ""} · ${p.reason || ""}`;
    default: return truncate(JSON.stringify(p), 100);
  }
}
function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n) + "…" : s; }
