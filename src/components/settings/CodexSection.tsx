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

import * as React from "react";
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
  url?: string;
  tokenTail?: string;
  experimentalApi?: boolean;
  connectionLocation?: "browser" | "tunnel" | "local-server";
}

type BridgeLocation = "browser" | "tunnel" | "local-server";

interface LocalStatus {
  supportsSpawn: boolean;
  reason?: "vercel-hosted" | "explicitly-disabled" | "unknown-serverless";
  runtime: "vercel" | "node-server" | "unknown";
  codexInstalled: boolean;
  version: string | null;
}

// P64.2 — aligned with real codex 0.130.0 wire shape:
//   { account: { type: "chatgpt", email, planType } | { type: "apiKey" }
//             | { type: "amazonBedrock" } | null,
//     requiresOpenaiAuth: boolean }
interface AccountState {
  type?: "chatgpt" | "apiKey" | "amazonBedrock";
  email?: string;
  planType?: string;
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
  // P64.1 — connection location is now the primary axis. "browser" =
  // browser tab connects to the user's localhost bridge; "tunnel" =
  // public URL routable from the hosted server; "local-server" = our
  // Node IS the user's machine.
  const [bridgeLocation, setBridgeLocation] = useState<BridgeLocation>("browser");
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
      body: JSON.stringify({
        url: bridgeUrl,
        capabilityToken: bridgeToken,
        experimentalApi,
        connectionLocation: bridgeLocation,
      }),
    });
    const j = await r.json();
    setBusy(null);
    if (r.ok) {
      toast.success("Bridge saved", "Connection details encrypted at rest.");
      setBridgeUrl(""); setBridgeToken(""); setExperimentalApi(false);
      setBridgeLocation("browser");
      setShowBridgeForm(false);
      reload();
    } else {
      toast.error("Save failed", j.error || "");
    }
  }

  async function testBridge() {
    setBusy("test");
    try {
      // For browser-direct bridges, the server can't reach the URL —
      // run the test in the browser instead by opening a WS straight
      // to the saved URL.
      if (bridge?.connectionLocation === "browser" && bridge?.url) {
        await testBridgeFromBrowser(bridge.url);
        return;
      }
      const r = await fetch("/api/codex/test-connection", { method: "POST" });
      const j = await r.json();
      if (j.ok) {
        const t = j.account?.type;
        const label = t === "chatgpt"
          ? `ChatGPT (${j.account.email || "signed in"})`
          : t === "apiKey"
            ? "API key"
            : t === "amazonBedrock"
              ? "Amazon Bedrock"
              : (j.requiresOpenaiAuth ? "needs sign-in" : "unauthenticated");
        toast.success("Bridge reachable", `Connected in ${j.elapsedMs}ms · ${label}`);
      } else if (j.requiresBrowserTest) {
        toast.info("Browser-direct", j.error || "Run the test from your browser.");
      } else {
        toast.error("Bridge unreachable", j.error || "");
      }
    } finally { setBusy(null); }
  }

  // P64.1 — browser-direct bridge connectivity test. Opens a WS from
  // the user's tab to their localhost bridge. Doesn't authenticate via
  // capability token (which would require pasting it back here in a
  // way the server already has) — it just confirms the bridge is
  // listening and accepting WebSocket upgrades.
  async function testBridgeFromBrowser(url: string) {
    return new Promise<void>(resolve => {
      const t0 = Date.now();
      let resolved = false;
      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        toast.error("Bridge unreachable from your browser", `Timed out connecting to ${url} after 5 s. Make sure codex app-server is running locally.`);
        resolve();
      }, 5000);
      try {
        const ws = new WebSocket(url);
        ws.onopen = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          const elapsed = Date.now() - t0;
          ws.close();
          toast.success("Bridge reachable from browser", `Connected in ${elapsed} ms. (Auth + account/read happen at chat time.)`);
          resolve();
        };
        ws.onerror = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          toast.error("Bridge unreachable from your browser", `Couldn't open WebSocket to ${url}. Verify codex app-server is listening on that host:port.`);
          resolve();
        };
      } catch (e: any) {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        toast.error("Bridge test failed", e?.message || String(e));
        resolve();
      }
    });
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
        if (a.account?.type) {
          setAccount(a.account);
          const label = a.account.type === "chatgpt"
            ? `ChatGPT (${a.account.email || "signed in"})`
            : a.account.type === "apiKey"
              ? "API key"
              : a.account.type === "amazonBedrock"
                ? "Amazon Bedrock"
                : a.account.type;
          toast.success("Signed in", `${label} auth active.`);
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
            padding: 12, borderRadius: 8, marginBottom: 14,
            background: "rgba(245,158,11,0.08)",
            border: "1px solid rgba(245,158,11,0.30)",
            fontSize: 11.5, color: "#92400e", lineHeight: 1.55,
          }}>
            <strong>Why is there a paste step?</strong> Because this app is hosted in the cloud, it
            cannot automatically start a process on your laptop. The paste is a hosted-web architecture
            limitation, NOT an OpenAI requirement. Codex Local (running locally) and Codex Companion
            (recommended) don&apos;t require any paste.
          </div>

          <div style={{
            padding: 12, borderRadius: 8, marginBottom: 18,
            background: "var(--bg-subtle)",
            fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
              Manual bridge has two variants
            </div>
            <div style={{ marginBottom: 6 }}>
              <strong>1. Browser-direct.</strong> Bridge runs at <code className="mono" style={MONO_INLINE}>ws://localhost:&lt;port&gt;</code> on
              your machine. Your browser tab opens the connection. The hosted server cannot — its
              loopback is its own runtime, not yours. Subject to browser HTTPS-to-localhost rules
              (use <code className="mono" style={MONO_INLINE}>http://</code> for the app or set up
              browser flags for mixed content).
            </div>
            <div>
              <strong>2. Public tunnel.</strong> You expose the local bridge through ngrok / Cloudflare
              Tunnel / SSH reverse-tunnel. URL is <code className="mono" style={MONO_INLINE}>wss://</code>
              against a public DNS name. Hosted server connects directly. <strong>Required:</strong> a
              capability token of at least 32 characters, since the URL is publicly addressable.
              We block private/loopback URLs in this mode (SSRF protection).
            </div>
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
                <label style={LABEL}>Connection variant</label>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6, marginBottom: 14 }}>
                  <LocationRadio
                    id="browser" label="Browser-direct"
                    desc="Browser tab opens a WebSocket to your laptop's localhost bridge. URL must be ws://localhost or a private/loopback host."
                    checked={bridgeLocation === "browser"} onChange={() => setBridgeLocation("browser")}
                  />
                  <LocationRadio
                    id="tunnel" label="Public tunnel"
                    desc="Bridge exposed via ngrok / Cloudflare Tunnel / etc. URL must be wss:// to a public host. Token must be at least 32 chars."
                    checked={bridgeLocation === "tunnel"} onChange={() => setBridgeLocation("tunnel")}
                  />
                  <LocationRadio
                    id="local-server" label="Local server (advanced)"
                    desc="Hyperagent's Node runtime IS your machine (e.g. desktop wrapper, npm run dev on your laptop). Loopback URLs are legitimately our loopback. Refused on hosted Vercel."
                    checked={bridgeLocation === "local-server"} onChange={() => setBridgeLocation("local-server")}
                  />
                </div>

                <label style={LABEL}>Bridge URL</label>
                <input className="input" value={bridgeUrl} onChange={e => setBridgeUrl(e.target.value)}
                  placeholder={bridgeLocation === "tunnel" ? "wss://your-tunnel.ngrok.io" : "ws://127.0.0.1:8345"}
                  style={{ marginTop: 4 }} />

                <label style={{ ...LABEL, marginTop: 12 }}>
                  Capability token {bridgeLocation === "tunnel"
                    ? <span style={{ color: "#dc2626" }}>(≥48 hex chars / 192 bits over public internet)</span>
                    : <span style={{ color: "var(--text-muted)" }}>(≥24 hex chars / 96 bits)</span>}
                </label>
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  <input className="input" type="password" value={bridgeToken} onChange={e => setBridgeToken(e.target.value)}
                    placeholder="The capability token whose SHA-256 you passed to codex via --ws-token-sha256"
                    style={{ flex: 1 }} />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      // P64.2 — generate 32 random bytes (256-bit) hex.
                      // crypto.getRandomValues is available in all modern
                      // browsers; we fall back to Math.random NEVER.
                      const buf = new Uint8Array(32);
                      crypto.getRandomValues(buf);
                      const hex = Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
                      setBridgeToken(hex);
                    }}
                    style={{ fontSize: 11, whiteSpace: "nowrap" }}
                  >
                    Generate 256-bit
                  </button>
                </div>
                <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 6 }}>
                  After generating, run{" "}
                  <code className="mono" style={MONO_INLINE}>
                    SHA=$(echo -n "&lt;TOKEN&gt;" | shasum -a 256 | cut -d' ' -f1)
                  </code>{" "}
                  on your machine and start codex with{" "}
                  <code className="mono" style={MONO_INLINE}>
                    codex app-server --listen ws://127.0.0.1:8345 --ws-auth capability-token --ws-token-sha256 $SHA
                  </code>
                  {". "}Codex requires the token via Authorization header — we send it that way from the server.
                </div>

                <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, fontSize: 12 }}>
                  <input type="checkbox" checked={experimentalApi}
                    onChange={e => setExperimentalApi(e.target.checked)} />
                  Enable <code className="mono" style={MONO_INLINE}>chatgptAuthTokens</code> flow (experimental)
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
              {!account || !account.type ? (
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
                        {account.email || (account.type === "apiKey" ? "(API key auth)"
                          : account.type === "amazonBedrock" ? "(Amazon Bedrock)"
                          : "(signed in)")}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                        {account.type === "chatgpt" ? "ChatGPT"
                          : account.type === "apiKey" ? "API key"
                          : account.type === "amazonBedrock" ? "Amazon Bedrock"
                          : account.type} auth
                        {account.planType && ` · plan: ${account.planType}`}
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

function LocationRadio({ id: _id, label, desc, checked, onChange }: {
  id: string; label: string; desc: string; checked: boolean; onChange: () => void;
}) {
  return (
    <label style={{
      display: "flex", alignItems: "flex-start", gap: 8,
      padding: "8px 10px",
      border: checked ? "1px solid var(--accent)" : "1px solid var(--border)",
      borderRadius: 8,
      background: checked ? "var(--accent-bg)" : "var(--bg)",
      cursor: "pointer",
    }}>
      <input type="radio" checked={checked} onChange={onChange} style={{ marginTop: 3 }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{label}</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.5 }}>{desc}</div>
      </span>
    </label>
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
  // P66b — auth probe state. The hosted server NEVER stores codex tokens;
  // this UI only displays what the local codex tells us about its own
  // auth state via getAuthStatus.
  const [auth, setAuth] = React.useState<{
    loading?: boolean;
    authMethod?: string | null;
    requiresOpenaiAuth?: boolean;
    error?: string | null;
  } | null>(null);
  const [testing, setTesting] = React.useState(false);

  const checkAuth = React.useCallback(async () => {
    setAuth({ loading: true });
    try {
      const r = await fetch("/api/codex/local/auth-status");
      const j = await r.json();
      if (!r.ok) {
        setAuth({ error: j.message || j.reason || `HTTP ${r.status}` });
        return;
      }
      setAuth({
        authMethod: j.authMethod ?? null,
        requiresOpenaiAuth: j.requiresOpenaiAuth === true,
      });
    } catch (e: any) {
      setAuth({ error: e?.message || "auth probe failed" });
    }
  }, []);

  // Auto-probe when the pane becomes ready.
  React.useEffect(() => {
    if (!ready) {
      setAuth(null);
      return;
    }
    checkAuth();
  }, [ready, checkAuth]);

  // ─── render ───────────────────────────────────────────────────
  let authBadge: React.ReactNode = null;
  if (ready) {
    if (auth?.loading) {
      authBadge = <span style={{ color: "var(--text-muted)" }}>Checking auth…</span>;
    } else if (auth?.error) {
      authBadge = <span style={{ color: "#dc2626" }}>{auth.error}</span>;
    } else if (auth?.requiresOpenaiAuth) {
      authBadge = <span style={{ color: "#f59e0b" }}>Login required</span>;
    } else if (auth?.authMethod) {
      authBadge = (
        <span style={{ color: "#16a34a" }}>
          Authenticated · {auth.authMethod}
        </span>
      );
    }
  }

  const headlineLabel = ready
    ? auth?.loading
      ? "Local Codex detected"
      : auth?.requiresOpenaiAuth
        ? "Local Codex detected — login required"
        : auth?.authMethod
          ? "Local Codex ready"
          : "Local Codex detected"
    : "Local Codex not available";

  const headlineDetail = ready
    ? `Detected ${local?.version || "codex"}. Turns spawn codex app-server over stdio — no paste, no companion needed.`
    : local?.reason === "vercel-hosted"
      ? "This app is hosted in the cloud. Codex Local needs to run on the same machine as the user. Use Codex Companion or run Hyperagent locally."
      : !local?.codexInstalled
        ? "Install the codex CLI from https://github.com/openai/codex, then click Refresh below."
        : "Local mode disabled by the operator (HYPERAGENT_DISABLE_LOCAL_CODEX=1).";

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{headlineLabel}</div>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {headlineDetail}
          </div>
          {authBadge && (
            <div style={{ fontSize: 11, marginTop: 6 }}>{authBadge}</div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <button onClick={() => { onRefresh(); checkAuth(); }} className="btn"
            style={{ fontSize: 11, padding: "5px 10px" }}>
            Refresh
          </button>
          {ready && (
            <button onClick={async () => {
              setTesting(true);
              try { await checkAuth(); } finally { setTesting(false); }
            }} className="btn" style={{ fontSize: 11, padding: "5px 10px" }} disabled={testing}>
              {testing ? "Testing…" : "Test"}
            </button>
          )}
        </div>
      </div>

      {/* Login instructions when codex is detected but unauthenticated. */}
      {ready && auth?.requiresOpenaiAuth && (
        <div style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: 10,
          fontSize: 11,
          marginBottom: 10,
          color: "var(--text-muted)",
          lineHeight: 1.55,
        }}>
          To sign in to ChatGPT, run this in another terminal:
          <pre className="mono" style={{
            margin: "6px 0 0",
            padding: "6px 8px",
            background: "var(--bg)",
            borderRadius: 4,
            fontSize: 11,
          }}>codex auth login</pre>
          Then click <strong>Test</strong> above. Tokens stay on your machine — Hyperagent never reads or stores them.
        </div>
      )}

      <details style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.55 }}>
        <summary style={{ cursor: "pointer", marginBottom: 6 }}>Where Local mode is and isn&apos;t available</summary>
        <ul style={{ paddingLeft: 18, margin: "6px 0", display: "flex", flexDirection: "column", gap: 4 }}>
          <li>
            <strong>npm run dev on your laptop:</strong> works if codex is on PATH and your Node process can spawn child processes.
          </li>
          <li>
            <strong>Desktop / native wrapper (Tauri / Electron / Hyperagent native):</strong> works — the wrapper runs on the same machine as the user.
          </li>
          <li>
            <strong>Long-lived Node host (your own VPS):</strong> works <em>only if</em> the host IS the same machine where Codex should run and where the ChatGPT/Codex auth state is stored. Don&apos;t use this on a shared multi-tenant server — every user&apos;s codex would share one auth state.
          </li>
          <li>
            <strong>Docker (locally on your laptop):</strong> works only if (a) the codex binary is inside the container or bind-mounted from the host, AND (b) the codex auth/state directory (typically <code className="mono">~/.codex</code>) is mounted into the container so login persists across container restarts.
          </li>
          <li>
            <strong>Remote Docker / production server / Vercel:</strong> does NOT work. The Node runtime there cannot spawn a process on your laptop, and even if it could, the codex auth state would belong to the server, not you.
          </li>
        </ul>
      </details>
    </div>
  );
}

