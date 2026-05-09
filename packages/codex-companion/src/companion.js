// companion.js — main companion orchestrator. Owns:
//
//   1. Pair claim against the hosted app.
//   2. Heartbeat loop.
//   3. CodexProcess (codex app-server child via stdio).
//   4. BrowserServer (loopback HTTP/WS for the user's browser tab).
//   5. EventMirror per active run.
//
// Lifecycle:
//
//   parseArgs → claim → start codex (optional) → start browser-server
//   → register heartbeat → print status → wait for browser turns
//
// Status output is intentionally human-readable on stdout. Diagnostic
// errors go to stderr. We never print pair-codes, session secrets,
// run tickets, or any field whose name matches the redactor's
// sensitive-key set.

const { CodexProcess, detectCodex } = require("./codex-process.js");
const { BrowserServer } = require("./browser-server.js");
const { EventMirror } = require("./event-mirror.js");
const { redact } = require("./redact.js");

async function runCompanion(opts) {
  const log = makeLogger();

  if (!opts.host) {
    throw new Error(
      "Missing --host=<url>. Pass the hosted Hyperagent URL (or set HYPERAGENT_HOST). Example: --host=https://app.example.com",
    );
  }
  if (!opts.iUnderstand && opts.bind !== "127.0.0.1" && opts.bind !== "::1" && opts.bind !== "localhost") {
    throw new Error(
      `Refusing to bind to ${opts.bind}. Loopback (127.0.0.1) is the only safe default for the companion. Re-run with --i-understand if you really need a non-loopback bind.`,
    );
  }

  const allowedOrigins = parseAllowedOrigins(opts.host);

  // 1. Detect codex up front so we fail fast with an actionable error.
  let codexInfo = null;
  if (opts.spawn) {
    const detect = detectCodex(opts.codex);
    if (!detect.found) {
      log.status("codex_missing", detect.error);
      throw new Error(detect.error);
    }
    codexInfo = { binary: opts.codex, version: detect.version };
    log.status("codex_found", `Codex binary: ${detect.version}`);
  }

  // 2. Bring up the local browser-facing server FIRST so we know what
  //    URL to register with the hosted app on claim. This URL is
  //    loopback-only and is what the browser will WebSocket against.
  const state = makeState();
  const browserServer = new BrowserServer({
    host: opts.bind,
    port: opts.port,
    allowedOrigins,
    onTurn: (args) => onTurnRequest(args, { log, state, opts }),
    onApproval: (body) => onApprovalRequest(body, { log, state }),
    onCancel: (body) => onCancelRequest(body, { log, state }),
    onShutdown: (body) => onShutdownRequest(body, { log, state, browserServer, codexProc, heartbeatHandle, log: log }),
    getStatus: () => ({
      ok: true,
      codexState: state.codexState,
      accountState: state.accountState,
      activeRuns: Array.from(state.runs.keys()),
      version: require("../package.json").version,
    }),
    log,
  });

  const baseUrl = await browserServer.start();
  log.status("browser_server_listening", `Listening at ${baseUrl}`);

  // 3. Claim the pair-code with the hosted app, sending our base URL.
  const claim = await claimPairing({
    host: opts.host,
    pairCode: opts.pairCode,
    companionBaseUrl: baseUrl,
    companionInfo: {
      packageVersion: require("../package.json").version,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      codex: codexInfo ? { version: codexInfo.version } : null,
    },
  });
  log.status("paired", `Paired (session expires in ~${Math.round((claim.expiresAt - Date.now()) / 60000)} min)`);
  state.session = claim;

  // 4. Spawn codex app-server and prepare a multiplexed connection.
  let codexProc = null;
  if (opts.spawn) {
    codexProc = new CodexProcess({ binPath: opts.codex });
    state.codexState = "starting";
    log.status("codex_starting", "Starting codex app-server (stdio)…");
    try {
      await codexProc.start();
      state.codexState = "ready";
      log.status("codex_ready", "Codex app-server is running.");
    } catch (e) {
      state.codexState = "error";
      log.status("codex_error", String((e && e.message) || e));
      throw e;
    }

    // Initialize handshake.
    try {
      await codexProc.request("initialize", {
        clientInfo: { name: "hyperagent-codex-companion", title: null, version: require("../package.json").version },
        capabilities: { experimentalApi: false, optOutNotificationMethods: null },
      });
    } catch (e) {
      log.status("codex_init_error", String((e && e.message) || e));
      throw e;
    }

    // Read the auth state once on start so the browser sees a sensible
    // status. We do NOT include the access token.
    try {
      const auth = await codexProc.request("getAuthStatus", { includeToken: false, refreshToken: false });
      state.accountState = auth?.requiresOpenaiAuth ? "needs_login" : auth?.authMethod ? "ready" : "unknown";
      log.status("auth", `Codex auth: ${state.accountState}`);
    } catch (e) {
      state.accountState = "unknown";
    }

    state.codex = codexProc;
  }

  // 5. Heartbeat loop. Runs every 30 s; updates lastHeartbeatAt on the
  // hosted side. On a 401/410 we treat the session as ended and exit.
  const heartbeatHandle = startHeartbeat({
    host: opts.host,
    sessionId: claim.sessionId,
    sessionSecret: claim.sessionSecret,
    log,
    onSessionEnded: async (reason) => {
      log.status("session_ended", `Hosted app reports session ${reason}; shutting down companion.`);
      await gracefulShutdown({ codexProc, browserServer, heartbeatHandle, log });
      process.exit(0);
    },
    getCompanionInfo: () => ({
      codexState: state.codexState,
      accountState: state.accountState,
      activeRuns: state.runs.size,
    }),
  });
  state.heartbeatHandle = heartbeatHandle;

  // Crash-on-codex-exit: if codex dies unexpectedly we fail the
  // session loudly so the browser can re-trigger.
  if (codexProc) {
    codexProc.onExit((code) => {
      state.codexState = "exited";
      log.status("codex_exited", `codex app-server exited with code ${code}`);
      // Best effort: revoke our pair session so the browser sees us
      // offline immediately rather than after the heartbeat grace.
      revokeSession({ host: opts.host, sessionId: claim.sessionId, log }).catch(() => undefined);
    });
  }

  // SIGTERM / SIGINT — orderly shutdown.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log.status("shutting_down", `Received ${sig}; shutting down…`);
      gracefulShutdown({ codexProc, browserServer, heartbeatHandle, log }).then(() => process.exit(0));
    });
  }

  // The function returns after a successful start. The companion is
  // now event-driven: browser → /turn drives codex → mirrors back.
  log.status("running", "Ready for browser turns.");
}

