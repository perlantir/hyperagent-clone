"use client";
// P57 + P64 — Settings → Chat provider.
//
// Six provider modes in two groups:
//
//   Direct API keys
//     - anthropicApiKey       Anthropic Claude (default)
//     - openaiApiKey          OpenAI Platform key (uses platform fallback)
//     - openaiUserApiKey      User-supplied OpenAI key (Settings → API Keys)
//
//   OpenAI Codex via ChatGPT (Experimental)
//     - codexChatGPTLocal     Phase 2: app spawns codex app-server via stdio.
//                             Only enabled when the runtime supports child
//                             processes AND the codex binary is on PATH.
//                             Disabled on Vercel.
//     - codexChatGPTCompanion Phase 3: hosted app + local companion. Browser
//                             talks directly to the companion's localhost
//                             WebSocket; pairing replaces manual paste.
//                             (Companion ships in P65 — this row is gated
//                             behind that release.)
//     - codexChatGPTBridge    Phase 1: hosted app + manually configured
//                             bridge. User pastes ws://localhost:<port> +
//                             capability token. Marked Advanced/Experimental.
//                             The paste is a hosted-web limitation, NOT an
//                             OpenAI requirement.
//
// Selection is always user-driven; we never silently switch billing
// models or auth accounts.

import { useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

type ProviderMode =
  | "anthropicApiKey"
  | "openaiApiKey"
  | "openaiUserApiKey"
  | "codexChatGPTLocal"
  | "codexChatGPTBridge"
  | "codexChatGPTCompanion";

interface BridgeStatus {
  configured: boolean;
  host?: string;
  tokenTail?: string;
  experimentalApi?: boolean;
}

interface LocalStatus {
  supportsSpawn: boolean;
  reason?: "vercel-hosted" | "explicitly-disabled" | "unknown-serverless";
  runtime: "vercel" | "node-server" | "unknown";
  codexInstalled: boolean;
  version: string | null;
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
  const [local, setLocal] = useState<LocalStatus | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [rateLimits, setRateLimits] = useState<RateLimits | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  // Bridge form fields (only used when adding/replacing).
  const [bridgeUrl, setBridgeUrl] = useState("");
  const [bridgeToken, setBridgeToken] = useState("");
  const [experimentalApi, setExperimentalApi] = useState(false);
  const [allowNonLoopback, setAllowNonLoopback] = useState(false);
  const [showBridgeForm, setShowBridgeForm] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      const [m, b, lc] = await Promise.all([
        fetch("/api/codex/provider-mode").then(r => r.json()),
        fetch("/api/codex/connection").then(r => r.json()),
        fetch("/api/codex/local/status").then(r => r.json()),
      ]);
      setMode(m.mode);
      setBridge(b);
      setLocal(lc);
      const isCodexBridge = m.mode === "codexChatGPTBridge";
      const isCodexLocal = m.mode === "codexChatGPTLocal";
      // Only pull bridge-account state when a bridge IS our auth surface.
      // Local mode has its own (the spawned codex), companion has its own
      // — neither is reachable via this server.
      if (isCodexBridge && b.configured) {
        try {
          const a = await fetch("/api/codex/account").then(r => r.json());
          setAccount(a.account || null);
        } catch { setAccount(null); }
        try {
          const rl = await fetch("/api/codex/rate-limits").then(r => r.json());
          setRateLimits(rl.rateLimits || null);
        } catch { setRateLimits(null); }
      } else {
        setAccount(null);
        setRateLimits(null);
      }
      // Suppress unused-state warning when local mode is selected; it
      // surfaces a separate UI block.
      void isCodexLocal;
    } finally { setLoading(false); }
  }
  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function chooseMode(next: ProviderMode) {
    if (next === mode) return;
    if (next === "codexChatGPTLocal" || next === "codexChatGPTBridge" || next === "codexChatGPTCompanion") {
      const ok = await confirm({
        title: "Enable OpenAI Codex via ChatGPT (Experimental)",
        body:
          "Each user authenticates with their own ChatGPT/Codex account. Usage follows your ChatGPT plan, workspace permissions, RBAC, and retention/residency settings. Don't pool, share, or resell account access.",
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
    if (r.ok) { toast.success("Provider mode updated"); setMode(next); reload(); }
    else { toast.error("Could not update mode"); }
  }

  async function saveBridge() {
    if (!bridgeUrl || !bridgeToken) return;
    setBusy("bridge");
    const r = await fetch("/api/codex/connection", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: bridgeUrl, capabilityToken: bridgeToken, experimentalApi, allowNonLoopback }),
    });
    const j = await r.json();
    setBusy(null);
    if (r.ok) {
      toast.success("Bridge saved", "Connection details encrypted at rest.");
      setBridgeUrl(""); setBridgeToken(""); setExperimentalApi(false); setAllowNonLoopback(false);
      setShowBridgeForm(false);
      reload();
    } else {
      toast.error("Save failed", j.error || "");
    }
  }

  async function testBridge() {
    setBusy("test");
    try {
      const r = await fetch("/api/codex/test-connection", { method: "POST" });
      const j = await r.json();
      if (j.ok) {
        toast.success("Bridge reachable", `Connected in ${j.elapsedMs}ms · ${j.account?.authMode || "unauthenticated"}`);
      } else {
        toast.error("Bridge unreachable", j.error || "");
      }
    } finally { setBusy(null); }
  }

  async function clearBridge() {
    const ok = await confirm({
      title: "Forget Codex bridge?",
      body: "Removes the saved bridge URL + capability token from this account. Doesn't log out of ChatGPT inside the bridge — use Sign out for that.",
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

  // ─── Local row enable/disable + status copy ───────────────────────
  const localAvailable = !!local?.supportsSpawn && !!local?.codexInstalled;
  const localBlockedReason =
    local?.reason === "vercel-hosted"
      ? "This app is hosted in the cloud, so it can't spawn a process on your laptop. Use Codex Companion (recommended) or Bridge (advanced)."
      : local?.reason === "explicitly-disabled"
        ? "Disabled by the operator (HYPERAGENT_DISABLE_LOCAL_CODEX=1)."
        : !local?.codexInstalled
          ? "The codex CLI isn't on PATH. Install it from github.com/openai/codex, then refresh."
          : null;

  return (
    <div>
      <h2 style={SECTION_HEADER}>Chat provider</h2>
      <p style={SECTION_LEAD}>
        Pick how chat turns are authenticated. Switching is explicit — we never
        silently fall back between providers, billing models, or accounts.
      </p>

      {/* Group 1: Direct API keys */}
      <h3 style={GROUP_LABEL}>Direct API keys</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
        <ModeRow
          label="Anthropic (Claude)"
          desc="Default. Uses your Anthropic key from Settings → API Keys, falling back to the platform key. Full HyperAgent tool-loop with prompt caching + plan mode."
          active={mode === "anthropicApiKey"}
          disabled={busy === "mode"}
          onPick={() => chooseMode("anthropicApiKey")}
        />
        <ModeRow
          label="OpenAI API (platform key)"
          desc="OpenAI Chat Completions. Function calls iterate server-side. Uses the platform's OpenAI key."
          active={mode === "openaiApiKey"}
          disabled={busy === "mode"}
          onPick={() => chooseMode("openaiApiKey")}
        />
        <ModeRow
          label="OpenAI API (your key)"
          desc="Same as above but billed to your OpenAI account. Paste your key in Settings → API Keys."
          active={mode === "openaiUserApiKey"}
          disabled={busy === "mode"}
          onPick={() => chooseMode("openaiUserApiKey")}
        />
      </div>

      {/* Group 2: Codex via ChatGPT */}
      <h3 style={GROUP_LABEL}>
        OpenAI Codex via ChatGPT
        <span style={{ color: "#f59e0b", fontSize: 10, fontWeight: 700, marginLeft: 8, letterSpacing: 0.4 }}>
          EXPERIMENTAL
        </span>
      </h3>
      <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 12, maxWidth: 720 }}>
        Sign in with your own ChatGPT account through Codex&apos;s app-server. Three connection paths
        depending on where you&apos;re running: pick the one that matches your environment.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
        <ModeRow
          label="Codex Local (automatic)"
          desc={localAvailable
            ? `Codex detected${local?.version ? ` (${local.version})` : ""}. We spawn codex app-server locally and talk to it over stdio — no paste, no companion needed.`
            : `Spawn codex app-server locally over stdio. ${localBlockedReason || ""}`}
          active={mode === "codexChatGPTLocal"}
          disabled={busy === "mode" || !localAvailable}
          onPick={() => chooseMode("codexChatGPTLocal")}
          rightSlot={local && (
            <LocalStatusBadge available={localAvailable} reason={localBlockedReason} version={local.version} />
          )}
        />
        <ModeRow
          label="Codex Companion (recommended for hosted)"
          desc="Install a tiny local companion on your machine; the hosted app pairs with it and routes Codex traffic through it. No bridge URL/token paste."
          active={mode === "codexChatGPTCompanion"}
          disabled={busy === "mode"}
          comingSoon
          onPick={() => chooseMode("codexChatGPTCompanion")}
        />
        <ModeRow
          label="Codex Bridge (advanced)"
          desc="Run codex app-server on your machine and paste its WebSocket URL + capability token below. Use this only if you can't use Local or Companion mode — it's the manual fallback."
          active={mode === "codexChatGPTBridge"}
          disabled={busy === "mode"}
          onPick={() => chooseMode("codexChatGPTBridge")}
        />
      </div>

      {/* Codex-mode-specific UI */}
      {mode === "codexChatGPTLocal" && (
        <CodexLocalPane local={local} onRefresh={async () => {
          setBusy("local-refresh");
          await fetch("/api/codex/local/status?refresh=1").then(r => r.json()).then(setLocal).catch(() => {});
          setBusy(null);
        }} />
      )}

      {mode === "codexChatGPTCompanion" && <CodexCompanionPane />}

      {mode === "codexChatGPTBridge" && (
        <>
          <div style={{
            padding: 12, borderRadius: 8, marginBottom: 18,
            background: "rgba(245,158,11,0.08)",
            border: "1px solid rgba(245,158,11,0.30)",
            fontSize: 11.5, color: "#92400e", lineHeight: 1.5,
          }}>
            <strong>Why is there a paste step?</strong> Because this app is hosted in the cloud, it
            cannot automatically start a process on your laptop. Use this manual bridge only if you
            know what you&apos;re doing. Codex Local (running locally) and Codex Companion don&apos;t
            require any paste.
          </div>

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
                    <button onClick={testBridge} disabled={busy === "test"} className="btn"
                      style={{ fontSize: 11, padding: "5px 10px" }}>
                      {busy === "test" ? "Testing…" : "Test connection"}
                    </button>
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
                  placeholder="ws://127.0.0.1:8345" style={{ marginTop: 4 }} />
                <label style={{ ...LABEL, marginTop: 12 }}>Capability token</label>
                <input className="input" type="password" value={bridgeToken} onChange={e => setBridgeToken(e.target.value)}
                  placeholder="The --auth-token you passed to codex app-server" style={{ marginTop: 4 }} />
                <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, fontSize: 12 }}>
                  <input type="checkbox" checked={experimentalApi}
                    onChange={e => setExperimentalApi(e.target.checked)} />
                  Enable <code className="mono" style={MONO_INLINE}>chatgptAuthTokens</code> flow (experimental — requires bridge with experimentalApi support)
                </label>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 6, marginTop: 8, fontSize: 12, lineHeight: 1.5 }}>
                  <input type="checkbox" checked={allowNonLoopback}
                    onChange={e => setAllowNonLoopback(e.target.checked)} style={{ marginTop: 2 }} />
                  <span>
                    <strong>Allow non-loopback URL.</strong> By default we require localhost / 127.0.0.1 / private network ranges.
                    Only enable this if the bridge runs on a remote host you fully control and the URL uses <code className="mono">wss://</code>.
                  </span>
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

