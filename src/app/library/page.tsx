"use client";
// P31b — Library v2: filter by type, agent, project; sort by date or title;
// each card links into the new /library/[id] detail page.

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";

type SortKey = "newest" | "oldest" | "title";

export default function LibraryPage() {
  const [items, setItems] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [filterType, setFilterType] = useState<string>("all");
  const [filterAgent, setFilterAgent] = useState<string>("all");
  const [filterProject, setFilterProject] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("newest");
  const [search, setSearch] = useState<string>("");

  useEffect(() => {
    fetch("/api/library").then(r => r.json()).then(j => setItems(j.artifacts || []));
    fetch("/api/agents").then(r => r.json()).then(j => setAgents(j.agents || []));
    fetch("/api/projects").then(r => r.json()).then(j => setProjects(j.projects || []));
  }, []);

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

          {/* Agent + project + sort + search */}
          <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap", alignItems: "center" }}>
            <FilterSelect label="Agent" value={filterAgent} onChange={setFilterAgent}
              options={[["all","All agents"],["none","No agent"], ...agents.map((a: any) => [a.id, a.name] as [string, string])]} />
            {projects.length > 0 && (
              <FilterSelect label="Project" value={filterProject} onChange={setFilterProject}
                options={[["all","All projects"],["none","No project"], ...projects.map((p: any) => [p.id, p.name] as [string, string])]} />
            )}
            <FilterSelect label="Sort" value={sort} onChange={(v) => setSort(v as SortKey)}
              options={[["newest","Newest"],["oldest","Oldest"],["title","Title A-Z"]]} />
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
                return (
                  <a key={a.id} href={`/library/${a.id}`} className="card"
                    style={{ padding: 0, overflow: "hidden", cursor: "pointer", textDecoration: "none", color: "inherit" }}>
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
                  </a>
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
