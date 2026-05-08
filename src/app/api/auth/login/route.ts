import { NextResponse } from "next/server";
import { getUserByEmail, verifyPassword } from "@/lib/db";
import { setSessionCookie } from "@/lib/auth";

export async function POST(req: Request) {
  const { email, password } = await req.json().catch(() => ({}));
  if (!email || !password) return NextResponse.json({ error: "email and password required" }, { status: 400 });
  const user = getUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }
  setSessionCookie(user.id);
  return NextResponse.json({ id: user.id, email: user.email, name: user.name });
}
