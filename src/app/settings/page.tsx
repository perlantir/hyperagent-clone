"use client";
// P42 — Restructured Settings page with left-nav.
//
// Mirrors Hyperagent's settings layout:
//   left nav (12 sections) | right pane (active section content)
//
// Sections are deep-linkable via URL hash (#profile / #api-keys / etc).
// Existing legacy panels (API Keys, Sandbox Policy) are mounted as-is;
// new sections (Profile, Personalization, Notifications, Security,
// Referrals) come from src/components/settings/NewSections.tsx.

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { SandboxPolicyPanel } from "@/components/SandboxPolicyPanel";
import { ApiKeysPanel } from "@/components/ApiKeysPanel";
import { SettingsNav, SETTINGS_SECTIONS } from "@/components/settings/SettingsNav";
import { CodexSection } from "@/components/settings/CodexSection";
import {
  ProfileSection, PersonalizationSection, NotificationsSection,
  SecuritySection, ReferralsSection,
  IntegrationsLinkSection, BillingLinkSection,
} from "@/components/settings/NewSections";

const SECTION_HEADER: React.CSSProperties = {
  fontFamily: "Instrument Serif, serif",
  fontSize: 32, fontWeight: 400, lineHeight: 1.1,
  marginBottom: 6,
};
const SECTION_LEAD: React.CSSProperties = {
  fontSize: 14, color: "var(--text-muted)",
  marginBottom: 28, maxWidth: 600, lineHeight: 1.5,
};

