"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";

export default function NewAgentPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("You are a helpful AI assistant.");
  const [routerHint, setRouterHint] = useState("");
  const [color, setColor] = useState("orange");
  const [tools, setTools] = useState<string[]>(["web_search", "generate_artifact"]);

  async function create() {
    if (!name) return;
    const r = await fetch("/api/agents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, systemPrompt, routerHint, color, tools, icon: name[0].toUpperCase() }),
    });
    const j = await r.json();
    if (j.agent) router.push(`/agents/${j.agent.id}`);
  }

  return (
    <AppShell>
      <Topbar title="New agent" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <h1 className="h-display" style={{ fontSize: 40, marginBottom: 24 }}>Create an agent</h1>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div><label className="h-section">Name</label><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Research Analyst" style={{ marginTop: 8 }} /></div>
            <div><label className="h-section">Description</label><input className="input" value={description} onChange={e => setDescription(e.target.value)} placeholder="What is this agent for?" style={{ marginTop: 8 }} /></div>
            <div><label className="h-section">Color</label>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                {["orange","blue","green","purple"].map(c => (
                  <button key={c} className={`chip ${color === c ? "active" : ""}`} onClick={() => setColor(c)}>{c}</button>
                ))}
              </div>
            </div>
            <div><label className="h-section">System prompt</label><textarea className="input" rows={5} value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} style={{ marginTop: 8, fontFamily: "JetBrains Mono, monospace", fontSize: 13 }} /></div>
            <div><label className="h-section">Router hint <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>(when should the router pick this agent?)</span></label><textarea className="input" rows={2} value={routerHint} onChange={e => setRouterHint(e.target.value)} style={{ marginTop: 8 }} placeholder="Choose me for: research, briefings, market analysis…" /></div>
            <div><label className="h-section">Tools</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {["web_search","generate_artifact","slack_notify","slack_send_message","gmail_search","linear_search_issues","stripe_list_charges","github_search","airtable_list_records"].map(t => (
                  <button key={t} className={`chip ${tools.includes(t) ? "active" : ""}`} onClick={() => setTools(tools.includes(t) ? tools.filter(x => x !== t) : [...tools, t])}>{t}</button>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button className="btn" onClick={() => router.back()}>Cancel</button>
              <button className="btn btn-primary" onClick={create} disabled={!name}>Create agent</button>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
