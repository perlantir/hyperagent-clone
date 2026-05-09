"use client";
// P50 — Thread 3-dot actions menu.
//
// Used everywhere a user sees a thread row (sidebar, /threads list, thread
// page header). Wires the four standard actions:
//   - Rename (inline editable title)
//   - Regenerate name (LLM-summarises recent messages)
//   - Move to project (projects picker)
//   - Archive (soft-delete; reversible from the "Show archived" filter)
//   - Delete (hard delete; double-confirm)
//
// Each action calls the relevant /api endpoint and invokes onChanged()
// so the parent reloads. The component is intentionally state-light so it
// can render in narrow sidebar rows or wide thread headers without layout
// surgery — pop-up menu uses fixed position based on the trigger button.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

interface Props {
  threadId: string;
  threadTitle: string;
  threadProjectId: string | null;
  // Called after a mutation succeeds so the parent can reload its list /
  // re-fetch the thread row. Truthy mutation in the success toast.
  onChanged?: () => void;
  // Optional explicit "deleted" callback so the parent can also remove the
  // row from local state without waiting on a refetch.
  onDeleted?: () => void;
  // Render style: "icon" = compact ⋮ button (sidebar / list rows);
  // "label" = pill button labeled "Actions" (thread header desktop layout).
  variant?: "icon" | "label";
}

