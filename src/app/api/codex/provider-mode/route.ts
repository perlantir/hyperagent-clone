// P57 — Codex provider-mode read/write.
//
//   GET  /api/codex/provider-mode → { mode: "openaiApiKey" | "openaiUserApiKey" | "codexChatGPT" }
//   POST /api/codex/provider-mode  Body: { mode }
//
// Provider mode selection is ALWAYS explicit. We reject any payload that
// doesn't match the enum. We do not silently fall back between modes.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getProviderMode, setProviderMode } from "@/lib/codex/store";
import { CODEX_PROVIDER_MODES } from "@/lib/codex/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const mode = await getProviderMode(user.id);
  return NextResponse.json({ mode });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!CODEX_PROVIDER_MODES.includes(body?.mode)) {
    return NextResponse.json(
      { error: `mode must be one of: ${CODEX_PROVIDER_MODES.join(", ")}` },
      { status: 400 },
    );
  }
  await setProviderMode(user.id, body.mode);
  return NextResponse.json({ ok: true, mode: body.mode });
}
