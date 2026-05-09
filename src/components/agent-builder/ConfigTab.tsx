"use client";
// P36 — Config tab. Name, description, prompt, color, model picker,
// extended-thinking toggle, budget cap, subagent model. All persist
// through the existing PATCH /api/agents/[id] endpoint, which already
// snapshots the prior version (P28b agent versioning).

import { useState, useEffect } from "react";
import { useToast } from "@/components/Toast";
import type { AgentLike } from "./types";
import { CLAUDE_MODEL_VARIANTS } from "./types";

const COLORS: Array<{ id: "orange" | "blue" | "green" | "purple"; gradient: string }> = [
  { id: "orange", gradient: "linear-gradient(135deg,#c2410c,#f97316)" },
  { id: "blue",   gradient: "linear-gradient(135deg,#1d4ed8,#3b82f6)" },
  { id: "green",  gradient: "linear-gradient(135deg,#15803d,#22c55e)" },
  { id: "purple", gradient: "linear-gradient(135deg,#6d28d9,#a78bfa)" },
];

export function ConfigTab({ agent, onSave }: {
  agent: AgentLike;
  onSave: (patch: Partial<AgentLike>) => Promise<void>;
}) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt);
  const [routerHint, setRouterHint] = useState(agent.routerHint || "");
  const [color, setColor] = useState(agent.color);
  const [icon, setIcon] = useState(agent.icon);
  const [modelId, setModelId] = useState(agent.modelId || "");
  const [subagentModelId, setSubagentModelId] = useState(agent.subagentModelId || "");
  const [extendedThinking, setExtendedThinking] = useState(!!agent.extendedThinking);
  const [budget, setBudget] = useState(agent.maxRunBudgetCredits ?? "");
  const [saving, setSaving] = useState(false);

  const isDirty =
    name !== agent.name ||
    description !== agent.description ||
    systemPrompt !== agent.systemPrompt ||
    routerHint !== (agent.routerHint || "") ||
    color !== agent.color ||
    icon !== agent.icon ||
    modelId !== (agent.modelId || "") ||
    subagentModelId !== (agent.subagentModelId || "") ||
    extendedThinking !== !!agent.extendedThinking ||
    budget !== (agent.maxRunBudgetCredits ?? "");

  async function commit() {
    setSaving(true);
    await onSave({
      name: name.trim(),
      description: description.trim(),
      systemPrompt,
      routerHint,
      color,
      icon: icon.trim().slice(0, 2) || agent.icon,
      modelId: modelId || null,
      subagentModelId: subagentModelId || null,
      extendedThinking,
      maxRunBudgetCredits: budget === "" ? null : Number(budget),
    });
    setSaving(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28, maxWidth: 720 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Agent details</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Customize the name, description, and settings of the agent.</div>
      </div>

      <Field label="Name" required>
        <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Agent name" />
      </Field>

      <Field label="Description">
        <textarea
          className="input" rows={3}
          value={description} onChange={e => setDescription(e.target.value)}
          placeholder="What does this agent do?"
          style={{ resize: "vertical", lineHeight: 1.5 }}
        />
      </Field>

      <Field label="Prompt" required>
        <textarea
          className="input mono" rows={6}
          value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)}
          placeholder="Add a system prompt…"
          style={{ resize: "vertical", fontSize: 13, lineHeight: 1.6, fontFamily: "JetBrains Mono, monospace" }}
        />
      </Field>

      <Field label="Router hint">
        <textarea
          className="input" rows={2}
          value={routerHint} onChange={e => setRouterHint(e.target.value)}
          placeholder="When should the smart router pick this agent?"
          style={{ resize: "vertical" }}
        />
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 14, alignItems: "start" }}>
        <Field label="Icon">
          <input
            className="input"
            value={icon} onChange={e => setIcon(e.target.value.slice(0, 2))}
            maxLength={2}
            style={{ textAlign: "center", fontSize: 16, fontWeight: 700 }} />
        </Field>
        <Field label="Color">
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            {COLORS.map(c => (
              <button key={c.id} type="button" onClick={() => setColor(c.id)}
                style={{
                  width: 40, height: 40, borderRadius: 10,
                  border: color === c.id ? "2px solid var(--text)" : "2px solid transparent",
                  background: c.gradient, padding: 0, cursor: "pointer",
                  boxShadow: color === c.id ? "0 0 0 2px var(--bg-elev) inset" : "none",
                }} />
            ))}
          </div>
        </Field>
      </div>

      {/* Model & Limits */}
      <div>
        <h3 className="h-section" style={{ marginBottom: 12 }}>Model &amp; limits</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Model picker */}
          <div className="card" style={{ padding: 14 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <span style={{ width: 14, height: 14, borderRadius: 3, background: "var(--accent)", marginTop: 4 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2 }}>Model</div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                  Override the account-default model for this agent.
                </div>
                <select
                  value={modelId} onChange={e => setModelId(e.target.value)}
                  style={{
                    marginTop: 10, width: "100%", padding: "8px 10px",
                    border: "1px solid var(--border)", borderRadius: 7,
                    background: "var(--bg)", color: "var(--text)", fontSize: 13,
                  }}>
                  <option value="">Account default (settings)</option>
                  {CLAUDE_MODEL_VARIANTS.map(m => (
                    <option key={m.id} value={m.id}>{m.label} — {m.sub}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Extended thinking toggle */}
          <ToggleRow
            label="Extended thinking"
            sub="Adaptive reasoning that auto-adjusts depth. Effort controls quality vs speed."
            on={extendedThinking}
            onChange={setExtendedThinking}
          />

          {/* Budget cap */}
          <div className="card" style={{ padding: 14 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <ToggleSwitch
                on={budget !== ""}
                onChange={v => setBudget(v ? 5000 : "")}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Budget limit per query</div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>Cap the maximum spend per agent query.</div>
                {budget !== "" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                    <input type="number" min={100} max={50000} step={100}
                      value={budget} onChange={e => setBudget(parseInt(e.target.value, 10) || 0)}
                      style={{
                        width: 120, padding: "6px 10px",
                        border: "1px solid var(--border)", borderRadius: 6,
                        background: "var(--bg)", color: "var(--text)", fontSize: 13,
                      }} />
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>credits per run · ${(Number(budget) * 0.001).toFixed(2)}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Subagent model */}
          <div className="card" style={{ padding: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Subagent model</div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                  Model used for dispatched subagents. Default is Sonnet.
                </div>
              </div>
              <select
                value={subagentModelId} onChange={e => setSubagentModelId(e.target.value)}
                style={{
                  padding: "7px 10px", borderRadius: 6,
                  border: "1px solid var(--border)", background: "var(--bg)",
                  color: "var(--text)", fontSize: 12.5, minWidth: 160,
                }}>
                <option value="">Default (Sonnet)</option>
                {CLAUDE_MODEL_VARIANTS.map(m => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {isDirty && (
        <div style={{
          position: "sticky", bottom: 0, padding: "12px 0",
          background: "var(--bg)", borderTop: "1px solid var(--border)",
          display: "flex", justifyContent: "flex-end", gap: 8,
          marginTop: 16,
        }}>
          <button className="btn btn-primary" onClick={commit} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 12.5, fontWeight: 500, marginBottom: 6 }}>
        {label}{required && <span style={{ color: "var(--accent)", marginLeft: 4 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

function ToggleRow({ label, sub, on, onChange }: {
  label: string; sub: string; on: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <ToggleSwitch on={on} onChange={onChange} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</div>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>
        </div>
      </div>
    </div>
  );
}

function ToggleSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-pressed={on}
      style={{
        position: "relative",
        width: 36, height: 22, borderRadius: 99,
        background: on ? "var(--text)" : "var(--bg-subtle)",
        border: `1px solid ${on ? "var(--text)" : "var(--border)"}`,
        cursor: "pointer", flexShrink: 0,
        transition: "background 0.15s",
      }}
    >
      <span style={{
        position: "absolute", top: 2, left: on ? 16 : 2,
        width: 16, height: 16, borderRadius: 99,
        background: on ? "var(--bg)" : "var(--text)",
        transition: "left 0.15s",
      }} />
    </button>
  );
}
