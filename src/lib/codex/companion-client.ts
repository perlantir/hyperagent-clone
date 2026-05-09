// P65 — Browser-side Codex Companion client.
//
// Drives a Codex turn from the browser tab through the user's local
// companion. Used by ChatView when providerMode === codexChatGPTCompanion.
//
// Flow:
//
//   1. fetch /api/codex/pair/status?sessionId — confirm the companion
//      is online and get its loopback URL.
//   2. fetch /api/codex/run-ticket — get a signed run ticket bound to
//      this user/thread/agent/pair-session.
//   3. open ws://127.0.0.1:PORT/turn — send the "hello" envelope with
//      the run ticket + user input.
//   4. forward streamed events back to the caller (mirrors the SSE
//      shape ChatView already understands).
//   5. mirror events to /api/codex/events as well so the hosted trace
//      store has its own copy.
//   6. surface approval requests to the caller; pipe decisions back
//      to the companion via WS messages.
//
// SECURITY:
//   - We never send the run ticket as a query param.
//   - Origin enforcement is on the COMPANION side; the browser is a
//     known-trusted client. Still, we refuse to open anything other
//     than ws://127.0.0.1 / ws://localhost / ws://[::1].

export type CompanionEvent =
  | { type: "started"; runId: string }
  | { type: "thread_started"; codexThreadId: string }
  | { type: "turn_started"; turnId: string }
  | { type: "delta"; text: string }
  | { type: "approval_required"; approvalId: string; method: string; summary: string; detail?: string; params: any }
  | { type: "tool_use"; id?: string; name: string; input: any }
  | { type: "tool_result"; id?: string; output: string; error?: string }
  | { type: "codex_event"; method: string; params: any }
  | { type: "turn_finished" }
  | { type: "error"; message: string }
  | { type: "done"; runId: string };

export interface CompanionTurnHandle {
  readonly runId: string;
  approval(approvalId: string, decision: "accept" | "acceptForSession" | "decline" | "cancel"): void;
  cancel(): void;
  close(): void;
  // Promise that resolves once the WS closes. Useful for UI to know
  // when to disable the input.
  done: Promise<void>;
}

export interface StartCompanionTurnOptions {
  threadId: string;
  agentId?: string | null;
  pairSessionId: string;
  text: string;
  onEvent: (e: CompanionEvent) => void;
}

