"use client";
// P63 — Manus Import settings section.
//
// Mirrors the section Hyperagent has under Settings. Lets users bring
// their prior Manus conversations + agents into Hyperagent in one
// upload.
//
// Mechanism:
//   1. User exports their Manus data from Manus (JSON export — file or
//      drag-drop). The export shape is documented in the upload help
//      text. We parse threads / agents / memories on our server and
//      insert them under the user's account.
//   2. Importer is idempotent — if the same export is uploaded twice,
//      we skip rows that already exist (matched by external_id).
//   3. After import we show a summary: # threads, # agents, # memories
//      created, plus any rows we skipped.
//
// Credential-paste alternative is intentionally NOT provided here:
//   Manus doesn't expose a public OAuth flow for third-party data
//   pulls, and we won't ask users to paste session cookies. JSON
//   export is the official portable path.

import { useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

interface ImportSummary {
  ok: boolean;
  threadsImported: number;
  agentsImported: number;
  memoriesImported: number;
  skipped: number;
  errors: string[];
}

interface ImportRecord {
  id: string;
  fileName: string;
  threadsImported: number;
  agentsImported: number;
  memoriesImported: number;
  skipped: number;
  errored: number;
  createdAt: number;
}

export function ManusImportSection() {
  const toast = useToast();
  const confirm = useConfirm();
  const [history, setHistory] = useState<ImportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [lastResult, setLastResult] = useState<ImportSummary | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch("/api/manus/imports");
      const j = await r.json();
      setHistory(j.imports || []);
    } finally { setLoading(false); }
  }
  useEffect(() => { reload(); }, []);

  async function handleFile(file: File) {
    if (!file.name.endsWith(".json") && !file.name.endsWith(".zip")) {
      toast.error("Unsupported file", "Manus export must be a .json or .zip file.");
      return;
    }
    setUploading(true);
    setLastResult(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch("/api/manus/imports", { method: "POST", body: fd });
      const j: ImportSummary & { error?: string } = await r.json();
      if (!r.ok || !j.ok) {
        toast.error("Import failed", j.error || "");
      } else {
        setLastResult(j);
        const total = j.threadsImported + j.agentsImported + j.memoriesImported;
        toast.success("Import complete",
          `Brought in ${total} item${total === 1 ? "" : "s"}.`);
        reload();
      }
    } catch (e: any) {
      toast.error("Import failed", e?.message || "");
    } finally {
      setUploading(false);
    }
  }

  async function clearHistory() {
    const ok = await confirm({
      title: "Clear import history?",
      body: "Doesn't delete the imported threads / agents / memories — just the audit history of past imports.",
      confirmLabel: "Clear",
      variant: "destructive",
    });
    if (!ok) return;
    await fetch("/api/manus/imports", { method: "DELETE" });
    reload();
  }

  return (
    <div>
      <h2 style={{ fontSize: 24, fontWeight: 600, marginBottom: 4 }}>Manus Import</h2>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 24, maxWidth: 720, lineHeight: 1.55 }}>
        Bring your past Manus conversations, agents, and memories into Hyperagent.
        Export your data from Manus first (Settings → Data → Export), then drop the
        <code className="mono" style={MONO_INLINE}>.json</code> or
        <code className="mono" style={MONO_INLINE}>.zip</code> file below.
        Imports are idempotent — re-uploading the same file won&apos;t create duplicates.
      </p>

      {/* Drop zone */}
      <UploadCard onFile={handleFile} uploading={uploading} />

      {/* Latest result */}
      {lastResult && (
        <div className="card" style={{ padding: 18, marginTop: 18, background: "rgba(34,197,94,0.06)", borderColor: "rgba(34,197,94,0.30)" }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: "#22c55e" }}>Import complete</div>
          <div style={{ fontSize: 13, color: "var(--text)", display: "flex", flexWrap: "wrap", gap: 16 }}>
            <span><strong>{lastResult.threadsImported}</strong> threads</span>
            <span><strong>{lastResult.agentsImported}</strong> agents</span>
            <span><strong>{lastResult.memoriesImported}</strong> memories</span>
            {lastResult.skipped > 0 && (
              <span style={{ color: "var(--text-muted)" }}>{lastResult.skipped} skipped (already imported)</span>
            )}
          </div>
          {lastResult.errors.length > 0 && (
            <details style={{ marginTop: 10, fontSize: 12, color: "var(--text-muted)" }}>
              <summary style={{ cursor: "pointer" }}>{lastResult.errors.length} errors</summary>
              <ul style={{ paddingLeft: 18, margin: "6px 0" }}>
                {lastResult.errors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* History */}
      <div style={{ marginTop: 32 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.6, margin: 0 }}>
            Past imports
          </h3>
          {history.length > 0 && (
            <button onClick={clearHistory} className="btn"
              style={{ fontSize: 11, padding: "4px 10px", color: "#dc2626", borderColor: "rgba(220,38,38,0.3)" }}>
              Clear history
            </button>
          )}
        </div>
        {loading ? (
          <div style={{ fontSize: 12, color: "var(--text-faint)" }}>Loading…</div>
        ) : history.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-faint)", padding: 16, border: "1px dashed var(--border)", borderRadius: 10, textAlign: "center" }}>
            No imports yet.
          </div>
        ) : (
          <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            {history.map((h, i) => (
              <div key={h.id} style={{
                padding: "10px 14px", borderTop: i === 0 ? "none" : "1px solid var(--border)",
                display: "grid", gridTemplateColumns: "1.4fr 80px 80px 80px 90px",
                gap: 12, alignItems: "center", fontSize: 12,
              }}>
                <div>
                  <div style={{ fontWeight: 500 }}>{h.fileName}</div>
                  <div style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 1 }}>
                    {new Date(h.createdAt).toLocaleString()}
                  </div>
                </div>
                <div style={{ textAlign: "right", color: "var(--text-muted)" }}>{h.threadsImported}t</div>
                <div style={{ textAlign: "right", color: "var(--text-muted)" }}>{h.agentsImported}a</div>
                <div style={{ textAlign: "right", color: "var(--text-muted)" }}>{h.memoriesImported}m</div>
                <div style={{ textAlign: "right", color: h.errored ? "#dc2626" : "var(--text-faint)" }}>
                  {h.errored ? `${h.errored} err` : (h.skipped ? `${h.skipped} skip` : "—")}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Format help */}
      <details style={{ marginTop: 32, fontSize: 12.5, color: "var(--text-muted)" }}>
        <summary style={{ cursor: "pointer", marginBottom: 8 }}>Expected export format</summary>
        <div style={{ padding: 12, background: "var(--bg-subtle)", borderRadius: 8, lineHeight: 1.55 }}>
          The Manus export is a single <code className="mono">.json</code> file (or a
          <code className="mono">.zip</code> containing one) with this shape:
          <pre style={{ marginTop: 8, fontFamily: "JetBrains Mono, monospace", fontSize: 11, lineHeight: 1.5 }}>{`{
  "threads": [{
    "id": "ext-thread-123",
    "title": "Pricing strategy",
    "createdAt": 1728000000000,
    "messages": [
      { "role": "user", "content": "...", "createdAt": ... },
      { "role": "assistant", "content": "...", "createdAt": ... }
    ]
  }],
  "agents": [{
    "id": "ext-agent-1",
    "name": "Research analyst",
    "systemPrompt": "..."
  }],
  "memories": [{
    "id": "ext-mem-7",
    "content": "Prefers 3-bullet executive summaries.",
    "importance": 8
  }]
}`}</pre>
          We match on the <code className="mono">id</code> field for deduplication.
          Missing top-level keys are simply skipped.
        </div>
      </details>
    </div>
  );
}

const MONO_INLINE: React.CSSProperties = {
  background: "var(--bg-subtle)", padding: "1px 6px", borderRadius: 4, margin: "0 4px",
};

// ─── Drop zone ───────────────────────────────────────────────────────

function UploadCard({ onFile, uploading }: { onFile: (f: File) => void; uploading: boolean }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      onDragEnter={e => { e.preventDefault(); setDragging(true); }}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={e => { e.preventDefault(); if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={e => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      style={{
        border: `2px dashed ${dragging ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 14,
        background: dragging ? "var(--accent-bg)" : "var(--bg-elev)",
        padding: 28,
        textAlign: "center",
        transition: "border-color 0.15s, background 0.15s",
      }}>
      <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.6 }}>↥</div>
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
        {uploading ? "Importing…" : "Drop your Manus export here"}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14 }}>
        .json or .zip · up to 25 MB
      </div>
      <label style={{ display: "inline-block" }}>
        <input type="file" accept=".json,.zip,application/json,application/zip"
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
          }}
          disabled={uploading}
          style={{ display: "none" }} />
        <span className="btn btn-primary" style={{ fontSize: 13, padding: "7px 16px", cursor: uploading ? "default" : "pointer" }}>
          Choose file…
        </span>
      </label>
    </div>
  );
}
