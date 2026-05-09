"use client";
// P30 — Skeleton loaders.
//
// Replace the bare "Loading…" text strings scattered across the app with
// shape-matched placeholders. Three primitives:
//   - <Skeleton/>: a single shimmering bar (configurable width/height)
//   - <SkeletonCard/>: a card-shaped block with title + 2 body lines
//   - <SkeletonRow/>: a row inside a list/table (icon + 2 cols + meta)
//
// Animation is a CSS keyframe to keep dependencies zero. The shimmer uses
// a subtle gradient that respects light/dark themes via CSS vars.

import React from "react";

const SHIMMER_STYLE: React.CSSProperties = {
  background: "linear-gradient(90deg, var(--bg-subtle) 0%, var(--border) 50%, var(--bg-subtle) 100%)",
  backgroundSize: "200% 100%",
  borderRadius: 4,
  animation: "skeleton-shimmer 1.4s ease-in-out infinite",
};

export function Skeleton({
  width = "100%",
  height = 12,
  style,
}: { width?: string | number; height?: string | number; style?: React.CSSProperties }) {
  return <div style={{ ...SHIMMER_STYLE, width, height, ...style }} />;
}

export function SkeletonCard({ height = 88 }: { height?: number }) {
  return (
    <div className="card" style={{ padding: 14, height }}>
      <Skeleton width={70} height={9} style={{ marginBottom: 10 }} />
      <Skeleton width="55%" height={20} style={{ marginBottom: 8 }} />
      <Skeleton width="38%" height={9} />
    </div>
  );
}

export function SkeletonRow({ cols = 4 }: { cols?: number }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `1.4fr ${"60px ".repeat(Math.max(0, cols - 1)).trim()}`,
      gap: 12,
      padding: "12px 14px",
      alignItems: "center",
      borderTop: "1px solid var(--border)",
    }}>
      <Skeleton width="65%" height={14} />
      {Array.from({ length: cols - 1 }).map((_, i) => (
        <Skeleton key={i} width={i === cols - 2 ? 40 : 50} height={12} />
      ))}
    </div>
  );
}

// Stat-card grid loader matching /costs and /traces/[id] layout.
export function SkeletonStatGrid({ count = 6, minW = 140 }: { count?: number; minW?: number }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `repeat(auto-fit, minmax(${minW}px, 1fr))`,
      gap: 12,
    }}>
      {Array.from({ length: count }).map((_, i) => <SkeletonCard key={i} />)}
    </div>
  );
}

// Inject the keyframe globally — does nothing on subsequent renders due to
// browser dedup. Cheap to repeat.
export function SkeletonStyles() {
  return <style>{`@keyframes skeleton-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>;
}