// P65 — Companion pairing UI.
//
// State machine:
//   not_installed → pending (pair-code generated, waiting for companion)
//                 → online (companion claimed + heartbeat fresh)
//                 → offline (claimed, no recent heartbeat)
//                 → revoked / expired
//
// We poll /api/codex/pair/status every 2s while we have a sessionId
// in local state. Once online, we increase the poll interval to 10s
// to reduce hosted-side load.
function CodexCompanionPane() {
  const [sessionId, setSessionId] = React.useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("codex-companion:sessionId") || null;
  });
  const [pairCode, setPairCode] = React.useState<string | null>(null);
  const [pairExpiresAt, setPairExpiresAt] = React.useState<number | null>(null);
  const [status, setStatus] = React.useState<{
    status?: string;
    online?: boolean;
    companionBaseUrl?: string | null;
    companionInfo?: any;
    expiresAt?: number;
    lastHeartbeatAt?: number | null;
  } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  // Compute the npx command. host defaults to current origin.
  const host = typeof window !== "undefined" ? window.location.origin : "";
  const command = pairCode
    ? `npx hyperagent-codex-companion ${pairCode} --host=${host}`
    : "";

  async function generatePairCode() {
    setBusy("start");
    setErrorMsg(null);
    try {
      const r = await fetch("/api/codex/pair/start", { method: "POST" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        if (r.status === 429) {
          throw new Error("Too many pair codes generated recently. Wait a minute and try again.");
        }
        throw new Error(j.error || `pair/start failed: ${r.status}`);
      }
      const j = await r.json();
      setPairCode(j.pairCode);
      setPairExpiresAt(j.expiresAt);
      setSessionId(j.sessionId);
      try { localStorage.setItem("codex-companion:sessionId", j.sessionId); } catch {}
    } catch (e: any) {
      setErrorMsg(e?.message || "Failed to generate pair code");
    } finally {
      setBusy(null);
    }
  }

  async function copyCommand() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErrorMsg("Couldn't copy to clipboard. Select the command manually.");
    }
  }

  async function disconnect() {
    if (!sessionId) return;
    setBusy("revoke");
    try {
      await fetch("/api/codex/pair/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } catch {}
    try { localStorage.removeItem("codex-companion:sessionId"); } catch {}
    setSessionId(null);
    setPairCode(null);
    setPairExpiresAt(null);
    setStatus(null);
    setBusy(null);
  }

  // Poll status whenever we have a sessionId.
  React.useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: any = null;
    const tick = async () => {
      if (cancelled) return;
      try {
        const r = await fetch(`/api/codex/pair/status?sessionId=${encodeURIComponent(sessionId)}`);
        if (cancelled) return;
        if (r.ok) {
          const j = await r.json();
          setStatus(j);
          // If revoked or expired, stop polling and clear local state.
          if (j.status === "revoked" || j.status === "expired") {
            try { localStorage.removeItem("codex-companion:sessionId"); } catch {}
            // Keep the row visible briefly so user sees the state, then reset.
            setTimeout(() => {
              if (cancelled) return;
              setSessionId(null);
              setPairCode(null);
              setPairExpiresAt(null);
              setStatus(null);
            }, 4000);
            return;
          }
          // Online → slow poll. Pending/offline → fast poll.
          const next = j.online ? 10_000 : 2_500;
          timer = setTimeout(tick, next);
          return;
        }
        if (r.status === 404) {
          try { localStorage.removeItem("codex-companion:sessionId"); } catch {}
          setSessionId(null);
          setStatus(null);
          return;
        }
      } catch {}
      timer = setTimeout(tick, 5_000);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  // ─── render ────────────────────────────────────────────────────
  const pairExpiresIn = pairExpiresAt
    ? Math.max(0, Math.floor((pairExpiresAt - Date.now()) / 1000))
    : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Honest banner */}
      <div className="card" style={{ padding: 12, background: "color-mix(in srgb, var(--accent) 6%, transparent)" }}>
        <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.55 }}>
          <strong>Experimental.</strong> This mode uses a local companion on your computer. The hosted app cannot directly start or reach processes on your laptop. The browser connects to the local companion, and the companion connects to Codex app-server. Disconnect anytime.
        </div>
      </div>

      {/* Status panel */}
      <CompanionStatusPanel status={status} hasSession={!!sessionId} pairCode={pairCode} pairExpiresIn={pairExpiresIn} />

      {/* Main action card — either pair-code generator or pair-code display */}
      {!sessionId || (status && (status.status === "expired" || status.status === "revoked")) ? (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Install local Codex companion</div>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.55 }}>
            Generates a short-lived pair code. Run the printed command on your machine; the companion claims the code and pairs.
          </div>
          <button className="btn btn-primary" disabled={busy === "start"} onClick={generatePairCode}
            style={{ fontSize: 12 }}>
            {busy === "start" ? "Generating…" : "Generate pair code"}
          </button>
        </div>
      ) : pairCode ? (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            Run this on your machine
          </div>
          <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginBottom: 8 }}>
            Pair code expires in {pairExpiresIn}s. After it claims, the companion stays paired for ~24h.
          </div>
          <pre className="mono" style={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 10,
            fontSize: 11,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            margin: 0,
          }}>{command}</pre>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button className="btn" onClick={copyCommand} style={{ fontSize: 11 }}>
              {copied ? "Copied" : "Copy command"}
            </button>
            <button className="btn" onClick={generatePairCode} disabled={busy === "start"} style={{ fontSize: 11 }}>
              {busy === "start" ? "Regenerating…" : "Regenerate"}
            </button>
            <div style={{ flex: 1 }} />
            <button className="btn" onClick={disconnect} disabled={busy === "revoke"} style={{ fontSize: 11, color: "#dc2626" }}>
              {busy === "revoke" ? "Cancelling…" : "Cancel"}
            </button>
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Companion paired</div>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 10 }}>
            {status?.online
              ? "Browser will connect to your local companion the next time you start a Codex turn."
              : "Companion claimed but not heartbeating. Check the terminal where you ran the npx command."}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn" onClick={() => setPairCode(null) || generatePairCode()}
              disabled={busy === "start"} style={{ fontSize: 11 }}>
              {busy === "start" ? "Regenerating…" : "Re-pair"}
            </button>
            <div style={{ flex: 1 }} />
            <button className="btn" onClick={disconnect} disabled={busy === "revoke"} style={{ fontSize: 11, color: "#dc2626" }}>
              {busy === "revoke" ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="card" style={{ padding: 10, fontSize: 11.5, color: "#dc2626" }}>{errorMsg}</div>
      )}

      <details>
        <summary style={{ fontSize: 11.5, color: "var(--text-muted)", cursor: "pointer" }}>Troubleshooting</summary>
        <ul style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6, margin: "6px 0 0 18px", paddingLeft: 0 }}>
          <li><strong>"Codex binary not found"</strong> — install codex from github.com/openai/codex, then re-run the npx command.</li>
          <li><strong>"Codex auth: needs_login"</strong> — run <code>codex auth login</code> in another terminal first.</li>
          <li><strong>Browser can't reach localhost</strong> — Chrome's Private Network Access blocks insecure origins from talking to private networks. Make sure you're using https:// for the hosted app.</li>
          <li><strong>403 origin_not_allowed</strong> — the host arg passed to the npx command must match the URL of the hosted app you're signed in to.</li>
          <li><strong>Status stuck on "Waiting"</strong> — the companion couldn't claim. Run <code>npx hyperagent-codex-companion --status</code> on your machine to inspect.</li>
        </ul>
      </details>
    </div>
  );
}

