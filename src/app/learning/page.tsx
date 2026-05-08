"use client";
// P25b — /learning page: user-facing knowledge base.
// Four tabs: Memories | Rubrics | Improvements | Skills

import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { MemoryCard } from "@/components/MemoryCard";
import { RubricCard } from "@/components/RubricCard";
import { ImprovementProposalCard } from "@/components/ImprovementProposalCard";
import { CompactionProposalCard } from "@/components/CompactionProposalCard";

type Tab = "memories" | "rubrics" | "improvements" | "skills";
type MemoryFilter = "all" | "proposed" | "accepted";

export default function LearningPage() {
  const [tab, setTab] = useState<Tab>("memories");

  const [memories, setMemories] = useState<any[]>([]);
  const [memCounts, setMemCounts] = useState<{ proposed: number; accepted: number; total: number }>({ proposed: 0, accepted: 0, total: 0 });
  const [memFilter, setMemFilter] = useState<MemoryFilter>("all");
  const [newMemForm, setNewMemForm] = useState({ content: "", category: "preference", importance: 5 });

  const [rubrics, setRubrics] = useState<any[]>([]);

  const [improvementProposals, setImprovementProposals] = useState<any[]>([]);
  const [compactionProposals, setCompactionProposals] = useState<any[]>([]);

  const [skills, setSkills] = useState<any[]>([]);

  async function loadMemories() {
    const r = await fetch(`/api/memories?state=${memFilter}`).then(r => r.json());
    setMemories(r.memories || []);
    setMemCounts(r.counts || { proposed: 0, accepted: 0, total: 0 });
  }
  async function loadRubrics() {
    const r = await fetch("/api/rubrics").then(r => r.json());
    setRubrics(r.rubrics || []);
  }
  async function loadImprovements() {
    const [imp, comp] = await Promise.all([
      fetch("/api/improvement-proposals?status=pending").then(r => r.json()),
      fetch("/api/memories/compact?status=pending").then(r => r.json()),
    ]);
    setImprovementProposals(imp.proposals || []);
    setCompactionProposals(comp.proposals || []);
  }
  async function loadSkills() {
    const r = await fetch("/api/skills").then(r => r.json());
    setSkills(r.skills || []);
  }

  useEffect(() => {
    if (tab === "memories") loadMemories();
    if (tab === "rubrics") loadRubrics();
    if (tab === "improvements") loadImprovements();
    if (tab === "skills") loadSkills();
  }, [tab]);
  useEffect(() => { if (tab === "memories") loadMemories(); }, [memFilter]);

  return (
    <AppShell>
      <Topbar title="Learning" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <h1 className="h-display" style={{ fontSize: 44, marginBottom: 8 }}>Learning</h1>
          <div style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 28, maxWidth: 640 }}>
            Memories, rubrics, and self-improvements your agents have picked up. Pin what matters; reject what doesn't; let the system get sharper over time.
          </div>

          <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", marginBottom: 24 }}>
            <TabButton active={tab === "memories"} onClick={() => setTab("memories")}
              label="Memories" count={memCounts.proposed > 0 ? memCounts.proposed : undefined} />
            <TabButton active={tab === "rubrics"} onClick={() => setTab("rubrics")} label="Rubrics" />
            <TabButton active={tab === "improvements"} onClick={() => setTab("improvements")}
              label="Improvements"
              count={improvementProposals.length + compactionProposals.length} />
            <TabButton active={tab === "skills"} onClick={() => setTab("skills")} label="Skills" />
          </div>

          {tab === "memories" && (
            <>
              <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
                {(["all", "proposed", "accepted"] as MemoryFilter[]).map(f => (
                  <button key={f} className={`chip ${memFilter === f ? "active" : ""}`}
                    onClick={() => setMemFilter(f)}>
                    {f}{f === "proposed" && memCounts.proposed > 0 ? ` (${memCounts.proposed})` : ""}
                  </button>
                ))}
              </div>

              <div className="card" style={{ padding: 16, marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Save a new memory</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <textarea
                    placeholder="A fact or preference to remember (one declarative sentence)…"
                    value={newMemForm.content}
                    onChange={e => setNewMemForm({ ...newMemForm, content: e.target.value })}
                    style={{
                      padding: 10, fontSize: 13, borderRadius: 6,
                      border: "1px solid var(--border)", background: "var(--bg)",
                      color: "var(--text)", minHeight: 60, resize: "vertical",
                    }} />
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <select value={newMemForm.category}
                      onChange={e => setNewMemForm({ ...newMemForm, category: e.target.value })}
                      style={{ padding: "6px 8px", borderRadius: 6, fontSize: 12,
                        border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }}>
                      <option value="user_fact">user_fact</option>
                      <option value="preference">preference</option>
                      <option value="tools_and_workflows">tools_and_workflows</option>
                      <option value="project_context">project_context</option>
                      <option value="domain_knowledge">domain_knowledge</option>
                      <option value="people">people</option>
                      <option value="active_work">active_work</option>
                      <option value="organization">organization</option>
                    </select>
                    <label style={{ fontSize: 11, color: "var(--text-muted)" }}>Importance</label>
                    <input type="number" min={1} max={10} value={newMemForm.importance}
                      onChange={e => setNewMemForm({ ...newMemForm, importance: parseInt(e.target.value) || 5 })}
                      style={{ width: 60, padding: "4px 8px", fontSize: 12, borderRadius: 6,
                        border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }} />
                    <button className="btn btn-primary" disabled={!newMemForm.content.trim()}
                      onClick={async () => {
                        await fetch("/api/memories", {
                          method: "POST", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ ...newMemForm, forceState: "accepted" }),
                        });
                        setNewMemForm({ content: "", category: "preference", importance: 5 });
                        loadMemories();
                      }}
                      style={{ marginLeft: "auto", fontSize: 12, padding: "6px 14px" }}>
                      Save
                    </button>
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {memories.length === 0 ? (
                  <div style={{ color: "var(--text-muted)", textAlign: "center", padding: 40, fontSize: 13 }}>
                    No memories {memFilter !== "all" ? `with state=${memFilter}` : "yet"}. Use the form above or the save_memory tool from chat.
                  </div>
                ) : memories.map(m => (
                  <MemoryCard key={m.id} memory={m} onChange={loadMemories} />
                ))}
              </div>
            </>
          )}

          {tab === "rubrics" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {rubrics.length === 0 ? (
                <div style={{ color: "var(--text-muted)", textAlign: "center", padding: 40, fontSize: 13 }}>
                  No rubrics yet. The Production-Grade rubric should auto-load on first chat.
                </div>
              ) : rubrics.map(r => (
                <RubricCard key={r.id} rubric={r} onChange={loadRubrics} />
              ))}
            </div>
          )}

          {tab === "improvements" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {improvementProposals.length > 0 && (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: "var(--text-muted)" }}>
                    SYSTEM-PROMPT IMPROVEMENTS · {improvementProposals.length}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {improvementProposals.map(p => (
                      <ImprovementProposalCard key={p.id} proposal={p} onChange={loadImprovements} />
                    ))}
                  </div>
                </div>
              )}

              {compactionProposals.length > 0 && (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: "var(--text-muted)" }}>
                    MEMORY COMPACTION · {compactionProposals.length}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {compactionProposals.map(p => (
                      <CompactionProposalCard key={p.id} proposal={p} onChange={loadImprovements} />
                    ))}
                  </div>
                </div>
              )}

              {improvementProposals.length === 0 && compactionProposals.length === 0 && (
                <div style={{ color: "var(--text-muted)", textAlign: "center", padding: 40, fontSize: 13 }}>
                  No pending improvements. Run multi-step chats and let the rubric system observe patterns.
                  <div style={{ marginTop: 12 }}>
                    <button className="btn" style={{ fontSize: 12, padding: "6px 14px" }}
                      onClick={async () => {
                        const r = await fetch("/api/memories/compact", { method: "POST" }).then(r => r.json());
                        alert(`Scanned ${r.pairs} pairs, generated ${r.proposals} proposals.`);
                        loadImprovements();
                      }}>
                      Scan for memory compaction
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "skills" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {skills.length === 0 ? (
                <div style={{ color: "var(--text-muted)", textAlign: "center", padding: 40, fontSize: 13 }}>
                  No skills yet. <a href="/skills" style={{ color: "var(--accent)" }}>Browse templates</a>.
                </div>
              ) : skills.map(s => (
                <div key={s.id} className="card" style={{ padding: 16 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{s.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{s.description}</div>
                  <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 8 }}>
                    {s.category}
                  </div>
                  <button className="btn" style={{ fontSize: 11, padding: "4px 10px", marginTop: 8 }}
                    onClick={async () => {
                      if (!confirm(`Delete skill "${s.name}"?`)) return;
                      await fetch(`/api/skills/${s.id}`, { method: "DELETE" });
                      loadSkills();
                    }}>Delete</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button onClick={onClick} style={{
      padding: "10px 16px",
      background: "transparent",
      border: "none",
      borderBottom: `2px solid ${active ? "var(--accent, #3b82f6)" : "transparent"}`,
      color: active ? "var(--text)" : "var(--text-muted)",
      fontSize: 13, fontWeight: active ? 600 : 500,
      cursor: "pointer",
      marginBottom: -1,
    }}>
      {label}
      {typeof count === "number" && count > 0 && (
        <span style={{
          marginLeft: 8, fontSize: 11, fontWeight: 600,
          background: "var(--accent, #3b82f6)", color: "white",
          padding: "1px 7px", borderRadius: 99,
        }}>{count}</span>
      )}
    </button>
  );
}
