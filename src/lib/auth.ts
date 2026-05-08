import { cookies } from "next/headers";
import { getSessionUser, createSession } from "./db";
import type { User } from "./types";

export const SESSION_COOKIE = "hyperagent_session";

export async function getCurrentUser(): Promise<User | null> {
  const c = cookies().get(SESSION_COOKIE);
  if (!c?.value) return null;
  return await getSessionUser(c.value);
}

export async function requireUser(): Promise<User> {
  const u = await getCurrentUser();
  if (!u) throw new Response("Unauthorized", { status: 401 });
  return u;
}

export async function setSessionCookie(userId: string) {
  const sid = await createSession(userId);
  cookies().set(SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearSessionCookie() {
  cookies().delete(SESSION_COOKIE);
}
