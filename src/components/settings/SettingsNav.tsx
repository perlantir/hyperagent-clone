"use client";
// P42 — Settings left-nav.
//
// Mirrors Hyperagent's settings left-nav: section list with the active
// item highlighted. Sections are routed via URL hash (#profile, etc.)
// so deep-linking + browser back/forward work.

interface SectionDef {
  id: string;
  label: string;
  description: string;
  icon: string;
}

export const SETTINGS_SECTIONS: SectionDef[] = [
  { id: "profile",         label: "Profile",         description: "Display name and how you appear.",                icon: "👤" },
  { id: "personalization", label: "Personalization", description: "Company, role, and preferences.",                 icon: "⚙" },
  { id: "integrations",    label: "Integrations",    description: "OAuth to 250+ third-party services.",            icon: "⊟" },
  { id: "manus-import",    label: "Manus Import",    description: "Bring your Manus conversations into Hyperagent.", icon: "↥" },
  { id: "models",          label: "Models",          description: "Default chat / image / video / TTS providers.",   icon: "✶" },
  { id: "api-keys",        label: "API Keys",        description: "Public hak_ keys + bring-your-own provider keys.", icon: "🔑" },
  { id: "codex",           label: "Codex / OpenAI",  description: "Provider mode + ChatGPT Sign-In (experimental).",  icon: "◈" },
  { id: "sandbox",         label: "Sandbox",         description: "Domain allowlist + concurrency caps.",            icon: "▢" },
  { id: "slack",           label: "Slack",           description: "Inbound Slack workspaces.",                       icon: "#" },
  { id: "notifications",   label: "Notifications",   description: "Browser push for background activity.",           icon: "◔" },
  { id: "security",        label: "Security",        description: "Password, sessions, audit access.",               icon: "◐" },
  { id: "billing",         label: "Billing",         description: "Subscription, credits, invoices.",                icon: "$" },
  { id: "referrals",       label: "Referrals",       description: "Earn credits for each new user.",                 icon: "★" },
  { id: "theme",           label: "Theme",           description: "Light / dark.",                                   icon: "◑" },
];

export function SettingsNav({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  return (
    <nav style={{
      flexShrink: 0, width: 240,
      borderRight: "1px solid var(--border)",
      padding: "20px 12px",
      overflowY: "auto",
    }}>
      <div style={{ padding: "0 8px 12px", fontSize: 11, fontWeight: 700, color: "var(--text-faint)", letterSpacing: 0.5, textTransform: "uppercase" }}>
        Settings
      </div>
      {SETTINGS_SECTIONS.map(s => (
        <button key={s.id} onClick={() => onSelect(s.id)}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            width: "100%", padding: "8px 10px", marginBottom: 1,
            border: "none", borderRadius: 6,
            background: active === s.id ? "var(--bg-subtle)" : "transparent",
            color: active === s.id ? "var(--text)" : "var(--text-muted)",
            fontSize: 13, fontWeight: active === s.id ? 500 : 400,
            cursor: "pointer", textAlign: "left",
          }}>
          <span style={{ width: 16, fontSize: 11, opacity: 0.7 }}>{s.icon}</span>
          {s.label}
        </button>
      ))}
    </nav>
  );
}
