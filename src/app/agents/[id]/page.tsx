"use client";
// P36 — Tabbed agent builder.
//
// Replaces the single-form edit page with a 10-tab workspace mirroring the
// Hyperagent reference: Config / Invocations / Integrations / Tools /
// Skills / Knowledge / Memory / Rubrics / Library / Budget & Security.
//
// Right-side summary sidebar shows model + accordion-style counts and
// links to each tab. The History panel from P28b is still reachable via
// the kebab menu so nothing regresses.

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Skeleton } from "@/components/Skeleton";
import type { AgentLike, TabKey, TabDef } from "@/components/agent-builder/types";
import { NATIVE_TOOL_CATALOG } from "@/components/agent-builder/types";
import { SummarySidebar } from "@/components/agent-builder/SummarySidebar";
import { ConfigTab } from "@/components/agent-builder/ConfigTab";
import { InlineTestPanel } from "@/components/agent-builder/InlineTestPanel";
import {
  InvocationsTab, IntegrationsTab, ToolsTab, MemoryTab,
  SkillsTab, KnowledgeTab, RubricsTab, LibraryTab, SecurityTab,
} from "@/components/agent-builder/OtherTabs";

const TABS: TabDef[] = [
  { key: "config",       label: "Config",       icon: "⚙" },
  { key: "invocations",  label: "Invocations",  icon: "↦" },
  { key: "integrations", label: "Integrations", icon: "⊟" },
  { key: "tools",        label: "Tools",        icon: "✶" },
  { key: "skills",       label: "Skills",       icon: "◇" },
  { key: "knowledge",    label: "Knowledge",    icon: "▤" },
  { key: "memory",       label: "Memory",       icon: "◐" },
  { key: "rubrics",      label: "Rubrics",      icon: "★" },
  { key: "library",      label: "Library",      icon: "▥" },
  { key: "security",     label: "Budget",       icon: "$" },
];

