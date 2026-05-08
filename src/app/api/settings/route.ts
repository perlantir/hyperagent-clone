// User settings: preferred model, theme, etc.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { MODELS } from "@/lib/models";
import { getPrefs, setPrefs } from "@/lib/preferences";
import { DEFAULT_MODEL_ID } from "@/lib/models";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const prefs = await getPrefs(user.id);
  return NextResponse.json({
    preferences: {
      modelId: prefs.modelId || DEFAULT_MODEL_ID,
      theme: prefs.theme || "light",
      ...prefs,
    },
    models: MODELS,
  });
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  await setPrefs(user.id, body);
  return NextResponse.json({ ok: true });
}
