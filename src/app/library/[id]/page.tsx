"use client";
// P31b — Artifact detail page.
//   - Sandboxed iframe preview (via /api/artifacts/{id}?render=1)
//   - Live edit (title + body) with Save creating a new version
//   - Version history sidebar with click-to-restore
//   - Open-in-new-tab link to the raw render
//
// The iframe uses sandbox="allow-scripts allow-same-origin" — same-origin so
// the rendered styles + fonts can load, allow-scripts for any embedded D3 /
// chart libraries the artifact may include. We keep frame-ancestors limited
// in the API response.

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { Skeleton, SkeletonRow } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

interface Artifact {
  id: string;
  threadId: string;
  type: "webpage" | "image" | "table" | "document";
  title: string;
  body: string;
  createdAt: number;
}
interface Version {
  id: string;
  version: number;
  title: string;
  body: string;
  createdAt: number;
  changeNote: string | null;
}

export default function ArtifactPage() {
  const params = useParams();
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const id = params?.id as string;
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [iframeKey, setIframeKey] = useState(0); // force-reload after save
  const [showHistory, setShowHistory] = useState(false);
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);

  const load = useCallback(async () => {
    const a = await fetch(`/api/artifacts/${id}`).then(r => r.json());
    if (a.artifact) {
      setArtifact(a.artifact);
      setTitle(a.artifact.title);
      setBody(a.artifact.body);
      setIframeKey(k => k + 1);
    }
    const v = await fetch(`/api/artifacts/${id}/versions`).then(r => r.json());
    setVersions(v.versions || []);
  }, [id]);

  useEffect(() => { if (id) load(); }, [id, load]);

  async function save() {
    if (saving) return;
    setSaving(true);
    const r = await fetch(`/api/artifacts/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body }),
    });
    setSaving(false);
    if (r.ok) {
      const j = await r.json();
      setEditing(false);
      load();
      toast.success(`Saved as v${j.newVersion}`, "Previous version captured in history.");
    } else {
      toast.error("Save failed", (await r.json().catch(() => ({}))).error);
    }
  }

  async function restore(version: number) {
    const ok = await confirm({
      title: `Restore to v${version}?`,
      body: "This creates a new version with the restored content. The current state is captured first, so the restore is reversible.",
      confirmLabel: "Restore",
    });
    if (!ok) return;
    const r = await fetch(`/api/artifacts/${id}/versions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    });
    if (r.ok) {
      const j = await r.json();
      load();
      toast.success(`Restored to v${version}`, `New snapshot saved as v${j.newVersion}.`);
    } else {
      toast.error("Restore failed", (await r.json().catch(() => ({}))).error);
    }
  }

  async function del() {
    const ok = await confirm({
      title: `Delete "${artifact?.title}"?`,
      body: "All version history will be removed too.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    const r = await fetch(`/api/artifacts/${id}`, { method: "DELETE" });
    if (r.ok) { toast.success("Artifact deleted"); router.push("/library"); }
    else toast.error("Delete failed");
  }

  if (!artifact) {
    return (
      <AppShell>
        <Topbar title="Library" />
        <div style={{ padding: "32px 48px", maxWidth: 1200, margin: "0 auto" }}>
          <Skeleton width={140} height={11} style={{ marginBottom: 8 }} />
          <Skeleton width={320} height={32} style={{ marginBottom: 24 }} />
          <Skeleton height={500} />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Topbar breadcrumb={
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          <a href="/library" style={{ color: "var(--accent)", textDecoration: "none" }}>Library</a>
          <span style={{ opacity: 0.4, margin: "0 8px" }}>/</span>
          <span style={{ color: "var(--text)", fontWeight: 500 }}>{artifact.title}</span>
        </div>
      } />
      <div style={{ overflowY: "auto", padding: "24px 32px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 20 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {editing ? (
                <input className="input" value={title} onChange={e => setTitle(e.target.value)}
                  style={{ fontSize: 22, fontFamily: "Instrument Serif,serif", padding: "8px 12px" }} />
              ) : (
                <h1 className="h-display" style={{ fontSize: 30, marginBottom: 4 }}>{artifact.title}</h1>
              )}
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                {artifact.type} · v{(versions.length || 0) + 1} current ·{" "}
                {new Date(artifact.createdAt).toLocaleString()}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {!editing ? (
                <>
                  <button className="btn" onClick={() => setShowHistory(s => !s)}>
                    History {versions.length > 0 && <span style={{ marginLeft: 4, fontSize: 11, color: "var(--text-muted)" }}>({versions.length})</span>}
                  </button>
                  <a className="btn" href={`/api/artifacts/${id}?render=1`} target="_blank" rel="noopener noreferrer">Open ↗</a>
                  <button className="btn" onClick={() => setEditing(true)}>Edit</button>
                  <button className="btn" onClick={del} style={{ color: "#dc2626" }}>Delete</button>
                </>
              ) : (
                <>
                  <button className="btn" onClick={() => { setEditing(false); setTitle(artifact.title); setBody(artifact.body); }}>Cancel</button>
                  <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
                </>
              )}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: showHistory ? "1fr 320px" : "1fr", gap: 24 }}>
            {/* Preview / Edit pane */}
            {editing ? (
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                className="mono"
                style={{
                  width: "100%", minHeight: 600, padding: 16,
                  border: "1px solid var(--border)", borderRadius: 10,
                  background: "var(--bg-subtle)", color: "var(--text)",
                  fontSize: 13, fontFamily: "JetBrains Mono, monospace",
                  lineHeight: 1.6, resize: "vertical", outline: "none",
                }}
              />
            ) : (
              <div style={{
                border: "1px solid var(--border)", borderRadius: 12,
                overflow: "hidden", background: "var(--bg-elev)",
              }}>
                <iframe
                  key={iframeKey}
                  src={`/api/artifacts/${id}?render=1`}
                  sandbox="allow-scripts allow-same-origin"
                  style={{
                    width: "100%", height: 700, border: "none",
                    display: "block", background: "var(--bg)",
                  }}
                  title={artifact.title}
                />
              </div>
            )}

            {/* Version history sidebar */}
            {showHistory && !editing && (
              <div style={{
                border: "1px solid var(--border)", borderRadius: 12,
                background: "var(--bg-elev)", overflow: "hidden", maxHeight: 700,
                display: "flex", flexDirection: "column",
              }}>
                <div className="h-section" style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
                  Version history · {versions.length}
                </div>
                <div style={{ overflowY: "auto", flex: 1 }}>
                  {versions.length === 0 ? (
                    <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 13, textAlign: "center" }}>
                      No prior versions yet. Edit the artifact to start tracking history.
                    </div>
                  ) : versions.map(v => (
                    <div key={v.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <div onClick={() => setExpandedVersion(expandedVersion === v.version ? null : v.version)}
                        style={{ padding: "10px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "var(--bg-subtle)", color: "var(--text-muted)" }}>v{v.version}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.title}</div>
                          {v.changeNote && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{v.changeNote}</div>}
                          <div style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 2 }}>{new Date(v.createdAt).toLocaleString()}</div>
                        </div>
                        <button className="btn" style={{ fontSize: 11, padding: "3px 9px" }}
                          onClick={(e) => { e.stopPropagation(); restore(v.version); }}>↺</button>
                      </div>
                      {expandedVersion === v.version && (
                        <pre style={{
                          margin: 0, padding: "10px 14px", background: "var(--bg-subtle)",
                          fontSize: 11, fontFamily: "JetBrains Mono, monospace",
                          whiteSpace: "pre-wrap", color: "var(--text-muted)",
                          maxHeight: 240, overflow: "auto",
                        }}>{v.body.length > 2000 ? v.body.slice(0, 2000) + "\n…" : v.body}</pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