function CompanionStatusPanel({
  status,
  hasSession,
  pairCode,
  pairExpiresIn,
}: {
  status: any;
  hasSession: boolean;
  pairCode: string | null;
  pairExpiresIn: number;
}) {
  let label = "Not installed";
  let dot = "#9ca3af"; // gray
  let detail = "Generate a pair code to begin.";
  if (hasSession && !status) {
    label = "Connecting…";
    dot = "#9ca3af";
    detail = "Asking the hosted app for status…";
  } else if (status?.status === "pending") {
    label = pairCode ? "Waiting for companion" : "Waiting";
    dot = "#f59e0b";
    detail = pairCode
      ? `Run the npx command. Pair code valid for ${pairExpiresIn}s.`
      : "Pair code consumed; waiting for companion to come online.";
  } else if (status?.status === "claimed" && status?.online) {
    label = "Companion online";
    dot = "#16a34a";
    const ci = status.companionInfo || {};
    detail = ci.codex?.version
      ? `${ci.codex.version} on ${ci.platform || "unknown"}.`
      : `Heartbeat fresh.`;
  } else if (status?.status === "claimed" && !status?.online) {
    label = "Companion paired but offline";
    dot = "#f59e0b";
    detail = "No heartbeat in the last 90s. Check the terminal where you ran the npx command.";
  } else if (status?.status === "expired") {
    label = "Session expired";
    dot = "#dc2626";
    detail = "Generate a new pair code.";
  } else if (status?.status === "revoked") {
    label = "Disconnected";
    dot = "#dc2626";
    detail = "Companion session was revoked.";
  }

  return (
    <div className="card" style={{ padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden style={{
          display: "inline-block",
          width: 8, height: 8,
          borderRadius: 99,
          background: dot,
        }} />
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</div>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{detail}</div>
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
