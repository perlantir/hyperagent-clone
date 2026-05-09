"use client";
// P35 — "Save as Agent" button for the thread Topbar.
//
// Opens a small modal to capture name + description + color, then POSTs
// to /api/agents/from-thread which snapshots the thread's current agent
// config (or platform defaults if no agent is bound) into a fresh saved
// agent. By default the originating thread is rebound to the new agent
// so subsequent turns continue against the saved version — matching what
// users expect when they click "save".

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";

const COLOR_OPTIONS: Array<{ id: "orange" | "blue" | "green" | "purple"; gradient: string }> = [
  { id: "orange", gradient: "linear-gradient(135deg,#c2410c,#f97316)" },
  { id: "blue",   gradient: "linear-gradient(135deg,#1d4ed8,#3b82f6)" },
  { id: "green",  gradient: "linear-gradient(135deg,#15803d,#22c55e)" },
  { id: "purple", gradient: "linear-gradient(135deg,#6d28d9,#a78bfa)" },
];

export function SaveAsAgentButton({ threadId }: { threadId: string }) {
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<"orange" | "blue" | "green" | "purple">("orange");
  const [icon, setIcon] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    const r = await fetch("/api/agents/from-thread", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        name: name.trim(),
        description: description.trim() || undefined,
        icon: icon.trim() || undefined,
        color,
      }),
    });
    setSaving(false);
    if (r.ok) {
      const j = await r.json();
      toast.success(`Saved as agent "${j.agent.name}"`, "Thread re-bound to the new agent.");
      setOpen(false);
      router.push(`/agents/${j.agent.id}`);
    } else {
      toast.error("Save failed", (await r.json().catch(() => ({}))).error);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Promote this thread's configuration into a saved agent"
        style={{
          padding: "5px 12px", fontSize: 12, fontWeight: 500,
          background: "transparent", border: "1px solid var(--border)",
          borderRadius: 7, color: "var(--text-muted)", cursor: "pointer",
        }}>
        + Save as agent
      </button>
      {open && (
        <div onClick={() => !saving && setOpen(false)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
          display: "grid", placeItems: "center", zIndex: 250,
          backdropFilter: "blur(4px)",
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            width: "min(440px, 92vw)", background: "var(--bg-elev)",
            border: "1px solid var(--border)", borderRadius: 12,
            boxShadow: "0 20px 60px rgba(0,0,0,0.25)", padding: 24,
          }}>
            <h2 className="h-display" style={{ fontSize: 22, marginBottom: 4 }}>Save thread as agent</h2>
            <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 18 }}>
              Snapshot this thread's system prompt and tools into a reusable agent. The thread will continue using the new saved version.
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label className="h-section">Name</label>
                <input
                  className="input" autoFocus
                  value={name} onChange={e => setName(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && name.trim()) save(); }}
                  placeholder="e.g. SF restaurant scout"
                  style={{ marginTop: 6 }} />
              </div>
              <div>
                <label className="h-section">Description (optional)</label>
                <input
                  className="input"
                  value={description} onChange={e => setDescription(e.target.value)}
                  placeholder="One-sentence summary of what this agent does"
                  style={{ marginTop: 6 }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 14 }}>
                <div>
                  <label className="h-section">Icon</label>
                  <input
                    className="input"
                    value={icon} onChange={e => setIcon(e.target.value.slice(0, 2))}
                    placeholder={(name.trim()[0] || "A").toUpperCase()}
                    maxLength={2}
                    style={{ marginTop: 6, textAlign: "center", fontSize: 16, fontWeight: 700 }} />
                </div>
                <div>
                  <label className="h-section">Color</label>
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    {COLOR_OPTIONS.map(c => (
                      <button
                        key={c.id} type="button"
                        onClick={() => setColor(c.id)}
                        style={{
                          width: 36, height: 36, borderRadius: 8,
                          border: color === c.id ? "2px solid var(--text)" : "2px solid transparent",
                          background: c.gradient, padding: 0, cursor: "pointer",
                          boxShadow: color === c.id ? "0 0 0 2px var(--bg-elev) inset" : "none",
                        }} />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 22 }}>
              <button className="btn" onClick={() => setOpen(false)} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={saving || !name.trim()}>
                {saving ? "Saving…" : "Save as agent"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
