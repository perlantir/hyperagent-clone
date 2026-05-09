"use client";
// P37 — Canvas pane.
//
// Right-hand workspace inside a thread. Three view modes:
//   - "doc": working doc (Plan Tasks, Findings, Decisions, Notes) — the
//            collaborative scratch space backed by Liveblocks.
//   - "artifact": fullscreen render of the active artifact in a
//            sandboxed iframe (carries forward from /library/[id]).
//   - "tile": grid of every artifact in the thread, click to open one
//            in artifact mode.
//
// Bottom of the canvas: thumbnail dock with up to 8 recent artifacts +
// "+ N more" link to the tile view. Click a tile to surface in canvas.
//
// State kept in the parent ThreadWorkspace so chat actions can poke the
// canvas (e.g. when the agent emits a new artifact, auto-switch to
// artifact mode and select it).

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";

export type CanvasMode = "doc" | "artifact" | "tile";

interface ArtifactRow {
  id: string; type: string; title: string; createdAt: number;
}

interface WorkingDocSection {
  id: string; name: string; content: string;
}

interface WorkingDoc {
  id: string;
  title: string;
  sections: WorkingDocSection[];
}

const TYPE_COLOR: Record<string, { bg: string; fg: string }> = {
  webpage:  { bg: "linear-gradient(135deg,#fed7aa,#fdba74)", fg: "#c2410c" },
  document: { bg: "linear-gradient(135deg,#d1fae5,#6ee7b7)", fg: "#15803d" },
  table:    { bg: "linear-gradient(135deg,#bae6fd,#7dd3fc)", fg: "#1d4ed8" },
  image:    { bg: "linear-gradient(135deg,#ddd6fe,#c4b5fd)", fg: "#6d28d9" },
};

export function Canvas({
  threadId, artifacts, activeArtifactId,
  workingDoc, mode, onChangeMode, onSelectArtifact, onClose,
}: {
  threadId: string;
  artifacts: ArtifactRow[];
  activeArtifactId: string | null;
  workingDoc: WorkingDoc | null;
  mode: CanvasMode;
  onChangeMode: (m: CanvasMode) => void;
  onSelectArtifact: (id: string | null) => void;
  onClose: () => void;
}) {
  const activeArtifact = useMemo(
    () => artifacts.find(a => a.id === activeArtifactId) || null,
    [artifacts, activeArtifactId],
  );

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      borderLeft: "1px solid var(--border)",
      background: "var(--bg)",
      minWidth: 0,
    }}>
      {/* Mode toggle bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "10px 14px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-elev)",
      }}>
        <ModeButton active={mode === "doc"}
          onClick={() => onChangeMode("doc")}
          icon="▤" label="Doc" />
        <ModeButton active={mode === "artifact"}
          onClick={() => { if (activeArtifact || artifacts.length > 0) {
            if (!activeArtifactId && artifacts[0]) onSelectArtifact(artifacts[0].id);
            onChangeMode("artifact");
          } else {
            onChangeMode("artifact");
          } }}
          icon="◫" label={activeArtifact ? activeArtifact.title.slice(0, 24) : "Artifact"}
          disabled={artifacts.length === 0 && !activeArtifact} />
        <ModeButton active={mode === "tile"}
          onClick={() => onChangeMode("tile")}
          icon="▦" label={`Tiles (${artifacts.length})`}
          disabled={artifacts.length === 0} />
        <div style={{ flex: 1 }} />
        <button onClick={onClose}
          title="Close canvas"
          style={{
            padding: "4px 10px", fontSize: 12, color: "var(--text-muted)",
            background: "transparent", border: "1px solid var(--border)",
            borderRadius: 6, cursor: "pointer",
          }}>
          ✕ Close
        </button>
      </div>

      {/* Mode-specific content */}
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        {mode === "doc" && (
          <DocView workingDoc={workingDoc} />
        )}
        {mode === "artifact" && activeArtifact && (
          <iframe
            key={activeArtifact.id}
            src={`/api/artifacts/${activeArtifact.id}?render=1`}
            sandbox="allow-scripts allow-same-origin"
            style={{
              width: "100%", height: "100%", border: "none", display: "block",
              background: "var(--bg)",
            }}
            title={activeArtifact.title}
          />
        )}
        {mode === "artifact" && !activeArtifact && (
          <EmptyState
            title="No artifact selected"
            body="Pick one from the dock below, or switch to Tiles to see all of them."
          />
        )}
        {mode === "tile" && (
          <TileView artifacts={artifacts} onPick={(id) => {
            onSelectArtifact(id);
            onChangeMode("artifact");
          }} />
        )}
      </div>

      {/* Artifact dock at bottom */}
      {artifacts.length > 0 && (
        <ArtifactDock
          artifacts={artifacts}
          activeId={activeArtifactId}
          onPick={(id) => {
            onSelectArtifact(id);
            onChangeMode("artifact");
          }}
        />
      )}
    </div>
  );
}

// ============ Doc view ============

