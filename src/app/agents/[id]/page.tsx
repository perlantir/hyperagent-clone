"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";

interface AgentVersion {
  id: string; agentId: string; version: number;
  name: string; icon: string; color: string; description: string;
  systemPrompt: string; tools: string[]; connectorIds: string[];
  routerHint: string; createdAt: number; changedBy: string | null; changeNote: string | null;
}

export default function AgentPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [a, setA] = useState<any>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(""); const [routerHint, setRouterHint] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [allTools] = useState(["web_search","generate_artifact","slack_notify","slack_send_message","gmail_search","gmail_send","linear_search_issues","stripe_list_charges","github_search","airtable_list_records","notion_search","drive_search"]);
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);

  async function loadVersions() {
    const j = await fetch(`/api/agents/${params.id}/versions`).then(r => r.json());
    setVersions(j.versions || []);
  }

  useEffect(() => {
    fetch(`/api/agents/${params.id}`).then(r => r.json()).then(j => {
      if (!j.agent) return;
      setA(j.agent); setName(j.agent.name); setDescription(j.agent.description);
      setSystemPrompt(j.agent.systemPrompt); setRouterHint(j.agent.routerHint || "");
      setTools(j.agent.tools);
    });
    loadVersions();
  }, [params.id]);

  async function save() {
    await fetch(`/api/agents/${params.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, systemPrompt, routerHint, tools }),
    });
    const j = await (await fetch(`/api/agents/${params.id}`)).json();
    setA(j.agent); setEditing(false);
    loadVersions();
  }
  async function startThread() {
    const r = await fetch("/api/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: a.id, title: `Chat with ${a.name}` }) });
    const j = await r.json();
    router.push(`/threads/${j.thread.id}`);
  }
  async function rollback(version: number) {
    if (!confirm(`Roll back to version ${version}? This creates a new version with the rolled-back state.`)) return;
    const r = await fetch(`/api/agents/${params.id}/versions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    });
    const j = await r.json();
    if (j.ok) {
      // Reload everything
      const a = await fetch(`/api/agents/${params.id}`).then(r => r.json());
      setA(a.agent); setName(a.agent.name); setDescription(a.agent.description);
      setSystemPrompt(a.agent.systemPrompt); setRouterHint(a.agent.routerHint || "");
      setTools(a.agent.tools);
      loadVersions();
    } else {
      alert(j.error || "Rollback failed");
    }
  }

  if (!a) return <AppShell><Topbar title="…" /></AppShell>;
  const colorMap: any = { orange: "linear-gradient(135deg,#c2410c,#f97316)", blue: "linear-gradient(135deg,#1d4ed8,#3b82f6)", green: "linear-gradient(135deg,#15803d,#22c55e)", purple: "linear-gradient(135deg,#6d28d9,#a78bfa)" };

  return (
    <AppShell>
      <Topbar breadcrumb={<div style={{ fontSize: 13, color: "var(--text-muted)" }}><a href="/agents/new">Agents</a> <span style={{ opacity: 0.4, margin: "0 8px" }}>/</span> <span style={{ color: "var(--text)", fontWeight: 500 }}>{a.name}</span></div>} />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 24, paddingBottom: 24, borderBottom: "1px solid var(--border)" }}>
            <div style={{ width: 64, height: 64, borderRadius: 14, background: colorMap[a.color] || colorMap.orange, color: "white", display: "grid", placeItems: "center", fontSize: 28, fontWeight: 700 }}>{a.icon}</div>
            <div style={{ flex: 1 }}>
              <h1 className="h-display" style={{ fontSize: 36 }}>{a.name}</h1>
              <div style={{ color: "var(--text-muted)", fontSize: 14.5, maxWidth: 600 }}>{a.description}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" onClick={() => { setShowVersions(!showVersions); if (!showVersions) loadVersions(); }}>
                History {versions.length > 0 && <span style={{ marginLeft: 4, fontSize: 11, color: "var(--text-muted)" }}>({versions.length})</span>}
              </button>
              <button className="btn" onClick={() => setEditing(!editing)}>{editing ? "Cancel" : "Edit"}</button>
              <button className="btn btn-primary" onClick={startThread}>+ New thread</button>
            </div>
          </div>

          {showVersions ? (
            <div style={{ paddingTop: 32 }}>
              <div className="h-section" style={{ marginBottom: 12 }}>Version history · {versions.length}</div>
              {versions.length === 0 ? (
                <div style={{ padding: 32, color: "var(--text-muted)", fontSize: 13 }}>No version snapshots yet — edit the agent to start tracking history.</div>
              ) : (
                <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                  {versions.map(v => (
                    <div key={v.id} style={{ borderTop: "1px solid var(--border)" }}>
                      <div onClick={() => setExpandedVersion(expandedVersion === v.version ? null : v.version)}
                        style={{ padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 14 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "var(--bg-subtle)", color: "var(--text-muted)" }}>v{v.version}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.name}</div>
                          {v.changeNote && <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>{v.changeNote}</div>}
                        </div>
                        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{new Date(v.createdAt).toLocaleString()}</span>
                        <button className="btn" style={{ fontSize: 11, padding: "4px 10px" }}
                          onClick={(e) => { e.stopPropagation(); rollback(v.version); }}>↺ Restore</button>
                        <span style={{ fontSize: 10, opacity: 0.5, transform: expandedVersion === v.version ? "none" : "rotate(-90deg)" }}>▾</span>
                      </div>
                      {expandedVersion === v.version && (
                        <div style={{ padding: "0 16px 16px", background: "var(--bg-subtle)" }}>
                          <div style={{ paddingTop: 12 }}>
                            <div style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: 0.5, fontWeight: 600, textTransform: "uppercase", marginBottom: 4 }}>Description</div>
                            <div style={{ fontSize: 13, marginBottom: 12 }}>{v.description}</div>
                            <div style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: 0.5, fontWeight: 600, textTransform: "uppercase", marginBottom: 4 }}>System prompt</div>
                            <pre style={{ fontSize: 12, fontFamily: "JetBrains Mono, monospace", whiteSpace: "pre-wrap", color: "var(--text-muted)", margin: 0, marginBottom: 12, lineHeight: 1.55, maxHeight: 240, overflow: "auto" }}>{v.systemPrompt}</pre>
                            <div style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: 0.5, fontWeight: 600, textTransform: "uppercase", marginBottom: 4 }}>Tools</div>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              {v.tools.map(t => (
                                <span key={t} className="badge badge-gray" style={{ padding: "3px 8px", fontSize: 11 }}>⚙ {t}</span>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : !editing ? (
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 40, paddingTop: 32 }}>
              <div>
                <div className="h-section">System prompt</div>
                <div className="mono" style={{ marginTop: 12, background: "var(--bg-subtle)", padding: 18, borderRadius: 10, fontSize: 13.5, lineHeight: 1.65, color: "var(--text-muted)" }}>{a.systemPrompt}</div>
                <div className="h-section" style={{ marginTop: 32 }}>Tools</div>
                <div style={{ marginTop: 12 }}>{a.tools.map((t: string) => <span key={t} className="badge badge-gray" style={{ marginRight: 6, marginBottom: 6, padding: "4px 10px" }}>⚙ {t}</span>)}</div>
                {a.routerHint && (<><div className="h-section" style={{ marginTop: 32 }}>Router hint</div>
                  <div style={{ marginTop: 8, color: "var(--text-muted)", fontSize: 13.5 }}>{a.routerHint}</div></>)}
              </div>
              <div>
                <div className="h-section">Color</div>
                <div style={{ marginTop: 8, color: "var(--text-muted)", fontSize: 13 }}>{a.color}</div>
              </div>
            </div>
          ) : (
            <div style={{ paddingTop: 32, display: "flex", flexDirection: "column", gap: 20, maxWidth: 720 }}>
              <div><label className="h-section">Name</label><input className="input" value={name} onChange={e => setName(e.target.value)} style={{ marginTop: 8 }} /></div>
              <div><label className="h-section">Description</label><input className="input" value={description} onChange={e => setDescription(e.target.value)} style={{ marginTop: 8 }} /></div>
              <div><label className="h-section">System prompt</label><textarea className="input" rows={6} value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} style={{ marginTop: 8, fontFamily: "JetBrains Mono, monospace", fontSize: 13 }} /></div>
              <div><label className="h-section">Router hint</label><textarea className="input" rows={2} value={routerHint} onChange={e => setRouterHint(e.target.value)} style={{ marginTop: 8 }} placeholder="When should the router pick me?" /></div>
              <div>
                <label className="h-section">Tools</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  {allTools.map(t => (
                    <button key={t} className={`chip ${tools.includes(t) ? "active" : ""}`} onClick={() => setTools(tools.includes(t) ? tools.filter(x => x !== t) : [...tools, t])}>{t}</button>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={save}>Save</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
