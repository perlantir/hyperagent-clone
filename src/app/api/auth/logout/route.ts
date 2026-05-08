import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { destroySession } from "@/lib/db";
import { SESSION_COOKIE, clearSessionCookie } from "@/lib/auth";

export async function POST() {
  const c = cookies().get(SESSION_COOKIE);
  if (c?.value) destroySession(c.value);
  clearSessionCookie();
  return NextResponse.json({ ok: true });
}