function DocView({ workingDoc }: { workingDoc: WorkingDoc | null }) {
  if (!workingDoc) {
    return (
      <EmptyState
        title="Working doc is empty"
        body="The agent populates this doc with Plan Tasks, Findings, Decisions, and Notes as it works. Start a turn to seed it."
      />
    );
  }
  return (
    <div style={{ overflowY: "auto", height: "100%", padding: "32px 40px" }}>
      <h1 className="h-display" style={{ fontSize: 36, marginBottom: 24, lineHeight: 1.1 }}>{workingDoc.title}</h1>
      {workingDoc.sections.map(s => (
        <div key={s.id} style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 10, color: "var(--text)" }}>{s.name}</h2>
          <div style={{
            fontSize: 13.5, lineHeight: 1.7, whiteSpace: "pre-wrap",
            color: s.content.trim() ? "var(--text-muted)" : "var(--text-faint)",
            fontStyle: s.content.trim() ? "normal" : "italic",
          }}>{s.content.trim() || "—"}</div>
        </div>
      ))}
    </div>
  );
}

// ============ Tile view ============

function TileView({ artifacts, onPick }: {
  artifacts: ArtifactRow[];
  onPick: (id: string) => void;
}) {
  return (
    <div style={{ overflowY: "auto", height: "100%", padding: 20 }}>
      {artifacts.length === 0 ? (
        <EmptyState
          title="No artifacts in this thread yet"
          body="Webpages, documents, tables, images created by the agent will appear here."
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}>
          {artifacts.map(a => {
            const c = TYPE_COLOR[a.type] || TYPE_COLOR.webpage;
            return (
              <button key={a.id} onClick={() => onPick(a.id)} className="card"
                style={{ padding: 0, overflow: "hidden", cursor: "pointer", textAlign: "left", border: "1px solid var(--border)" }}>
                <div style={{
                  height: 100, background: c.bg, color: c.fg,
                  display: "grid", placeItems: "center",
                  fontFamily: "Instrument Serif, serif", fontSize: 18, padding: 12,
                  textAlign: "center",
                }}>{a.title}</div>
                <div style={{ padding: "8px 12px" }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.title}</div>
                  <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                    {a.type} · {new Date(a.createdAt).toLocaleString()}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============ Bottom artifact dock ============

function ArtifactDock({ artifacts, activeId, onPick }: {
  artifacts: ArtifactRow[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  // Show up to 8 most-recent; the rest accessed via Tile view.
  const visible = artifacts.slice(0, 8);
  const overflow = Math.max(0, artifacts.length - visible.length);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "8px 12px",
      borderTop: "1px solid var(--border)",
      background: "var(--bg-elev)",
      overflowX: "auto",
      flexShrink: 0,
    }}>
      {visible.map(a => {
        const c = TYPE_COLOR[a.type] || TYPE_COLOR.webpage;
        return (
          <button key={a.id} onClick={() => onPick(a.id)}
            title={a.title}
            style={{
              flexShrink: 0,
              width: 56, height: 40, padding: 0,
              border: activeId === a.id ? "2px solid var(--text)" : "1px solid var(--border)",
              borderRadius: 6, cursor: "pointer",
              background: c.bg, color: c.fg,
              display: "grid", placeItems: "center",
              fontFamily: "Instrument Serif, serif", fontSize: 9,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              padding: "2px 4px",
            }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{a.title.slice(0, 16)}</span>
          </button>
        );
      })}
      {overflow > 0 && (
        <button title={`${overflow} more`}
          style={{
            flexShrink: 0,
            width: 56, height: 40,
            border: "1px solid var(--border)",
            borderRadius: 6, cursor: "default",
            background: "var(--bg-subtle)",
            color: "var(--text-muted)", fontSize: 11, fontWeight: 600,
          }}>
          +{overflow}
        </button>
      )}
    </div>
  );
}

// ============ Helpers ============

function ModeButton({ active, onClick, icon, label, disabled }: {
  active: boolean; onClick: () => void;
  icon: string; label: string; disabled?: boolean;
}) {
  return (
    <button onClick={disabled ? undefined : onClick} disabled={disabled}
      style={{
        padding: "5px 10px", fontSize: 12, fontWeight: 500,
        background: active ? "var(--text)" : "transparent",
        color: active ? "var(--bg)" : disabled ? "var(--text-faint)" : "var(--text-muted)",
        border: "1px solid",
        borderColor: active ? "var(--text)" : "var(--border)",
        borderRadius: 6, cursor: disabled ? "not-allowed" : "pointer",
        display: "flex", alignItems: "center", gap: 6,
        opacity: disabled ? 0.5 : 1,
        whiteSpace: "nowrap",
      }}>
      <span style={{ fontSize: 11, opacity: 0.8 }}>{icon}</span>
      {label}
    </button>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div style={{
      height: "100%", display: "grid", placeItems: "center",
      padding: 32, textAlign: "center",
    }}>
      <div style={{ maxWidth: 380 }}>
        <div className="h-display" style={{ fontSize: 22, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 13.5, color: "var(--text-muted)", lineHeight: 1.55 }}>{body}</div>
      </div>
    </div>
  );
}
