"use client";
// Wraps a thread in a Liveblocks RoomProvider so multiple users in the same
// thread see each other's presence (avatars, "X is typing", cursors).
//
// Uses the non-suspense API so we don't need Suspense boundaries everywhere.
// If LIVEBLOCKS public key isn't configured, the room is skipped AND any
// child components reading liveblocks hooks (PresenceAvatars, etc.) need
// to short-circuit on the `useLiveblocksEnabled()` flag we publish via
// React context. Without that signal, hooks like `useOthers()` would
// throw "RoomProvider is missing from the React tree" the moment they
// run on a page where Liveblocks isn't configured.

import { ReactNode, createContext, useContext } from "react";
import { LiveblocksProvider, RoomProvider } from "@liveblocks/react";

const PUBLIC_KEY = process.env.NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY;

const LiveblocksEnabledContext = createContext(false);

/**
 * Read whether Liveblocks is actually mounted in this subtree. Components
 * that call `useOthers` / `useSelf` MUST guard their render on this; the
 * Liveblocks hooks throw when no RoomProvider is in the tree.
 */
export function useLiveblocksEnabled(): boolean {
  return useContext(LiveblocksEnabledContext);
}

export function LiveblocksRoom({ threadId, children }: { threadId: string; children: ReactNode }) {
  if (!PUBLIC_KEY) {
    // Publish enabled=false so guarded children skip the hook entirely.
    return (
      <LiveblocksEnabledContext.Provider value={false}>
        {children}
      </LiveblocksEnabledContext.Provider>
    );
  }
  return (
    <LiveblocksEnabledContext.Provider value={true}>
      <LiveblocksProvider authEndpoint="/api/liveblocks/auth">
        <RoomProvider id={`thread:${threadId}`} initialPresence={{ cursor: null, isTyping: false }}>
          {children}
        </RoomProvider>
      </LiveblocksProvider>
    </LiveblocksEnabledContext.Provider>
  );
}
