"use client";
import { useState } from "react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";

interface Rubric {
  id: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  isPinned: boolean;
  criteria: Array<{ name: string; type: string; weight: number; required: boolean }>;
  passingThreshold: number;
  judgePassingScore: number;
  version: number;
}

export function RubricCard({ rubric, onChange }: { rubric: Rubric; onChange: () => void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const detCount = rubric.criteria.filter(c => c.type === "deterministic").length;
  const judgeCount = rubric.criteria.filter(c => c.type === "judge").length;
  const requiredCount = rubric.criteria.filter(c => c.required).length;

  async function togglePin() {
    setBusy(true);
    await fetch(`/api/rubrics/${rubric.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: rubric.isPinned ? "unpin" : "pin" }),
    });
    setBusy(false);
    onChange();
  }

  async function del() {
    const ok = await confirm({
      title: `Delete "${rubric.name}"?`,
      body: "Past evaluations using this rubric remain in trace history, but the rubric itself can no longer be applied.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    const r = await fetch(`/api/rubrics/${rubric.id}`, { method: "DELETE" });
    setBusy(false);
    if (!r.ok) toast.error("Delete failed", (await r.json().catch(() => ({}))).error);
    else toast.success("Rubric deleted");
    onChange();
  }

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{rubric.name}</span>
            {rubric.isBuiltin && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                background: "rgba(168,85,247,0.10)", color: "#a855f7", letterSpacing: 0.5 }}>BUILT-IN</span>
            )}
            {rubric.isPinned && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                background: "rgba(59,130,246,0.10)", color: "#3b82f6" }}>📌 PINNED</span>
            )}
            <span style={{ fontSize: 11, color: "var(--text-faint)" }}>v{rubric.version}</span>
          </div>
          {rubric.description && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.45, marginBottom: 6 }}>
              {rubric.description}
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
            {rubric.criteria.length} criteria ({detCount} deterministic, {judgeCount} judge, {requiredCount} required) ·
            pass threshold {Math.round(rubric.passingThreshold * 100)}% · judge passing ≥ {rubric.judgePassingScore}/5
          </div>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 6, background: "var(--bg-elevated)", fontSize: 12 }}>
          {rubric.criteria.map((c, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderTop: i ? "1px solid var(--border)" : "none" }}>
              <span style={{ flex: 1 }}>
                <strong>{c.name}</strong>
                <span style={{ marginLeft: 8, color: "var(--text-muted)" }}>
                  {c.type} · weight {c.weight}{c.required ? " · required" : ""}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button className="btn" onClick={() => setExpanded(!expanded)}
          style={{ fontSize: 11, padding: "4px 10px" }}>
          {expanded ? "Hide criteria" : "Show criteria"}
        </button>
        <button className="btn" disabled={busy} onClick={togglePin}
          style={{ fontSize: 11, padding: "4px 10px" }}>
          {rubric.isPinned ? "Unpin" : "Pin"}
        </button>
        {!rubric.isBuiltin && (
          <button className="btn" disabled={busy} onClick={del}
            style={{ fontSize: 11, padding: "4px 10px" }}>Delete</button>
        )}
      </div>
    </div>
  );
}
