"use client";
// P50 — Thread header breadcrumb with inline title editor + 3-dot menu.
//
// Renders into Topbar's `breadcrumb` slot. Click the title to enter edit
// mode (Enter saves, Escape cancels); the 3-dot menu beside it exposes
// Rename/Regenerate/Move/Archive/Delete via ThreadActionsMenu.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ThreadActionsMenu } from "@/components/ThreadActionsMenu";

export function ThreadHeader({
  threadId, initialTitle, projectId,
}: {
  threadId: string;
  initialTitle: string;
  projectId: string | null;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialTitle);

  // Refresh local title when prop changes (e.g. after server-side router push).
  useEffect(() => { setTitle(initialTitle); setDraft(initialTitle); }, [initialTitle]);

  async function commit() {
    const next = draft.trim();
    if (!next || next === title) { setEditing(false); return; }
    const r = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next }),
    });
    if (r.ok) { setTitle(next); setEditing(false); router.refresh(); }
    else { setEditing(false); }
  }

  return (
    <div style={{ fontSize: 13, color: "var(--text-muted)", display: "flex", gap: 8, alignItems: "center" }}>
      <Link href="/" style={{ color: "var(--text-muted)", textDecoration: "none" }}>Threads</Link>
      <span style={{ opacity: 0.4 }}>/</span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") { setDraft(title); setEditing(false); }
          }}
          style={{
            background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: 6, padding: "2px 8px", fontSize: 13, fontWeight: 500,
            color: "var(--text)", outline: "none", minWidth: 200, maxWidth: 400,
          }}
        />
      ) : (
        <button onClick={() => setEditing(true)}
          title="Click to rename"
          style={{
            color: "var(--text)", fontWeight: 500, fontSize: 13,
            background: "transparent", border: "none", padding: "2px 4px",
            borderRadius: 4, cursor: "text",
          }}
          onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-subtle)")}
          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
          {title}
        </button>
      )}
      <ThreadActionsMenu
        threadId={threadId}
        threadTitle={title}
        threadProjectId={projectId}
        onChanged={() => router.refresh()}
        variant="icon"
      />
    </div>
  );
}
