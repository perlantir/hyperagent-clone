"use client";
// P25b — Save-as-memory button. Appears on assistant messages in chat.
// Click → small inline modal with content + category + importance, fields
// pre-filled from the message text. Save → POST /api/memories with
// forceState=accepted (user-initiated saves bypass the proposal queue).

import { useState } from "react";

const CATEGORIES = [
  { value: "preference", label: "Preference" },
  { value: "user_fact", label: "User fact" },
  { value: "tools_and_workflows", label: "Tools / workflows" },
  { value: "project_context", label: "Project context" },
  { value: "domain_knowledge", label: "Domain knowledge" },
  { value: "people", label: "People" },
  { value: "active_work", label: "Active work" },
  { value: "organization", label: "Organization" },
];

export function SaveMemoryButton({ messageText }: { messageText: string }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("preference");
  const [importance, setImportance] = useState(5);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function openModal() {
    // Pre-fill with first 200 chars of message
    setContent(messageText.slice(0, 200).trim());
    setSaved(false);
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    const r = await fetch("/api/memories", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, category, importance, forceState: "accepted" }),
    });
    setSaving(false);
    if (r.ok) {
      setSaved(true);
      setTimeout(() => { setOpen(false); setSaved(false); }, 1200);
    } else {
      alert("Failed to save memory: " + ((await r.json()).error || "unknown"));
    }
  }

  return (
    <>
      <button onClick={openModal}
        title="Save as memory"
        style={{
          background: "transparent", border: "1px solid var(--border)",
          padding: "2px 8px", borderRadius: 4, fontSize: 11,
          color: "var(--text-muted)", cursor: "pointer",
        }}>
        + Save as memory
      </button>

      {open && (
        <div onClick={() => setOpen(false)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,.4)",
          zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: "var(--bg)", borderRadius: 12, padding: 20,
            width: "min(520px, 90vw)", boxShadow: "0 8px 32px rgba(0,0,0,.2)",
            border: "1px solid var(--border)",
          }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Save as memory</div>
            <textarea value={content} onChange={e => setContent(e.target.value)}
              placeholder="Memory content (one declarative sentence)…"
              style={{
                width: "100%", padding: 10, fontSize: 13, borderRadius: 6,
                border: "1px solid var(--border)", background: "var(--bg)",
                color: "var(--text)", minHeight: 80, resize: "vertical",
                marginBottom: 12,
              }} />
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <select value={category} onChange={e => setCategory(e.target.value)}
                style={{ padding: "6px 8px", borderRadius: 6, fontSize: 12,
                  border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", flex: 1 }}>
                {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <label style={{ fontSize: 11, color: "var(--text-muted)" }}>Importance</label>
                <input type="number" min={1} max={10} value={importance}
                  onChange={e => setImportance(parseInt(e.target.value) || 5)}
                  style={{ width: 60, padding: "6px 8px", fontSize: 12, borderRadius: 6,
                    border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setOpen(false)} disabled={saving}
                style={{ fontSize: 12, padding: "6px 14px" }}>Cancel</button>
              <button className="btn btn-primary" disabled={!content.trim() || saving}
                onClick={save}
                style={{ fontSize: 12, padding: "6px 14px" }}>
                {saving ? "Saving…" : saved ? "✓ Saved" : "Save"}
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 12 }}>
              User-initiated saves auto-accept (importance ≥ 8 also auto-pins to T1).
            </div>
          </div>
        </div>
      )}
    </>
  );
}
