"use client";
// P57 — Settings → Codex section.
//
// UI for selecting one of three provider modes:
//   1. openaiApiKey       — platform-managed (default)
//   2. openaiUserApiKey   — user-provided OpenAI key (pasted in API Keys)
//   3. codexChatGPT       — EXPERIMENTAL: ChatGPT sign-in via codex app-server
//                           bridge running on the user's machine
//
// When mode = codexChatGPT, surfaces:
//   - Bridge connection form (URL + capability token)
//   - Sign in with ChatGPT / Sign in with API key buttons
//   - Account email + plan + rate limits when signed in
//   - Disconnect (logout from the bridge) + Clear bridge (forget URL/token)
//   - Permanent warning that usage follows the user's own ChatGPT plan,
//     workspace permissions, RBAC, and retention/residency settings

import { useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

type ProviderMode = "anthropicApiKey" | "openaiApiKey" | "codexChatGPT";

interface BridgeStatus {
  configured: boolean;
  host?: string;
  tokenTail?: string;
  experimentalApi?: boolean;
}

interface AccountState {
  authMode?: "none" | "chatgpt" | "apiKey";
  email?: string;
  plan?: string;
  experimentalApi?: boolean;
}

interface RateLimits {
  tokensRemaining?: number;
  tokensLimit?: number;
  requestsRemaining?: number;
  requestsLimit?: number;
  resetsAt?: number;
  message?: string;
}

export function CodexSection() {
  const toast = useToast();
  const confirm = useConfirm();
  const [mode, setMode] = useState<ProviderMode>("anthropicApiKey");
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [rateLimits, setRateLimits] = useState<RateLimits | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  // Bridge form fields (only used when adding/replacing).
  const [bridgeUrl, setBridgeUrl] = useState("");
  const [bridgeToken, setBridgeToken] = useState("");
  const [experimentalApi, setExperimentalApi] = useState(false);
  const [showBridgeForm, setShowBridgeForm] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      const [m, b] = await Promise.all([
        fetch("/api/codex/provider-mode").then(r => r.json()),
        fetch("/api/codex/connection").then(r => r.json()),
      ]);
      setMode(m.mode);
      setBridge(b);
      // Only fetch account + rate-limits if a bridge is configured AND
      // the user is in codexChatGPT mode — otherwise the bridge isn't
      // the authoritative auth surface.
      if (b.configured && m.mode === "codexChatGPT") {
        try {
          const a = await fetch("/api/codex/account").then(r => r.json());
          if (a.account) setAccount(a.account);
          else setAccount(null);
        } catch { setAccount(null); }
        try {
          const rl = await fetch("/api/codex/rate-limits").then(r => r.json());
          if (rl.rateLimits) setRateLimits(rl.rateLimits);
          else setRateLimits(null);
        } catch { setRateLimits(null); }
      } else {
        setAccount(null);
        setRateLimits(null);
      }
    } finally { setLoading(false); }
  }
  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function chooseMode(next: ProviderMode) {
    if (next === mode) return;
    if (next === "codexChatGPT") {
      // Block silent activation: require an explicit confirmation that
      // the user understands the experimental nature.
      const ok = await confirm({
        title: "Enable Codex via ChatGPT (Experimental)",
        body: "This routes turns through your own ChatGPT/Codex account via a local Codex app-server bridge you run on your machine. Usage follows your own plan, workspace permissions, and retention settings. Don't pool, share, or resell account access.",
        confirmLabel: "Enable",
      });
      if (!ok) return;
    }
    setBusy("mode");
    const r = await fetch("/api/codex/provider-mode", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }),
    });
    setBusy(null);
    if (r.ok) { setMode(next); toast.success("Provider mode updated"); reload(); }
    else { toast.error("Could not update mode"); }
  }

  async function saveBridge() {
    if (!bridgeUrl || !bridgeToken) return;
    setBusy("bridge");
    const r = await fetch("/api/codex/connection", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: bridgeUrl, capabilityToken: bridgeToken, experimentalApi }),
    });
    const j = await r.json();
    setBusy(null);
    if (r.ok) {
      toast.success("Bridge saved", "Connection details encrypted at rest.");
      setBridgeUrl(""); setBridgeToken(""); setExperimentalApi(false);
      setShowBridgeForm(false);
      reload();
    } else {
      toast.error("Save failed", j.error || "");
    }
  }

  async function clearBridge() {
    const ok = await confirm({
      title: "Forget Codex bridge?",
      body: "Removes the saved bridge URL + capability token from this account. Does not log out of ChatGPT inside the bridge — use Sign out for that.",
      confirmLabel: "Forget",
      variant: "destructive",
    });
    if (!ok) return;
    setBusy("clear");
    const r = await fetch("/api/codex/connection", { method: "DELETE" });
    setBusy(null);
    if (r.ok) { toast.success("Bridge cleared"); reload(); }
  }

  async function startChatGptLogin() {
    setBusy("login-chatgpt");
    const r = await fetch("/api/codex/account/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "chatgpt" }),
    });
    const j = await r.json();
    setBusy(null);
    if (!r.ok) { toast.error("Login start failed", j.error || ""); return; }
    if (j.login?.loginUrl) {
      window.open(j.login.loginUrl, "_blank", "noopener");
      toast.info("ChatGPT login opened", "Complete sign-in in the new tab. We'll refresh once your bridge confirms.");
      // Poll account state every 4s for up to 2 minutes.
      pollAccountUntilSignedIn();
    } else if (j.login?.userCode) {
      toast.info("Device code", `Enter ${j.login.userCode} at ${j.login.verificationUri}`);
      pollAccountUntilSignedIn();
    } else {
      reload();
    }
  }

  async function startApiKeyLogin() {
    const apiKey = window.prompt("Paste an OpenAI API key (sk-...) to sign in via api-key auth inside the bridge.");
    if (!apiKey) return;
    setBusy("login-apikey");
    const r = await fetch("/api/codex/account/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "apiKey", apiKey }),
    });
    setBusy(null);
    if (r.ok) { toast.success("Signed in"); reload(); }
    else { toast.error("Sign-in failed", (await r.json().catch(() => ({}))).error || ""); }
  }

  async function disconnectAccount() {
    const ok = await confirm({
      title: "Sign out of ChatGPT?",
      body: "Tells the Codex bridge to log out. The bridge will clear its local credential storage.",
      confirmLabel: "Sign out",
      variant: "destructive",
    });
    if (!ok) return;
    setBusy("logout");
    const r = await fetch("/api/codex/account", { method: "DELETE" });
    setBusy(null);
    if (r.ok) { toast.success("Signed out"); reload(); }
    else { toast.error("Logout failed"); }
  }

  function pollAccountUntilSignedIn() {
    const start = Date.now();
    const tick = async () => {
      if (Date.now() - start > 120_000) return;
      try {
        const a = await fetch("/api/codex/account").then(r => r.json());
        if (a.account?.authMode && a.account.authMode !== "none") {
          setAccount(a.account);
          toast.success("Signed in", `${a.account.authMode === "chatgpt" ? "ChatGPT" : "API key"} auth active.`);
          reload();
          return;
        }
      } catch {}
      setTimeout(tick, 4000);
    };
    setTimeout(tick, 2000);
  }

  return (
    <div>
      <h2 style={SECTION_HEADER}>Chat provider</h2>
      <p style={SECTION_LEAD}>
        Pick which provider runs your chat turns. Switching is explicit — we never silently fall back
        between providers, billing models, or accounts. Your selection applies to every new turn in
        every thread until you change it.
      </p>

      {/* Mode picker */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
        <ModeRow
          id="anthropicApiKey"
          label="Anthropic (Claude)"
          desc="Default. Uses your Anthropic key from Settings → API Keys, falling back to the platform key. Full HyperAgent tool-loop, prompt caching, plan mode, multi-turn iteration."
          active={mode === "anthropicApiKey"}
          disabled={busy === "mode"}
          onPick={() => chooseMode("anthropicApiKey")}
        />
        <ModeRow
          id="openaiApiKey"
          label="OpenAI API"
          desc="OpenAI Chat Completions (GPT-4o, GPT-4o mini, o1). Single-pass turns; tool calls surface in the UI but don't auto-iterate server-side. Uses your OpenAI key from Settings → API Keys."
          active={mode === "openaiApiKey"}
          disabled={busy === "mode"}
          onPick={() => chooseMode("openaiApiKey")}
        />
        <ModeRow
          id="codexChatGPT"
          label={<>OpenAI Codex (ChatGPT Sign-In) <span style={{ color: "#f59e0b", fontSize: 10, fontWeight: 700, marginLeft: 6, letterSpacing: 0.4 }}>EXPERIMENTAL</span></>}
          desc="Sign in with your own ChatGPT account via a local codex app-server bridge. Codex owns the thread state. Usage follows your ChatGPT plan, workspace permissions, RBAC, and retention settings."
          active={mode === "codexChatGPT"}
          disabled={busy === "mode"}
          onPick={() => chooseMode("codexChatGPT")}
        />
      </div>

      {/* Codex-specific UI only renders when codexChatGPT is the active mode */}
      {mode === "codexChatGPT" && (
        <>
          {/* Permanent warning banner */}
          <div style={{
            padding: 12, borderRadius: 8, marginBottom: 18,
            background: "rgba(245,158,11,0.08)",
            border: "1px solid rgba(245,158,11,0.30)",
            fontSize: 11.5, color: "#92400e", lineHeight: 1.5,
          }}>
            ⚠ Each Codex thread runs against the signed-in ChatGPT account&apos;s plan limits, workspace permissions, RBAC, and retention/residency settings. Don&apos;t pool, share, or resell access — one user, one ChatGPT account.
          </div>

          {/* Bridge connection */}
          <div style={{ marginBottom: 24 }}>
            <h3 style={SUBSECTION}>Bridge connection</h3>
            {loading ? (
              <div style={{ fontSize: 12, color: "var(--text-faint)" }}>Loading…</div>
            ) : bridge?.configured ? (
              <div className="card" style={{ padding: 14 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
                      Connected to <code className="mono" style={MONO_INLINE}>{bridge.host || "(bridge)"}</code>
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                      Capability token: <code className="mono">…{bridge.tokenTail}</code>{bridge.experimentalApi && " · experimentalApi: ON"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => setShowBridgeForm(s => !s)} className="btn"
                      style={{ fontSize: 11, padding: "5px 10px" }}>Replace</button>
                    <button onClick={clearBridge} disabled={busy === "clear"} className="btn"
                      style={{ fontSize: 11, padding: "5px 10px", color: "#dc2626" }}>Forget</button>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
                No bridge configured yet. Run <code className="mono" style={MONO_INLINE}>codex app-server --listen 127.0.0.1:8345 --auth-token &lt;your-token&gt;</code> on your machine, then enter the URL + token below.
              </div>
            )}

            {(showBridgeForm || !bridge?.configured) && (
              <div className="card" style={{ padding: 14, marginTop: 8 }}>
                <label style={LABEL}>Bridge URL</label>
                <input className="input" value={bridgeUrl} onChange={e => setBridgeUrl(e.target.value)}
                  placeholder="ws://127.0.0.1:8345 or wss://relay.example.com" style={{ marginTop: 4 }} />
                <label style={{ ...LABEL, marginTop: 12 }}>Capability token</label>
                <input className="input" type="password" value={bridgeToken} onChange={e => setBridgeToken(e.target.value)}
                  placeholder="The --auth-token you passed to codex app-server" style={{ marginTop: 4 }} />
                <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, fontSize: 12 }}>
                  <input type="checkbox" checked={experimentalApi}
                    onChange={e => setExperimentalApi(e.target.checked)} />
                  Enable <code className="mono" style={MONO_INLINE}>chatgptAuthTokens</code> flow (experimental — requires bridge with experimentalApi support)
                </label>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 14 }}>
                  <button className="btn btn-primary" disabled={busy === "bridge" || !bridgeUrl || !bridgeToken}
                    onClick={saveBridge} style={{ fontSize: 12 }}>
                    {busy === "bridge" ? "Saving…" : (bridge?.configured ? "Replace bridge" : "Save bridge")}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Account state */}
          {bridge?.configured && (
            <div style={{ marginBottom: 24 }}>
              <h3 style={SUBSECTION}>Account</h3>
              {!account || account.authMode === "none" ? (
                <div className="card" style={{ padding: 14 }}>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
                    Not signed in. Pick a method.
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="btn btn-primary" disabled={busy === "login-chatgpt"}
                      onClick={startChatGptLogin} style={{ fontSize: 12 }}>
                      {busy === "login-chatgpt" ? "Opening…" : "Sign in with ChatGPT"}
                    </button>
                    <button className="btn" disabled={busy === "login-apikey"}
                      onClick={startApiKeyLogin} style={{ fontSize: 12 }}>
                      Sign in with API key
                    </button>
                  </div>
                </div>
              ) : (
                <div className="card" style={{ padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
                        {account.email || "(signed in)"}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                        {account.authMode === "chatgpt" ? "ChatGPT" : "API key"} auth
                        {account.plan && ` · plan: ${account.plan}`}
                        {account.experimentalApi && " · experimentalApi: ON"}
                      </div>
                    </div>
                    <button className="btn" disabled={busy === "logout"}
                      onClick={disconnectAccount} style={{ fontSize: 11, color: "#dc2626" }}>
                      Sign out
                    </button>
                  </div>
                  {rateLimits && (
                    <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                      <div className="h-section" style={{ marginBottom: 6 }}>Rate limits</div>
                      <RateLimitsView rl={rateLimits} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ModeRow({ id: _id, label, desc, active, disabled, onPick }: {
  id: ProviderMode; label: React.ReactNode; desc: string;
  active: boolean; disabled: boolean; onPick: () => void;
}) {
  return (
    <button onClick={onPick} disabled={disabled}
      className="card" style={{
        textAlign: "left", padding: 14, cursor: disabled ? "wait" : "pointer",
        borderColor: active ? "var(--accent)" : "var(--border)",
        borderWidth: active ? 2 : 1,
        background: active ? "var(--accent-bg)" : "var(--bg-elev)",
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          width: 14, height: 14, borderRadius: 99,
          border: active ? "4px solid var(--accent)" : "1px solid var(--border)",
          background: active ? "var(--accent)" : "transparent",
        }} />
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</div>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 6, marginLeft: 22, lineHeight: 1.5 }}>
        {desc}
      </div>
    </button>
  );
}

function RateLimitsView({ rl }: { rl: RateLimits }) {
  const items: Array<{ label: string; value: string }> = [];
  if (rl.tokensRemaining !== undefined && rl.tokensLimit !== undefined) {
    items.push({ label: "Tokens", value: `${rl.tokensRemaining.toLocaleString()} / ${rl.tokensLimit.toLocaleString()}` });
  }
  if (rl.requestsRemaining !== undefined && rl.requestsLimit !== undefined) {
    items.push({ label: "Requests", value: `${rl.requestsRemaining.toLocaleString()} / ${rl.requestsLimit.toLocaleString()}` });
  }
  if (rl.resetsAt) {
    items.push({ label: "Resets", value: new Date(rl.resetsAt).toLocaleString() });
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.length === 0 && rl.message && (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{rl.message}</div>
      )}
      {items.map(it => (
        <div key={it.label} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
          <span style={{ color: "var(--text-muted)" }}>{it.label}</span>
          <span style={{ fontWeight: 500 }}>{it.value}</span>
        </div>
      ))}
      {rl.message && items.length > 0 && (
        <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 4 }}>{rl.message}</div>
      )}
    </div>
  );
}

const SECTION_HEADER: React.CSSProperties = { fontSize: 24, fontWeight: 600, marginBottom: 4 };
const SECTION_LEAD: React.CSSProperties = { fontSize: 13, color: "var(--text-muted)", marginBottom: 24, maxWidth: 720, lineHeight: 1.55 };
const SUBSECTION: React.CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 10 };
const LABEL: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 };
const MONO_INLINE: React.CSSProperties = { background: "var(--bg-subtle)", padding: "1px 6px", borderRadius: 4, fontSize: "0.92em" };