// ─── Sub-components ──────────────────────────────────────────────────

function ModeRow({ label, desc, active, disabled, onPick, rightSlot, comingSoon }: {
  label: React.ReactNode; desc: string;
  active: boolean; disabled: boolean; onPick: () => void;
  rightSlot?: React.ReactNode;
  comingSoon?: boolean;
}) {
  return (
    <button onClick={onPick} disabled={disabled}
      className="card" style={{
        textAlign: "left", padding: 14, cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.65 : 1,
        borderColor: active ? "var(--accent)" : "var(--border)",
        borderWidth: active ? 2 : 1,
        background: active ? "var(--accent-bg)" : "var(--bg-elev)",
        position: "relative",
      }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span style={{
          width: 14, height: 14, borderRadius: 99, marginTop: 4,
          border: active ? "4px solid var(--accent)" : "1px solid var(--border)",
          background: active ? "var(--accent)" : "transparent",
          flexShrink: 0,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 600 }}>
            {label}
            {comingSoon && (
              <span style={{
                fontSize: 9.5, fontWeight: 700, color: "#ca8a04",
                background: "rgba(202,138,4,0.15)", padding: "2px 6px", borderRadius: 999,
                letterSpacing: 0.5,
              }}>SOON</span>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>
            {desc}
          </div>
        </div>
        {rightSlot}
      </div>
    </button>
  );
}

function LocalStatusBadge({ available, reason, version }: { available: boolean; reason: string | null; version: string | null }) {
  if (available) {
    return (
      <span style={{
        fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 999,
        background: "rgba(34,197,94,0.10)", color: "#16a34a",
        whiteSpace: "nowrap",
      }} title={version ? `codex ${version}` : "codex installed"}>● READY</span>
    );
  }
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 999,
      background: "rgba(245,158,11,0.10)", color: "#b45309",
      whiteSpace: "nowrap",
    }} title={reason || "unavailable"}>UNAVAILABLE</span>
  );
}

