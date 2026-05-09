"use client";
// P34 — Sandbox policy editor for /settings.
//
// Three controls:
//   - Domain allowlist: textarea, one host per line. "Reset to defaults"
//     restores DEFAULT_DOMAIN_ALLOWLIST.
//   - Concurrency cap: how many sandboxes can run simultaneously.
//   - Per-minute cap: rate limit on new sandbox starts.
//
// Below the editor: the last 25 sandbox executions for this user, with
// their detected hosts and outcome. Helpful when calibrating the
// allowlist — you can see "I tried X, it was blocked because of host Y".

import { useEffect, useState } from "react";
import { useToast } from "@/components/Toast";

interface Policy {
  domainAllowlist: string[];
  concurrencyCap: number;
  perMinuteCap: number;
  failOpen: boolean;
}
interface SandboxRun {
  id: string;
  kind: string;
  codePreview: string | null;
  detectedHosts: string[];
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  exitCode: number | null;
  blocked: boolean;
  blockReason: string | null;
}

export function SandboxPolicyPanel() {
  const toast = useToast();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [defaults, setDefaults] = useState<Policy | null>(null);
  const [allowlistText, setAllowlistText] = useState<string>("");
  const [recentRuns, setRecentRuns] = useState<SandboxRun[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  async function load() {
    const r = await fetch("/api/sandbox/policy");
    if (!r.ok) return;
    const j = await r.json();
    setPolicy(j.policy);
    setDefaults(j.defaults);
    setAllowlistText((j.policy.domainAllowlist || []).join("\n"));
    setRecentRuns(j.recentRuns || []);
    setDirty(false);
  }
  useEffect(() => { load(); }, []);

  async function save(patch: Partial<Policy>) {
    setSaving(true);
    const r = await fetch("/api/sandbox/policy", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setSaving(false);
    if (r.ok) {
      toast.success("Sandbox policy saved");
      load();
    } else {
      toast.error("Save failed", (await r.json().catch(() => ({}))).error);
    }
  }

  async function saveAllowlist() {
    const list = allowlistText.split("\n").map(s => s.trim()).filter(Boolean);
    await save({ domainAllowlist: list });
  }

  function resetAllowlist() {
    if (!defaults) return;
    setAllowlistText(defaults.domainAllowlist.join("\n"));
    setDirty(true);
  }

  if (!policy || !defaults) {
    return <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading sandbox policy…</div>;
  }

  const recentBlocked = recentRuns.filter(r => r.blocked).length;

  return (
    <div>
      <div style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>
        Static guardrails on sandboxed code execution (<code className="mono">code_interpreter</code>, <code className="mono">run_shell</code>).
        URLs in the code are extracted before execution and rejected if their host isn't allowlisted.
        Concurrency and rate caps protect your e2b quota from runaway agents.
      </div>

      {/* Domain allowlist */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Domain allowlist</div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
              One host per line. Subdomains are matched automatically (<code className="mono">api.openai.com</code> covers <code className="mono">metrics.api.openai.com</code>).
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn" onClick={resetAllowlist} style={{ fontSize: 11, padding: "4px 10px" }}>
              Reset to defaults ({defaults.domainAllowlist.length})
            </button>
          </div>
        </div>
        <textarea
          value={allowlistText}
          onChange={e => { setAllowlistText(e.target.value); setDirty(true); }}
          rows={8}
          className="mono"
          style={{
            width: "100%", padding: "10px 12px",
            border: "1px solid var(--border)", borderRadius: 7,
            background: "var(--bg)", color: "var(--text)",
            fontSize: 12.5, lineHeight: 1.5, resize: "vertical",
            outline: "none", fontFamily: "JetBrains Mono, monospace",
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
            {allowlistText.split("\n").filter(s => s.trim()).length} hosts
          </span>
          {dirty && (
            <button className="btn btn-primary" onClick={saveAllowlist} disabled={saving}
              style={{ fontSize: 12, padding: "5px 14px" }}>
              {saving ? "Saving…" : "Save allowlist"}
            </button>
          )}
        </div>
      </div>

      {/* Caps */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 12 }}>Resource caps</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <NumberControl
            label="Concurrent sandboxes"
            sub={`Max in-flight at once. Default ${defaults.concurrencyCap}.`}
            value={policy.concurrencyCap}
            min={1} max={50}
            onCommit={v => save({ concurrencyCap: v })} />
          <NumberControl
            label="Per-minute starts"
            sub={`Hard rate limit. Default ${defaults.perMinuteCap}.`}
            value={policy.perMinuteCap}
            min={1} max={1000}
            onCommit={v => save({ perMinuteCap: v })} />
        </div>
      </div>

      {/* Recent runs */}
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Recent sandbox executions</div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
              Last 25. {recentBlocked > 0 && <span style={{ color: "#dc2626" }}>{recentBlocked} blocked.</span>}
            </div>
          </div>
        </div>
        {recentRuns.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--text-faint)", textAlign: "center" }}>
            No sandbox executions yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {recentRuns.map(r => <SandboxRunRow key={r.id} run={r} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function NumberControl({ label, sub, value, min, max, onCommit }: {
  label: string; sub: string; value: number; min: number; max: number;
  onCommit: (v: number) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  const dirty = v !== value;
  return (
    <div>
      <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>{sub}</div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="number" value={v}
          min={min} max={max}
          onChange={e => setV(Math.max(min, Math.min(max, parseInt(e.target.value, 10) || min)))}
          style={{
            flex: 1, padding: "6px 10px", border: "1px solid var(--border)",
            borderRadius: 6, background: "var(--bg)", color: "var(--text)",
            fontSize: 13, outline: "none",
          }} />
        {dirty && (
          <button className="btn btn-primary" onClick={() => onCommit(v)}
            style={{ fontSize: 11, padding: "4px 10px" }}>Save</button>
        )}
      </div>
    </div>
  );
}

function SandboxRunRow({ run }: { run: SandboxRun }) {
  const [expanded, setExpanded] = useState(false);
  const status = run.blocked ? "BLOCKED" :
    run.endedAt === null ? "RUNNING" :
    run.exitCode === 0 ? "OK" : "ERROR";
  const statusColor = run.blocked ? "#d97706" :
    run.endedAt === null ? "#3b82f6" :
    run.exitCode === 0 ? "#22c55e" : "#dc2626";
  const dur = run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` :
    run.endedAt ? "—" : "in flight";
  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      <div onClick={() => setExpanded(!expanded)} style={{
        padding: "8px 4px", cursor: "pointer", display: "flex",
        alignItems: "center", gap: 10, fontSize: 12,
      }}>
        <span style={{
          width: 60, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
          background: `${statusColor}22`, color: statusColor, textAlign: "center",
        }}>{status}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)", width: 110 }}>
          {run.kind}
        </span>
        <span style={{ flex: 1, minWidth: 0, color: "var(--text-muted)", fontSize: 11.5,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} className="mono">
          {(run.codePreview || "").split("\n")[0].slice(0, 80) || <em style={{ color: "var(--text-faint)" }}>(empty)</em>}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-faint)", width: 70, textAlign: "right" }}>{dur}</span>
        <span style={{ fontSize: 11, color: "var(--text-faint)", width: 110, textAlign: "right" }}>
          {new Date(run.startedAt).toLocaleTimeString()}
        </span>
        <span style={{ fontSize: 10, opacity: 0.5, transform: expanded ? "none" : "rotate(-90deg)" }}>▾</span>
      </div>
      {expanded && (
        <div style={{ padding: "8px 14px", background: "var(--bg-subtle)", fontSize: 11.5 }}>
          {run.blockReason && (
            <div style={{ color: "#dc2626", marginBottom: 6 }}>
              <strong>Block reason:</strong> {run.blockReason}
            </div>
          )}
          {run.detectedHosts.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <strong>Detected hosts:</strong>{" "}
              {run.detectedHosts.map(h => <code key={h} className="mono" style={{ marginRight: 6 }}>{h}</code>)}
            </div>
          )}
          {run.codePreview && (
            <pre className="mono" style={{
              margin: 0, padding: "8px 10px", background: "var(--bg)",
              border: "1px solid var(--border)", borderRadius: 6,
              fontSize: 11, color: "var(--text-muted)",
              whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 240,
            }}>{run.codePreview}</pre>
          )}
        </div>
      )}
    </div>
  );
}
