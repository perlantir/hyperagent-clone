// DELETE /api/settings/secrets/{provider} — remove a saved key.
// After deletion the user reverts to whatever platform default exists.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { deleteUserSecret, SECRET_PROVIDERS, type SecretProvider } from "@/lib/secrets";

export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: { provider: string } }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!SECRET_PROVIDERS.includes(params.provider as any)) {
    return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  }
  await deleteUserSecret(user.id, params.provider as SecretProvider);
  return NextResponse.json({ ok: true });
}
