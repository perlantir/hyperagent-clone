"use client";
// P36 — Right-side summary sidebar for the agent builder.
//
// Avatar tile + accordion of: Model, Invocations, Integrations, Tools,
// Skills, Memory, Library. Each accordion row shows a count badge and
// expands to a quick-pick mini-list (read-only, click → jump to tab).
//
// The sidebar mirrors the Hyperagent reference: a contextual at-a-glance
// of what the agent is wired to, with quick-add carets that switch to
// the matching tab.

import { useState } from "react";
import type { AgentLike, TabKey } from "./types";

interface Counts {
  invocations: number;
  integrations: number;
  tools: number;
  skills: number;
  memory: number;
  library: number;
}

const COLOR_GRADIENTS: Record<string, string> = {
  orange: "linear-gradient(135deg,#c2410c,#f97316)",
  blue:   "linear-gradient(135deg,#1d4ed8,#3b82f6)",
  green:  "linear-gradient(135deg,#15803d,#22c55e)",
  purple: "linear-gradient(135deg,#6d28d9,#a78bfa)",
};

export function SummarySidebar({
  agent, counts, onJumpToTab,
}: {
  agent: AgentLike;
  counts: Counts;
  onJumpToTab: (tab: TabKey) => void;
}) {
  const modelLabel = agent.modelId
    ? agent.modelId.replace(/-\d{8}$/, "").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : "Account default";

  return (
    <div style={{
      width: 240, flexShrink: 0,
      display: "flex", flexDirection: "column",
      borderLeft: "1px solid var(--border)",
      background: "var(--bg-subtle)",
    }}>
      {/* Avatar / name tile — P49: if avatar URL set, render image */}
      <div style={{
        padding: "20px 18px",
        borderBottom: "1px solid var(--border)",
        display: "flex", flexDirection: "column", alignItems: "center",
      }}>
        <div style={{
          width: 80, height: 80, borderRadius: 20,
          background: agent.avatar
            ? `url(${agent.avatar}) center/cover`
            : (COLOR_GRADIENTS[agent.color] || COLOR_GRADIENTS.orange),
          color: "white",
          display: "grid", placeItems: "center",
          fontSize: 32, fontWeight: 700,
          boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
        }}>{!agent.avatar && agent.icon}</div>
      </div>

      {/* Model row */}
      <Row
        title="Model"
        value={modelLabel}
        onClick={() => onJumpToTab("config")}
      />

      {/* Accordion items */}
      <Accordion
        title="Invocations"
        count={counts.invocations}
        onClick={() => onJumpToTab("invocations")}
      />
      <Accordion
        title="Integrations"
        count={counts.integrations}
        onClick={() => onJumpToTab("integrations")}
      />
      <Accordion
        title="Tools"
        count={counts.tools}
        onClick={() => onJumpToTab("tools")}
      />
      <Accordion
        title="Skills"
        count={counts.skills}
        onClick={() => onJumpToTab("skills")}
      />
      <Accordion
        title="Memory"
        count={counts.memory}
        onClick={() => onJumpToTab("memory")}
      />
      <Accordion
        title="Library"
        count={counts.library}
        onClick={() => onJumpToTab("library")}
      />
    </div>
  );
}

function Row({ title, value, onClick }: { title: string; value: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", flexDirection: "column", alignItems: "stretch",
      width: "100%", padding: "12px 18px",
      border: "none", borderBottom: "1px solid var(--border)",
      background: "transparent", textAlign: "left", cursor: "pointer",
      gap: 4,
    }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text)" }}>{title}</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 14, height: 14, borderRadius: 3, background: "var(--accent)", flexShrink: 0 }} />
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</span>
      </div>
    </button>
  );
}

function Accordion({ title, count, onClick }: { title: string; count: number; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      width: "100%", padding: "13px 18px",
      border: "none", borderBottom: "1px solid var(--border)",
      background: "transparent", textAlign: "left", cursor: "pointer",
    }}>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{title}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{count}</span>
        <span style={{ fontSize: 14, color: "var(--text-faint)" }}>›</span>
      </div>
    </button>
  );
}
