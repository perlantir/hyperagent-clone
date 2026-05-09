// P65 — Internal helpers used by /api/codex/pair/claim. Kept out of
// pair-store.ts to make the pair-store public surface minimal. The
// only reason this exists is that claimPairSession needs the userId
// for its constant-time scoping check, but the companion only knows
// the pair-code. We lookup userId here and pass it through.
//
// SECURITY: this lookup intentionally does NOT prove the caller's
// identity — pair-code entropy is the auth signal. We never log the
// pair-code or the resolved userId.

import { createHash } from "node:crypto";
import { pool } from "../db";
import { ensurePairingSchema } from "./pair-store";

export async function findUserIdByPairCode(pairCode: string): Promise<string | null> {
  await ensurePairingSchema();
  const codeHash = createHash("sha256").update(pairCode, "utf8").digest("hex");
  const r = await pool().query(
    `SELECT "userId" FROM codex_pair_sessions
      WHERE "pairCodeHash" = $1
      ORDER BY "createdAt" DESC
      LIMIT 1`,
    [codeHash],
  );
  return r.rows[0]?.userId ?? null;
}
