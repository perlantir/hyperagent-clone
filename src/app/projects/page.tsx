"use client";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<any[]>([]);
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [color, setColor] = useState("orange");
  const [creating, setCreating] = useState(false);

  async function reload() { const r = await (await fetch("/api/projects")).json(); setProjects(r.projects || []); }
  useEffect(() => { reload(); }, []);

  async function create() {
    await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, description, color }) });
    setCreating(false); setName(""); setDescription(""); reload();
  }

  return (
    <AppShell>
      <Topbar title="Projects" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 32 }}>
            <div>
              <h1 className="h-display" style={{ fontSize: 44, marginBottom: 8 }}>Projects</h1>
              <div style={{ color: "var(--text-muted)", fontSize: 15, maxWidth: 580 }}>Group threads, agents, and memories into a project so context stays cohesive.</div>
            </div>
            <button className="btn btn-primary" style={{ marginLeft: "auto" }} onClick={() => setCreating(true)}>+ New project</button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px,1fr))", gap: 12 }}>
            {projects.map(p => (
              <a key={p.id} href={`/projects/${p.id}`} className="card" style={{ padding: 20, textDecoration: "none", color: "inherit" }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: ({orange:"#fed7aa",blue:"#bae6fd",green:"#bbf7d0",purple:"#ddd6fe"} as any)[p.color] || "#fed7aa", marginBottom: 12 }} />
                <div style={{ fontSize: 16, fontWeight: 600 }}>{p.name}</div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>{p.description || "—"}</div>
              </a>
            ))}
            {projects.length === 0 && !creating && (
              <div style={{ gridColumn: "1/-1", padding: 64, textAlign: "center", color: "var(--text-faint)" }}>No projects yet.</div>
            )}
          </div>
        </div>
      </div>

      {creating && (
        <div onClick={() => setCreating(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "grid", placeItems: "center", zIndex: 100, backdropFilter: "blur(4px)" }}>
          <div onClick={e => e.stopPropagation()} className="card" style={{ width: 460, padding: 24 }}>
            <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>New project</h2>
            <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>A folder for related work.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <input className="input" placeholder="Name" value={name} onChange={e => setName(e.target.value)} />
              <input className="input" placeholder="Description (optional)" value={description} onChange={e => setDescription(e.target.value)} />
              <div style={{ display: "flex", gap: 8 }}>
                {["orange","blue","green","purple"].map(c => (
                  <button key={c} className={`chip ${color === c ? "active" : ""}`} onClick={() => setColor(c)}>{c}</button>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
              <button className="btn" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={!name} onClick={create}>Create</button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