// ─── pairing ──────────────────────────────────────────────────────────

async function claimPairing({ host, pairCode, companionBaseUrl, companionInfo }) {
  const url = `${host.replace(/\/+$/, "")}/api/codex/pair/claim`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairCode, companionBaseUrl, companionInfo }),
  });
  let body;
  try { body = await res.json(); }
  catch { body = {}; }
  if (!res.ok) {
    throw new Error(`Pair claim failed: ${res.status} ${body.error || ""}`.trim());
  }
  if (!body.sessionId || !body.sessionSecret) {
    throw new Error("Pair claim returned no session credentials");
  }
  return body;
}

async function revokeSession({ host, sessionId, log }) {
  // Best-effort revoke. The hosted app will also expire us on
  // heartbeat timeout, so we tolerate failure.
  try {
    await fetch(`${host.replace(/\/+$/, "")}/api/codex/pair/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  } catch (e) {
    log.status("revoke_failed", String((e && e.message) || e));
  }
}

function startHeartbeat({ host, sessionId, sessionSecret, log, onSessionEnded, getCompanionInfo }) {
  const intervalMs = 30_000;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const res = await fetch(`${host.replace(/\/+$/, "")}/api/codex/pair/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, sessionSecret, companionInfo: getCompanionInfo() }),
      });
      if (res.status === 401) return onSessionEnded("auth_failed");
      if (res.status === 410) return onSessionEnded("expired_or_revoked");
    } catch {
      // Network blip; the hosted app will eventually mark us offline
      // after the grace period. Retry on next interval.
    }
    setTimeout(tick, intervalMs);
  };
  setTimeout(tick, intervalMs);
  return { stop() { stopped = true; } };
}

// ─── turn dispatch ────────────────────────────────────────────────────