export function ThreadActionsMenu({
  threadId, threadTitle, threadProjectId, onChanged, onDeleted, variant = "icon",
}: Props) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(threadTitle);
  const [moveOpen, setMoveOpen] = useState(false);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  // Position the menu under the trigger and close on outside click.
  useEffect(() => {
    if (!open) return;
    const t = triggerRef.current;
    if (t) {
      const r = t.getBoundingClientRect();
      // Show menu below trigger by default; flip up if too close to viewport bottom.
      const bottom = window.innerHeight - r.bottom;
      const top = bottom < 220 ? Math.max(r.top - 220 - 4, 8) : r.bottom + 4;
      const left = Math.min(r.left, window.innerWidth - 220);
      setCoords({ top, left });
    }
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as any) &&
          triggerRef.current && !triggerRef.current.contains(e.target as any)) {
        setOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("click", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  // Lazy-load projects only when the move modal opens.
  useEffect(() => {
    if (!moveOpen) return;
    fetch("/api/projects").then(r => r.json()).then(j => {
      setProjects((j.projects || []).map((p: any) => ({ id: p.id, name: p.name })));
    }).catch(() => {});
  }, [moveOpen]);

  // ───── Actions ──────────────────────────────────────────────────────

  async function rename(newTitle: string) {
    const t = newTitle.trim();
    if (!t || t === threadTitle) { setRenameOpen(false); return; }
    setBusy(true);
    const r = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: t }),
    });
    setBusy(false);
    if (r.ok) {
      toast.success("Renamed");
      setRenameOpen(false);
      onChanged?.();
    } else {
      toast.error("Rename failed");
    }
  }

  async function regenerate() {
    setOpen(false);
    setBusy(true);
    const r = await fetch(`/api/threads/${threadId}/regenerate-title`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok && j.title) {
      toast.success("Renamed", `New title: ${j.title}`);
      onChanged?.();
    } else {
      toast.error("Regenerate failed", j.error || "");
    }
  }

  async function moveToProject(projectId: string | null) {
    setBusy(true);
    const r = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    setBusy(false);
    if (r.ok) {
      toast.success("Moved");
      setMoveOpen(false);
      onChanged?.();
    } else {
      toast.error("Move failed");
    }
  }

  async function archive() {
    setOpen(false);
    setBusy(true);
    const r = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archivedAt: Date.now() }),
    });
    setBusy(false);
    if (r.ok) {
      toast.success("Archived", "Find archived threads in the threads list with the Show archived filter.");
      onChanged?.();
      onDeleted?.();
    } else {
      toast.error("Archive failed");
    }
  }

  async function destroy() {
    setOpen(false);
    const ok = await confirm({
      title: "Delete this thread?",
      body: "This permanently removes the thread and all its messages. Use Archive if you want to keep it but hide it.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    const r = await fetch(`/api/threads/${threadId}`, { method: "DELETE" });
    setBusy(false);
    if (r.ok) {
      toast.success("Deleted");
      onDeleted?.();
      // If we're currently viewing this thread, route home.
      if (typeof window !== "undefined" && window.location.pathname === `/threads/${threadId}`) {
        router.push("/");
      }
    } else {
      toast.error("Delete failed");
    }
  }

  // ───── Render ───────────────────────────────────────────────────────

  return (
    <>
      <button ref={triggerRef}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(o => !o); }}
        title="Thread actions"
        className={variant === "label" ? "btn" : ""}
        style={variant === "label" ? { fontSize: 12, padding: "4px 10px" } : {
          width: 22, height: 22, borderRadius: 4,
          border: "none", background: "transparent",
          color: "var(--text-muted)", cursor: "pointer",
          display: "grid", placeItems: "center", fontSize: 14,
          opacity: busy ? 0.5 : 1,
        }}>
        {variant === "label" ? "Actions ▾" : "⋮"}
      </button>

      {/* Floating menu */}
      {open && coords && (
        <div ref={menuRef} style={{
          position: "fixed", top: coords.top, left: coords.left, zIndex: 200,
          width: 220, background: "var(--bg)",
          border: "1px solid var(--border)", borderRadius: 10,
          boxShadow: "0 10px 40px rgba(0,0,0,0.18)", padding: 4,
        }}>
          <MenuItem icon="✎"  label="Rename"             onClick={() => { setOpen(false); setRenameValue(threadTitle); setRenameOpen(true); }} />
          <MenuItem icon="↻"  label="Regenerate name"    onClick={regenerate} />
          <MenuItem icon="◫"  label="Move to project…"   onClick={() => { setOpen(false); setMoveOpen(true); }} />
          <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
          <MenuItem icon="□"  label="Archive"            onClick={archive} />
          <MenuItem icon="✕"  label="Delete…"            onClick={destroy} destructive />
        </div>
      )}

      {/* Rename modal */}
      {renameOpen && (
        <Modal onClose={() => setRenameOpen(false)} title="Rename thread">
          <input
            autoFocus
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") rename(renameValue); }}
            style={{
              width: "100%", padding: "8px 11px", fontSize: 13.5,
              border: "1px solid var(--border)", borderRadius: 8,
              background: "var(--bg)", color: "var(--text)", outline: "none",
              marginBottom: 12,
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button onClick={() => setRenameOpen(false)} className="btn" style={{ fontSize: 12 }}>Cancel</button>
            <button onClick={() => rename(renameValue)} disabled={busy || !renameValue.trim()}
              className="btn btn-primary" style={{ fontSize: 12 }}>Save</button>
          </div>
        </Modal>
      )}

      {/* Move-to-project modal */}
      {moveOpen && (
        <Modal onClose={() => setMoveOpen(false)} title="Move to project">
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12, maxHeight: 280, overflowY: "auto" }}>
            <ProjectChoice
              name="(No project)"
              selected={threadProjectId === null}
              onClick={() => moveToProject(null)}
            />
            {projects.map(p => (
              <ProjectChoice key={p.id} name={p.name}
                selected={threadProjectId === p.id}
                onClick={() => moveToProject(p.id)}
              />
            ))}
            {projects.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--text-faint)", padding: 14, textAlign: "center" }}>
                No projects yet. Create one from the sidebar to organize threads.
              </div>
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => setMoveOpen(false)} className="btn" style={{ fontSize: 12 }}>Close</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function MenuItem({ icon, label, onClick, destructive }: {
  icon: string; label: string; onClick: () => void; destructive?: boolean;
}) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 10, width: "100%",
      padding: "8px 10px", borderRadius: 6,
      border: "none", background: "transparent",
      color: destructive ? "#dc2626" : "var(--text)",
      fontSize: 12.5, textAlign: "left", cursor: "pointer",
    }} onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-subtle)")}
       onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
      <span style={{ width: 16, color: "var(--text-faint)", textAlign: "center" }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function ProjectChoice({ name, selected, onClick }: { name: string; selected: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 10, width: "100%",
      padding: "8px 10px", borderRadius: 6,
      border: "1px solid " + (selected ? "var(--accent)" : "transparent"),
      background: selected ? "var(--accent-bg)" : "transparent",
      fontSize: 12.5, textAlign: "left", cursor: "pointer",
      color: "var(--text)",
    }}>
      <span style={{ width: 14, color: selected ? "var(--accent)" : "var(--text-faint)" }}>
        {selected ? "●" : "○"}
      </span>
      <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
    </button>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
      display: "grid", placeItems: "center", zIndex: 300,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: "min(420px, 92vw)", background: "var(--bg)",
        border: "1px solid var(--border)", borderRadius: 14,
        padding: 18, boxShadow: "0 12px 50px rgba(0,0,0,0.25)",
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}
