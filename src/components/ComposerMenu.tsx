"use client";
// P38 — Composer + button menu and run-mode dropdown.
//
// AddMenu replaces the bare file picker with a sectioned menu:
//   Upload file · Add integration · Add output · Add asset · Add memory · Add skill
//
// Each "Add X" option opens a picker modal that lets the user select an
// item; the selected item is appended into the composer textarea as a
// reference token like @memory:mem_abc123 — the chat route doesn't yet
// resolve these references, but the input persists, the composer renders
// them as pills, and downstream slices can wire resolution as the
// product matures.
//
// RunModeMenu sits next to the Send button: Plan first / Execute / Suggest
// learnings / Build skill / Give feedback / Run evaluation. The first two
// switch the next chat turn's runMode; the latter four are immediate
// actions on the current thread / most-recent run.

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

export type RunMode =
  | "execute" | "plan_first";

export interface AddMenuProps {
  threadId: string;
  onPickFile: () => void;
  onInsertReference: (token: string) => void;
}

const SECTION_HEADER: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
  textTransform: "uppercase", color: "var(--text-faint)",
  padding: "8px 14px 4px",
};
const ITEM: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10,
  width: "100%", padding: "8px 14px", border: "none",
  background: "transparent", textAlign: "left", cursor: "pointer",
  fontSize: 13,
};
const ITEM_HOVER = { background: "var(--bg-subtle)" };

export function AddMenu({ threadId, onPickFile, onInsertReference }: AddMenuProps) {
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState<null | "integration" | "output" | "asset" | "memory" | "skill">(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Add to message"
        style={{
          width: 32, height: 32, borderRadius: 7, background: "transparent",
          border: "1px solid var(--border)", color: "var(--text-muted)",
          fontSize: 14, lineHeight: 1, cursor: "pointer",
        }}>
        +
      </button>
      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: 0,
          width: 240, padding: "6px 0",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)", borderRadius: 10,
          boxShadow: "0 12px 32px rgba(0,0,0,0.12)",
          zIndex: 30,
        }}>
          <div style={SECTION_HEADER}>FROM YOUR LIBRARY</div>
          <MenuItem icon="▤" label="Add output" sub="Existing artifact" onClick={() => { setOpen(false); setPicker("output"); }} />
          <MenuItem icon="◐" label="Add memory" sub="Reference a saved fact" onClick={() => { setOpen(false); setPicker("memory"); }} />
          <MenuItem icon="◇" label="Add skill" sub="Force a skill into context" onClick={() => { setOpen(false); setPicker("skill"); }} />
          <div style={SECTION_HEADER}>FROM CONNECTIONS</div>
          <MenuItem icon="⊟" label="Add integration" sub="Connector tools for this turn" onClick={() => { setOpen(false); setPicker("integration"); }} />
          <div style={SECTION_HEADER}>UPLOAD</div>
          <MenuItem icon="📎" label="Upload file" sub="Image or text up to 25 MB" onClick={() => { setOpen(false); onPickFile(); }} />
          <MenuItem icon="🗂" label="Add asset" sub="Re-use a previously uploaded file" onClick={() => { setOpen(false); setPicker("asset"); }} />
        </div>
      )}

      {picker && (
        <PickerModal
          kind={picker}
          threadId={threadId}
          onClose={() => setPicker(null)}
          onPick={(token) => { setPicker(null); onInsertReference(token); }}
        />
      )}
    </div>
  );
}

function MenuItem({ icon, label, sub, onClick }: { icon: string; label: string; sub?: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...ITEM, ...(hover ? ITEM_HOVER : {}) }}>
      <span style={{ width: 20, fontSize: 13, opacity: 0.7 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, color: "var(--text)" }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 1 }}>{sub}</div>}
      </div>
    </button>
  );
}

// =============== Picker modals ===============

