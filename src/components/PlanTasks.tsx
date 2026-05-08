"use client";
// P24 — Renders the working doc's Plan Tasks section as a live checkbox list
// with progress. Auto-refreshes on a short interval while the chat is active
// so users see tasks tick off in real time as the agent updates the doc.
//
// Renders nothing if the working doc has no Plan Tasks. Once tasks exist,
// shows them in a small floating panel beside the chat.

import { useEffect, useState } from "react";

interface PlanTask {
  text: string;
  done: boolean;
  index: number;
}

interface DocResponse {
  sections: Array<{ name: string; content: string; updatedAt: number }>;
  planTasks: PlanTask[];
  progress: { done: number; total: number; ratio: number } | null;
  updatedAt: number;
}

export function PlanTasks({ threadId }: { threadId: string }) {
  const [doc, setDoc] = useState<DocResponse | null>(null);

  async function fetchDoc() {
    try {
      const r = await fetch(`/api/threads/${threadId}/working-doc`, { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as DocResponse;
      setDoc(data);
    } catch {}
  }

  useEffect(() => {
    fetchDoc();
    // Poll every 3 seconds while the page is visible. Cheap (single GET).
    // Real-time push via SSE would be cleaner but fits naturally into P28b's
    // streaming-event work — for now polling keeps it simple.
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        fetchDoc();
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [threadId]);

  if (!doc || !doc.planTasks || doc.planTasks.length === 0) return null;

  const { done, total, ratio } = doc.progress!;

  return (
    <div style={{
      border: "1px solid var(--border)",
      borderRadius: 10,
      padding: 16,
      marginBottom: 12,
      background: "var(--bg-elevated)",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Plan</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {done} of {total} done
        </div>
      </div>

      {/* Progress bar */}
      <div style={{
        height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden", marginBottom: 12,
      }}>
        <div style={{
          width: `${Math.round(ratio * 100)}%`,
          height: "100%", background: "var(--accent, #3b82f6)",
          transition: "width 240ms ease",
        }} />
      </div>

      {/* Task list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {doc.planTasks.map(t => (
          <div key={t.index} style={{
            display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13,
            opacity: t.done ? 0.6 : 1,
            textDecoration: t.done ? "line-through" : "none",
          }}>
            <span style={{
              width: 16, height: 16, borderRadius: 4, flexShrink: 0,
              border: "1.5px solid var(--text-muted)",
              background: t.done ? "var(--accent, #3b82f6)" : "transparent",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, color: "white", fontWeight: 700, marginTop: 2,
            }}>{t.done ? "✓" : ""}</span>
            <span style={{ flex: 1 }}>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
