"use client";
// P35 — API keys management panel for /settings.
//
// List all keys (showing only prefix + last-used time), create a new key
// (the raw secret is shown ONCE, with a clear "this is the only time you
// will see it" warning + copy button), and revoke individual keys with a
// destructive confirm.
//
// Shows the canonical webhook URL pattern below the table so users have
// the API surface in front of them while they're managing keys.

import { useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: number | null;
  createdAt: number;
}

export function ApiKeysPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [revealedKey, setRevealedKey] = useState<{ id: string; key: string; name: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/v1/keys");
      const j = await r.json();
      setKeys(j.keys || []);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function create() {
    const name = newName.trim() || "Untitled key";
    setCreating(true);
    try {
      const r = await fetch("/api/v1/keys", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        toast.error("Couldn't create key", (await r.json().catch(() => ({}))).error);
        return;
      }
      const j = await r.json();
      setRevealedKey({ id: j.id, key: j.key, name: j.name });
      setNewName("");
      await load();
    } finally { setCreating(false); }
  }

  async function revoke(k: ApiKey) {
    const ok = await confirm({
      title: `Revoke "${k.name}"?`,
      body: `Any caller using ${k.keyPrefix} will get a 401 immediately. This cannot be undone.`,
      confirmLabel: "Revoke",
      variant: "destructive",
    });
    if (!ok) return;
    const r = await fetch(`/api/v1/keys/${k.id}`, { method: "DELETE" });
    if (r.ok) {
      toast.success("Key revoked");
      await load();
    } else {
      toast.error("Revoke failed", (await r.json().catch(() => ({}))).error);
    }
  }

  function copyKey(value: string) {
    try {
      navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy failed", "Select and copy manually.");
    }
  }

  return (
    <div>
      <div style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>
        Bearer tokens for the public API. Use them with{" "}
        <code className="mono" style={{ background: "var(--bg-subtle)", padding: "1px 6px", borderRadius: 4 }}>POST /api/v1/chat</code>{" "}
        and{" "}
        <code className="mono" style={{ background: "var(--bg-subtle)", padding: "1px 6px", borderRadius: 4 }}>POST /api/v1/agents/{`{agentId}`}/invoke</code>.
        Keys are hashed at rest — the raw value is shown ONCE on creation.
      </div>

      {/* Create new */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") create(); }}
          placeholder="Key name (e.g. 'Zapier production')"
          className="input"
          style={{ flex: 1, fontSize: 13 }}
          disabled={creating}
        />
        <button className="btn btn-primary" onClick={create} disabled={creating}
          style={{ fontSize: 12, padding: "8px 16px" }}>
          {creating ? "…" : "+ New key"}
        </button>
      </div>

      {/* Reveal banner */}
      {revealedKey && (
        <div style={{
          padding: 14, marginBottom: 16, borderRadius: 8,
          background: "rgba(34,197,94,0.06)",
          border: "1px solid rgba(34,197,94,0.30)",
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5, color: "#22c55e", marginBottom: 6 }}>
            ⚠ COPY THIS NOW — IT WON'T BE SHOWN AGAIN
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
            <code className="mono">{revealedKey.name}</code>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <code className="mono" style={{
              flex: 1, padding: "8px 12px",
              background: "var(--bg)", border: "1px solid var(--border)",
              borderRadius: 6, fontSize: 12, fontFamily: "JetBrains Mono, monospace",
              overflow: "auto", whiteSpace: "nowrap",
            }}>{revealedKey.key}</code>
            <button className="btn" onClick={() => copyKey(revealedKey.key)}
              style={{ fontSize: 11, padding: "5px 12px" }}>Copy</button>
            <button className="btn" onClick={() => setRevealedKey(null)}
              style={{ fontSize: 11, padding: "5px 12px" }}>Done</button>
          </div>
        </div>
      )}

      {/* Keys list */}
      {loading ? (
        <div style={{ padding: 24, fontSize: 12, color: "var(--text-muted)" }}>Loading…</div>
      ) : keys.length === 0 ? (
        <div className="card" style={{ padding: 24, fontSize: 13, color: "var(--text-faint)", textAlign: "center" }}>
          No API keys yet. Create one to call the public endpoints.
        </div>
      ) : (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          {keys.map(k => (
            <div key={k.id} style={{
              padding: "12px 14px", borderTop: "1px solid var(--border)",
              display: "grid", gridTemplateColumns: "1fr 200px 110px 80px",
              alignItems: "center", gap: 12, fontSize: 13,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{k.name}</div>
                <code className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>{k.keyPrefix}</code>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-faint)", whiteSpace: "nowrap" }}>
                {k.lastUsedAt
                  ? `Last used ${formatRelative(Date.now() - k.lastUsedAt)} ago`
                  : <em>Never used</em>}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
                {new Date(k.createdAt).toLocaleDateString()}
              </div>
              <button className="btn" onClick={() => revoke(k)}
                style={{ fontSize: 11, padding: "4px 10px", color: "#dc2626", borderColor: "rgba(220,38,38,0.4)" }}>
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatRelative(ms: number): string {
  const sec = Math.abs(ms) / 1000;
  if (sec < 60) return `${sec.toFixed(0)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(0)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}
