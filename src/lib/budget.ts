// P27a — Budget Ledger v0.
//
// Per-run credit accounting with reserve-before-dispatch semantics. Sits on
// top of the existing trace_runs table — no separate tables. Two scenarios:
//
//   1. Chat turns / scheduled runs / v1 API calls: each run gets a budget cap
//      (e.g. 5000 credits = ~$5). After each LLM call we charge the run; if
//      we'd exceed cap on the next iteration, the chat loop breaks early.
//
//   2. Subagent dispatch (P24): parent reserves a slice of its budget for
//      each child. Reservations are atomic ("can I afford this?") and
//      either commit (subagent succeeded, charge actual cost) or rollback
//      (subagent failed/cancelled, refund the reservation).
//
// All functions emit corresponding trace events when called from a chat
// route — the caller passes the TraceEmitter and we route events through it.
//
// Hard caps prevent the runaway-cost case where a buggy agent calls 50
// expensive tools or recurses forever via dispatch_agent. The default per-
// run cap is conservative; agent owners can raise it via agents.maxRunBudgetCredits.

import crypto from "node:crypto";
import { pool } from "./db";

// Defaults in credits (1 credit ≈ $0.001)
export const DEFAULT_CHAT_TURN_BUDGET = 5000;       // ~$5
export const DEFAULT_SCHEDULED_RUN_BUDGET = 5000;
export const DEFAULT_V1_CALL_BUDGET = 5000;
export const DEFAULT_SUBAGENT_BUDGET = 2000;
export const DEFAULT_SLACK_INBOUND_BUDGET = 3000;

export interface BudgetState {
  cap: number;
  spent: number;
  reserved: number;
  remaining: number;
  overCap: boolean;
}

let _initialized = false;

async function ensureSchema() {
  if (_initialized) return;
  // Add budget columns to trace_runs if missing. Column adds are idempotent.
  await pool().query(`
    ALTER TABLE trace_runs ADD COLUMN IF NOT EXISTS "budgetCapCredits" BIGINT;
    ALTER TABLE trace_runs ADD COLUMN IF NOT EXISTS "spentCredits" BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE trace_runs ADD COLUMN IF NOT EXISTS "reservedCredits" BIGINT NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS budget_reservations (
      id TEXT PRIMARY KEY,
      "parentRunId" TEXT NOT NULL REFERENCES trace_runs(id) ON DELETE CASCADE,
      "childRunId" TEXT REFERENCES trace_runs(id) ON DELETE SET NULL,
      "amountCredits" BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'committed' | 'rolled_back'
      "createdAt" BIGINT NOT NULL,
      "resolvedAt" BIGINT,
      "actualCostCredits" BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_budget_res_parent ON budget_reservations("parentRunId");
  `);
  _initialized = true;
}

// Set the budget cap for a run. Called once at startRun (or directly via
// startRun's budgetCapCredits param). Idempotent — re-setting overwrites.
export async function setBudgetCap(runId: string, cap: number): Promise<void> {
  await ensureSchema();
  await pool().query(
    `UPDATE trace_runs SET "budgetCapCredits"=$2 WHERE id=$1`,
    [runId, cap],
  );
}

// Charge an amount against the run's spent_credits. Increments atomically.
export async function chargeRunBudget(runId: string, credits: number): Promise<void> {
  if (credits <= 0) return;
  await ensureSchema();
  await pool().query(
    `UPDATE trace_runs SET "spentCredits" = "spentCredits" + $2 WHERE id=$1`,
    [runId, credits],
  );
}

// Read budget state. Used by isOverBudget and surfacing to UI/traces.
export async function getBudgetState(runId: string): Promise<BudgetState | null> {
  await ensureSchema();
  const r = await pool().query(
    `SELECT "budgetCapCredits", "spentCredits", "reservedCredits"
     FROM trace_runs WHERE id=$1`,
    [runId],
  );
  if (!r.rows[0]) return null;
  const cap = Number(r.rows[0].budgetCapCredits || Infinity);
  const spent = Number(r.rows[0].spentCredits || 0);
  const reserved = Number(r.rows[0].reservedCredits || 0);
  return {
    cap, spent, reserved,
    remaining: Math.max(0, cap - spent - reserved),
    overCap: spent + reserved >= cap,
  };
}

