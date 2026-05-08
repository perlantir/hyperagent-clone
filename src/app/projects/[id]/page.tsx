"use client";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";

export default function ProjectPage({ params }: { params: { id: string } }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => { fetch(`/api/projects/${params.id}`).then(r => r.json()).then(setData); }, [params.id]);
  if (!data?.project) return <AppShell><Topbar title="…" /></AppShell>;
  const p = data.project;
  return (
    <AppShell>
      <Topbar breadcrumb={<div style={{ fontSize: 13, color: "var(--text-muted)" }}><a href="/projects">Projects</a> <span style={{ opacity: 0.4, margin: "0 8px" }}>/</span> <span style={{ color: "var(--text)", fontWeight: 500 }}>{p.name}</span></div>} />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto" }}>
          <h1 className="h-display" style={{ fontSize: 44, marginBottom: 8 }}>{p.name}</h1>
          <div style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 32 }}>{p.description || "—"}</div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32 }}>
            <div>
              <div className="h-section" style={{ marginBottom: 12 }}>Threads</div>
              {data.threads?.length ? data.threads.map((t: any) => (
                <a key={t.id} href={`/threads/${t.id}`} className="card" style={{ display: "block", padding: "12px 16px", marginBottom: 6, textDecoration: "none", color: "inherit", fontSize: 13.5 }}>
                  <div style={{ fontWeight: 500 }}>{t.title}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>{new Date(t.updatedAt).toLocaleDateString()}</div>
                </a>
              )) : <div style={{ color: "var(--text-faint)", fontSize: 13 }}>No threads in this project yet.</div>}
            </div>
            <div>
              <div className="h-section" style={{ marginBottom: 12 }}>Agents</div>
              {data.agents?.length ? data.agents.map((a: any) => (
                <a key={a.id} href={`/agents/${a.id}`} className="card" style={{ display: "block", padding: "12px 16px", marginBottom: 6, textDecoration: "none", color: "inherit", fontSize: 13.5 }}>
                  <div style={{ fontWeight: 500 }}>{a.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>{a.description}</div>
                </a>
              )) : <div style={{ color: "var(--text-faint)", fontSize: 13 }}>No project-scoped agents.</div>}

              <div className="h-section" style={{ marginTop: 32, marginBottom: 12 }}>Memories</div>
              {data.memories?.length ? data.memories.map((m: any) => (
                <div key={m.id} style={{ padding: "10px 14px", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 6, fontSize: 13 }}>{m.content}</div>
              )) : <div style={{ color: "var(--text-faint)", fontSize: 13 }}>No project memories yet.</div>}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
