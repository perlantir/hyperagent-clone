"use client";
// Wraps a thread in a Liveblocks RoomProvider so multiple users in the same
// thread see each other's presence (cursor, "X is typing", avatars).
//
// If LIVEBLOCKS public key isn't configured, the component renders children
// without a room — features degrade gracefully to "single-user mode".

import { ReactNode } from "react";
import { LiveblocksProvider, RoomProvider } from "@liveblocks/react/suspense";

const PUBLIC_KEY = process.env.NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY;

export function LiveblocksRoom({ threadId, children }: { threadId: string; children: ReactNode }) {
  // Fail open: if not configured, just render the children. Real-time features
  // (presence, cursors) won't work but the rest of the app does.
  if (!PUBLIC_KEY) return <>{children}</>;

  return (
    <LiveblocksProvider authEndpoint="/api/liveblocks/auth">
      <RoomProvider id={`thread:${threadId}`} initialPresence={{ cursor: null, isTyping: false }}>
        {children}
      </RoomProvider>
    </LiveblocksProvider>
  );
}
