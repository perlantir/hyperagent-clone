"use client";
// P42 — New settings sections: Profile, Personalization, Notifications,
// Security, Referrals, plus links to Integrations / Billing.
//
// Each section is self-contained — fetches its own data, has its own save
// flow, surfaces its own toasts. The page composes them based on the
// active hash.

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

const SECTION_HEADER: React.CSSProperties = {
  fontFamily: "Instrument Serif, serif",
  fontSize: 32, fontWeight: 400, lineHeight: 1.1,
  marginBottom: 6,
};
const SECTION_LEAD: React.CSSProperties = {
  fontSize: 14, color: "var(--text-muted)",
  marginBottom: 28, maxWidth: 600, lineHeight: 1.5,
};
const FIELD_LABEL: React.CSSProperties = {
  display: "block", fontSize: 12.5, fontWeight: 500, marginBottom: 6,
};
const HELP_TEXT: React.CSSProperties = {
  fontSize: 11.5, color: "var(--text-faint)", marginTop: 4,
};

// ============ Profile ============

export function ProfileSection({ user, onUpdate }: { user: any; onUpdate: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(user?.name || "");
  const [avatar, setAvatar] = useState<string>(user?.avatar || "");
  const [saving, setSaving] = useState(false);

  const dirty = name !== (user?.name || "") || avatar !== (user?.avatar || "");

  async function save() {
    setSaving(true);
    const r = await fetch("/api/auth/profile", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), avatar: avatar || null }),
    });
    setSaving(false);
    if (r.ok) {
      toast.success("Profile updated");
      onUpdate();
    } else {
      toast.error("Save failed", (await r.json().catch(() => ({}))).error);
    }
  }

  function onAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 512 * 1024) {
      toast.error("Image too large", "Avatar must be under 512 KB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAvatar(String(reader.result));
    reader.readAsDataURL(f);
  }

  return (
    <div>
      <h2 style={SECTION_HEADER}>Profile</h2>
      <p style={SECTION_LEAD}>Your account identity — display name and how you appear across Hyperagent.</p>

      <div className="card" style={{ padding: 20, maxWidth: 600 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
          <div style={{
            width: 64, height: 64, borderRadius: 16,
            background: avatar ? `url(${avatar}) center/cover` : "linear-gradient(135deg,var(--accent),#f97316)",
            color: "white",
            display: "grid", placeItems: "center",
            fontSize: 26, fontWeight: 700, flexShrink: 0,
          }}>{!avatar && (name[0] || "?").toUpperCase()}</div>
          <div style={{ flex: 1 }}>
            <label style={{ display: "inline-block" }}>
              <input type="file" accept="image/*" onChange={onAvatarFile} style={{ display: "none" }} />
              <span className="btn" style={{ fontSize: 12, padding: "6px 12px", display: "inline-block" }}>Upload image</span>
            </label>
            {avatar && (
              <button className="btn" onClick={() => setAvatar("")}
                style={{ marginLeft: 6, fontSize: 12, padding: "6px 12px" }}>Remove</button>
            )}
            <div style={HELP_TEXT}>JPG, PNG, GIF, or SVG. Up to 512 KB.</div>
          </div>
        </div>

        <label style={FIELD_LABEL}>Display name</label>
        <input className="input" value={name} onChange={e => setName(e.target.value)}
          placeholder="Your name" />
        <div style={HELP_TEXT}>Shown in chats, presence avatars, and audit logs.</div>

        <label style={{ ...FIELD_LABEL, marginTop: 16 }}>Email</label>
        <input className="input" value={user?.email || ""} disabled style={{ opacity: 0.7, cursor: "not-allowed" }} />
        <div style={HELP_TEXT}>Email changes aren't supported yet.</div>

        <label style={{ ...FIELD_LABEL, marginTop: 16 }}>User ID</label>
        <code className="mono" style={{ display: "block", padding: "8px 12px", background: "var(--bg-subtle)", borderRadius: 7, fontSize: 11.5 }}>
          {user?.id || ""}
        </code>

        {dirty && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ============ Personalization ============

const INDUSTRIES = [
  "Technology", "Software / SaaS", "Financial services", "Healthcare", "Media",
  "Consulting", "Education", "Retail / E-commerce", "Manufacturing",
  "Government / Non-profit", "Other",
];
const ROLES = [
  "Founder / CEO", "Engineering", "Product", "Design", "Marketing", "Sales",
  "Customer success", "Operations", "Finance", "Legal", "Other",
];

export function PersonalizationSection({ prefs, onSave }: { prefs: any; onSave: (patch: any) => Promise<void> }) {
  const toast = useToast();
  const [company, setCompany] = useState(prefs.company || "");
  const [role, setRole] = useState(prefs.role || "");
  const [industry, setIndustry] = useState(prefs.industry || "");
  const [useCase, setUseCase] = useState(prefs.useCase || "");
  const [timeZone, setTimeZone] = useState(prefs.timeZone || (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC"));
  const [saving, setSaving] = useState(false);

  const dirty = company !== (prefs.company || "") ||
    role !== (prefs.role || "") ||
    industry !== (prefs.industry || "") ||
    useCase !== (prefs.useCase || "") ||
    timeZone !== (prefs.timeZone || "");

  async function save() {
    setSaving(true);
    await onSave({ company, role, industry, useCase, timeZone });
    setSaving(false);
    toast.success("Preferences saved");
  }

  return (
    <div>
      <h2 style={SECTION_HEADER}>Personalization</h2>
      <p style={SECTION_LEAD}>
        Tell Hyperagent about your company and preferences for recommendations tailored to your industry. Used by the router and skill suggestions.
      </p>

      <div className="card" style={{ padding: 20, maxWidth: 600 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <label style={FIELD_LABEL}>Company</label>
            <input className="input" value={company} onChange={e => setCompany(e.target.value)} placeholder="Acme Inc." />
          </div>
          <div>
            <label style={FIELD_LABEL}>Role</label>
            <select className="input" value={role} onChange={e => setRole(e.target.value)}>
              <option value="">Select…</option>
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
          <div>
            <label style={FIELD_LABEL}>Industry</label>
            <select className="input" value={industry} onChange={e => setIndustry(e.target.value)}>
              <option value="">Select…</option>
              {INDUSTRIES.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
          <div>
            <label style={FIELD_LABEL}>Time zone</label>
            <input className="input" value={timeZone} onChange={e => setTimeZone(e.target.value)}
              placeholder="America/New_York" />
            <div style={HELP_TEXT}>Used for schedules + relative timestamps.</div>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <label style={FIELD_LABEL}>Primary use case</label>
          <textarea className="input" rows={3} value={useCase} onChange={e => setUseCase(e.target.value)}
            placeholder="e.g. competitive research, customer support automation, code review"
            style={{ resize: "vertical" }} />
          <div style={HELP_TEXT}>Helps the smart router pick agents that match your typical work.</div>
        </div>

        {dirty && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ============ Notifications ============

const NOTIFICATION_LABELS: Array<{ key: string; label: string; sub: string }> = [
  { key: "thread_complete", label: "Thread complete", sub: "Agent finished a turn while the tab was inactive." },
  { key: "thread_failed", label: "Thread failed", sub: "Turn errored or hit budget cap." },
  { key: "plan_ready", label: "Plan ready for review", sub: "Plan-first mode paused for your approval." },
  { key: "credit_low", label: "Credit low", sub: "Balance dropped below 1,000 credits." },
  { key: "schedule_completed", label: "Schedule completed", sub: "A scheduled run finished." },
  { key: "security_event", label: "Security events", sub: "Login from new device, password changed, key rotated." },
];

export function NotificationsSection() {
  const toast = useToast();
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [subs, setSubs] = useState<any[]>([]);
  const [pushSupported, setPushSupported] = useState(false);
  const [pushPermission, setPushPermission] = useState<NotificationPermission>("default");

  const reload = useCallback(async () => {
    const r = await fetch("/api/notifications");
    if (r.ok) {
      const j = await r.json();
      setPrefs(j.preferences);
      setSubs(j.subscriptions || []);
    }
  }, []);
  useEffect(() => {
    reload();
    if (typeof window !== "undefined") {
      setPushSupported("serviceWorker" in navigator && "PushManager" in window);
      if ("Notification" in window) setPushPermission(Notification.permission);
    }
  }, [reload]);

  async function togglePref(key: string, value: boolean) {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    await fetch("/api/notifications", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferences: { [key]: value } }),
    });
  }

  async function requestPermission() {
    if (typeof Notification === "undefined") return;
    const p = await Notification.requestPermission();
    setPushPermission(p);
    if (p === "granted") toast.success("Browser notifications enabled");
    else toast.warning("Notifications dismissed", "You won't get background alerts.");
  }

  async function revokeSub(id: string) {
    await fetch(`/api/notifications?id=${id}`, { method: "DELETE" });
    reload();
  }

  return (
    <div>
      <h2 style={SECTION_HEADER}>Notifications</h2>
      <p style={SECTION_LEAD}>Configure browser notifications for agent activity on background threads.</p>

      <div className="card" style={{ padding: 20, marginBottom: 16, maxWidth: 700 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Browser permission</div>
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 12 }}>
          {!pushSupported && "Your browser doesn't support push notifications."}
          {pushSupported && pushPermission === "default" && "Enable notifications to receive alerts when an agent finishes work in a backgrounded tab."}
          {pushSupported && pushPermission === "granted" && (
            <span style={{ color: "var(--green)" }}>✓ Notifications are enabled.</span>
          )}
          {pushSupported && pushPermission === "denied" && (
            <span style={{ color: "var(--c1)" }}>Notifications blocked. Re-enable from your browser site settings.</span>
          )}
        </div>
        {pushSupported && pushPermission !== "granted" && (
          <button className="btn btn-primary" onClick={requestPermission} disabled={pushPermission === "denied"}>
            Enable browser notifications
          </button>
        )}
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16, maxWidth: 700 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Per-event preferences</div>
        {NOTIFICATION_LABELS.map(item => (
          <label key={item.key} style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "10px 0", borderTop: "1px solid var(--border)",
          }}>
            <input type="checkbox" checked={!!prefs[item.key]} onChange={e => togglePref(item.key, e.target.checked)}
              style={{ margin: 0, transform: "scale(1.15)" }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{item.label}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 1 }}>{item.sub}</div>
            </div>
          </label>
        ))}
      </div>

      {subs.length > 0 && (
        <div className="card" style={{ padding: 20, maxWidth: 700 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Subscribed devices</div>
          {subs.map((s: any) => (
            <div key={s.id} style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "8px 0", borderTop: "1px solid var(--border)",
              fontSize: 12,
            }}>
              <div style={{ flex: 1 }}>
                <div>{s.endpointDomain}</div>
                <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{s.userAgent || "Unknown UA"}</div>
              </div>
              <button className="btn" onClick={() => revokeSub(s.id)} style={{ fontSize: 11, padding: "4px 10px" }}>
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ Security ============

export function SecuritySection() {
  const toast = useToast();
  const confirm = useConfirm();
  const [sessions, setSessions] = useState<any[]>([]);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const r = await fetch("/api/auth/sessions");
    if (r.ok) setSessions((await r.json()).sessions || []);
  }, []);
  useEffect(() => { reload(); }, [reload]);

  async function changePw() {
    if (next !== confirmPw) { toast.error("Passwords don't match"); return; }
    setBusy(true);
    const r = await fetch("/api/auth/password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current, next }),
    });
    setBusy(false);
    if (r.ok) {
      toast.success("Password changed");
      setCurrent(""); setNext(""); setConfirmPw("");
    } else {
      toast.error("Couldn't change password", (await r.json().catch(() => ({}))).error);
    }
  }

  async function revoke(id: string, isCurrent: boolean) {
    const ok = await confirm({
      title: isCurrent ? "Sign out this device?" : "Revoke this session?",
      body: isCurrent ? "You'll be signed out immediately." : "The session token will be invalidated; whoever holds it will be signed out.",
      confirmLabel: isCurrent ? "Sign out" : "Revoke",
      variant: "destructive",
    });
    if (!ok) return;
    const r = await fetch(`/api/auth/sessions/${id}`, { method: "DELETE" });
    if (r.ok) {
      if (isCurrent) window.location.href = "/login";
      else { toast.success("Session revoked"); reload(); }
    }
  }

  return (
    <div>
      <h2 style={SECTION_HEADER}>Security</h2>
      <p style={SECTION_LEAD}>Manage your sessions and security settings. Audit log captures every login, key rotation, and session revoke.</p>

      <div className="card" style={{ padding: 20, marginBottom: 16, maxWidth: 600 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Change password</div>
        <input type="password" className="input" placeholder="Current password"
          value={current} onChange={e => setCurrent(e.target.value)}
          style={{ marginBottom: 8 }} />
        <input type="password" className="input" placeholder="New password (min 8 chars)"
          value={next} onChange={e => setNext(e.target.value)}
          style={{ marginBottom: 8 }} />
        <input type="password" className="input" placeholder="Confirm new password"
          value={confirmPw} onChange={e => setConfirmPw(e.target.value)} />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn btn-primary"
            onClick={changePw}
            disabled={busy || !current || next.length < 8 || next !== confirmPw}>
            {busy ? "Saving…" : "Change password"}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 20, maxWidth: 700 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Active sessions</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
          {sessions.length} session{sessions.length === 1 ? "" : "s"} authorized.
        </div>
        {sessions.map((s: any) => (
          <div key={s.id} style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "10px 0", borderTop: "1px solid var(--border)",
            fontSize: 12.5,
          }}>
            <code className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>{s.idPrefix}…</code>
            <div style={{ flex: 1 }}>
              {s.current && <span style={{
                fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                background: "rgba(34,197,94,0.10)", color: "var(--green)", marginRight: 8,
              }}>CURRENT</span>}
              Expires {new Date(s.expiresAt).toLocaleDateString()}
            </div>
            <button className="btn" onClick={() => revoke(s.id, s.current)}
              style={{ fontSize: 11, padding: "4px 10px", color: "#dc2626" }}>
              {s.current ? "Sign out" : "Revoke"}
            </button>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16 }}>
        <Link href="/audit" style={{ fontSize: 13, color: "var(--accent)" }}>
          View audit log →
        </Link>
      </div>
    </div>
  );
}

// ============ Referrals ============

export function ReferralsSection() {
  const toast = useToast();
  const [data, setData] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/referrals").then(r => r.json()).then(setData);
  }, []);

  function copy(value: string) {
    try {
      navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success("Link copied");
    } catch {}
  }

  if (!data) return null;
  const refereeReward = (data.rewards.referee / 1000).toFixed(0);
  const referrerReward = (data.rewards.referrer / 1000).toFixed(0);

  return (
    <div>
      <h2 style={SECTION_HEADER}>Referrals</h2>
      <p style={SECTION_LEAD}>
        Share Hyperagent and earn ${referrerReward} in credits for each referral. Your friends get ${refereeReward}.
      </p>

      <div className="card" style={{ padding: 24, maxWidth: 600, marginBottom: 16,
        background: "linear-gradient(135deg, rgba(245,158,11,0.06), rgba(220,38,38,0.04))",
        border: "1px solid var(--border-strong)" }}>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Your referral link</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <code className="mono" style={{
            flex: 1, padding: "10px 14px",
            background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 7,
            fontSize: 12, overflow: "auto", whiteSpace: "nowrap",
          }}>{data.link}</code>
          <button className="btn" onClick={() => copy(data.link)} style={{ fontSize: 12, padding: "8px 14px" }}>
            {copied ? "✓ Copied" : "Copy link"}
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 8 }}>
          Code: <code className="mono">{data.code}</code>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
        <Stat label="Invites sent" value={data.stats.invites} />
        <Stat label="Signups" value={data.stats.signups} />
        <Stat label="Converted" value={data.stats.converted} />
        <Stat label="Credits earned" value={`${(data.stats.credited_count * data.rewards.referrer / 1000).toFixed(0)}`} prefix="$" />
      </div>

      {data.referees.length > 0 && (
        <div className="card" style={{ padding: 20, maxWidth: 700 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Referrals</div>
          {data.referees.map((r: any) => (
            <div key={r.id} style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "10px 0", borderTop: "1px solid var(--border)",
              fontSize: 12.5,
            }}>
              <span style={{
                fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                background: r.kind === "converted" ? "rgba(34,197,94,0.10)" :
                            r.kind === "signup" ? "rgba(59,130,246,0.10)" :
                            "var(--bg-subtle)",
                color: r.kind === "converted" ? "var(--green)" :
                       r.kind === "signup" ? "#3b82f6" : "var(--text-muted)",
              }}>{r.kind.toUpperCase()}</span>
              <div style={{ flex: 1 }}>{r.refereeEmail || "—"}</div>
              <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                {new Date(r.createdAt).toLocaleDateString()}
              </span>
              {r.credited && <span style={{ color: "var(--green)" }}>✓ credited</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, prefix }: { label: string; value: any; prefix?: string }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", letterSpacing: 0.5, textTransform: "uppercase" }}>{label}</div>
      <div className="h-display" style={{ fontSize: 28, marginTop: 4 }}>
        {prefix}{typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

// ============ Integrations / Billing pointer sections ============

export function IntegrationsLinkSection({ count }: { count: number }) {
  return (
    <div>
      <h2 style={SECTION_HEADER}>Integrations</h2>
      <p style={SECTION_LEAD}>
        Connect third-party services like GitHub, Slack, Gmail, and 250+ more via OAuth. Enable your agents to interact with external tools.
      </p>
      <div className="card" style={{ padding: 20, maxWidth: 600 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
          {count} {count === 1 ? "integration" : "integrations"} connected
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 12 }}>
          Browse the catalog, OAuth into new accounts, or unbind existing ones.
        </div>
        <Link href="/integrations" className="btn btn-primary" style={{ fontSize: 12, padding: "8px 14px" }}>
          Open Integrations →
        </Link>
      </div>
    </div>
  );
}

export function BillingLinkSection({ balance }: { balance: number }) {
  return (
    <div>
      <h2 style={SECTION_HEADER}>Billing</h2>
      <p style={SECTION_LEAD}>Manage your subscription, apply coupon codes, and view billing details.</p>
      <div className="card" style={{ padding: 20, maxWidth: 600 }}>
        <div style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: 0.5, textTransform: "uppercase", fontWeight: 600 }}>Balance</div>
        <div className="h-display" style={{ fontSize: 36, marginTop: 4 }}>{balance.toLocaleString()}</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
          ≈ ${(balance * 0.001).toFixed(2)} USD
        </div>
        <Link href="/billing" className="btn btn-primary" style={{ fontSize: 12, padding: "8px 14px" }}>
          Open Billing →
        </Link>
      </div>
    </div>
  );
}
