// event-mirror.js — companion → hosted /api/codex/events. Buffers
// events with a simple in-memory queue, retries on transient errors,
// and gives up after a few attempts so a flaky network doesn't hang
// the run loop.

const { redact } = require("./redact.js");

class EventMirror {
  constructor({ host, runTicket, runId, log, source = "companion" }) {
    this.host = host.replace(/\/+$/, "");
    this.runTicket = runTicket; // encoded "<payload>.<sig>"
    this.runId = runId;
    this.log = log || (() => {});
    this.source = source;
    this.queue = [];
    this.flushing = false;
    this.sequence = 0;
    this.flushTimer = null;
  }

  push({ source, eventType, payload, idempotencyKey }) {
    const seq = this.sequence++;
    const event = {
      source: source || this.source,
      sequence: seq,
      eventType,
      emittedAt: Date.now(),
      idempotencyKey: idempotencyKey || `${source || this.source}-${seq}-${eventType}`,
      payload: redact(payload),
    };
    this.queue.push(event);
    if (process.env.HYPERAGENT_COMPANION_DEBUG) {
      try { process.stderr.write(`[mirror.push] ${eventType} (queue=${this.queue.length})\n`); } catch {}
    }
    this._scheduleFlush();
  }

  _scheduleFlush() {
    if (this.flushTimer || this.flushing) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (process.env.HYPERAGENT_COMPANION_DEBUG) {
        try { process.stderr.write(`[mirror.flush] firing (queue=${this.queue.length}) host=${this.host}\n`); } catch {}
      }
      this._flush().catch((e) => {
        if (process.env.HYPERAGENT_COMPANION_DEBUG) {
          try { process.stderr.write(`[mirror.flush] err: ${(e && e.message) || e}\n`); } catch {}
        }
      });
    }, 250);
  }

  async _flush() {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, Math.min(this.queue.length, 50));
    let attempt = 0;
    let lastErr = null;
    while (attempt < 3) {
      attempt++;
      try {
        // We use the global fetch (Node 18+).
        if (process.env.HYPERAGENT_COMPANION_DEBUG) {
          try { process.stderr.write(`[mirror._flush] attempt ${attempt} POST ${this.host}/api/codex/events with ${batch.length} events\n`); } catch {}
        }
        const res = await fetch(`${this.host}/api/codex/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticket: this.runTicket, events: batch }),
        });
        if (process.env.HYPERAGENT_COMPANION_DEBUG) {
          try { process.stderr.write(`[mirror._flush] got status ${res.status}\n`); } catch {}
        }
        if (res.ok) {
          this.flushing = false;
          if (this.queue.length > 0) this._scheduleFlush();
          return;
        }
        const txt = await res.text().catch(() => "");
        lastErr = `HTTP ${res.status}: ${txt.slice(0, 200)}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          // Permanent error; drop the batch (logging only counts).
          this.log(`mirror dropped batch (${batch.length}) at ${this.host}/api/codex/events: ${lastErr}`);
          this.flushing = false;
          if (this.queue.length > 0) this._scheduleFlush();
          return;
        }
      } catch (e) {
        lastErr = String((e && e.message) || e);
        // Network blip; retry.
      }
      await sleep(500 * attempt);
    }
    this.log(`mirror flush failed after retries; dropping ${batch.length} events. lastErr=${lastErr}`);
    this.flushing = false;
    if (this.queue.length > 0) this._scheduleFlush();
  }

  async drain() {
    while (this.queue.length > 0 || this.flushing) {
      await sleep(50);
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { EventMirror };
