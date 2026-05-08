"use client";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";

export default function LearningPage() {
  const [tab, setTab] = useState<"memories" | "skills">("memories");
  const [memories, setMemories] = useState<any[]>([]);
  const [skills, setSkills] = useState<any[]>([]);
  const [newMem, setNewMem] = useState("");

  async function reload() {
    const m = await (await fetch("/api/memories")).json();
    setMemories(m.memories || []);
    const s = await (await fetch("/api/skills")).json();
    setSkills(s.skills || []);
  }
  useEffect(() => { reload(); }, []);

  async function addMemory() {
    if (!newMem.trim()) return;
    await fetch("/api/memories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: newMem }) });
    setNewMem(""); reload();
  }
  async function deleteMemory(id: string) {
    await fetch(`/api/memories/${id}`, { method: "DELETE" });
    reload();
  }
  async function deleteSkill(id: string) {
    await fetch(`/api/skills/${id}`, { method: "DELETE" });
    reload();
  }

  return (
    <AppShell>
      <Topbar title="Learning" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto" }}>
          <h1 className="h-display" style={{ fontSize: 44, marginBottom: 8 }}>Learning</h1>
          <div style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 24, maxWidth: 580 }}>Memories and skills Hyperagent has picked up working with you.</div>
          <div style={{ display: "flex", borderBottom: "1px solid var(--border)", marginBottom: 24 }}>
            {[["memories","Memories"],["skills","Skills installed"]].map(([k,l]) => (
              <button key={k} onClick={() => setTab(k as any)} style={{ padding: "10px 16px", fontSize: 13.5, color: tab === k ? "var(--text)" : "var(--text-muted)", borderBottom: tab === k ? "2px solid var(--text)" : "2px solid transparent", marginBottom: -1, background: "transparent", border: "none", borderRadius: 0, fontWeight: tab === k ? 500 : 400 }}>
                {l} · {k === "memories" ? memories.length : skills.length}
              </button>
            ))}
            <a href="/skills" style={{ marginLeft: "auto", padding: "10px 16px", fontSize: 13, color: "var(--accent)" }}>Browse skill templates →</a>
          </div>

          {tab === "memories" ? (
            <>
              <div className="card" style={{ display: "flex", gap: 8, marginBottom: 16, padding: 16 }}>
                <input className="input" value={newMem} onChange={e => setNewMem(e.target.value)} placeholder="Add a memory — a fact, preference, or instruction…" onKeyDown={e => { if (e.key === "Enter") addMemory(); }} />
                <button className="btn btn-primary" onClick={addMemory}>Save</button>
              </div>
              {memories.length === 0 ? (
                <div style={{ padding: 64, textAlign: "center", color: "var(--text-faint)" }}>No memories yet.</div>
              ) : memories.map(m => (
                <div key={m.id} className="card" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 16, padding: 14 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--accent-bg)", color: "var(--accent)", display: "grid", placeItems: "center", fontSize: 16 }}>◇</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14 }}>{m.content}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>importance {m.importance}/10 · {m.agentId ? `agent-scoped` : "global"}</div>
                  </div>
                  <button className="btn" onClick={() => deleteMemory(m.id)}>Forget</button>
                </div>
              ))}
            </>
          ) : (
            <>
              {skills.length === 0 ? (
                <div style={{ padding: 64, textAlign: "center", color: "var(--text-faint)" }}>No skills installed. <a href="/skills" style={{ color: "var(--accent)" }}>Browse templates</a>.</div>
              ) : skills.map(s => (
                <div key={s.id} className="card" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 16, padding: 14 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--bg-subtle)", color: "var(--text)", display: "grid", placeItems: "center", fontSize: 16 }}>⚙</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{s.name}</div>
                    <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{s.description}</div>
                    <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>{s.category}</div>
                  </div>
                  <button className="btn" onClick={() => deleteSkill(s.id)}>Remove</button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
