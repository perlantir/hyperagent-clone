"use client";
// P43 — Threads dashboard.
//
// Replaces the auto-redirect-into-newest-thread behavior with a real
// landing page. Threads grouped by recency (Today / Past week / Past
// month / Older), with search, agent filter, and a prominent New thread
// CTA.

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { Skeleton } from "@/components/Skeleton";
import { ThreadActionsMenu } from "@/components/ThreadActionsMenu";

interface Thread {
  id: string;
  title: string;
  agentId: string | null;
  createdAt: number;
  updatedAt: number;
}
interface AgentRow { id: string; name: string; icon: string; color: string; }

const COLORS: Record<string, string> = {
  orange: "linear-gradient(135deg,#c2410c,#f97316)",
  blue:   "linear-gradient(135deg,#1d4ed8,#3b82f6)",
  green:  "linear-gradient(135deg,#15803d,#22c55e)",
  purple: "linear-gradient(135deg,#6d28d9,#a78bfa)",
};

export default function ThreadsListPage() {
  const router = useRouter();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [search, setSearch] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [creating, setCreating] = useState(false);
  // P50 — Show archived toggle. Archived threads are hidden by default;
  // toggling fetches with ?archived=1 and they show with reduced opacity.
  const [showArchived, setShowArchived] = useState(false);

  function reload() {
    fetch(`/api/threads${showArchived ? "?archived=1" : ""}`)
      .then(r => r.json()).then(j => setThreads(j.threads || []));
  }

  useEffect(() => {
    reload();
    fetch("/api/agents").then(r => r.json()).then(j => setAgents(j.agents || []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived]);

  async function newThread(agentId: string | null = null) {
    setCreating(true);
    const r = await fetch("/api/threads", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    const j = await r.json();
    if (j.thread?.id) router.push(`/threads/${j.thread.id}`);
    setCreating(false);
  }

  const grouped = useMemo(() => groupByRecency(threads || [], { search, agentId: agentFilter === "all" ? null : agentFilter }), [threads, search, agentFilter]);

  return (
    <AppShell>
      <Topbar title="Threads" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, gap: 16 }}>
            <div>
              <h1 className="h-display" style={{ fontSize: 44, marginBottom: 6 }}>Threads</h1>
              <div style={{ fontSize: 14, color: "var(--text-muted)", maxWidth: 580 }}>
                {threads === null ? "Loading…" : `${threads.length} ${threads.length === 1 ? "thread" : "threads"}.`}
              </div>
            </div>
            <button className="btn btn-primary" onClick={() => newThread(null)} disabled={creating}
              style={{ fontSize: 13, padding: "8px 16px" }}>
              + New thread
            </button>
          </div>

          {/* Filters */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 24, flexWrap: "wrap" }}>
            <input className="input" placeholder="Search titles…"
              value={search} onChange={e => setSearch(e.target.value)}
              style={{ maxWidth: 320, padding: "7px 12px", fontSize: 13 }} />
            <select value={agentFilter} onChange={e => setAgentFilter(e.target.value)}
              style={{
                padding: "7px 12px", borderRadius: 7,
                border: "1px solid var(--border)", background: "var(--bg-elev)",
                color: "var(--text)", fontSize: 13, outline: "none",
              }}>
              <option value="all">All agents</option>
              <option value="">No agent</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <button onClick={() => setShowArchived(s => !s)}
              className={`chip ${showArchived ? "active" : ""}`}
              style={{ fontSize: 12.5, padding: "5px 12px" }}
              title="Toggle archived threads">
              {showArchived ? "Hiding active" : "Show archived"}
            </button>
          </div>

          {/* Quick-start agents row */}
          {threads !== null && agents.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <div className="h-section" style={{ marginBottom: 10 }}>Start with an agent</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px,1fr))", gap: 10 }}>
                {agents.slice(0, 4).map(a => (
                  <button key={a.id} onClick={() => newThread(a.id)} disabled={creating} className="card"
                    style={{ padding: 12, cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border)" }}>
                    <span style={{
                      width: 32, height: 32, borderRadius: 8,
                      background: COLORS[a.color] || COLORS.orange,
                      color: "white", display: "grid", placeItems: "center",
                      fontSize: 14, fontWeight: 700, flexShrink: 0,
                    }}>{a.icon}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{a.name}</div>
                      <div style={{ fontSize: 11, color: "var(--text-faint)" }}>+ Start chat</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Grouped threads */}
          {threads === null ? (
            <Skeleton height={400} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              {grouped.map(group => (
                <div key={group.label}>
                  <div className="h-section" style={{ marginBottom: 10 }}>{group.label} · {group.threads.length}</div>
                  <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                    {group.threads.map((t, i) => (
                      <ThreadRow key={t.id} thread={t} agent={agents.find(a => a.id === t.agentId)} first={i === 0} onChanged={reload} />
                    ))}
                  </div>
                </div>
              ))}
              {grouped.length === 0 && (
                <div style={{ padding: 64, textAlign: "center", color: "var(--text-faint)", border: "1px solid var(--border)", borderRadius: 10 }}>
                  {threads.length === 0 ? "No threads yet." : "No matches."}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function ThreadRow({ thread, agent, first, onChanged }: { thread: Thread; agent?: AgentRow; first: boolean; onChanged?: () => void }) {
  return (
    <div className="threads-list-row" style={{
      position: "relative", display: "flex", alignItems: "center",
      borderTop: first ? "none" : "1px solid var(--border)",
    }}>
      <Link href={`/threads/${thread.id}`} style={{
        flex: 1, display: "flex", alignItems: "center", gap: 12,
        padding: "12px 16px",
        textDecoration: "none", color: "inherit",
        transition: "background 0.1s", minWidth: 0,
      }}>
        {agent ? (
          <span style={{
            width: 26, height: 26, borderRadius: 6,
            background: COLORS[agent.color] || COLORS.orange,
            color: "white", display: "grid", placeItems: "center",
            fontSize: 11, fontWeight: 700, flexShrink: 0,
          }}>{agent.icon}</span>
        ) : (
          <span style={{
            width: 26, height: 26, borderRadius: 6,
            background: "var(--bg-subtle)", color: "var(--text-faint)",
            display: "grid", placeItems: "center", fontSize: 13,
          }}>·</span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{thread.title}</div>
          {agent && <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 1 }}>{agent.name}</div>}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-faint)", whiteSpace: "nowrap", paddingRight: 30 }}>
          {formatRelative(Date.now() - thread.updatedAt)}
        </div>
      </Link>
      {/* P50 — 3-dot menu */}
      <span className="threads-list-actions"
        style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)" }}>
        <ThreadActionsMenu
          threadId={thread.id}
          threadTitle={thread.title}
          threadProjectId={(thread as any).projectId ?? null}
          onChanged={onChanged}
          onDeleted={onChanged}
          variant="icon"
        />
      </span>
    </div>
  );
}

function groupByRecency(threads: Thread[], opts: { search: string; agentId: string | null }) {
  const filtered = threads.filter(t => {
    if (opts.agentId !== null) {
      if (opts.agentId === "" && t.agentId !== null) return false;
      if (opts.agentId !== "" && t.agentId !== opts.agentId) return false;
    }
    if (opts.search.trim()) {
      if (!t.title.toLowerCase().includes(opts.search.trim().toLowerCase())) return false;
    }
    return true;
  });
  const now = Date.now();
  const day = 24 * 3600_000;
  const groups: Array<{ label: string; threads: Thread[] }> = [
    { label: "Today",      threads: [] },
    { label: "Past week",  threads: [] },
    { label: "Past month", threads: [] },
    { label: "Older",      threads: [] },
  ];
  for (const t of filtered) {
    const age = now - t.updatedAt;
    if (age < day) groups[0].threads.push(t);
    else if (age < 7 * day) groups[1].threads.push(t);
    else if (age < 30 * day) groups[2].threads.push(t);
    else groups[3].threads.push(t);
  }
  return groups.filter(g => g.threads.length > 0);
}

function formatRelative(ms: number): string {
  const sec = Math.abs(ms) / 1000;
  if (sec < 60) return `${sec.toFixed(0)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(0)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(0)}h`;
  if (sec < 7 * 86400) return `${(sec / 86400).toFixed(0)}d`;
  return new Date(Date.now() - ms).toLocaleDateString();
}