async function onTurnRequest({ ws, hello, send }, { log, state, opts }) {
  const codex = state.codex;
  if (!codex || state.codexState !== "ready") {
    send({ type: "error", message: "Codex app-server is not running on the companion." });
    try { ws.close(1011, "codex_not_ready"); } catch {}
    return null;
  }

  // Decode the run ticket locally (signature verified server-side).
  const decoded = decodeTicketLocal(hello.runTicket);
  if (!decoded) {
    send({ type: "error", message: "Invalid run ticket" });
    try { ws.close(4401, "bad_ticket"); } catch {}
    return null;
  }
  if (decoded.expiresAt < Date.now()) {
    send({ type: "error", message: "Run ticket has expired" });
    try { ws.close(4401, "ticket_expired"); } catch {}
    return null;
  }
  if (decoded.pairSessionId && state.session && decoded.pairSessionId !== state.session.sessionId) {
    send({ type: "error", message: "Run ticket bound to a different pair session" });
    try { ws.close(4401, "ticket_session_mismatch"); } catch {}
    return null;
  }

  const runId = decoded.runId;
  const mirror = new EventMirror({
    host: opts.host,
    runTicket: hello.runTicket,
    runId,
    log: (s) => log.status("mirror", s),
    source: "companion",
  });
  state.runs.set(runId, { mirror, ws });

  mirror.push({
    source: "companion",
    eventType: "companion/connected",
    payload: { runId, packageVersion: require("../package.json").version },
  });
  mirror.push({
    source: "companion",
    eventType: "codex/state",
    payload: { codexState: state.codexState, accountState: state.accountState },
  });

  // Subscribe to codex notifications for this turn and forward them
  // both to the browser AND the hosted mirror.
  const offNotify = codex.onNotification((env) => {
    const method = env?.method || "";
    if (!method) return;
    const params = env.params;
    send({ type: "codex_event", method, params });
    mirror.push({ source: "codex", eventType: method, payload: { method, params } });
  });

  // Pending approval map for THIS turn. Keyed on synthesized
  // approvalId we mint locally; companion-side approvals respond to
  // the original codex server-request id.
  const pendingApprovals = new Map();
  const offApproval = codex.onServerRequest(async (env) => {
    const method = env?.method || "";
    if (!method) return undefined;
    if (!isApprovalMethod(method)) return undefined;
    const approvalId = `${method}#${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const summary = approvalSummary(method, env.params);
    const approvalEvent = {
      type: "approval_required",
      approvalId,
      method,
      summary,
      detail: approvalDetail(method, env.params),
      params: env.params, // companion redacts via mirror; the browser also redacts
    };
    send(approvalEvent);
    mirror.push({
      source: "codex",
      eventType: "approval/required",
      payload: { method, approvalId, summary },
    });
    return await new Promise((resolve) => {
      pendingApprovals.set(approvalId, resolve);
    });
  });

  // Send the user message as a codex turn/start. We need a thread
  // first; if the hello carries a known codexThreadId we reuse it,
  // otherwise we open one.
  let codexThreadId = hello.codexThreadId;
  if (!codexThreadId) {
    try {
      const r = await codex.request("thread/start", {});
      codexThreadId = r?.thread?.id;
      if (!codexThreadId) throw new Error("thread/start returned no thread id");
      mirror.push({ source: "codex", eventType: "thread/started", payload: { threadId: codexThreadId } });
      send({ type: "thread_started", codexThreadId });
    } catch (e) {
      send({ type: "error", message: `thread/start failed: ${(e && e.message) || e}` });
      offNotify(); offApproval();
      try { ws.close(1011, "thread_start_failed"); } catch {}
      return null;
    }
  }

  // turn/start with the user input.
  const userInput = String(hello.input?.text ?? "");
  let turnStartId = null;
  try {
    const r = await codex.request("turn/start", {
      threadId: codexThreadId,
      input: [{ type: "text", text: userInput, text_elements: [] }],
    });
    turnStartId = r?.turn?.id;
    mirror.push({ source: "codex", eventType: "turn/started", payload: { turnId: turnStartId } });
    send({ type: "turn_started", turnId: turnStartId });
  } catch (e) {
    send({ type: "error", message: `turn/start failed: ${(e && e.message) || e}` });
    offNotify(); offApproval();
    try { ws.close(1011, "turn_start_failed"); } catch {}
    return null;
  }

  // Return per-turn handles the WS dispatcher uses.
  return {
    approval: async (msg) => {
      const id = msg.approvalId;
      const decision = msg.decision === "accept" ? "approved"
                     : msg.decision === "acceptForSession" ? "approvedForSession"
                     : "denied";
      const resolve = pendingApprovals.get(id);
      if (resolve) {
        pendingApprovals.delete(id);
        resolve({ decision });
        mirror.push({
          source: "browser",
          eventType: "approval/decision",
          payload: { approvalId: id, decision },
        });
      }
    },
    cancel: async () => {
      try { await codex.request("turn/interrupt", { turnId: turnStartId }); } catch {}
      mirror.push({ source: "browser", eventType: "turn/cancel_requested", payload: { turnId: turnStartId } });
      send({ type: "turn_cancel_requested" });
    },
    close: async () => {
      offNotify(); offApproval();
      mirror.push({ source: "companion", eventType: "browser/disconnected", payload: { runId } });
      // Drain the mirror so the hosted trace is consistent.
      try { await mirror.drain(); } catch {}
      state.runs.delete(runId);
    },
  };
}

function decodeTicketLocal(encoded) {
  if (typeof encoded !== "string") return null;
  const ix = encoded.indexOf(".");
  if (ix < 0) return null;
  const payloadB64 = encoded.slice(0, ix);
  if (!payloadB64) return null;
  try {
    const pad = payloadB64.length % 4 === 0 ? "" : "=".repeat(4 - (payloadB64.length % 4));
    const std = payloadB64.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const json = Buffer.from(std, "base64").toString("utf8");
    return JSON.parse(json);
  } catch { return null; }
}

function isApprovalMethod(method) {
  return method === "applyPatchApproval"
      || method === "execCommandApproval"
      || method === "item/commandExecution/requestApproval"
      || method === "item/fileChange/requestApproval"
      || method === "item/permissions/requestApproval"
      || method === "item/tool/requestUserInput"
      || method === "item/tool/call";
}

function approvalSummary(method, params) {
  if (method === "execCommandApproval" || method === "item/commandExecution/requestApproval") {
    const cmd = params?.command || params?.cmd || "";
    return cmd ? `Run: ${String(cmd).slice(0, 200)}` : "Run command";
  }
  if (method === "applyPatchApproval" || method === "item/fileChange/requestApproval") {
    const path = params?.path || params?.file_path || "";
    return path ? `Modify: ${String(path).slice(0, 200)}` : "Apply patch";
  }
  return method;
}

function approvalDetail(method, params) {
  if (method === "applyPatchApproval" || method === "item/fileChange/requestApproval") {
    const diff = params?.diff || params?.unified_diff;
    return typeof diff === "string" ? diff.slice(0, 5000) : undefined;
  }
  if (method === "execCommandApproval" || method === "item/commandExecution/requestApproval") {
    return params?.cwd ? `cwd: ${params.cwd}` : undefined;
  }
  return undefined;
}

// ─── REST handlers ────────────────────────────────────────────────────

async function onApprovalRequest(body, { log, state }) {
  const runId = body?.runId;
  const turn = state.runs.get(runId);
  if (!turn) return { status: 404, body: { error: "no_active_turn" } };
  // Rebroadcast through the WS path; the per-turn dispatcher in
  // onTurnRequest owns the pendingApprovals map. We simulate a WS
  // message by delivering directly.
  if (turn.ws && turn.ws.readyState === 1 /* OPEN */) {
    turn.ws.emit("message", JSON.stringify({ type: "approval", approvalId: body.approvalId, decision: body.decision }));
    return { status: 200, body: { ok: true } };
  }
  return { status: 410, body: { error: "ws_gone" } };
}

async function onCancelRequest(body, { state }) {
  const runId = body?.runId;
  const turn = state.runs.get(runId);
  if (!turn || !turn.ws) return { status: 404, body: { error: "no_active_turn" } };
  turn.ws.emit("message", JSON.stringify({ type: "cancel" }));
  return { status: 200, body: { ok: true } };
}

async function onShutdownRequest(_body, { state, browserServer, log }) {
  await gracefulShutdown({
    codexProc: state.codex,
    browserServer,
    heartbeatHandle: state.heartbeatHandle,
    log,
  });
  setTimeout(() => process.exit(0), 100);
  return { status: 200, body: { ok: true } };
}

async function gracefulShutdown({ codexProc, browserServer, heartbeatHandle, log }) {
  try { heartbeatHandle && heartbeatHandle.stop(); } catch {}
  try { browserServer && (await browserServer.stop()); } catch {}
  try { codexProc && (await codexProc.stop()); } catch {}
  log.status("shutdown", "All subsystems stopped.");
}

// ─── helpers ──────────────────────────────────────────────────────────

function makeState() {
  return {
    session: null,
    codex: null,
    codexState: "stopped",
    accountState: "unknown",
    runs: new Map(),
    heartbeatHandle: null,
  };
}

function parseAllowedOrigins(host) {
  // The hosted app's origin is the only one we accept by default.
  // Strip path/query so http://app.example.com/foo turns into the
  // origin form used by browsers.
  try {
    const u = new URL(host);
    return [`${u.protocol}//${u.host}`];
  } catch {
    throw new Error(`Invalid --host URL: ${host}`);
  }
}

function makeLogger() {
  return {
    status(kind, msg) {
      const ts = new Date().toISOString().slice(11, 19);
      // Always redact even though we only print known-safe fields,
      // as defense in depth.
      const safe = typeof msg === "string" ? msg : JSON.stringify(redact(msg));
      process.stdout.write(`[${ts}] ${kind}: ${safe}\n`);
    },
    debug(...args) {
      if (!process.env.DEBUG_COMPANION) return;
      process.stderr.write(`[debug] ${args.map((a) => typeof a === "string" ? a : JSON.stringify(redact(a))).join(" ")}\n`);
    },
    error(msg) {
      process.stderr.write(`[error] ${msg}\n`);
    },
  };
}

module.exports = { runCompanion };