function PickerModal({ kind, threadId, onClose, onPick }: {
  kind: "integration" | "output" | "asset" | "memory" | "skill";
  threadId: string;
  onClose: () => void;
  onPick: (token: string) => void;
}) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setLoading(true);
    const url = (() => {
      switch (kind) {
        case "memory":      return "/api/memories?filter=accepted";
        case "skill":       return "/api/skills";
        case "integration": return "/api/connectors";
        case "output":      return "/api/library";
        case "asset":       return `/api/library`;
      }
    })();
    fetch(url).then(r => r.json()).then(j => {
      const list =
        kind === "memory"      ? (j.memories || []) :
        kind === "skill"       ? (j.skills || []) :
        kind === "integration" ? (j.connectors || []).filter((c: any) => c.connected) :
        kind === "output"      ? (j.artifacts || []).filter((a: any) => a.threadId === threadId) :
        kind === "asset"       ? (j.artifacts || []).filter((a: any) => a.threadId === threadId && (a.type === "image" || a.type === "document")) :
        [];
      setItems(list);
      setLoading(false);
    });
  }, [kind, threadId]);

  const title: Record<string, string> = {
    memory: "Add memory", skill: "Add skill", integration: "Add integration",
    output: "Add output (artifact)", asset: "Add asset (uploaded file)",
  };
  const filtered = items.filter(item => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    const text = (item.name || item.title || item.content || "").toLowerCase();
    return text.includes(q);
  });

  function pick(item: any) {
    const token =
      kind === "memory"      ? `@memory:${item.id}` :
      kind === "skill"       ? `@skill:${item.id}` :
      kind === "integration" ? `@integration:${item.slug}` :
      kind === "output"      ? `@artifact:${item.id}` :
      kind === "asset"       ? `@asset:${item.id}` : "";
    if (token) onPick(token);
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
      display: "grid", placeItems: "center", zIndex: 250,
      backdropFilter: "blur(4px)",
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: "min(560px, 92vw)", maxHeight: "70vh",
        background: "var(--bg-elev)", border: "1px solid var(--border)",
        borderRadius: 12, boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ padding: "16px 20px 8px" }}>
          <h2 className="h-display" style={{ fontSize: 22, marginBottom: 4 }}>{title[kind]}</h2>
          <input
            autoFocus
            value={filter} onChange={e => setFilter(e.target.value)}
            placeholder={`Search ${kind}s…`}
            style={{
              width: "100%", marginTop: 10, padding: "8px 12px",
              border: "1px solid var(--border)", borderRadius: 7,
              background: "var(--bg)", color: "var(--text)",
              fontSize: 13, outline: "none",
            }}
          />
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <EmptyPicker kind={kind} />
          ) : (
            filtered.slice(0, 100).map((item: any) => (
              <button key={item.id || item.slug}
                onClick={() => pick(item)}
                style={{
                  width: "100%", padding: "10px 20px",
                  border: "none", borderTop: "1px solid var(--border)",
                  background: "transparent", textAlign: "left", cursor: "pointer",
                  display: "flex", flexDirection: "column", gap: 2,
                }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {item.name || item.title || (item.content || "").slice(0, 80)}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                  {item.description || item.content?.slice(0, 100) || item.type || ""}
                </div>
              </button>
            ))
          )}
        </div>
        <div style={{ padding: "10px 20px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose} style={{ fontSize: 12, padding: "5px 12px" }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function EmptyPicker({ kind }: { kind: string }) {
  const empties: Record<string, { title: string; body: string; href: string; cta: string }> = {
    memory:      { title: "No memories yet", body: "Save anything from a chat with the + Save as memory button.", href: "/learning", cta: "Open Learning" },
    skill:       { title: "No skills installed", body: "Browse the template gallery to install skills.", href: "/skills", cta: "Browse skills" },
    integration: { title: "No connected integrations", body: "Connect Slack, Gmail, Notion, etc. via OAuth.", href: "/integrations", cta: "Open Integrations" },
    output:      { title: "No artifacts in this thread", body: "Webpages and documents the agent creates appear here.", href: "/library", cta: "Open Library" },
    asset:       { title: "No uploaded files in this thread", body: "Drop a file into the chat to add it as an asset.", href: "#", cta: "Got it" },
  };
  const e = empties[kind];
  return (
    <div style={{ padding: 32, textAlign: "center" }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{e.title}</div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.5, maxWidth: 360, margin: "0 auto 14px" }}>{e.body}</div>
      {e.href !== "#" && (
        <Link href={e.href} className="btn" style={{ fontSize: 12, padding: "5px 12px" }}>{e.cta}</Link>
      )}
    </div>
  );
}

