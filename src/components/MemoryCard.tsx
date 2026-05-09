"use client";
import { useState } from "react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";

interface Memory {
  id: string;
  content: string;
  state: string;
  category: string | null;
  importance: number;
  pinned: boolean;
  piiFlag: boolean;
  whenToUse: string | null;
  tags: string[] | null;
  agentId: string | null;
  projectId: string | null;
  createdAt: number;
  decayScore: number | null;
  lastUsedAt: number | null;
}

const STATE_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  proposed:   { label: "PROPOSED",   bg: "rgba(234,179,8,0.12)",   color: "#eab308" },
  accepted:   { label: "ACCEPTED",   bg: "rgba(34,197,94,0.10)",   color: "#22c55e" },
  rejected:   { label: "REJECTED",   bg: "rgba(220,38,38,0.10)",   color: "#dc2626" },
  expired:    { label: "EXPIRED",    bg: "var(--bg-elevated)",     color: "var(--text-muted)" },
  superseded: { label: "SUPERSEDED", bg: "var(--bg-elevated)",     color: "var(--text-muted)" },
};

export function MemoryCard({ memory, onChange }: { memory: Memory; onChange: () => void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ content: memory.content, importance: memory.importance });

  const badge = STATE_BADGE[memory.state] || STATE_BADGE.accepted;
  const ageDays = Math.floor((Date.now() - memory.createdAt) / (24 * 3600 * 1000));

  async function patch(action: string) {
    setBusy(true);
    await fetch(`/api/memories/${memory.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setBusy(false);
    onChange();
  }

  async function del() {
    const ok = await confirm({
      title: "Delete this memory?",
      body: `"${memory.content.slice(0, 80)}${memory.content.length > 80 ? "…" : ""}"`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    const r = await fetch(`/api/memories/${memory.id}`, { method: "DELETE" });
    setBusy(false);
    onChange();
    if (r.ok) toast.success("Memory deleted");
    else toast.error("Failed to delete memory");
  }

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
              background: badge.bg, color: badge.color, letterSpacing: 0.5,
            }}>{badge.label}</span>
            {memory.pinned && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                background: "rgba(59,130,246,0.10)", color: "#3b82f6" }}>📌 PINNED</span>
            )}
            {memory.piiFlag && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                background: "rgba(220,38,38,0.10)", color: "#dc2626" }}>PII</span>
            )}
            {memory.category && (
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{memory.category}</span>
            )}
            <span style={{ fontSize: 10, color: "var(--text-faint)" }}>· importance {memory.importance}/10</span>
            <span style={{ fontSize: 10, color: "var(--text-faint)" }}>· {ageDays}d old</span>
          </div>

          {editing ? (
            <textarea value={editForm.content}
              onChange={e => setEditForm({ ...editForm, content: e.target.value })}
              style={{ width: "100%", padding: 8, fontSize: 13, borderRadius: 6,
                border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", minHeight: 60 }} />
          ) : (
            <div style={{ fontSize: 13.5, lineHeight: 1.45 }}>{memory.content}</div>
          )}

          {memory.whenToUse && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              <em>When: {memory.whenToUse}</em>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        {memory.state === "proposed" && (
          <>
            <button className="btn btn-primary" disabled={busy} onClick={() => patch("accept")}
              style={{ fontSize: 11, padding: "4px 10px" }}>Accept</button>
            <button className="btn" disabled={busy} onClick={() => patch("reject")}
              style={{ fontSize: 11, padding: "4px 10px" }}>Reject</button>
          </>
        )}
        {memory.state === "accepted" && (
          <>
            <button className="btn" disabled={busy}
              onClick={() => patch(memory.pinned ? "unpin" : "pin")}
              style={{ fontSize: 11, padding: "4px 10px" }}>
              {memory.pinned ? "Unpin" : "Pin"}
            </button>
            <button className="btn" disabled={busy} onClick={() => del()}
              style={{ fontSize: 11, padding: "4px 10px" }}>Delete</button>
          </>
        )}
      </div>
    </div>
  );
}
