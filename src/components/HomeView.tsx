"use client";
// P62 — Home landing screen, redesigned to match Hyperagent's layout.
//
// Layout (top → bottom):
//   1. Editorial hero: "Let's get to work."
//   2. 3-line description
//   3. Quick-task composer card (input + Plan dropdown + send button)
//   4. Quick-start chips (Design / Source / Research / Generate + More)
//   5. Recent threads section with "Show all" link
//
// On send: create a new thread, navigate to it, and pass the prompt as
// a #seed= URL hash so ChatView pre-fills the composer. This keeps the
// API surface identical to the existing thread create + open flow.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Thread {
  id: string;
  title: string;
  agentId: string | null;
  projectId?: string | null;
  createdAt: number;
  updatedAt: number;
}

interface AgentRow { id: string; name: string; icon: string; color: string; }
interface ProjectRow { id: string; name: string; color: string; }

const AGENT_GRADIENT: Record<string, string> = {
  orange: "linear-gradient(135deg,#c2410c,#f97316)",
  blue:   "linear-gradient(135deg,#1d4ed8,#3b82f6)",
  green:  "linear-gradient(135deg,#15803d,#22c55e)",
  purple: "linear-gradient(135deg,#6d28d9,#a78bfa)",
};

// Quick-start chips. Each entry maps to a seed prompt + an icon glyph
// matching Hyperagent's home grid.
const QUICK_CHIPS: { icon: string; label: string; prompt: string }[] = [
  { icon: "▢", label: "Design a website",   prompt: "Design a website for " },
  { icon: "✦", label: "Source candidates",   prompt: "Source candidates for " },
  { icon: "◯", label: "Research a topic",    prompt: "Research " },
  { icon: "▣", label: "Generate images",     prompt: "Generate an image of " },
  { icon: "✎", label: "Write a draft",       prompt: "Write a draft of " },
  { icon: "✓", label: "Build a checklist",   prompt: "Build a checklist for " },
  { icon: "▤", label: "Summarize a doc",     prompt: "Summarize this document: " },
  { icon: "↗", label: "Plan an outreach",    prompt: "Plan an outreach campaign for " },
];

type RunMode = "execute" | "plan_first";