// =============== Run-mode menu ===============

interface RunModeMenuProps {
  threadId: string;
  agentId: string | null;
  lastRunId: string | null;
  runMode: RunMode;
  onChangeRunMode: (m: RunMode) => void;
  onSend: () => void;
  disabled?: boolean;
}

const RUN_MODE_LABELS: Record<RunMode, string> = {
  execute: "Execute",
  plan_first: "Plan first",
};

export function RunModeMenu({ threadId, agentId, lastRunId, runMode, onChangeRunMode, onSend, disabled }: RunModeMenuProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function suggestLearnings() {
    setBusy("learn"); setOpen(false);
    const r = await fetch(`/api/threads/${threadId}/suggest-learnings`, { method: "POST" });
    setBusy(null);
    if (r.ok) {
      const j = await r.json();
      const n = j.proposals?.length || 0;
      toast.success(
        n > 0 ? `${n} learning proposal${n === 1 ? "" : "s"} drafted` : "No new learnings detected",
        n > 0 ? "Review and accept in Learning." : "Try after a longer conversation.",
      );
    } else {
      toast.error("Suggest failed", (await r.json().catch(() => ({}))).error);
    }
  }

  async function buildSkill() {
    setBusy("skill"); setOpen(false);
    const r = await fetch(`/api/threads/${threadId}/build-skill`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    setBusy(null);
    if (r.ok) {
      const j = await r.json();
      toast.success(`Skill "${j.skill.name}" created`, "Find it under Skills.");
    } else {
      toast.error("Couldn't build skill", (await r.json().catch(() => ({}))).error);
    }
  }

  async function runEval() {
    if (!lastRunId) {
      toast.warning("No completed run yet", "Send a message first; evaluation runs against the most recent assistant turn.");
      return;
    }
    setBusy("eval"); setOpen(false);
    const r = await fetch(`/api/runs/${lastRunId}/evaluate`, { method: "POST" });
    setBusy(null);
    if (r.ok) {
      const j = await r.json();
      const passed = j.results.filter((x: any) => x.passed).length;
      toast.success(
        j.results.length > 0 ? `Eval ran: ${passed}/${j.results.length} passing rubrics` : "No rubrics applied",
        j.results.length > 0 ? "Open the trace viewer for findings." : "Pin a rubric to evaluate this agent.",
      );
    } else {
      toast.error("Evaluation failed", (await r.json().catch(() => ({}))).error);
    }
  }

  return (
    <div ref={ref} style={{ position: "relative", display: "flex", alignItems: "stretch" }}>
      {/* Send button — clicks default to send w/ current mode */}
      <button
        onClick={onSend}
        disabled={disabled}
        style={{
          padding: "0 12px", fontSize: 12.5, fontWeight: 500,
          background: "var(--text)", color: "var(--bg)",
          border: "none", borderRadius: "8px 0 0 8px",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.3 : 1,
          height: 32, display: "flex", alignItems: "center", gap: 6,
        }}>
        <span style={{ fontSize: 13 }}>↑</span>
        {RUN_MODE_LABELS[runMode]}
      </button>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          padding: "0 8px", fontSize: 11,
          background: "var(--text)", color: "var(--bg)",
          border: "none", borderLeft: "1px solid var(--bg-elev)",
          borderRadius: "0 8px 8px 0",
          cursor: "pointer", opacity: 0.85,
          height: 32, display: "flex", alignItems: "center",
        }}>
        ▾
      </button>

      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", right: 0,
          width: 260, padding: "6px 0",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)", borderRadius: 10,
          boxShadow: "0 12px 32px rgba(0,0,0,0.12)",
          zIndex: 30,
        }}>
          <div style={SECTION_HEADER}>RUN MODE</div>
          <RunModeItem
            icon="↑" label="Execute" sub="Default — run the next message"
            active={runMode === "execute"}
            onClick={() => { onChangeRunMode("execute"); setOpen(false); }}
          />
          <RunModeItem
            icon="◰" label="Plan first" sub="Draft a plan, pause for review"
            active={runMode === "plan_first"}
            onClick={() => { onChangeRunMode("plan_first"); setOpen(false); }}
          />

          <div style={SECTION_HEADER}>ACTIONS</div>
          <RunModeItem
            icon="★" label="Run evaluation" sub="Score the last run against pinned rubrics"
            onClick={runEval} busy={busy === "eval"}
          />
          <RunModeItem
            icon="◇" label="Suggest learnings" sub="LLM analysis → memories + skill drafts"
            onClick={suggestLearnings} busy={busy === "learn"}
          />
          <RunModeItem
            icon="★" label="Build skill" sub="Distill this thread into a reusable skill"
            onClick={buildSkill} busy={busy === "skill"}
          />
          <RunModeItem
            icon="✎" label="Give feedback" sub="Rate the last run + leave a note"
            onClick={() => { setFeedbackOpen(true); setOpen(false); }}
          />
        </div>
      )}

      {feedbackOpen && (
        <FeedbackModal
          threadId={threadId} runId={lastRunId}
          onClose={() => setFeedbackOpen(false)}
        />
      )}
    </div>
  );
}

