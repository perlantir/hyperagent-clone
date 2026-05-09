// P65 — run ticket signature + verification tests.

let failed = 0;
function pass(label: string, cond: boolean, detail?: string) {
  if (!cond) { console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
  else console.log("PASS:", label);
}

import {
  issueRunTicket, verifyRunTicket, encodeRunTicket, decodeRunTicket,
  RUN_TICKET_TTL_MS, setRunTicketKeyForTest,
} from "../codex/run-ticket";

(async () => {
  // Pin the signing key so all tests in this file are reproducible.
  setRunTicketKeyForTest("p65-test-secret-please-do-not-use-in-prod");

  // ─── basic issue + verify ─────────────────────────────────────────
  {
    const { ticket, payload } = issueRunTicket({
      userId: "u1",
      threadId: "t1",
      providerMode: "codexChatGPTCompanion",
      pairSessionId: "ses_abc",
    });
    pass("ticket payload + sig populated",
      typeof ticket.payload === "string" && typeof ticket.sig === "string");
    pass("payload carries runId",
      typeof payload.runId === "string" && payload.runId.startsWith("run_"));
    pass("payload carries pairSessionId",
      payload.pairSessionId === "ses_abc");
    pass("companion mode defaults budgetEnforcement = advisory",
      payload.budgetEnforcement === "advisory");
    pass("expiresAt in TTL window",
      payload.expiresAt > Date.now() && payload.expiresAt <= Date.now() + RUN_TICKET_TTL_MS + 100);

    const v = verifyRunTicket(ticket);
    pass("verify accepts our own ticket", v.ok === true);
    if (v.ok) {
      pass("verified payload.runId matches", v.payload.runId === payload.runId);
      pass("verified payload.userId matches", v.payload.userId === "u1");
    }
  }

  // ─── tampered payload fails verification ──────────────────────────
  {
    const { ticket } = issueRunTicket({
      userId: "u1", threadId: "t1", providerMode: "codexChatGPTCompanion",
    });
    // Flip last char of payload (still valid base64 char, breaks JSON
    // body OR signature).
    const tampered = {
      payload: ticket.payload.slice(0, -1) + (ticket.payload.endsWith("A") ? "B" : "A"),
      sig: ticket.sig,
    };
    const v = verifyRunTicket(tampered);
    pass("tampered payload fails verification",
      v.ok === false);
  }

  // ─── tampered signature fails ──────────────────────────────────────
  {
    const { ticket } = issueRunTicket({ userId: "u1", threadId: "t1", providerMode: "codexChatGPTCompanion" });
    const tampered = { payload: ticket.payload, sig: ticket.sig.slice(0, -2) + "XX" };
    const v = verifyRunTicket(tampered);
    pass("tampered signature fails verification",
      v.ok === false && v.reason !== undefined);
  }

  // ─── different signing key produces non-verifying tickets ─────────
  {
    const { ticket } = issueRunTicket({ userId: "u1", threadId: "t1", providerMode: "codexChatGPTCompanion" });
    setRunTicketKeyForTest("a-different-secret");
    const v = verifyRunTicket(ticket);
    pass("ticket signed with old key fails after key rotation",
      v.ok === false);
    // Restore for remaining tests.
    setRunTicketKeyForTest("p65-test-secret-please-do-not-use-in-prod");
  }

  // ─── expiry ─────────────────────────────────────────────────────────
  {
    const { ticket } = issueRunTicket({
      userId: "u1", threadId: "t1", providerMode: "codexChatGPTCompanion",
      ttlMs: 1, // 1 ms TTL
    });
    await new Promise(r => setTimeout(r, 5));
    const v = verifyRunTicket(ticket);
    pass("expired ticket fails with reason=expired",
      v.ok === false && (v as any).reason === "expired");
  }

  // ─── encode / decode round-trip ───────────────────────────────────
  {
    const { ticket } = issueRunTicket({ userId: "u1", threadId: "t1", providerMode: "codexChatGPTCompanion" });
    const encoded = encodeRunTicket(ticket);
    pass("encode produces single dot-joined string",
      typeof encoded === "string" && encoded.split(".").length === 2);
    const decoded = decodeRunTicket(encoded);
    pass("decode round-trips exactly",
      decoded?.payload === ticket.payload && decoded?.sig === ticket.sig);
    pass("decode rejects malformed string",
      decodeRunTicket("no-dot") === null && decodeRunTicket(".") === null);
  }

  // ─── approval policy carried through ──────────────────────────────
  {
    const { ticket, payload } = issueRunTicket({
      userId: "u1", threadId: "t1", providerMode: "codexChatGPTCompanion",
      approvalPolicy: { require: ["command", "file"], autoApprove: ["tool"] },
    });
    pass("approval policy require carried in payload",
      JSON.stringify(payload.approvalPolicy.require) === JSON.stringify(["command", "file"]));
    pass("approval policy autoApprove carried in payload",
      JSON.stringify(payload.approvalPolicy.autoApprove) === JSON.stringify(["tool"]));
    const v = verifyRunTicket(ticket);
    pass("verified approval policy survives signature",
      v.ok === true && JSON.stringify((v as any).payload.approvalPolicy.require) === JSON.stringify(["command", "file"]));
  }

  // ─── nonce uniqueness ─────────────────────────────────────────────
  {
    const a = issueRunTicket({ userId: "u1", threadId: "t1", providerMode: "codexChatGPTCompanion" });
    const b = issueRunTicket({ userId: "u1", threadId: "t1", providerMode: "codexChatGPTCompanion" });
    pass("two tickets with same inputs have different runIds",
      a.payload.runId !== b.payload.runId);
    pass("two tickets with same inputs have different nonces",
      a.payload.nonce !== b.payload.nonce);
    pass("their signatures differ (no replay)",
      a.ticket.sig !== b.ticket.sig);
  }

  // ─── traceTarget defaults to /api/codex/events ────────────────────
  {
    const { payload } = issueRunTicket({ userId: "u1", threadId: "t1", providerMode: "codexChatGPTCompanion" });
    pass("traceTarget defaults to /api/codex/events",
      payload.traceTarget === "/api/codex/events");
  }

  if (failed > 0) {
    console.error(`\n${failed} run-ticket test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll codex-run-ticket tests passed");
})();
