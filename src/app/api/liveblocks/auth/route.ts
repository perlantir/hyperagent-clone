// Liveblocks auth endpoint.
// Issues per-thread access tokens scoped to the current user's session.
// Called by the Liveblocks client before connecting to a room.
//
// Each thread becomes a Liveblocks "room" identified by `thread:<threadId>`.
// Users are only granted access to threads they own (via getThread which
// scopes by userId).

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getThread } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const secretKey = process.env.LIVEBLOCKS_SECRET_KEY;
  if (!secretKey) {
    return NextResponse.json({ error: "Liveblocks not configured on this deployment" }, { status: 503 });
  }

  const { room } = await req.json().catch(() => ({}));
  if (!room || typeof room !== "string" || !room.startsWith("thread:")) {
    return NextResponse.json({ error: "room must be a thread:<id> identifier" }, { status: 400 });
  }
  const threadId = room.slice("thread:".length);

  // Authorize: user must own this thread
  const thread = await getThread(threadId, user.id);
  if (!thread) return NextResponse.json({ error: "Thread not found or not yours" }, { status: 404 });

  // Issue a Liveblocks token via their REST API.
  // https://liveblocks.io/docs/api-reference/rest-api-endpoints#authorize-user
  const r = await fetch("https://api.liveblocks.io/v2/authorize-user", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      userId: user.id,
      userInfo: {
        name: user.name,
        email: user.email,
        // Color is derived from a hash of userId for stable per-user accents
        color: pickColor(user.id),
      },
      permissions: {
        [room]: ["room:write"],
      },
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    return NextResponse.json({ error: `Liveblocks auth failed: ${t.slice(0, 300)}` }, { status: 502 });
  }
  const j = await r.json();
  return NextResponse.json(j);
}

function pickColor(seed: string): string {
  const palette = ["#ef4444","#f97316","#eab308","#22c55e","#06b6d4","#3b82f6","#8b5cf6","#ec4899"];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}