function RunModeItem({ icon, label, sub, active, onClick, busy }: {
  icon: string; label: string; sub: string;
  active?: boolean; onClick: () => void; busy?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick} disabled={busy}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        ...ITEM, ...(hover && !busy ? ITEM_HOVER : {}),
        opacity: busy ? 0.6 : 1,
        background: active ? "var(--accent-bg)" : (hover ? "var(--bg-subtle)" : "transparent"),
      }}>
      <span style={{ width: 20, fontSize: 13, opacity: 0.7 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, color: active ? "var(--accent)" : "var(--text)" }}>
          {label}{busy && " …"}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 1 }}>{sub}</div>
      </div>
      {active && <span style={{ fontSize: 12, color: "var(--accent)" }}>✓</span>}
    </button>
  );
}

function FeedbackModal({ threadId, runId, onClose }: {
  threadId: string; runId: string | null; onClose: () => void;
}) {
  const toast = useToast();
  const [rating, setRating] = useState<-1 | 0 | 1>(1);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    const r = await fetch("/api/feedback", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, runId, rating, text: text.trim() || undefined, scope: runId ? "run" : "thread" }),
    });
    setSaving(false);
    if (r.ok) {
      toast.success("Feedback saved", "It will inform future evaluation + improvement proposals.");
      onClose();
    } else {
      toast.error("Submit failed", (await r.json().catch(() => ({}))).error);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
      display: "grid", placeItems: "center", zIndex: 260,
      backdropFilter: "blur(4px)",
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: "min(440px, 92vw)", padding: 24,
        background: "var(--bg-elev)", border: "1px solid var(--border)",
        borderRadius: 12, boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
      }}>
        <h2 className="h-display" style={{ fontSize: 22, marginBottom: 4 }}>Give feedback</h2>
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 16 }}>
          {runId ? "Rate the most recent assistant turn." : "Rate this thread overall."}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          {[
            { v: 1 as const, label: "👍 Good" },
            { v: 0 as const, label: "Mixed" },
            { v: -1 as const, label: "👎 Off" },
          ].map(o => (
            <button key={o.v} onClick={() => setRating(o.v)}
              className={`chip ${rating === o.v ? "active" : ""}`}
              style={{ flex: 1 }}>
              {o.label}
            </button>
          ))}
        </div>
        <textarea
          value={text} onChange={e => setText(e.target.value)}
          placeholder="What worked, what didn't, what to do differently…"
          rows={4}
          style={{
            width: "100%", padding: 10, borderRadius: 7,
            border: "1px solid var(--border)", background: "var(--bg)",
            color: "var(--text)", fontSize: 13, lineHeight: 1.55,
            resize: "vertical", outline: "none", fontFamily: "inherit",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Submit"}
          </button>
        </div>
      </div>
    </div>
  );
}
