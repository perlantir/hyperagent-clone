"use client";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";

export default function SettingsPage() {
  const [me, setMe] = useState<any>(null);
  const [prefs, setPrefs] = useState<any>({});
  const [models, setModels] = useState<any[]>([]);
  const [provider, setProvider] = useState("anthropic");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function reload() {
    const meR = await (await fetch("/api/auth/me")).json();
    setMe(meR.user);
    const r = await (await fetch("/api/settings")).json();
    setPrefs(r.preferences || {});
    setModels(r.models || []);
    const cur = (r.models || []).find((m: any) => m.id === r.preferences?.modelId);
    if (cur) setProvider(cur.provider);
  }
  useEffect(() => { reload(); }, []);

  async function save(patch: Record<string, any>) {
    setSaving(true); setSaved(false);
    const newPrefs = { ...prefs, ...patch };
    setPrefs(newPrefs);
    await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  const providers = [
    { id: "anthropic", label: "Anthropic", desc: "Claude — best for reasoning + tool use" },
    { id: "openai",    label: "OpenAI",    desc: "GPT-4o, o1 — broad ecosystem" },
    { id: "google",    label: "Google",    desc: "Gemini 2.5 — long context + multimodal" },
  ];
  const providerModels = models.filter(m => m.provider === provider);

  return (
    <AppShell>
      <Topbar title="Settings" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <h1 className="h-display" style={{ fontSize: 44, marginBottom: 8 }}>Settings</h1>
          <div style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 32 }}>Account, theme, and the AI model that powers your agents.</div>

          {/* Account */}
          <div style={{ marginBottom: 40 }}>
            <div className="h-section" style={{ marginBottom: 12 }}>Account</div>
            <div className="card" style={{ padding: 20 }}>
              <div style={{ fontSize: 14 }}><strong>{me?.name}</strong></div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>{me?.email}</div>
            </div>
          </div>

          {/* Model selector */}
          <div style={{ marginBottom: 40 }}>
            <div className="h-section" style={{ marginBottom: 12 }}>AI Model</div>
            <div style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>Pick the provider, then a specific model. Each agent uses this unless overridden.</div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 16 }}>
              {providers.map(p => (
                <button key={p.id} onClick={() => setProvider(p.id)}
                  className="card"
                  style={{ padding: 14, textAlign: "left", cursor: "pointer", borderColor: provider === p.id ? "var(--accent)" : "var(--border)", borderWidth: 2 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{p.label}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{p.desc}</div>
                </button>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6 }}>
              {providerModels.map(m => (
                <button key={m.id} onClick={() => save({ modelId: m.id })}
                  className="card"
                  style={{ padding: 14, textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, borderColor: prefs.modelId === m.id ? "var(--accent)" : "var(--border)", borderWidth: 2 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{m.label}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                      {m.contextWindow.toLocaleString()} ctx · ${m.inputPer1k}/1k in · ${m.outputPer1k}/1k out
                    </div>
                  </div>
                  {prefs.modelId === m.id && <span className="badge badge-accent">Active</span>}
                </button>
              ))}
            </div>
            {saving && <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)" }}>Saving…</div>}
            {saved && <div style={{ marginTop: 8, fontSize: 12, color: "var(--green)" }}>✓ Saved</div>}
          </div>

          {/* Theme */}
          <div style={{ marginBottom: 40 }}>
            <div className="h-section" style={{ marginBottom: 12 }}>Theme</div>
            <div style={{ display: "flex", gap: 8 }}>
              {["light","dark"].map(t => (
                <button key={t}
                  onClick={() => { document.documentElement.setAttribute("data-theme", t); try { localStorage.setItem("hyperagent-theme", t); } catch {} save({ theme: t }); }}
                  className={`chip ${prefs.theme === t ? "active" : ""}`}>{t}</button>
              ))}
            </div>
          </div>

          {/* API key */}
          <div style={{ marginBottom: 40 }}>
            <div className="h-section" style={{ marginBottom: 12 }}>API access (coming soon)</div>
            <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Public API + bearer tokens for programmatic access. Phase 17.</div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