export function HomeView() {
  const router = useRouter();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [input, setInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [runMode, setRunMode] = useState<RunMode>("execute");
  const [showAllChips, setShowAllChips] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    fetch("/api/threads").then(r => r.json()).then(j => {
      setThreads((j.threads || []).slice(0, 6));
      setLoadingThreads(false);
    });
    fetch("/api/agents").then(r => r.json()).then(j => setAgents(j.agents || []));
    fetch("/api/projects").then(r => r.json()).then(j => setProjects(j.projects || []));
  }, []);

  async function startTask() {
    const text = input.trim();
    if (!text || creating) return;
    setCreating(true);
    const r = await fetch("/api/threads", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const j = await r.json();
    if (j.thread?.id) {
      // Pre-seed the composer AND auto-send so the user gets straight
      // into the work — matches Hyperagent's "type → arrive in
      // running thread" rhythm. ChatView reads these params on mount.
      const params = new URLSearchParams();
      params.set("seed", text);
      params.set("autosend", "1");
      if (runMode === "plan_first") params.set("runMode", "plan_first");
      router.push(`/threads/${j.thread.id}#${params.toString()}`);
    } else {
      setCreating(false);
    }
  }

  function pickChip(c: { prompt: string }) {
    setInput(c.prompt);
    setTimeout(() => inputRef.current?.focus(), 30);
  }

  return (
    <div style={{
      flex: 1, overflowY: "auto",
      padding: "min(64px, 6vw) min(32px, 5vw)",
    }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        {/* Hero */}
        <h1 className="h-display" style={{
          fontSize: "clamp(48px, 8vw, 88px)",
          lineHeight: 1.02,
          letterSpacing: "-0.025em",
          marginBottom: 18,
        }}>Let&apos;s get to work.</h1>
        <p style={{
          fontSize: "clamp(15px, 1.4vw, 18px)",
          color: "var(--text-muted)",
          lineHeight: 1.55,
          marginBottom: 32,
          maxWidth: 620,
        }}>
          Give me any assignment, large or small. I&apos;ll research, build, or analyze whatever you need, using real sources and real data, to produce polished deliverables.
        </p>

        {/* Composer */}
        <div className="card home-composer" style={{
          padding: 16,
          borderRadius: 18,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          boxShadow: "0 4px 24px rgba(0,0,0,0.04)",
          marginBottom: 28,
        }}>
          {/* top bar: + / filter / Plan dropdown */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <button className="home-composer-icon" title="Add reference"
              style={iconBtnStyle}>＋</button>
            <button className="home-composer-icon" title="Composer settings"
              style={iconBtnStyle}>⚙</button>
            <div style={{ marginLeft: "auto" }}>
              <RunModePill value={runMode} onChange={setRunMode} />
            </div>
          </div>
          {/* input row */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  startTask();
                }
              }}
              rows={2}
              placeholder="What's the task?"
              style={{
                flex: 1, resize: "none", border: "none", outline: "none",
                background: "transparent", fontSize: 16,
                lineHeight: 1.5, color: "var(--text)",
                padding: "8px 4px", minHeight: 48,
                fontFamily: "inherit",
              }}
            />
            <button
              onClick={startTask}
              disabled={!input.trim() || creating}
              title="Start task"
              style={{
                width: 40, height: 40, borderRadius: 999,
                border: "none", cursor: input.trim() ? "pointer" : "default",
                background: input.trim() ? "var(--text)" : "var(--text-faint)",
                color: "var(--bg)",
                display: "grid", placeItems: "center",
                fontSize: 18, fontWeight: 700,
                transition: "background 0.15s",
                flexShrink: 0,
              }}>{creating ? "…" : "↑"}</button>
          </div>
        </div>

        {/* Quick chips */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 10,
          marginBottom: 48,
        }}>
          {(showAllChips ? QUICK_CHIPS : QUICK_CHIPS.slice(0, 4)).map(c => (
            <button key={c.label} onClick={() => pickChip(c)}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "11px 14px",
                borderRadius: 999,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                fontSize: 13.5,
                cursor: "pointer",
                textAlign: "left",
                transition: "border-color 0.15s, background 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--border-strong)"; e.currentTarget.style.background = "var(--bg-elev)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg)"; }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)", flexShrink: 0 }}>{c.icon}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
            </button>
          ))}
          {!showAllChips && (
            <button onClick={() => setShowAllChips(true)}
              style={{
                gridColumn: "1 / -1",
                justifySelf: "center",
                marginTop: 4,
                padding: "8px 18px",
                borderRadius: 999,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text-muted)",
                fontSize: 13, cursor: "pointer",
              }}>
              More…
            </button>
          )}
        </div>

        {/* Recent threads */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Recent threads</h2>
          <Link href="/threads" className="btn"
            style={{ fontSize: 12.5, padding: "6px 14px" }}>
            Show all
          </Link>
        </div>
        {loadingThreads ? (
          <div className="card" style={{ padding: 24, textAlign: "center", color: "var(--text-faint)", fontSize: 13 }}>
            Loading…
          </div>
        ) : threads.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: "center", color: "var(--text-faint)", fontSize: 13 }}>
            No threads yet — type something above to start.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 32 }}>
            {threads.map(t => {
              const agent = agents.find(a => a.id === t.agentId);
              const project = projects.find(p => p.id === t.projectId);
              return (
                <Link key={t.id} href={`/threads/${t.id}`} className="card"
                  style={{
                    display: "block",
                    padding: "16px 18px",
                    borderRadius: 14,
                    textDecoration: "none", color: "inherit",
                    border: "1px solid var(--border)",
                    background: "var(--bg-elev)",
                    transition: "border-color 0.15s",
                  }}>
                  {project && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 11.5, color: "var(--text-muted)" }}>
                      <span>📁</span>
                      <span>{project.name}</span>
                    </div>
                  )}
                  <div style={{ fontSize: 16.5, fontWeight: 600, marginBottom: 6, lineHeight: 1.35 }}>
                    {t.title}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, color: "var(--text-muted)" }}>
                    {agent && (
                      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{
                          width: 14, height: 14, borderRadius: 4,
                          background: AGENT_GRADIENT[agent.color] || AGENT_GRADIENT.orange,
                          color: "white", display: "grid", placeItems: "center",
                          fontSize: 8, fontWeight: 700,
                        }}>{agent.icon}</span>
                        <span>{agent.name}</span>
                      </span>
                    )}
                    <span>·</span>
                    <span>{formatRelative(Date.now() - t.updatedAt)}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────

const iconBtnStyle: React.CSSProperties = {
  width: 32, height: 32, borderRadius: 999,
  border: "1px solid var(--border)",
  background: "var(--bg)", color: "var(--text-muted)",
  display: "grid", placeItems: "center", cursor: "pointer",
  fontSize: 14,
};

function RunModePill({ value, onChange }: { value: RunMode; onChange: (v: RunMode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as any)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  const label = value === "plan_first" ? "Plan" : "Execute";
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "6px 12px",
          borderRadius: 999,
          border: "1px solid var(--border)",
          background: "var(--bg)",
          color: "var(--text)",
          fontSize: 13, fontWeight: 500,
          cursor: "pointer",
        }}>
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>≡</span>
        <span>{label}</span>
        <span style={{ fontSize: 9, color: "var(--text-faint)" }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", right: 0,
          width: 220,
          background: "var(--bg)", border: "1px solid var(--border)",
          borderRadius: 10, boxShadow: "0 10px 40px rgba(0,0,0,0.18)",
          padding: 4, zIndex: 30,
        }}>
          <RunModeRow active={value === "execute"} title="Execute"
            sub="Run normally — agent acts, calls tools, produces output."
            onClick={() => { onChange("execute"); setOpen(false); }} />
          <RunModeRow active={value === "plan_first"} title="Plan first"
            sub="Agent writes a plan, stops, and waits for your approval."
            onClick={() => { onChange("plan_first"); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}

function RunModeRow({ active, title, sub, onClick }: { active: boolean; title: string; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: "block", width: "100%",
      padding: "8px 10px", borderRadius: 6,
      border: active ? "1px solid var(--accent)" : "1px solid transparent",
      background: active ? "var(--accent-bg)" : "transparent",
      textAlign: "left", cursor: "pointer", color: "var(--text)",
    }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4 }}>{sub}</div>
    </button>
  );
}

function formatRelative(ms: number): string {
  const sec = Math.abs(ms) / 1000;
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 7 * 86400) return `${Math.round(sec / 86400)}d ago`;
  return new Date(Date.now() - ms).toLocaleDateString();
}