export default function AgentBuilderPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [agent, setAgent] = useState<AgentLike | null>(null);
  const [tab, setTab] = useState<TabKey>("config");
  const [counts, setCounts] = useState({
    invocations: 1, integrations: 0, tools: 0,
    skills: 0, memory: 0, library: 0,
  });
  const [showHistory, setShowHistory] = useState(false);
  const [versions, setVersions] = useState<any[]>([]);
  // P46 — inline test panel toggle. promptVersion bumps every save so the
  // test panel can flag stale conversations.
  const [showTest, setShowTest] = useState(false);
  const [promptVersion, setPromptVersion] = useState(0);

  const reload = useCallback(async () => {
    const j = await fetch(`/api/agents/${params.id}`).then(r => r.json());
    if (j.agent) setAgent(j.agent);
  }, [params.id]);

  useEffect(() => { reload(); }, [reload]);

  // Pull counts in parallel for the right-sidebar accordion.
  useEffect(() => {
    async function load() {
      const [skR, mR, lR] = await Promise.all([
        fetch("/api/skills").then(r => r.json()),
        fetch(`/api/memories?agentId=${params.id}&filter=accepted`).then(r => r.json()),
        fetch("/api/library").then(r => r.json()),
      ]);
      setCounts(c => ({
        ...c,
        skills: (skR.skills || []).length,
        memory: (mR.memories || []).length,
        library: ((lR.artifacts || []).filter((a: any) => a.agentId === params.id)).length,
      }));
    }
    load();
  }, [params.id]);

  useEffect(() => {
    if (agent) {
      setCounts(c => ({
        ...c,
        tools: agent.tools.length,
        integrations: (agent.connectorIds || []).length,
      }));
    }
  }, [agent]);

  async function loadVersions() {
    const j = await fetch(`/api/agents/${params.id}/versions`).then(r => r.json());
    setVersions(j.versions || []);
  }

  async function save(patch: Partial<AgentLike>) {
    const r = await fetch(`/api/agents/${params.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (r.ok) {
      toast.success("Agent updated", "A version snapshot was saved to history.");
      reload();
      if (showHistory) loadVersions();
      // Bump promptVersion so the inline test panel can show its drift hint.
      setPromptVersion(v => v + 1);
    } else {
      toast.error("Save failed", (await r.json().catch(() => ({}))).error);
    }
  }

  async function rollback(version: number) {
    const ok = await confirm({
      title: `Roll back to v${version}?`,
      body: "Creates a new version with the rolled-back state. Reversible.",
      confirmLabel: "Roll back",
    });
    if (!ok) return;
    const r = await fetch(`/api/agents/${params.id}/versions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    });
    if (r.ok) { reload(); loadVersions(); toast.success(`Rolled back to v${version}`); }
    else toast.error("Rollback failed");
  }

  async function startThread() {
    const r = await fetch("/api/threads", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: params.id, title: `Chat with ${agent?.name || "agent"}` }),
    });
    const j = await r.json();
    router.push(`/threads/${j.thread.id}`);
  }

  if (!agent) {
    return (
      <AppShell>
        <Topbar title="…" />
        <div style={{ padding: 32, maxWidth: 1100, margin: "0 auto" }}>
          <Skeleton width={240} height={40} style={{ marginBottom: 12 }} />
          <Skeleton width={420} height={18} style={{ marginBottom: 24 }} />
          <Skeleton height={400} />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Topbar
        breadcrumb={
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
            <Link href="/agents/new" style={{ color: "var(--accent)", textDecoration: "none" }}>← Create agent</Link>
          </div>
        }
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              className="btn"
              onClick={() => setShowTest(s => !s)}
              style={showTest ? {
                background: "var(--accent)", color: "white",
                borderColor: "var(--accent)",
              } : undefined}
              title="Quick-test the agent without leaving the builder"
            >
              {showTest ? "● Testing" : "▶ Test"}
            </button>
            <button className="btn" onClick={() => { setShowHistory(s => !s); if (!showHistory) loadVersions(); }}>
              History {versions.length > 0 && <span style={{ marginLeft: 4, fontSize: 11, color: "var(--text-muted)" }}>({versions.length})</span>}
            </button>
            <button className="btn btn-primary" onClick={startThread}>+ New thread</button>
          </div>
        }
      />

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Main column: tabs + content */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Tabs */}
          <div style={{
            display: "flex", gap: 4, padding: "12px 24px 0",
            borderBottom: "1px solid var(--border)",
            overflowX: "auto",
          }}>
            {TABS.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                style={{
                  padding: "10px 14px",
                  border: "none", background: "transparent",
                  fontSize: 13, fontWeight: tab === t.key ? 600 : 500,
                  color: tab === t.key ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  borderBottom: `2px solid ${tab === t.key ? "var(--text)" : "transparent"}`,
                  marginBottom: -1,
                  whiteSpace: "nowrap",
                  display: "flex", alignItems: "center", gap: 6,
                  transition: "color 0.15s",
                }}>
                <span style={{ fontSize: 11, opacity: 0.7 }}>{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflowY: "auto", padding: "32px 32px 64px" }}>
            {showHistory ? (
              <HistoryPanel
                versions={versions} onRestore={rollback}
                onClose={() => setShowHistory(false)}
              />
            ) : tab === "config" ? (
              <ConfigTab agent={agent} onSave={save} />
            ) : tab === "invocations" ? (
              <InvocationsTab agent={agent} />
            ) : tab === "integrations" ? (
              <IntegrationsTab agent={agent} onSave={save} />
            ) : tab === "tools" ? (
              <ToolsTab agent={agent} onSave={save} />
            ) : tab === "skills" ? (
              <SkillsTab agent={agent} />
            ) : tab === "knowledge" ? (
              <KnowledgeTab agent={agent} />
            ) : tab === "memory" ? (
              <MemoryTab agent={agent} />
            ) : tab === "rubrics" ? (
              <RubricsTab agent={agent} />
            ) : tab === "library" ? (
              <LibraryTab agent={agent} />
            ) : tab === "security" ? (
              <SecurityTab agent={agent} onSave={save} />
            ) : null}
          </div>
        </div>

        {/* Right summary sidebar */}
        <SummarySidebar
          agent={agent}
          counts={counts}
          onJumpToTab={(t) => { setTab(t); setShowHistory(false); }}
        />

        {/* P46 — inline test panel (toggleable, sits beside SummarySidebar) */}
        {showTest && (
          <InlineTestPanel
            agentId={params.id}
            systemPromptVersion={promptVersion}
            onClose={() => setShowTest(false)}
          />
        )}
      </div>
    </AppShell>
  );
}

// ============ History panel (P28b carryover) ============

function HistoryPanel({ versions, onRestore, onClose }: {
  versions: any[]; onRestore: (v: number) => void; onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <div style={{ maxWidth: 880 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 className="h-display" style={{ fontSize: 28 }}>Version history</h2>
        <button className="btn" onClick={onClose} style={{ fontSize: 12 }}>Close</button>
      </div>
      {versions.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
          No version snapshots yet — edit the agent to start tracking history.
        </div>
      ) : (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          {versions.map((v: any) => (
            <div key={v.id} style={{ borderTop: "1px solid var(--border)" }}>
              <div onClick={() => setExpanded(expanded === v.version ? null : v.version)}
                style={{ padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 14 }}>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "var(--bg-subtle)", color: "var(--text-muted)" }}>v{v.version}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>{v.name}</div>
                  {v.changeNote && <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>{v.changeNote}</div>}
                </div>
                <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{new Date(v.createdAt).toLocaleString()}</span>
                <button className="btn" onClick={(e) => { e.stopPropagation(); onRestore(v.version); }}
                  style={{ fontSize: 11, padding: "4px 10px" }}>↺ Restore</button>
              </div>
              {expanded === v.version && (
                <div style={{ padding: "0 16px 16px", background: "var(--bg-subtle)" }}>
                  <pre style={{ fontSize: 11.5, fontFamily: "JetBrains Mono, monospace", whiteSpace: "pre-wrap", margin: "12px 0 8px", color: "var(--text-muted)", maxHeight: 240, overflow: "auto" }}>{v.systemPrompt}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
