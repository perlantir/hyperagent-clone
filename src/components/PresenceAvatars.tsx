"use client";
// Stack of avatars showing who's currently in this thread.
// Reads from the Liveblocks room. Renders nothing when:
//   - Liveblocks isn't configured (no provider in tree)
//   - We haven't connected yet (self is null)
//   - There's only one user (self) — no point showing your own avatar alone

import { useOthers, useSelf } from "@liveblocks/react";

export function PresenceAvatars() {
  const others = useOthers();
  const self = useSelf();
  if (!self || others.length === 0) return null;

  const all = [self, ...others].slice(0, 4);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ display: "flex" }}>
        {all.map((u: any, i: number) => {
          const name = u.info?.name || "User";
          const color = u.info?.color || "#3b82f6";
          const initial = name.charAt(0).toUpperCase();
          return (
            <div key={u.connectionId || i}
              title={`${name}${u === self ? " (you)" : ""}`}
              style={{
                width: 24, height: 24, borderRadius: 12,
                background: color, color: "white",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, fontWeight: 600,
                marginLeft: i === 0 ? 0 : -6,
                border: "2px solid var(--bg)",
                boxShadow: "0 1px 2px rgba(0,0,0,.1)",
              }}>{initial}</div>
          );
        })}
      </div>
      {others.length > 0 && (
        <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
          {others.length === 1 ? "1 other here" : `${others.length} others here`}
        </span>
      )}
    </div>
  );
}
