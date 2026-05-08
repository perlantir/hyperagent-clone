"use client";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";

export default function IntegrationsPage() {
  const [connectors, setConnectors] = useState<any[]>([]);
  const [open, setOpen] = useState<any | null>(null);
  const [creds, setCreds] = useState<Record<string, string>>({});

  async function reload() {
    const r = await (await fetch("/api/connectors")).json();
    setConnectors(r.connectors || []);
  }
  useEffect(() => { reload(); }, []);

  async function connect() {
    const r = await fetch(`/api/connectors/${open.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credentials: creds }) });
    if (r.ok) { setOpen(null); setCreds({}); reload(); }
  }
  async function disconnect(id: string) {
    await fetch(`/api/connectors/${id}`, { method: "DELETE" });
    reload();
  }

  return (
    <AppShell>
      <Topbar title="Integrations" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <h1 className="h-display" style={{ fontSize: 44, marginBottom: 8 }}>Integrations</h1>
          <div style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 24, maxWidth: 580 }}>Connect Hyperagent to the tools where your work already lives. Each connector exposes its API as tools your agents can call.</div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px,1fr))", gap: 12 }}>
            {connectors.map(c => (
              <div key={c.id} className="card" style={{ padding: 16, display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 9, background: c.color, color: c.textColor, display: "grid", placeItems: "center", fontSize: 18, fontWeight: 700, flexShrink: 0 }}>{c.icon}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{c.name}</div>
                  <div style={{ fontSize: 11.5, color: c.connected ? "var(--green)" : "var(--text-muted)" }}>{c.connected ? "● Connected" : c.category}</div>
                </div>
                {c.connected ? (
                  <button className="btn" onClick={() => disconnect(c.id)}>Disconnect</button>
                ) : (
                  <button className="btn btn-primary" onClick={() => { setOpen(c); setCreds({}); }}>Connect</button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {open && (
        <div onClick={() => setOpen(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "grid", placeItems: "center", zIndex: 100, backdropFilter: "blur(4px)" }}>
          <div onClick={e => e.stopPropagation()} className="card" style={{ width: 460, padding: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: open.color, color: open.textColor, display: "grid", placeItems: "center", fontWeight: 700, fontSize: 14 }}>{open.icon}</div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>Connect {open.name}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{open.description}</div>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {open.credentialFields.map((f: any) => (
                <div key={f.name}>
                  <label className="h-section">{f.label}</label>
                  <input className="input" type={f.type === "password" ? "password" : "text"} value={creds[f.name] || ""} onChange={e => setCreds({ ...creds, [f.name]: e.target.value })} style={{ marginTop: 6 }} />
                </div>
              ))}
            </div>
            <div style={{ marginTop: 16, fontSize: 12, color: "var(--text-faint)" }}>Tools added: {open.tools.join(", ")}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
              <button className="btn" onClick={() => setOpen(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={connect}>Connect</button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