export class CompanionUnavailableError extends Error {
  reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

export async function startCompanionTurn(opts: StartCompanionTurnOptions): Promise<CompanionTurnHandle> {
  // 1. Confirm pair session online.
  const status = await fetchPairStatus(opts.pairSessionId);
  if (!status || status.status !== "claimed" || !status.online) {
    throw new CompanionUnavailableError(
      "companion_offline",
      "Codex Companion is not online. Run the npx command on your machine and wait for status to flip to Online.",
    );
  }
  if (!status.companionBaseUrl) {
    throw new CompanionUnavailableError("companion_no_url", "Companion did not report a base URL.");
  }
  if (!isLoopbackUrl(status.companionBaseUrl)) {
    // Companion is supposed to be loopback. If it isn't, refuse — even
    // though the server already validated this at claim time, defense
    // in depth.
    throw new CompanionUnavailableError(
      "non_loopback_companion",
      "Companion URL is not loopback; refusing to connect.",
    );
  }

  // 2. Issue run ticket.
  const ticketResp = await fetch("/api/codex/run-ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: opts.threadId,
      agentId: opts.agentId ?? null,
      providerMode: "codexChatGPTCompanion",
      pairSessionId: opts.pairSessionId,
    }),
  });
  if (!ticketResp.ok) {
    const j = await ticketResp.json().catch(() => ({}));
    throw new CompanionUnavailableError(
      "run_ticket_failed",
      `Could not issue run ticket: ${j.error || ticketResp.status}`,
    );
  }
  const ticketJson = await ticketResp.json();
  const runId: string = ticketJson?.payload?.runId;
  if (!runId) {
    throw new CompanionUnavailableError("run_ticket_invalid", "Run ticket response missing runId.");
  }

  // 3. Open WS to companion /turn.
  const wsUrl = httpToWs(status.companionBaseUrl) + "/turn";
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl);
  } catch (e: any) {
    throw new CompanionUnavailableError("ws_construct_failed", e?.message || "WS construct failed");
  }

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  let helloSent = false;

  ws.onopen = () => {
    if (helloSent) return;
    helloSent = true;
    ws.send(JSON.stringify({
      type: "hello",
      runTicket: ticketJson.encoded,
      input: { threadId: opts.threadId, text: opts.text },
    }));
    opts.onEvent({ type: "started", runId });
  };

  ws.onmessage = (ev) => {
    const data = typeof ev.data === "string" ? ev.data : "";
    if (!data) return;
    let msg: any;
    try { msg = JSON.parse(data); } catch { return; }

    // Map companion events → ChatView event shape.
    switch (msg.type) {
      case "thread_started":
        opts.onEvent({ type: "thread_started", codexThreadId: msg.codexThreadId });
        return;
      case "turn_started":
        opts.onEvent({ type: "turn_started", turnId: msg.turnId });
        return;
      case "approval_required":
        opts.onEvent({
          type: "approval_required",
          approvalId: msg.approvalId,
          method: msg.method,
          summary: msg.summary,
          detail: msg.detail,
          params: msg.params,
        });
        return;
      case "codex_event": {
        // Translate well-known codex notifications into the events
        // ChatView already renders.
        const m = msg.method;
        const p = msg.params;
        if (m === "item/agentMessage/delta" || m === "item/reasoning/textDelta") {
          if (typeof p?.delta === "string" && p.delta) {
            opts.onEvent({ type: "delta", text: p.delta });
          } else if (typeof p?.text === "string" && p.text) {
            opts.onEvent({ type: "delta", text: p.text });
          }
        } else if (m === "turn/completed") {
          opts.onEvent({ type: "turn_finished" });
        } else if (m === "item/started" && p?.itemType === "tool_call") {
          opts.onEvent({ type: "tool_use", id: p.itemId, name: p.toolName, input: p.arguments });
        } else if (m === "item/completed" && p?.itemType === "tool_call") {
          opts.onEvent({ type: "tool_result", id: p.itemId, output: typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "") });
        }
        // Always forward the raw event too so traces are complete.
        opts.onEvent({ type: "codex_event", method: m, params: p });
        return;
      }
      case "error":
        opts.onEvent({ type: "error", message: String(msg.message || "companion error") });
        return;
    }
  };

  ws.onerror = () => {
    opts.onEvent({ type: "error", message: "Companion WebSocket error" });
  };
  ws.onclose = () => {
    opts.onEvent({ type: "done", runId });
    resolveDone();
  };

  return {
    runId,
    approval(approvalId, decision) {
      try {
        ws.send(JSON.stringify({ type: "approval", approvalId, decision }));
      } catch {}
    },
    cancel() {
      try {
        ws.send(JSON.stringify({ type: "cancel" }));
      } catch {}
    },
    close() {
      try { ws.close(1000, "client_close"); } catch {}
    },
    done,
  };
}

// ─── helpers ──────────────────────────────────────────────────────────

async function fetchPairStatus(sessionId: string): Promise<any | null> {
  try {
    const r = await fetch(`/api/codex/pair/status?sessionId=${encodeURIComponent(sessionId)}`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function httpToWs(url: string): string {
  if (url.startsWith("https://")) return "wss://" + url.slice("https://".length);
  if (url.startsWith("http://")) return "ws://" + url.slice("http://".length);
  // Already ws/wss; trust as-is.
  return url;
}

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ws:" && u.protocol !== "wss:") return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}
