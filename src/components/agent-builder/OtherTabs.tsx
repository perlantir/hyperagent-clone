"use client";
// P36 — All non-Config tabs in the agent builder.
//
// Bundled into one file so each tab is a thin component and reviewers can
// see the whole new surface in a single read. Tabs that need substantial
// new infrastructure (Knowledge retrieval) ship as honest UI shells with
// a banner pointing to the phase that will land the backend.

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Skeleton } from "@/components/Skeleton";
import type { AgentLike } from "./types";
import { NATIVE_TOOL_CATALOG } from "./types";

// ============ Slack inline binder (P52) ============
//
// Replaces the "Manage workspaces" → /settings redirect that frustrated
// users on the agent builder. Lets them:
//   - Kick off Composio's Slack OAuth in a new tab (for outbound tools)
//   - Bind a workspace inline by entering teamId + bot token (needed for
//     inbound webhook routing — Composio doesn't proxy slack/events)
//   - Unbind a previously-bound workspace
// All without leaving the builder.

function SlackBinder({ agentId, workspaces, onChanged }: {
  agentId: string;
  workspaces: any[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [showForm, setShowForm] = useState(false);
  const [teamId, setTeamId] = useState("");
  const [botToken, setBotToken] = useState("");
  const [busy, setBusy] = useState(false);

  async function startOAuth() {
    setBusy(true);
    try {
      const r = await fetch("/api/connectors/slack", { method: "POST" });
      const j = await r.json();
      if (j.redirectUrl || j.url) {
        window.open(j.redirectUrl || j.url, "_blank", "noopener");
        toast.info("Slack OAuth opened", "Approve in the new tab. After Composio confirms the connection, return here and click Add workspace.");
      } else {
        toast.error("OAuth start failed", j.error || "no redirect URL returned");
      }
    } catch (e: any) {
      toast.error("OAuth start failed", e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function bind() {
    if (!teamId.trim() || !botToken.trim()) return;
    setBusy(true);
    const r = await fetch("/api/settings/slack-workspaces", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamId: teamId.trim(), botToken: botToken.trim(), agentId }),
    });
    const j = await r.json();
    setBusy(false);
    if (r.ok) {
      toast.success("Slack workspace bound", "Inbound messages will route to this agent.");
      setTeamId(""); setBotToken(""); setShowForm(false);
      onChanged();
    } else {
      toast.error("Bind failed", j.error || "");
    }
  }

  async function unbind(tid: string) {
    setBusy(true);
    const r = await fetch(`/api/settings/slack-workspaces/${encodeURIComponent(tid)}`, { method: "DELETE" });
    setBusy(false);
    if (r.ok) { toast.success("Unbound"); onChanged(); }
    else toast.error("Unbind failed");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {workspaces.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {workspaces.map(w => (
            <div key={w.teamId} style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "6px 10px", background: "var(--bg-subtle)",
              borderRadius: 6, fontSize: 12,
            }}>
              <code className="mono" style={{ flex: 1, fontSize: 11.5 }}>{w.teamId}</code>
              <span style={{ fontSize: 10.5, color: "var(--text-faint)" }}>
                token {w.botTokenRedacted}
              </span>
              <button className="btn" disabled={busy} onClick={() => unbind(w.teamId)}
                style={{ fontSize: 11, padding: "3px 9px" }}>
                Unbind
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn btn-primary" disabled={busy} onClick={startOAuth}
          style={{ fontSize: 11, padding: "5px 12px" }}>
          + Connect Slack (OAuth)
        </button>
        <button className="btn" disabled={busy} onClick={() => setShowForm(s => !s)}
          style={{ fontSize: 11, padding: "5px 12px" }}>
          {showForm ? "Hide manual bind" : "Bind workspace manually"}
        </button>
      </div>

      {showForm && (
        <div style={{ padding: 10, background: "var(--bg-subtle)", borderRadius: 6, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
            For inbound webhooks (events from Slack), provide your Slack app&apos;s Team ID and bot token.
            Configure your Slack app&apos;s Event Subscriptions to <code className="mono">{typeof window !== "undefined" ? window.location.origin : ""}/api/slack/events</code> and subscribe to <code className="mono">message.channels</code> + <code className="mono">app_mention</code>.
          </div>
          <input value={teamId} onChange={e => setTeamId(e.target.value)} placeholder="T01ABCDEFGH (Slack Team ID)"
            style={{
              padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6,
              background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
            }} />
          <input value={botToken} onChange={e => setBotToken(e.target.value)} placeholder="xoxb-… (Slack bot token)"
            style={{
              padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6,
              background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
              fontFamily: "JetBrains Mono, monospace",
            }} />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button className="btn btn-primary" disabled={busy || !teamId.trim() || !botToken.trim()}
              onClick={bind} style={{ fontSize: 11, padding: "5px 12px" }}>
              Bind to this agent
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============ Invocations Tab ============
//
// Shows all five trigger channels. Thread = always available; Webhook is
// production; Schedule + Slack are wired; Email is a UI shell pointing
// to P41. Each row reveals action-buttons + last-fired info.

export function InvocationsTab({ agent }: { agent: AgentLike }) {
  const toast = useToast();
  const [origin, setOrigin] = useState("");
  const [schedules, setSchedules] = useState<any[]>([]);
  const [slackWorkspaces, setSlackWorkspaces] = useState<any[]>([]);
  const [emailAddresses, setEmailAddresses] = useState<any[]>([]);
  const [emailDomain, setEmailDomain] = useState("");
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [newEmailSlug, setNewEmailSlug] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
    fetch("/api/schedules").then(r => r.json()).then(j => setSchedules((j.schedules || []).filter((s: any) => s.agentId === agent.id)));
    fetch("/api/settings/slack-workspaces").then(r => r.json()).then(j => setSlackWorkspaces((j.workspaces || []).filter((w: any) => w.agentId === agent.id)));
    fetch(`/api/agents/${agent.id}/email-addresses`).then(r => r.json()).then(j => {
      setEmailAddresses(j.addresses || []);
      setEmailDomain(j.domain || "");
    });
    fetch(`/api/agents/${agent.id}/webhook-secret`).then(r => r.json()).then(j => setWebhookSecret(j.secret || null));
  }, [agent.id]);
  useEffect(() => { reload(); }, [reload]);

  function copy(value: string, label: string) {
    try {
      navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1200);
    } catch {}
  }

  async function rotateSecret() {
    setBusy("rotate");
    const r = await fetch(`/api/agents/${agent.id}/webhook-secret`, { method: "POST" });
    setBusy(null);
    if (r.ok) {
      const j = await r.json();
      setWebhookSecret(j.secret);
      toast.success("Webhook secret rotated", "Update any callers using the previous secret.");
    } else toast.error("Rotate failed");
  }

  async function clearSecret() {
    setBusy("clear");
    const r = await fetch(`/api/agents/${agent.id}/webhook-secret`, { method: "DELETE" });
    setBusy(null);
    if (r.ok) { setWebhookSecret(null); toast.success("Webhook secret cleared"); }
    else toast.error("Clear failed");
  }

  async function addEmail() {
    if (!newEmailSlug.trim()) return;
    setBusy("email");
    const r = await fetch(`/api/agents/${agent.id}/email-addresses`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: newEmailSlug.trim() }),
    });
    setBusy(null);
    if (r.ok) {
      setNewEmailSlug("");
      reload();
      toast.success("Email address provisioned");
    } else {
      toast.error("Couldn't provision", (await r.json().catch(() => ({}))).error);
    }
  }

  const webhookUrl = `${origin}/api/v1/agents/${agent.id}/invoke`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 800 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Invocations</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>How this agent gets triggered. All channels share the same execution path — same memory, same tools, same audit.</div>
      </div>

      <ChannelRow
        title="Thread"
        sub="Interactive chat — what users see when they open this agent."
        status="active"
        statusLabel="ACTIVE"
        body={
          <Link href={`/threads/new?agentId=${agent.id}`} className="btn"
            style={{ fontSize: 12, padding: "5px 12px" }}>+ New thread</Link>
        }
      />

      <ChannelRow
        title="Webhook"
        sub="Per-agent public URL. Authenticate with an API key (Settings) OR an HMAC-signed signature using the per-agent secret below."
        status="active" statusLabel="PROD"
        body={
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <code className="mono" style={{
                flex: 1, padding: "8px 10px", background: "var(--bg-subtle)",
                border: "1px solid var(--border)", borderRadius: 6,
                fontSize: 11.5, overflow: "auto", whiteSpace: "nowrap",
              }}>{webhookUrl}</code>
              <button className="btn" onClick={() => copy(webhookUrl, "url")}
                style={{ fontSize: 11, padding: "5px 12px" }}>
                {copied === "url" ? "✓" : "Copy URL"}
              </button>
              <Link href="/settings" className="btn"
                style={{ fontSize: 11, padding: "5px 12px" }}>API keys</Link>
            </div>
            {/* Webhook signing secret (P41) */}
            <div style={{ paddingTop: 10, borderTop: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600 }}>HMAC signing secret</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn" onClick={rotateSecret} disabled={busy === "rotate"} style={{ fontSize: 11, padding: "4px 10px" }}>
                    {webhookSecret ? "Rotate" : "Generate"}
                  </button>
                  {webhookSecret && (
                    <button className="btn" onClick={clearSecret} disabled={busy === "clear"} style={{ fontSize: 11, padding: "4px 10px", color: "#dc2626" }}>
                      Clear
                    </button>
                  )}
                </div>
              </div>
              {webhookSecret ? (
                <>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
                    <code className="mono" style={{
                      flex: 1, padding: "6px 10px", background: "var(--bg-subtle)",
                      border: "1px solid var(--border)", borderRadius: 6,
                      fontSize: 11, overflow: "auto", whiteSpace: "nowrap",
                    }}>{webhookSecret}</code>
                    <button className="btn" onClick={() => copy(webhookSecret, "secret")}
                      style={{ fontSize: 11, padding: "4px 10px" }}>
                      {copied === "secret" ? "✓" : "Copy"}
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
                    Sign each request: <code className="mono">X-Hyperagent-Signature: t=&lt;unix&gt;,v1=HMAC_SHA256(secret, "&lt;unix&gt;.&lt;body&gt;")</code>. 5-minute clock skew tolerance enforced.
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                  No signing secret. API-key auth still works. Generate a secret to accept signed webhooks (Stripe-style HMAC).
                </div>
              )}
            </div>
          </div>
        }
      />

      <ChannelRow
        title="Schedules"
        sub="Cron-driven runs. Each execution writes a fresh thread."
        status={schedules.length > 0 ? "active" : "inactive"}
        statusLabel={schedules.length > 0 ? `${schedules.length} ACTIVE` : "NONE"}
        body={
          <div>
            {schedules.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {schedules.map(s => (
                  <div key={s.id} style={{
                    fontSize: 12, color: "var(--text-muted)",
                    padding: "6px 10px", background: "var(--bg-subtle)",
                    borderRadius: 6, display: "flex", justifyContent: "space-between",
                  }}>
                    <span>{s.name} — every {s.intervalMinutes}m</span>
                    <span style={{ color: s.active ? "var(--green)" : "var(--text-faint)", fontSize: 11 }}>
                      {s.active ? "ACTIVE" : "PAUSED"}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            <Link href="/live" className="btn" style={{ fontSize: 11, padding: "5px 12px", marginTop: schedules.length > 0 ? 8 : 0 }}>
              Manage schedules
            </Link>
          </div>
        }
      />

      <ChannelRow
        title="Slack"
        sub="Connect a Slack workspace and bind it to this agent — inbound messages route here, outbound replies use the bot token."
        status={slackWorkspaces.length > 0 ? "active" : "inactive"}
        statusLabel={slackWorkspaces.length > 0 ? `${slackWorkspaces.length} BOUND` : "NOT BOUND"}
        body={<SlackBinder agentId={agent.id} workspaces={slackWorkspaces} onChanged={reload} />}
      />

      <ChannelRow
        title="Email"
        sub="Forward an email to a per-agent address; each inbound spawns a new thread. Outbound reply tools land in a follow-on slice."
        status={emailAddresses.length > 0 ? "active" : "inactive"}
        statusLabel={emailAddresses.length > 0 ? `${emailAddresses.length} ADDRESS${emailAddresses.length === 1 ? "" : "ES"}` : "NONE"}
        body={
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {emailAddresses.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {emailAddresses.map((a: any) => (
                  <div key={a.id} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "6px 10px", background: "var(--bg-subtle)",
                    borderRadius: 6, fontSize: 12,
                  }}>
                    <code className="mono" style={{ flex: 1, fontSize: 11.5 }}>{a.address}</code>
                    <span style={{ fontSize: 10.5, color: "var(--text-faint)" }}>
                      {a.messageCount} email{a.messageCount === 1 ? "" : "s"} received
                    </span>
                    <button className="btn" onClick={() => copy(a.address, `addr-${a.id}`)}
                      style={{ fontSize: 11, padding: "3px 9px" }}>
                      {copied === `addr-${a.id}` ? "✓" : "Copy"}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                value={newEmailSlug}
                onChange={e => setNewEmailSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                placeholder="slug"
                style={{
                  flex: "0 1 180px", padding: "6px 10px",
                  border: "1px solid var(--border)", borderRadius: 6,
                  background: "var(--bg)", color: "var(--text)", fontSize: 12,
                  outline: "none",
                }} />
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>@{emailDomain || "agents.hyperagent.app"}</span>
              <button className="btn btn-primary" onClick={addEmail} disabled={busy === "email" || !newEmailSlug.trim()}
                style={{ fontSize: 11, padding: "5px 12px" }}>
                {busy === "email" ? "…" : "+ Add address"}
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Configure SendGrid Inbound Parse (or SES) to POST to <code className="mono">/api/email/inbound</code> with shared secret <code className="mono">SENDGRID_INBOUND_SECRET</code>. Each inbound email creates a thread bound to this agent.
            </div>
          </div>
        }
      />
    </div>
  );
}

function ChannelRow({ title, sub, status, statusLabel, body }: {
  title: string; sub: string;
  status: "active" | "inactive" | "planned";
  statusLabel: string;
  body: React.ReactNode;
}) {
  const colors: Record<string, { bg: string; fg: string }> = {
    active:   { bg: "rgba(34,197,94,0.10)", fg: "#22c55e" },
    inactive: { bg: "var(--bg-subtle)",     fg: "var(--text-muted)" },
    planned:  { bg: "rgba(168,85,247,0.10)", fg: "#a855f7" },
  };
  const c = colors[status];
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
          background: c.bg, color: c.fg, letterSpacing: 0.5,
        }}>{statusLabel}</span>
      </div>
      {body}
    </div>
  );
}

// ============ Integrations Tab ============
//
// Lists Composio-backed connectors with toggle-to-bind to this agent.
// Connecting a new account redirects to the existing /integrations OAuth
// flow — we don't reinvent the auth dance here.

export function IntegrationsTab({ agent, onSave }: {
  agent: AgentLike;
  onSave: (patch: Partial<AgentLike>) => Promise<void>;
}) {
  const [connectors, setConnectors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [bound, setBound] = useState<string[]>(agent.connectorIds || []);
  // P47 — per-action allow-list per toolkit slug. Empty array / missing key
  // = all actions allowed.
  const [scopes, setScopes] = useState<Record<string, string[]>>(agent.connectorScopes || {});
  const [permEditor, setPermEditor] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    fetch("/api/connectors").then(r => r.json()).then(j => {
      setConnectors(j.connectors || []);
      setLoading(false);
    });
  }, []);

  async function toggle(slug: string) {
    const next = bound.includes(slug)
      ? bound.filter(x => x !== slug)
      : [...bound, slug];
    setBound(next);
    // When unbinding, also drop the toolkit's scope entry to keep the JSON
    // tidy. Re-binding starts from "all allowed" again.
    let nextScopes = scopes;
    if (!next.includes(slug) && scopes[slug]) {
      nextScopes = { ...scopes };
      delete nextScopes[slug];
      setScopes(nextScopes);
    }
    await onSave({ connectorIds: next, connectorScopes: nextScopes });
  }

  async function saveScope(slug: string, allowed: string[]) {
    const next = { ...scopes };
    if (allowed.length === 0) {
      delete next[slug];
    } else {
      next[slug] = allowed;
    }
    setScopes(next);
    await onSave({ connectorScopes: next });
  }

  const connected = connectors.filter(c => c.connected);
  const available = connectors.filter(c => !c.connected);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 880 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Integrations</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Bind connector accounts to this agent. Tools from each connector become callable inside agent turns. Click a bound connector to scope it to specific actions.</div>
      </div>

      {loading ? (
        <Skeleton height={120} />
      ) : (
        <>
          {connected.length > 0 && (
            <div>
              <h3 className="h-section" style={{ marginBottom: 8 }}>Connected ({connected.length})</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
                {connected.map(c => (
                  <ConnectorCard
                    key={c.slug} c={c}
                    bound={bound.includes(c.slug)}
                    scopedCount={scopes[c.slug]?.length}
                    onToggle={() => toggle(c.slug)}
                    onConfigure={bound.includes(c.slug) ? () => setPermEditor(c.slug) : undefined}
                  />
                ))}
              </div>
            </div>
          )}

          <div>
            <h3 className="h-section" style={{ marginBottom: 8 }}>Available ({available.length})</h3>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
              Connect via OAuth to enable per-agent binding.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
              {available.map(c => (
                <ConnectorCard key={c.slug} c={c} bound={false} onToggle={() => {
                  toast.info("Connect first", "Open Integrations to authorize this account.");
                }} />
              ))}
            </div>
            <Link href="/integrations" className="btn" style={{ marginTop: 14, fontSize: 12, padding: "6px 14px" }}>
              Open integrations →
            </Link>
          </div>
        </>
      )}

      {/* P47 — per-action permissioning modal */}
      {permEditor && (
        <PermissionsModal
          slug={permEditor}
          connector={connectors.find(c => c.slug === permEditor)}
          allowed={scopes[permEditor] || []}
          onClose={() => setPermEditor(null)}
          onSave={async (next) => {
            await saveScope(permEditor, next);
            setPermEditor(null);
            toast.success("Permissions updated", next.length === 0
              ? "All actions are allowed for this connector."
              : `${next.length} action${next.length === 1 ? "" : "s"} allowed.`);
          }}
        />
      )}
    </div>
  );
}

function ConnectorCard({ c, bound, scopedCount, onToggle, onConfigure }: {
  c: any; bound: boolean; scopedCount?: number;
  onToggle: () => void; onConfigure?: () => void;
}) {
  return (
    <div className="card"
      style={{
        padding: 12,
        borderColor: bound ? "var(--accent)" : "var(--border)",
        borderWidth: bound ? 2 : 1,
        background: bound ? "var(--accent-bg)" : "var(--bg-elev)",
        position: "relative",
      }}>
      <button onClick={onToggle} style={{
        all: "unset", display: "flex", alignItems: "center", gap: 10,
        cursor: "pointer", width: "100%",
      }}>
        <span style={{
          width: 32, height: 32, borderRadius: 7,
          background: c.color || "var(--bg-subtle)",
          color: c.textColor || "var(--text)",
          display: "grid", placeItems: "center", fontSize: 14, fontWeight: 700,
          flexShrink: 0,
        }}>{c.icon || c.name?.[0] || "?"}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</div>
          <div style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 1 }}>
            {c.connected ? (bound ? "Bound" : "Connected") : "Not connected"}
          </div>
        </div>
        {bound && <span style={{ fontSize: 14, color: "var(--accent)" }}>✓</span>}
      </button>
      {bound && onConfigure && (
        <button onClick={onConfigure} style={{
          marginTop: 8, fontSize: 11, padding: "3px 8px",
          background: "transparent", border: "1px solid var(--border)",
          color: "var(--text-muted)", borderRadius: 6, cursor: "pointer",
          width: "100%",
        }}>
          {scopedCount && scopedCount > 0
            ? `Scoped: ${scopedCount} action${scopedCount === 1 ? "" : "s"}`
            : "All actions allowed"} <span style={{ marginLeft: 4 }}>⚙</span>
        </button>
      )}
    </div>
  );
}

// P47 — per-action permissioning modal. Lists every callable action in
// the toolkit. Empty selection = all allowed (no scope written). Selected
// subset = allow-list. Search box filters by name + description.
function PermissionsModal({ slug, connector, allowed, onClose, onSave }: {
  slug: string;
  connector?: any;
  allowed: string[];
  onClose: () => void;
  onSave: (allowed: string[]) => void | Promise<void>;
}) {
  const [actions, setActions] = useState<{ name: string; description: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set(allowed));
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/connectors/${encodeURIComponent(slug)}/actions`)
      .then(r => r.json())
      .then(j => { if (!cancelled) { setActions(j.actions || []); setLoading(false); } });
    return () => { cancelled = true; };
  }, [slug]);

  function toggle(name: string) {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name); else next.add(name);
    setSelected(next);
  }

  const q = search.trim().toLowerCase();
  const filtered = q
    ? actions.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q))
    : actions;

  const allSelected = selected.size === 0 || selected.size === actions.length;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
      display: "grid", placeItems: "center", zIndex: 100,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        width: "min(640px, 95vw)", maxHeight: "85vh",
        background: "var(--bg)", borderRadius: 14,
        border: "1px solid var(--border)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            {connector?.icon && (
              <span style={{
                width: 28, height: 28, borderRadius: 6,
                background: connector.color || "var(--bg-subtle)",
                color: connector.textColor || "var(--text)",
                display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700,
              }}>{connector.icon}</span>
            )}
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              {connector?.name || slug} · permissions
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Pick the specific actions this agent may invoke. Select none to allow every action (default).
          </div>
        </div>

        <div style={{ padding: "10px 20px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", gap: 10 }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search actions…"
            style={{
              flex: 1, padding: "6px 10px", fontSize: 12,
              border: "1px solid var(--border)", borderRadius: 6,
              background: "var(--bg-subtle)", color: "var(--text)", outline: "none",
            }}
          />
          <button onClick={() => setSelected(new Set())} className="btn"
            style={{ fontSize: 11, padding: "5px 10px" }}>Clear</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "8px 4px" }}>
          {loading ? (
            <div style={{ padding: 20 }}><Skeleton height={28} style={{ marginBottom: 6 }} /><Skeleton height={28} style={{ marginBottom: 6 }} /><Skeleton height={28} /></div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--text-faint)", fontSize: 12 }}>
              {actions.length === 0 ? "No actions returned for this toolkit." : "No matches."}
            </div>
          ) : filtered.map(a => (
            <label key={a.name} style={{
              display: "flex", alignItems: "flex-start", gap: 10,
              padding: "8px 16px", cursor: "pointer",
              borderRadius: 6, transition: "background 0.1s",
            }} onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-subtle)")}
               onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              <input type="checkbox" checked={selected.has(a.name)}
                onChange={() => toggle(a.name)}
                style={{ marginTop: 3 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontFamily: "JetBrains Mono, monospace", color: "var(--text)" }}>
                  {a.name}
                </div>
                {a.description && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.4 }}>
                    {a.description}
                  </div>
                )}
              </div>
            </label>
          ))}
        </div>

        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
            {selected.size === 0 ? `All ${actions.length} actions allowed`
              : allSelected ? "All actions selected"
              : `${selected.size} of ${actions.length} allowed`}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} className="btn" style={{ fontSize: 12, padding: "5px 12px" }}>Cancel</button>
            <button onClick={() => onSave(Array.from(selected))} className="btn btn-primary"
              style={{ fontSize: 12, padding: "5px 14px" }}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============ Tools Tab ============
//
// Native tool catalog grouped by category. Toggle-to-bind. Persists into
// agents.tools through the existing PATCH endpoint.

export function ToolsTab({ agent, onSave }: {
  agent: AgentLike;
  onSave: (patch: Partial<AgentLike>) => Promise<void>;
}) {
  const [bound, setBound] = useState<string[]>(agent.tools || []);
  async function toggle(name: string) {
    const next = bound.includes(name) ? bound.filter(x => x !== name) : [...bound, name];
    setBound(next);
    await onSave({ tools: next });
  }
  const byCategory = NATIVE_TOOL_CATALOG.reduce((acc: any, t) => {
    (acc[t.category] = acc[t.category] || []).push(t); return acc;
  }, {});

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 880 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Tools</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Native tools the agent can call. {bound.length} of {NATIVE_TOOL_CATALOG.length} enabled.
        </div>
      </div>
      {Object.entries(byCategory).map(([cat, tools]: [string, any]) => (
        <div key={cat}>
          <h3 className="h-section" style={{ marginBottom: 10 }}>{cat}</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
            {tools.map((t: any) => (
              <button key={t.name} onClick={() => toggle(t.name)} className="card"
                style={{
                  padding: 12, textAlign: "left", cursor: "pointer",
                  borderColor: bound.includes(t.name) ? "var(--accent)" : "var(--border)",
                  borderWidth: bound.includes(t.name) ? 2 : 1,
                  background: bound.includes(t.name) ? "var(--accent-bg)" : "var(--bg-elev)",
                }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</div>
                  {bound.includes(t.name) && <span style={{ fontSize: 12, color: "var(--accent)" }}>✓</span>}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.4 }}>{t.description}</div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ============ Memory Tab ============

export function MemoryTab({ agent }: { agent: AgentLike }) {
  const [memories, setMemories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    fetch(`/api/memories?agentId=${agent.id}&filter=accepted`).then(r => r.json()).then(j => {
      setMemories(j.memories || []);
      setLoading(false);
    });
  }, [agent.id]);
  useEffect(() => { reload(); }, [reload]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 800 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Memory</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Memories scoped to this agent. Plus all global memories that apply to every agent.</div>
      </div>
      {loading ? <Skeleton height={120} /> : memories.length === 0 ? (
        <EmptyState
          title="No agent-scoped memories yet"
          body="Memories saved with this agent's id will appear here. Save anything from a chat with the + Save as memory button."
          ctaLabel="Open Learning"
          ctaHref="/learning"
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {memories.map(m => (
            <div key={m.id} className="card" style={{ padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: "rgba(34,197,94,0.10)", color: "#22c55e" }}>
                  ACCEPTED
                </span>
                {m.pinned && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: "rgba(59,130,246,0.10)", color: "#3b82f6" }}>📌 PINNED</span>}
                <span style={{ fontSize: 10, color: "var(--text-faint)" }}>importance {m.importance}/10</span>
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>{m.content}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ Skills Tab (P52 — toggleable per-agent binding) ============

export function SkillsTab({ agent, onSave }: {
  agent: AgentLike;
  onSave?: (patch: Partial<AgentLike>) => Promise<void>;
}) {
  const toast = useToast();
  const [skills, setSkills] = useState<any[]>([]);
  const [bound, setBound] = useState<string[]>(agent.skillIds || []);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/skills").then(r => r.json()).then(j => setSkills(j.skills || []));
  }, []);

  // Keep bound state in sync if the agent prop changes (e.g. after a save).
  useEffect(() => { setBound(agent.skillIds || []); }, [agent.id, agent.skillIds]);

  async function toggle(id: string) {
    if (!onSave) return;
    const next = bound.includes(id) ? bound.filter(x => x !== id) : [...bound, id];
    setBound(next);
    setSaving(true);
    try {
      await onSave({ skillIds: next });
      toast.success(bound.includes(id) ? "Skill unbound" : "Skill bound", "Will apply on the next agent turn.");
    } catch {
      // Revert on failure so the UI doesn't lie.
      setBound(bound);
      toast.error("Save failed");
    } finally {
      setSaving(false);
    }
  }

  // Group by category for a slightly more browsable layout.
  const byCategory: Record<string, any[]> = {};
  for (const s of skills) {
    const c = s.category || "Other";
    (byCategory[c] = byCategory[c] || []).push(s);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 880 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Skills</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Reusable system-prompt additions. {bound.length} bound · {skills.length} installed.
          When bound, each skill&apos;s prompt addition feeds into this agent&apos;s system prompt.
        </div>
      </div>
      {skills.length === 0 ? (
        <EmptyState
          title="No skills installed"
          body="Browse the template gallery and install skills like Stripe operator, Board memo writer, Competitive teardown."
          ctaLabel="Browse skill templates"
          ctaHref="/skills"
        />
      ) : (
        Object.entries(byCategory).map(([cat, list]) => (
          <div key={cat}>
            <h3 className="h-section" style={{ marginBottom: 10 }}>{cat}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
              {list.map((s: any) => {
                const isBound = bound.includes(s.id);
                return (
                  <button key={s.id} onClick={() => toggle(s.id)} disabled={saving} className="card"
                    style={{
                      padding: 12, textAlign: "left", cursor: saving ? "wait" : "pointer",
                      borderColor: isBound ? "var(--accent)" : "var(--border)",
                      borderWidth: isBound ? 2 : 1,
                      background: isBound ? "var(--accent-bg)" : "var(--bg-elev)",
                    }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{s.name}</div>
                      {isBound && <span style={{ fontSize: 12, color: "var(--accent)" }}>✓</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.4 }}>{s.description}</div>
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}
      <Link href="/skills" className="btn" style={{ alignSelf: "flex-start", fontSize: 12, padding: "6px 14px" }}>
        Browse skill templates →
      </Link>
    </div>
  );
}

// ============ Knowledge Tab (P40 — functional) ============

interface KnowledgeDoc {
  id: string; title: string; sourceUrl: string | null;
  byteSize: number; createdAt: number; chunkCount?: number;
}

export function KnowledgeTab({ agent }: { agent: AgentLike }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetch(`/api/agents/${agent.id}/knowledge`);
    if (r.ok) {
      const j = await r.json();
      setDocs(j.docs || []);
    }
    setLoading(false);
  }, [agent.id]);
  useEffect(() => { load(); }, [load]);

  async function submit() {
    if (!title.trim() || !content.trim()) {
      toast.error("Title and content required");
      return;
    }
    setSubmitting(true);
    const r = await fetch(`/api/agents/${agent.id}/knowledge`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        content,
        sourceUrl: sourceUrl.trim() || undefined,
      }),
    });
    setSubmitting(false);
    if (r.ok) {
      const j = await r.json();
      toast.success(`Doc added`, `${j.chunkCount} chunks indexed.`);
      setTitle(""); setContent(""); setSourceUrl("");
      setAdding(false);
      load();
    } else {
      toast.error("Add failed", (await r.json().catch(() => ({}))).error);
    }
  }

  async function del(doc: KnowledgeDoc) {
    const ok = await confirm({
      title: `Delete "${doc.title}"?`,
      body: "All chunks + embeddings will be removed. This can't be undone.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    const r = await fetch(`/api/agents/${agent.id}/knowledge/${doc.id}`, { method: "DELETE" });
    if (r.ok) {
      toast.success("Doc deleted");
      load();
    } else {
      toast.error("Delete failed");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 880 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Knowledge</h2>
          <div style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 560 }}>
            Documents the agent retrieves from at run-time. Each doc is chunked (~400 tokens, 200 token overlap), embedded, and the top-4 most-relevant chunks are injected into context per turn.
          </div>
        </div>
        {!adding && (
          <button className="btn btn-primary" onClick={() => setAdding(true)} style={{ fontSize: 12, padding: "6px 14px" }}>
            + Add doc
          </button>
        )}
      </div>

      {adding && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 12 }}>Add knowledge document</div>
          <input
            value={title} onChange={e => setTitle(e.target.value)}
            placeholder="Title (required)" className="input"
            style={{ marginBottom: 8 }}
          />
          <input
            value={sourceUrl} onChange={e => setSourceUrl(e.target.value)}
            placeholder="Source URL (optional, for citation)" className="input"
            style={{ marginBottom: 8 }}
          />
          <textarea
            value={content} onChange={e => setContent(e.target.value)}
            placeholder="Paste document content here. Markdown / plain text / HTML all fine."
            rows={10}
            style={{
              width: "100%", padding: "10px 12px",
              border: "1px solid var(--border)", borderRadius: 7,
              background: "var(--bg)", color: "var(--text)",
              fontSize: 13, lineHeight: 1.55, resize: "vertical",
              fontFamily: "JetBrains Mono, monospace", outline: "none",
            }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
            <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
              {content ? `${(Buffer.byteLength?.(content, "utf-8") ?? content.length).toLocaleString()} bytes` : "0 bytes"} · 2 MB max
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" onClick={() => setAdding(false)} disabled={submitting}>Cancel</button>
              <button className="btn btn-primary" onClick={submit} disabled={submitting || !title.trim() || !content.trim()}>
                {submitting ? "Indexing…" : "Add + index"}
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? <Skeleton height={120} /> :
       docs.length === 0 && !adding ? (
        <EmptyState
          title="No knowledge docs yet"
          body="Upload reference material the agent should retrieve from — product specs, FAQs, internal docs."
          ctaLabel="Add your first doc"
          ctaHref="#"
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {docs.map(d => (
            <div key={d.id} className="card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{d.title}</div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>
                  {d.chunkCount ?? 0} chunks · {(d.byteSize / 1024).toFixed(1)} KB · {new Date(d.createdAt).toLocaleDateString()}
                </div>
                {d.sourceUrl && (
                  <a href={d.sourceUrl} target="_blank" rel="noopener noreferrer"
                    style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none", marginTop: 2, display: "inline-block" }}>
                    {d.sourceUrl} ↗
                  </a>
                )}
              </div>
              <button className="btn" onClick={() => del(d)}
                style={{ fontSize: 11, padding: "4px 10px", color: "#dc2626", borderColor: "rgba(220,38,38,0.4)" }}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ Rubrics Tab ============

export function RubricsTab({ agent }: { agent: AgentLike }) {
  const [rubrics, setRubrics] = useState<any[]>([]);
  useEffect(() => {
    fetch("/api/rubrics").then(r => r.json()).then(j => setRubrics(j.rubrics || []));
  }, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 800 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Rubrics</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Evaluation criteria applied to multi-step runs. Pinned rubrics auto-fire after each turn.</div>
      </div>
      {rubrics.length === 0 ? (
        <EmptyState
          title="No rubrics yet"
          body="Build a rubric and pin it to evaluate every multi-step run automatically."
          ctaLabel="Open Learning"
          ctaHref="/learning"
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rubrics.map(r => (
            <div key={r.id} className="card" style={{ padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{r.name}</span>
                {r.isBuiltin && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: "rgba(168,85,247,0.10)", color: "#a855f7" }}>BUILT-IN</span>}
                {r.isPinned && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: "rgba(59,130,246,0.10)", color: "#3b82f6" }}>📌 PINNED</span>}
              </div>
              {r.description && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{r.description}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ Library Tab ============

export function LibraryTab({ agent }: { agent: AgentLike }) {
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch("/api/library").then(r => r.json()).then(j => {
      setArtifacts((j.artifacts || []).filter((a: any) => a.agentId === agent.id));
      setLoading(false);
    });
  }, [agent.id]);
  const colors: any = {
    webpage: { bg: "linear-gradient(135deg,#fed7aa,#fdba74)", fg: "#c2410c" },
    document: { bg: "linear-gradient(135deg,#d1fae5,#6ee7b7)", fg: "#15803d" },
    table: { bg: "linear-gradient(135deg,#bae6fd,#7dd3fc)", fg: "#1d4ed8" },
    image: { bg: "linear-gradient(135deg,#ddd6fe,#c4b5fd)", fg: "#6d28d9" },
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1100 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Library</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Artifacts produced in threads bound to this agent.</div>
      </div>
      {loading ? <Skeleton height={140} /> : artifacts.length === 0 ? (
        <EmptyState
          title="No artifacts yet"
          body="Artifacts created in this agent's threads — webpages, documents, tables, images — will appear here."
          ctaLabel="Open Library"
          ctaHref="/library"
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
          {artifacts.slice(0, 50).map(a => {
            const c = colors[a.type] || colors.webpage;
            return (
              <Link key={a.id} href={`/library/${a.id}`} className="card"
                style={{ padding: 0, overflow: "hidden", textDecoration: "none", color: "inherit" }}>
                <div style={{ height: 100, background: c.bg, color: c.fg, display: "grid", placeItems: "center", fontFamily: "Instrument Serif,serif", fontSize: 16, padding: 12, textAlign: "center" }}>{a.title}</div>
                <div style={{ padding: "8px 12px" }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.title}</div>
                  <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{a.type} · {new Date(a.createdAt).toLocaleDateString()}</div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============ Security / Budget Tab ============

export function SecurityTab({ agent, onSave }: {
  agent: AgentLike;
  onSave: (patch: Partial<AgentLike>) => Promise<void>;
}) {
  const [budget, setBudget] = useState<number | "">(agent.maxRunBudgetCredits ?? "");
  const [extendedThinking, setExtendedThinking] = useState(!!agent.extendedThinking);
  const dirty = budget !== (agent.maxRunBudgetCredits ?? "") ||
    extendedThinking !== !!agent.extendedThinking;

  async function commit() {
    await onSave({
      maxRunBudgetCredits: budget === "" ? null : Number(budget),
      extendedThinking,
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Budget &amp; Security</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Per-agent overrides. Account-default sandbox policy still applies — manage in Settings.</div>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>Budget cap per run</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
          Hard ceiling — when reached the run exits cleanly. Default 5,000 credits (~$5).
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            type="number" min={100} max={50000} step={100}
            value={budget} onChange={e => setBudget(e.target.value === "" ? "" : Number(e.target.value))}
            placeholder="No cap (use account default)"
            style={{
              width: 200, padding: "8px 12px",
              border: "1px solid var(--border)", borderRadius: 7,
              background: "var(--bg)", color: "var(--text)", fontSize: 13,
            }}
          />
          {budget !== "" && (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              ≈ ${(Number(budget) * 0.001).toFixed(2)} per run
            </span>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button" onClick={() => setExtendedThinking(!extendedThinking)}
            style={{
              position: "relative", width: 36, height: 22, borderRadius: 99,
              background: extendedThinking ? "var(--text)" : "var(--bg-subtle)",
              border: `1px solid ${extendedThinking ? "var(--text)" : "var(--border)"}`,
              cursor: "pointer", flexShrink: 0,
            }}
          >
            <span style={{
              position: "absolute", top: 2, left: extendedThinking ? 16 : 2,
              width: 16, height: 16, borderRadius: 99,
              background: extendedThinking ? "var(--bg)" : "var(--text)",
            }} />
          </button>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Extended thinking</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
              Adaptive reasoning that auto-adjusts depth. Higher quality, slightly higher cost.
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>Sandbox policy</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
          Domain allowlist + concurrency cap apply across all your agents.
        </div>
        <Link href="/settings" className="btn" style={{ fontSize: 11.5, padding: "5px 12px" }}>
          Manage sandbox policy →
        </Link>
      </div>

      {dirty && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn btn-primary" onClick={commit}>Save changes</button>
        </div>
      )}
    </div>
  );
}

// ============ Shared empty-state ============

function EmptyState({ title, body, ctaLabel, ctaHref }: {
  title: string; body: string; ctaLabel: string; ctaHref: string;
}) {
  return (
    <div className="card" style={{ padding: 32, textAlign: "center" }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 16, maxWidth: 460, margin: "0 auto 16px", lineHeight: 1.5 }}>{body}</div>
      <Link href={ctaHref} className="btn" style={{ fontSize: 12, padding: "6px 14px" }}>{ctaLabel}</Link>
    </div>
  );
}
