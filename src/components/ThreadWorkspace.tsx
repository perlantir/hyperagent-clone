"use client";
// P37 — Thread workspace shell.
//
// Wraps the ChatView in a resizable two-column layout with the canvas
// pane on the right. Canvas opens automatically when the thread has any
// artifacts; the user can also toggle it with a button in the chat
// composer surround.
//
// Layout state (canvas open + split width + canvas mode + selected
// artifact) persists per-thread in localStorage so reopening the thread
// keeps the user's view.

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { ChatView } from "./ChatView";
import { Canvas, type CanvasMode } from "./Canvas";
import { PlanTasks } from "./PlanTasks";

interface Artifact {
  id: string; type: string; title: string; createdAt: number;
}

interface WorkingDocSection { id: string; name: string; content: string; }
interface WorkingDoc { id: string; title: string; sections: WorkingDocSection[]; }

const STORAGE_PREFIX = "ha:thread:";

export function ThreadWorkspace({ threadId, agentId }: {
  threadId: string;
  agentId: string | null;
}) {
  const storage = useMemo(() => ({
    canvasOpen: `${STORAGE_PREFIX}${threadId}:canvasOpen`,
    splitPct: `${STORAGE_PREFIX}${threadId}:splitPct`,
    mode: `${STORAGE_PREFIX}${threadId}:mode`,
    activeArtifact: `${STORAGE_PREFIX}${threadId}:activeArtifact`,
  }), [threadId]);

  const [canvasOpen, setCanvasOpen] = useState<boolean>(false);
  const [splitPct, setSplitPct] = useState(55);  // chat width %
  const [mode, setMode] = useState<CanvasMode>("doc");
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [workingDoc, setWorkingDoc] = useState<WorkingDoc | null>(null);
  const dragRef = useRef(false);

  // Hydrate from localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const o = localStorage.getItem(storage.canvasOpen);
      if (o) setCanvasOpen(o === "1");
      const s = localStorage.getItem(storage.splitPct);
      if (s) setSplitPct(Number(s));
      const m = localStorage.getItem(storage.mode);
      if (m) setMode(m as CanvasMode);
      const a = localStorage.getItem(storage.activeArtifact);
      if (a) setActiveArtifactId(a);
    } catch {}
  }, [storage.canvasOpen, storage.splitPct, storage.mode, storage.activeArtifact]);

  // Persist
  useEffect(() => {
    try { localStorage.setItem(storage.canvasOpen, canvasOpen ? "1" : "0"); } catch {}
  }, [canvasOpen, storage.canvasOpen]);
  useEffect(() => {
    try { localStorage.setItem(storage.splitPct, String(splitPct)); } catch {}
  }, [splitPct, storage.splitPct]);
  useEffect(() => {
    try { localStorage.setItem(storage.mode, mode); } catch {}
  }, [mode, storage.mode]);
  useEffect(() => {
    try {
      if (activeArtifactId) localStorage.setItem(storage.activeArtifact, activeArtifactId);
      else localStorage.removeItem(storage.activeArtifact);
    } catch {}
  }, [activeArtifactId, storage.activeArtifact]);

  // Pull artifacts + working doc; poll every 4s so canvas stays current
  // when the agent emits new ones mid-conversation.
  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/library`);
      const j = await r.json();
      const filtered = (j.artifacts || []).filter((a: any) => a.threadId === threadId)
        .sort((a: any, b: any) => b.createdAt - a.createdAt);
      setArtifacts(filtered);
      // Auto-open canvas the first time an artifact arrives.
      if (filtered.length > 0 && !canvasOpen && !localStorage.getItem(storage.canvasOpen)) {
        setCanvasOpen(true);
        setMode("artifact");
        setActiveArtifactId(filtered[0].id);
      }
    } catch {}
    try {
      const r = await fetch(`/api/threads/${threadId}/working-doc`);
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.sections)) {
          setWorkingDoc({
            id: j.threadId,
            title: "Working doc",
            sections: j.sections.map((s: any) => ({
              id: s.id || s.name, name: s.name, content: s.content || "",
            })),
          });
        }
      }
    } catch {}
  }, [threadId, canvasOpen, storage.canvasOpen]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  // Resizable split via mousemove on a center handle.
  function onSplitterDown(e: React.MouseEvent) {
    e.preventDefault();
    dragRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const pct = (e.clientX / window.innerWidth) * 100;
      // Clamp 25%..80% so neither side disappears.
      setSplitPct(Math.max(25, Math.min(80, pct)));
    }
    function onUp() {
      if (dragRef.current) {
        dragRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
      {/* Chat column */}
      <div style={{
        flex: canvasOpen ? `0 0 ${splitPct}%` : "1 1 100%",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
        minWidth: 0,
        transition: dragRef.current ? "none" : "flex 0.18s ease",
      }}>
        {/* Plan Tasks live header — same as before */}
        <div style={{ padding: "0 16px", paddingTop: 12 }}>
          <PlanTasks threadId={threadId} />
        </div>
        <ChatView threadId={threadId} agentId={agentId} />

        {/* Canvas-toggle floating button when canvas is closed */}
        {!canvasOpen && (
          <button onClick={() => setCanvasOpen(true)}
            title="Open canvas"
            style={{
              position: "absolute", right: 16, bottom: 110,
              padding: "7px 12px", fontSize: 12, fontWeight: 500,
              background: "var(--bg-elev)", color: "var(--text)",
              border: "1px solid var(--border-strong)", borderRadius: 8,
              cursor: "pointer", boxShadow: "0 4px 12px rgba(0,0,0,0.06)",
              display: "flex", alignItems: "center", gap: 6,
              zIndex: 10,
            }}>
            <span style={{ fontSize: 11 }}>◫</span>
            Canvas
            {artifacts.length > 0 && (
              <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>· {artifacts.length}</span>
            )}
          </button>
        )}
      </div>

      {/* Splitter */}
      {canvasOpen && (
        <div onMouseDown={onSplitterDown}
          style={{
            width: 4, cursor: "col-resize",
            background: "var(--border)",
            flexShrink: 0,
            position: "relative",
          }}>
          <div style={{
            position: "absolute", top: "50%", left: -3,
            width: 10, height: 40, transform: "translateY(-50%)",
            background: "transparent",
          }} />
        </div>
      )}

      {/* Canvas column */}
      {canvasOpen && (
        <Canvas
          threadId={threadId}
          artifacts={artifacts}
          activeArtifactId={activeArtifactId}
          workingDoc={workingDoc}
          mode={mode}
          onChangeMode={setMode}
          onSelectArtifact={setActiveArtifactId}
          onClose={() => setCanvasOpen(false)}
        />
      )}
    </div>
  );
}
