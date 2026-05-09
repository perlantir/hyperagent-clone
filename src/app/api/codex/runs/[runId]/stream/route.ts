// P66d — GET /api/codex/runs/:runId/stream
//
// Server-Sent-Events stream of mirrored run events for the browser.
// The browser opens this when entering a thread that has an active
// run, OR when starting a new companion-mode run.
//
// Mechanics:
//   - On open, read all stored events for the run (from the user's
//     `Last-Event-ID` if provided, else from 0).
//   - Push them as SSE `data:` frames with `id:` set to the event row id.
//   - Then poll for new events every 600ms; push as they arrive.
//   - Stops when run.state in [completed, failed, cancelled] AND
//     all events have been pushed.
//
// This is intentionally NOT a true push channel — Vercel functions
// time out before that's useful. SSE + reasonable polling is the
// pragmatic shape for the alpha. The browser's reconnect-with-
// `Last-Event-ID` ensures continuity across the function-timeout
// boundary.

import { getCurrentUser } from "@/lib/auth";
import { enforceCsrfReadOnly } from "@/lib/codex/origin-guard";
import { getRun } from "@/lib/codex/runs-store";
import { listMirroredEvents } from "@/lib/codex/event-mirror";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel allows up to 800s on the Node runtime. We bound at 770 to
// give the browser time to reconnect cleanly before the function
// hard-stops.
export const maxDuration = 770;

const POLL_INTERVAL_MS = 600;
const RUN_TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

export async function GET(req: Request, { params }: { params: { runId: string } }) {
  const csrf = enforceCsrfReadOnly(req);
  if (csrf) return csrf;
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const run = await getRun({ runId: params.runId, userId: user.id });
  if (!run) return new Response("not_found", { status: 404 });

  const lastEventIdHeader = req.headers.get("last-event-id");
  let cursor = lastEventIdHeader ? Math.max(0, Number(lastEventIdHeader) || 0) : 0;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      const send = (id: number, eventType: string, data: any) => {
        const frame = `id: ${id}\nevent: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(frame));
      };

      // Initial snapshot: send a "snapshot" event with the run row.
      send(cursor, "snapshot", { run });

      let active = true;
      const tick = async (): Promise<void> => {
        if (!active) return;
        try {
          // Fetch any events newer than cursor.
          const events = await listMirroredEvents({
            userId: user.id,
            runId: params.runId,
            limit: 500,
          });
          const fresh = events.filter((e) => e.id > cursor);
          for (const ev of fresh) {
            send(ev.id, ev.eventType, {
              source: ev.source,
              sequence: ev.sequence,
              eventType: ev.eventType,
              emittedAt: ev.emittedAt,
              redactedPayload: ev.redactedPayload,
            });
            if (ev.id > cursor) cursor = ev.id;
          }
          // Re-read run row to detect terminal state.
          const cur = await getRun({ runId: params.runId, userId: user.id });
          if (cur && RUN_TERMINAL_STATES.has(cur.state)) {
            send(cursor, "run_state", { state: cur.state, endedAt: cur.endedAt });
            controller.close();
            active = false;
            return;
          }
        } catch (e: any) {
          // Best-effort poll. Surface a warn frame and keep going so
          // a transient DB blip doesn't kill the stream.
          send(cursor, "warn", { message: String(e?.message || e).slice(0, 200) });
        }
        if (active) setTimeout(tick, POLL_INTERVAL_MS);
      };

      // Heartbeat every 20s so long-lived SSE connections aren't
      // closed by intermediaries that idle-timeout silent streams.
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": heartbeat\n\n")); }
        catch { active = false; }
      }, 20_000);

      // Kick off the polling loop.
      setTimeout(tick, 50);

      // Clean up when the request aborts.
      req.signal.addEventListener("abort", () => {
        active = false;
        clearInterval(heartbeat);
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
