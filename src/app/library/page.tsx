"use client";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";

export default function LibraryPage() {
  const [items, setItems] = useState<any[]>([]);
  const [filter, setFilter] = useState("all");
  useEffect(() => { fetch("/api/library").then(r => r.json()).then(j => setItems(j.artifacts || [])); }, []);
  const filtered = filter === "all" ? items : items.filter(i => i.type === filter);
  const colors: any = {
    webpage: { bg: "linear-gradient(135deg,#fed7aa,#fdba74)", fg: "#c2410c" },
    document: { bg: "linear-gradient(135deg,#d1fae5,#6ee7b7)", fg: "#15803d" },
    table: { bg: "linear-gradient(135deg,#bae6fd,#7dd3fc)", fg: "#1d4ed8" },
    image: { bg: "linear-gradient(135deg,#ddd6fe,#c4b5fd)", fg: "#6d28d9" },
  };
  return (
    <AppShell>
      <Topbar title="Library" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <h1 className="h-display" style={{ fontSize: 44, marginBottom: 8 }}>Library</h1>
          <div style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 24, maxWidth: 580 }}>Everything Hyperagent has produced — across threads, agents, and types.</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
            {[["all","All"],["webpage","Webpages"],["document","Documents"],["table","Tables"],["image","Images"]].map(([k,l]) => (
              <button key={k} className={`chip ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>{l} ({k === "all" ? items.length : items.filter(i => i.type === k).length})</button>
            ))}
          </div>
          {filtered.length === 0 ? (
            <div style={{ padding: 64, textAlign: "center", color: "var(--text-faint)" }}>No artifacts yet. Send a chat that produces a webpage or document.</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px,1fr))", gap: 16 }}>
              {filtered.map(a => {
                const c = colors[a.type] || colors.webpage;
                return (
                  <a key={a.id} href={`/api/artifacts/${a.id}?render=1`} target="_blank" rel="noreferrer" className="card" style={{ padding: 0, overflow: "hidden", cursor: "pointer", textDecoration: "none", color: "inherit" }}>
                    <div style={{ height: 140, background: c.bg, color: c.fg, display: "grid", placeItems: "center", fontFamily: "Instrument Serif,serif", fontSize: 22, padding: 16, textAlign: "center" }}>{a.title}</div>
                    <div style={{ padding: "12px 14px" }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{a.title}</div>
                      <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{a.type} · {new Date(a.createdAt).toLocaleDateString()}</div>
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