// Quick check used by chat loops. Returns true when no further work should
// be issued because spent + reserved would exceed cap.
export async function isOverBudget(runId: string, addCredits = 0): Promise<boolean> {
  const state = await getBudgetState(runId);
  if (!state) return false; // no cap = no constraint
  return state.spent + state.reserved + addCredits > state.cap;
}

// =================== RESERVATIONS (for subagent dispatch, P24) ===================
//
// reserveBudget atomically: checks parent has remaining ≥ amount, increments
// reserved on parent, returns reservation id. Subsequent commit converts it
// to spent on the child run; rollback refunds.
//
// Race-safe via row lock: SELECT FOR UPDATE inside a transaction.

export async function reserveBudget(
  parentRunId: string,
  amountCredits: number,
): Promise<{ ok: boolean; reservationId?: string; reason?: string }> {
  await ensureSchema();
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    const r = await c.query(
      `SELECT "budgetCapCredits", "spentCredits", "reservedCredits"
       FROM trace_runs WHERE id=$1 FOR UPDATE`,
      [parentRunId],
    );
    const row = r.rows[0];
    if (!row) {
      await c.query("ROLLBACK");
      return { ok: false, reason: "run not found" };
    }
    const cap = Number(row.budgetCapCredits || Infinity);
    const spent = Number(row.spentCredits || 0);
    const reserved = Number(row.reservedCredits || 0);
    if (spent + reserved + amountCredits > cap) {
      await c.query("ROLLBACK");
      return { ok: false, reason: `would exceed cap (${spent}+${reserved}+${amountCredits} > ${cap})` };
    }
    await c.query(
      `UPDATE trace_runs SET "reservedCredits" = "reservedCredits" + $2 WHERE id=$1`,
      [parentRunId, amountCredits],
    );
    const reservationId = "res_" + crypto.randomBytes(8).toString("hex");
    await c.query(
      `INSERT INTO budget_reservations (id, "parentRunId", "amountCredits", status, "createdAt")
       VALUES ($1, $2, $3, 'pending', $4)`,
      [reservationId, parentRunId, amountCredits, Date.now()],
    );
    await c.query("COMMIT");
    return { ok: true, reservationId };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

// Commit a reservation: convert pending reserved → spent on parent, mark
// reservation completed. actualCost can be less than reserved (refund the
// difference back to remaining).
export async function commitReservation(
  reservationId: string,
  actualCostCredits: number,
  childRunId?: string,
): Promise<void> {
  await ensureSchema();
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    const r = await c.query(
      `SELECT "parentRunId", "amountCredits", status
       FROM budget_reservations WHERE id=$1 FOR UPDATE`,
      [reservationId],
    );
    const row = r.rows[0];
    if (!row || row.status !== "pending") {
      await c.query("ROLLBACK");
      return;
    }
    const reserved = Number(row.amountCredits);
    await c.query(
      `UPDATE trace_runs
       SET "reservedCredits" = "reservedCredits" - $2,
           "spentCredits" = "spentCredits" + $3
       WHERE id=$1`,
      [row.parentRunId, reserved, actualCostCredits],
    );
    await c.query(
      `UPDATE budget_reservations
       SET status='committed', "resolvedAt"=$2, "actualCostCredits"=$3, "childRunId"=$4
       WHERE id=$1`,
      [reservationId, Date.now(), actualCostCredits, childRunId || null],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

// Rollback a reservation: refund the reserved amount back to parent's remaining.
export async function rollbackReservation(reservationId: string): Promise<void> {
  await ensureSchema();
  const c = await pool().connect();
  try {
    await c.query("BEGIN");
    const r = await c.query(
      `SELECT "parentRunId", "amountCredits", status
       FROM budget_reservations WHERE id=$1 FOR UPDATE`,
      [reservationId],
    );
    const row = r.rows[0];
    if (!row || row.status !== "pending") {
      await c.query("ROLLBACK");
      return;
    }
    await c.query(
      `UPDATE trace_runs SET "reservedCredits" = "reservedCredits" - $2 WHERE id=$1`,
      [row.parentRunId, Number(row.amountCredits)],
    );
    await c.query(
      `UPDATE budget_reservations SET status='rolled_back', "resolvedAt"=$2 WHERE id=$1`,
      [reservationId, Date.now()],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