function CodexLocalPane({ local, onRefresh }: { local: LocalStatus | null; onRefresh: () => void }) {
  const ready = !!local?.supportsSpawn && !!local?.codexInstalled;
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
            {ready ? "Local Codex ready" : "Local Codex not available"}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {ready
              ? `Detected ${local?.version || "codex"}. Turns will spawn codex app-server over stdio — no paste, no companion needed.`
              : local?.reason === "vercel-hosted"
                ? "This app is hosted in the cloud. Codex Local needs a long-lived host where Hyperagent can spawn child processes. Use Codex Companion (recommended) or run Hyperagent locally."
                : !local?.codexInstalled
                  ? "Install the codex CLI from https://github.com/openai/codex, then click Refresh below."
                  : "Local mode disabled by the operator."}
          </div>
        </div>
        <button onClick={onRefresh} className="btn"
          style={{ fontSize: 11, padding: "5px 10px" }}>
          Refresh
        </button>
      </div>
    </div>
  );
}

function CodexCompanionPane() {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        Companion is the next ship
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
        The companion is a tiny app you install on your machine. It runs codex app-server locally and pairs with this hosted app over a short-lived signed token — no manual URL/token paste. Until it lands, use Codex Local (running Hyperagent on your machine) or the Codex Bridge advanced fallback.
      </div>
    </div>
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

// ─── styles ──────────────────────────────────────────────────────────

const SECTION_HEADER: React.CSSProperties = { fontSize: 24, fontWeight: 600, marginBottom: 4 };
const SECTION_LEAD: React.CSSProperties = { fontSize: 13, color: "var(--text-muted)", marginBottom: 24, maxWidth: 720, lineHeight: 1.55 };
const SUBSECTION: React.CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 10 };
const LABEL: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 };
const MONO_INLINE: React.CSSProperties = { background: "var(--bg-subtle)", padding: "1px 6px", borderRadius: 4, fontSize: "0.92em" };
const GROUP_LABEL: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "var(--text-faint)",
  textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 10,
  display: "flex", alignItems: "center",
};