export default function SettingsPage() {
  const toast = useToast();
  const confirm = useConfirm();

  const [active, setActive] = useState<string>("profile");
  const [me, setMe] = useState<any>(null);
  const [prefs, setPrefs] = useState<any>({});
  const [models, setModels] = useState<any[]>([]);
  const [provider, setProvider] = useState("anthropic");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [secretProviders, setSecretProviders] = useState<any[]>([]);
  const [secretStatus, setSecretStatus] = useState<Record<string, "user" | "platform" | "missing">>({});
  const [slackWorkspaces, setSlackWorkspaces] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [connectorCount, setConnectorCount] = useState(0);
  const [balance, setBalance] = useState(0);
  const [slackForm, setSlackForm] = useState({ teamId: "", botToken: "", agentId: "" });
  const [slackSaving, setSlackSaving] = useState(false);
  const [slackError, setSlackError] = useState("");

  // Hydrate active section from URL hash.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const fromHash = window.location.hash.replace("#", "");
    if (fromHash && SETTINGS_SECTIONS.some(s => s.id === fromHash)) setActive(fromHash);
    function onHashChange() {
      const h = window.location.hash.replace("#", "");
      if (h && SETTINGS_SECTIONS.some(s => s.id === h)) setActive(h);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function selectSection(id: string) {
    setActive(id);
    if (typeof window !== "undefined") history.replaceState(null, "", `#${id}`);
  }

  const reload = useCallback(async () => {
    const meR = await (await fetch("/api/auth/me")).json();
    setMe(meR.user);
    const r = await (await fetch("/api/settings")).json();
    setPrefs(r.preferences || {});
    setModels(r.models || []);
    const cur = (r.models || []).find((m: any) => m.id === r.preferences?.modelId);
    if (cur) setProvider(cur.provider);
    const s = await (await fetch("/api/settings/secrets")).json();
    setSecretProviders(s.providers || []);
    setSecretStatus(s.secrets || {});
    const sw = await (await fetch("/api/settings/slack-workspaces")).json();
    setSlackWorkspaces(sw.workspaces || []);
    const ag = await (await fetch("/api/agents")).json();
    setAgents(ag.agents || []);
    fetch("/api/connectors").then(r => r.json()).then(j =>
      setConnectorCount((j.connectors || []).filter((c: any) => c.connected).length));
    fetch("/api/credits").then(r => r.json()).then(j => setBalance(j.balance || 0));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  async function saveSlackWorkspace() {
    setSlackSaving(true); setSlackError("");
    const r = await fetch("/api/settings/slack-workspaces", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slackForm),
    });
    setSlackSaving(false);
    if (r.ok) { setSlackForm({ teamId: "", botToken: "", agentId: "" }); reload(); }
    else setSlackError((await r.json()).error || "Failed");
  }
  async function deleteSlackWorkspace(teamId: string) {
    const ok = await confirm({
      title: "Disconnect Slack workspace?",
      body: `Workspace ${teamId} will no longer route messages to your agents.`,
      confirmLabel: "Disconnect",
      variant: "destructive",
    });
    if (!ok) return;
    await fetch("/api/settings/slack-workspaces/" + teamId, { method: "DELETE" });
    reload();
    toast.success("Slack workspace disconnected");
  }

  async function saveSecret(providerId: string, value: string) {
    const r = await fetch("/api/settings/secrets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: providerId, value }),
    });
    if (r.ok) { reload(); toast.success(`${providerId} key saved`); }
    else toast.error("Failed to save key", (await r.json().catch(() => ({}))).error);
  }
  async function deleteSecret(providerId: string) {
    const ok = await confirm({
      title: `Remove your ${providerId} key?`,
      body: "Calls will fall back to the platform default.",
      confirmLabel: "Remove key", variant: "destructive",
    });
    if (!ok) return;
    const r = await fetch("/api/settings/secrets/" + providerId, { method: "DELETE" });
    if (r.ok) { reload(); toast.success("Key removed"); }
  }

  async function save(patch: Record<string, any>) {
    setSaving(true); setSaved(false);
    setPrefs({ ...prefs, ...patch });
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

  const imageProviders = [
    { id: "gemini", label: "Gemini Nano Banana", desc: "Fast, cheap, photorealistic" },
    { id: "openai", label: "OpenAI gpt-image-1", desc: "Sharp text + composition" },
    { id: "grok",   label: "Grok 2 Image",        desc: "xAI's Aurora model" },
  ];
  const speechProviders = [
    { id: "gemini", label: "Gemini TTS",  desc: "30+ voices, natural prosody" },
    { id: "openai", label: "OpenAI TTS",  desc: "tts-1 / tts-1-hd, 6 voices" },
  ];
  const videoProviders = [
    { id: "gemini", label: "Gemini Veo",  desc: "6s clips, native audio" },
    { id: "openai", label: "OpenAI Sora", desc: "Higher fidelity, slower" },
  ];

  return (
    <AppShell>
      <Topbar title="Settings" />
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <SettingsNav active={active} onSelect={selectSection} />
        <div style={{ flex: 1, overflowY: "auto", padding: "32px 48px 64px" }}>
          <div style={{ maxWidth: 800, margin: "0 auto" }}>

            {active === "profile" && me && (
              <ProfileSection user={me} onUpdate={reload} />
            )}

            {active === "personalization" && (
              <PersonalizationSection prefs={prefs} onSave={save} />
            )}

            {active === "integrations" && (
              <IntegrationsLinkSection count={connectorCount} />
            )}

            {active === "models" && (
              <div>
                <h2 style={SECTION_HEADER}>Models</h2>
                <p style={SECTION_LEAD}>Default LLM and media providers used by your agents and tools when an agent doesn't override.</p>

                <h3 className="h-section" style={{ marginBottom: 12 }}>Chat model</h3>
                <div style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 14 }}>The LLM that powers chat conversations and tool routing.</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 16 }}>
                  {providers.map(p => (
                    <button key={p.id} onClick={() => setProvider(p.id)} className="card"
                      style={{ padding: 14, textAlign: "left", cursor: "pointer", borderColor: provider === p.id ? "var(--accent)" : "var(--border)", borderWidth: 2 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{p.label}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{p.desc}</div>
                    </button>
                  ))}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6, marginBottom: 32 }}>
                  {providerModels.map(m => (
                    <button key={m.id} onClick={() => save({ modelId: m.id })} className="card"
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

                <h3 className="h-section" style={{ marginBottom: 12 }}>Media generation</h3>
                <Picker title="Image"  subtitle="Used by generate_image"  options={imageProviders}  prefKey="imageProvider"  prefs={prefs} save={save} />
                <Picker title="Speech" subtitle="Used by generate_speech" options={speechProviders} prefKey="speechProvider" prefs={prefs} save={save} />
                <Picker title="Video"  subtitle="Used by generate_video"  options={videoProviders}  prefKey="videoProvider"  prefs={prefs} save={save} />
                {saving && <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)" }}>Saving…</div>}
                {saved && <div style={{ marginTop: 8, fontSize: 12, color: "var(--green)" }}>✓ Saved</div>}
              </div>
            )}

            {active === "api-keys" && (
              <div>
                <h2 style={SECTION_HEADER}>API Keys</h2>
                <p style={SECTION_LEAD}>Public <code className="mono">hak_</code> tokens for the API + bring-your-own-key for LLM and media providers.</p>

                <h3 className="h-section" style={{ marginBottom: 12, marginTop: 24 }}>Public API keys</h3>
                <ApiKeysPanel />

                <h3 className="h-section" style={{ marginTop: 32, marginBottom: 12 }}>Provider keys (BYOK)</h3>
                <div style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>
                  Bring your own keys for any provider. Stored encrypted (AES-256-GCM). Each provider falls back to the platform default if you don't set one.
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  {secretProviders.map((p: any) => (
                    <KeyRow key={p.id} provider={p}
                      status={secretStatus[p.id] || "missing"}
                      onSave={v => saveSecret(p.id, v)}
                      onDelete={() => deleteSecret(p.id)} />
                  ))}
                </div>
              </div>
            )}

            {/* P57 — Codex / OpenAI provider mode + ChatGPT Sign-In experimental flow. */}
            {active === "codex" && <CodexSection />}

            {active === "sandbox" && (
              <div>
                <h2 style={SECTION_HEADER}>Sandbox</h2>
                <p style={SECTION_LEAD}>Static guardrails on sandboxed code execution. Domain allowlist + concurrency cap.</p>
                <SandboxPolicyPanel />
              </div>
            )}

            {active === "slack" && (
              <div>
                <h2 style={SECTION_HEADER}>Slack workspaces</h2>
                <p style={SECTION_LEAD}>Connect a Slack workspace so an agent can reply to messages and mentions in real time.</p>

                <div style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16, lineHeight: 1.55 }}>
                  Set up a Slack app at <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>api.slack.com/apps</a>,
                  configure the Events URL to <code>{typeof window !== "undefined" ? window.location.origin : ""}/api/slack/events</code>,
                  and paste the bot token (xoxb-…) here.
                </div>
                {slackWorkspaces.length > 0 && (
                  <div style={{ marginBottom: 16, display: "grid", gap: 6 }}>
                    {slackWorkspaces.map((w: any) => (
                      <div key={w.teamId} className="card" style={{ padding: 12, display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{w.teamId}</div>
                          <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                            Token {w.botTokenRedacted} · {w.agentId
                              ? <>responds as <strong>{agents.find((a:any) => a.id === w.agentId)?.name || w.agentId}</strong></>
                              : <em>no agent bound — won't respond yet</em>}
                          </div>
                        </div>
                        <button className="btn" onClick={() => deleteSlackWorkspace(w.teamId)}
                          style={{ fontSize: 12, padding: "6px 12px" }}>Disconnect</button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="card" style={{ padding: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Connect a workspace</div>
                  <div style={{ display: "grid", gap: 8 }}>
                    <input placeholder="Team ID (T01ABCXYZ)"
                      value={slackForm.teamId}
                      onChange={e => setSlackForm({ ...slackForm, teamId: e.target.value.trim() })}
                      style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 13, fontFamily: "monospace" }} />
                    <input type="password" placeholder="Bot token (xoxb-…)"
                      value={slackForm.botToken}
                      onChange={e => setSlackForm({ ...slackForm, botToken: e.target.value.trim() })}
                      style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 13, fontFamily: "monospace" }} />
                    <select value={slackForm.agentId} onChange={e => setSlackForm({ ...slackForm, agentId: e.target.value })}
                      style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 13 }}>
                      <option value="">— Pick an agent to respond as —</option>
                      {agents.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                    {slackError && <div style={{ fontSize: 12, color: "#dc2626" }}>{slackError}</div>}
                    <button className="btn btn-primary" onClick={saveSlackWorkspace}
                      disabled={!slackForm.teamId || !slackForm.botToken || slackSaving}
                      style={{ fontSize: 12, padding: "8px 14px", justifyContent: "center" }}>
                      {slackSaving ? "Verifying token…" : "Connect workspace"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {active === "notifications" && <NotificationsSection />}
            {active === "security" && <SecuritySection />}
            {active === "billing" && <BillingLinkSection balance={balance} />}
            {active === "referrals" && <ReferralsSection />}

            {active === "theme" && (
              <div>
                <h2 style={SECTION_HEADER}>Theme</h2>
                <p style={SECTION_LEAD}>Choose your interface mode.</p>
                <div className="card" style={{ padding: 16, maxWidth: 400 }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    {["light","dark"].map(t => (
                      <button key={t}
                        onClick={() => { document.documentElement.setAttribute("data-theme", t); try { localStorage.setItem("hyperagent-theme", t); } catch {} save({ theme: t }); }}
                        className={`chip ${prefs.theme === t ? "active" : ""}`}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </AppShell>
  );
}

function Picker({ title, subtitle, options, prefKey, prefs, save }: {
  title: string; subtitle: string; options: any[]; prefKey: string;
  prefs: any; save: (patch: Record<string, any>) => void;
}) {
  const current = prefs[prefKey] || options[0]?.id;
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 8 }}>{subtitle}</div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${options.length}, 1fr)`, gap: 8 }}>
        {options.map((o: any) => (
          <button key={o.id} onClick={() => save({ [prefKey]: o.id })} className="card"
            style={{ padding: 12, textAlign: "left", cursor: "pointer", borderColor: current === o.id ? "var(--accent)" : "var(--border)", borderWidth: 2 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{o.label}</div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 4 }}>{o.desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function KeyRow({ provider, status, onSave, onDelete }: {
  provider: { id: string; label: string; description: string; placeholder: string; helpUrl: string };
  status: "user" | "platform" | "missing";
  onSave: (v: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const badge = status === "user"
    ? { text: "Your key", color: "var(--green)", bg: "rgba(34,197,94,0.1)" }
    : status === "platform"
      ? { text: "Platform default", color: "var(--text-muted)", bg: "var(--bg-elevated)" }
      : { text: "Not configured", color: "#dc2626", bg: "rgba(220,38,38,0.08)" };
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{provider.label}</div>
            <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 8px", borderRadius: 99, color: badge.color, background: badge.bg }}>
              {badge.text}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>{provider.description}</div>
          <a href={provider.helpUrl} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 11, color: "var(--accent)", marginTop: 4, display: "inline-block" }}>
            Get a key →
          </a>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {!editing ? (
            <button className="btn" onClick={() => setEditing(true)} style={{ fontSize: 12, padding: "5px 10px" }}>
              {status === "user" ? "Replace" : "Add"}
            </button>
          ) : (
            <>
              <input type="password" autoFocus value={value} onChange={e => setValue(e.target.value)}
                placeholder={provider.placeholder}
                style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "monospace", minWidth: 240 }} />
              <button className="btn btn-primary" onClick={() => { onSave(value); setEditing(false); setValue(""); }} disabled={!value} style={{ fontSize: 12, padding: "5px 10px" }}>Save</button>
              <button className="btn" onClick={() => { setEditing(false); setValue(""); }} style={{ fontSize: 12, padding: "5px 10px" }}>Cancel</button>
            </>
          )}
          {status === "user" && !editing && (
            <button className="btn" onClick={onDelete} style={{ fontSize: 12, padding: "5px 10px", color: "#dc2626" }}>Remove</button>
          )}
        </div>
      </div>
    </div>
  );
}
