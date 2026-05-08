"use client";
// Wraps a thread in a Liveblocks RoomProvider so multiple users in the same
// thread see each other's presence (avatars, "X is typing", cursors).
//
// Uses the non-suspense API so we don't need Suspense boundaries everywhere.
// If LIVEBLOCKS public key isn't configured, renders children without a room
// — features degrade gracefully to single-user mode.

import { ReactNode } from "react";
import { LiveblocksProvider, RoomProvider } from "@liveblocks/react";

const PUBLIC_KEY = process.env.NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY;

export function LiveblocksRoom({ threadId, children }: { threadId: string; children: ReactNode }) {
  if (!PUBLIC_KEY) return <>{children}</>;
  return (
    <LiveblocksProvider authEndpoint="/api/liveblocks/auth">
      <RoomProvider id={`thread:${threadId}`} initialPresence={{ cursor: null, isTyping: false }}>
        {children}
      </RoomProvider>
    </LiveblocksProvider>
  );
}
