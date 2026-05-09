"use client";
// P31b — Library v2: filter by type, agent, project; sort by date or title;
// each card links into the new /library/[id] detail page.
// P44 — multi-select + bulk archive/delete + show-archived toggle.

import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

type SortKey = "newest" | "oldest" | "title";

export default function LibraryPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [filterType, setFilterType] = useState<string>("all");
  const [filterAgent, setFilterAgent] = useState<string>("all");
  const [filterProject, setFilterProject] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("newest");
  const [search, setSearch] = useState<string>("");
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reload = useCallback(() => {
    fetch(`/api/library?includeArchived=${showArchived ? "1" : "0"}`)
      .then(r => r.json())
      .then(j => setItems(j.artifacts || []));
  }, [showArchived]);

  useEffect(() => {
    reload();
    fetch("/api/agents").then(r => r.json()).then(j => setAgents(j.agents || []));
    fetch("/api/projects").then(r => r.json()).then(j => setProjects(j.projects || []));
  }, [reload]);

  async function bulk(action: "archive" | "unarchive" | "delete") {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (action === "delete") {
      const ok = await confirm({
        title: `Delete ${ids.length} artifact${ids.length === 1 ? "" : "s"}?`,
        body: "This is permanent. Versions and history are removed too.",
        confirmLabel: "Delete",
        variant: "destructive",
      });
      if (!ok) return;
    }
    const r = await fetch("/api/artifacts/bulk", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, action }),
    });
    if (r.ok) {
      const j = await r.json();
      toast.success(`${j.touched} ${action}d`);
      setSelected(new Set());
      reload();
    } else {
      toast.error("Bulk action failed");
    }
  }
  function toggleSelect(id: string) {
    setSelected(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function selectAll(visibleIds: string[]) {
    setSelected(new Set(visibleIds));
  }

  const colors: any = {
    webpage: { bg: "linear-gradient(135deg,#fed7aa,#fdba74)", fg: "#c2410c" },
    document: { bg: "linear-gradient(135deg,#d1fae5,#6ee7b7)", fg: "#15803d" },
    table: { bg: "linear-gradient(135deg,#bae6fd,#7dd3fc)", fg: "#1d4ed8" },
    image: { bg: "linear-gradient(135deg,#ddd6fe,#c4b5fd)", fg: "#6d28d9" },
  };

  const filtered = useMemo(() => {
    let out = items;
    if (filterType !== "all") out = out.filter(i => i.type === filterType);
    if (filterAgent !== "all") {
      out = out.filter(i => filterAgent === "none" ? !i.agentId : i.agentId === filterAgent);
    }
    if (filterProject !== "all") {
      out = out.filter(i => filterProject === "none" ? !i.projectId : i.projectId === filterProject);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(i => i.title.toLowerCase().includes(q));
    }
    if (sort === "newest") out = [...out].sort((a, b) => b.createdAt - a.createdAt);
    if (sort === "oldest") out = [...out].sort((a, b) => a.createdAt - b.createdAt);
    if (sort === "title")  out = [...out].sort((a, b) => a.title.localeCompare(b.title));
    return out;
  }, [items, filterType, filterAgent, filterProject, search, sort]);

  return (
    <AppShell>
      <Topbar title="Library" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <h1 className="h-display" style={{ fontSize: 44, marginBottom: 8 }}>Library</h1>
          <div style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 24, maxWidth: 580 }}>
            Everything Hyperagent has produced — across threads, agents, and types.
          </div>

          {/* Type chips */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            {[["all","All"],["webpage","Webpages"],["document","Documents"],["table","Tables"],["image","Images"]].map(([k,l]) => (
              <button key={k} className={`chip ${filterType === k ? "active" : ""}`} onClick={() => setFilterType(k)}>
                {l} ({k === "all" ? items.length : items.filter(i => i.type === k).length})
              </button>
            ))}
          </div>

          {/* Agent + project + sort + search + archived toggle */}
          <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap", alignItems: "center" }}>
            <FilterSelect label="Agent" value={filterAgent} onChange={setFilterAgent}
              options={[["all","All agents"],["none","No agent"], ...agents.map((a: any) => [a.id, a.name] as [string, string])]} />
            {projects.length > 0 && (
              <FilterSelect label="Project" value={filterProject} onChange={setFilterProject}
                options={[["all","All projects"],["none","No project"], ...projects.map((p: any) => [p.id, p.name] as [string, string])]} />
            )}
            <FilterSelect label="Sort" value={sort} onChange={(v) => setSort(v as SortKey)}
              options={[["newest","Newest"],["oldest","Oldest"],["title","Title A-Z"]]} />
            <button className={`chip ${showArchived ? "active" : ""}`}
              onClick={() => setShowArchived(s => !s)}>
              {showArchived ? "Hide archived" : "Show archived"}
            </button>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search titles…"
              style={{
                marginLeft: "auto", padding: "6px 12px", borderRadius: 7,
                border: "1px solid var(--border)", background: "var(--bg-elev)",
                color: "var(--text)", fontSize: 13, outline: "none", minWidth: 200,
              }} />
          </div>

          {/* P44 — bulk action bar; appears when any artifact is selected */}
          {selected.size > 0 && (
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 14px", marginBottom: 16,
              background: "var(--accent-bg)",
              border: "1px solid var(--accent)",
              borderRadius: 8,
            }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--accent)" }}>
                {selected.size} selected
              </span>
              <button className="btn" onClick={() => setSelected(new Set())}
                style={{ fontSize: 12, padding: "4px 10px" }}>Clear</button>
              <div style={{ flex: 1 }} />
              <button className="btn" onClick={() => bulk("archive")}
                style={{ fontSize: 12, padding: "5px 12px" }}>Archive</button>
              <button className="btn" onClick={() => bulk("unarchive")}
                style={{ fontSize: 12, padding: "5px 12px" }}>Unarchive</button>
              <button className="btn" onClick={() => bulk("delete")}
                style={{ fontSize: 12, padding: "5px 12px", color: "#dc2626" }}>Delete</button>
            </div>
          )}

          {filtered.length === 0 ? (
            <div style={{ padding: 64, textAlign: "center", color: "var(--text-faint)" }}>
              {items.length === 0
                ? "No artifacts yet. Send a chat that produces a webpage or document."
                : "No artifacts match the current filters."}
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px,1fr))", gap: 16 }}>
              {filtered.map(a => {
                const c = colors[a.type] || colors.webpage;
                const isSelected = selected.has(a.id);
                const isArchived = !!a.archivedAt;
                return (
                  <div key={a.id} className="card" style={{
                    padding: 0, overflow: "hidden",
                    position: "relative",
                    borderColor: isSelected ? "var(--accent)" : "var(--border)",
                    borderWidth: isSelected ? 2 : 1,
                    opacity: isArchived ? 0.6 : 1,
                  }}>
                    {/* P44 — selection checkbox overlay */}
                    <button onClick={(e) => { e.preventDefault(); toggleSelect(a.id); }}
                      style={{
                        position: "absolute", top: 8, left: 8, zIndex: 2,
                        width: 22, height: 22, borderRadius: 4,
                        border: `1.5px solid ${isSelected ? "var(--accent)" : "var(--border-strong)"}`,
                        background: isSelected ? "var(--accent)" : "rgba(255,255,255,0.85)",
                        color: "white", cursor: "pointer", padding: 0,
                        display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700,
                      }}>
                      {isSelected ? "✓" : ""}
                    </button>
                    {isArchived && (
                      <span style={{
                        position: "absolute", top: 8, right: 8, zIndex: 2,
                        fontSize: 9.5, fontWeight: 700, padding: "2px 6px",
                        borderRadius: 4, background: "var(--bg-elev)", color: "var(--text-muted)",
                        letterSpacing: 0.5, border: "1px solid var(--border)",
                      }}>ARCHIVED</span>
                    )}
                    <Link href={`/library/${a.id}`} style={{ display: "block", textDecoration: "none", color: "inherit" }}>
                    <div style={{ height: 140, background: c.bg, color: c.fg, display: "grid", placeItems: "center", fontFamily: "Instrument Serif,serif", fontSize: 22, padding: 16, textAlign: "center" }}>{a.title}</div>
                    <div style={{ padding: "12px 14px" }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.title}</div>
                      <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2, display: "flex", alignItems: "center", gap: 6 }}>
                        <span>{a.type}</span>
                        {a.agentName && <><span style={{ opacity: 0.5 }}>·</span><span>{a.agentName}</span></>}
                        <span style={{ opacity: 0.5 }}>·</span>
                        <span>{new Date(a.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    </Link>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </AppShell>
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
