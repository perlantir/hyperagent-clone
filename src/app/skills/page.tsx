"use client";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";

export default function SkillsPage() {
  const [templates, setTemplates] = useState<any[]>([]);
  const [installed, setInstalled] = useState<any[]>([]);
  const [filter, setFilter] = useState("all");
  const [installing, setInstalling] = useState<string | null>(null);

  async function reload() {
    const r = await (await fetch("/api/skills")).json();
    setTemplates(r.templates || []); setInstalled(r.skills || []);
  }
  useEffect(() => { reload(); }, []);

  async function install(id: string) {
    setInstalling(id);
    await fetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ installFromTemplate: id }) });
    setInstalling(null); reload();
  }

  const categories = Array.from(new Set(templates.map(t => t.category))).sort();
  const installedTemplateIds = new Set(installed.map(s => s.installedFromTemplate).filter(Boolean));
  const filtered = filter === "all" ? templates : templates.filter(t => t.category === filter);

  return (
    <AppShell>
      <Topbar title="Skills" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto" }}>
          <h1 className="h-display" style={{ fontSize: 44, marginBottom: 8 }}>Skills</h1>
          <div style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 24, maxWidth: 580 }}>Templated capabilities you can install onto your agents. Each adds a system-prompt fragment and recommends tools.</div>

          <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
            <button className={`chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>All ({templates.length})</button>
            {categories.map(c => (
              <button key={c} className={`chip ${filter === c ? "active" : ""}`} onClick={() => setFilter(c)}>{c}</button>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px,1fr))", gap: 16 }}>
            {filtered.map(t => (
              <div key={t.id} className="card">
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <span style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{t.category}</span>
                  {installedTemplateIds.has(t.id) && <span className="badge badge-green">Installed</span>}
                </div>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>{t.name}</div>
                <div style={{ fontSize: 13.5, color: "var(--text-muted)", lineHeight: 1.55, marginBottom: 12, minHeight: 60 }}>{t.description}</div>
                {t.toolHints?.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    {t.toolHints.map((h: string) => <span key={h} className="badge badge-gray" style={{ marginRight: 4 }}>{h}</span>)}
                  </div>
                )}
                <button className="btn btn-primary" disabled={installedTemplateIds.has(t.id) || installing === t.id} onClick={() => install(t.id)} style={{ width: "100%", justifyContent: "center" }}>
                  {installing === t.id ? "Installing…" : installedTemplateIds.has(t.id) ? "Installed" : "Install"}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
