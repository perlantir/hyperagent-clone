// Per-user API key management (P19+).
//   GET  /api/settings/secrets         → presence map (which providers user has set, or fall back to platform)
//   POST /api/settings/secrets         → save a key. Body: { provider, value }

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  listUserSecretPresence,
  setUserSecret,
  SECRET_PROVIDERS,
  PROVIDER_META,
  type SecretProvider,
} from "@/lib/secrets";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const presence = await listUserSecretPresence(user.id);
  return NextResponse.json({
    secrets: presence,
    providers: SECRET_PROVIDERS.map(id => ({ id, ...PROVIDER_META[id] })),
  });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { provider, value } = await req.json().catch(() => ({}));
  if (!SECRET_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  }
  if (typeof value !== "string" || value.trim().length < 4) {
    return NextResponse.json({ error: "value too short" }, { status: 400 });
  }
  await setUserSecret(user.id, provider as SecretProvider, value.trim());
  return NextResponse.json({ ok: true });
}
