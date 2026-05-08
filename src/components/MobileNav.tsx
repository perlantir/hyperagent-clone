"use client";
import { useEffect, useState } from "react";

// Mobile drawer wrapper. On screens <900px, hides the sidebar by default and
// exposes a hamburger button. The sidebar slides in from the left when toggled.

export function MobileNav({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 900);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Auto-close on route navigate
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("popstate", close);
    return () => window.removeEventListener("popstate", close);
  }, []);

  if (!isMobile) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        style={{
          position: "fixed", top: 12, left: 12, zIndex: 60,
          width: 36, height: 36, borderRadius: 8,
          background: "var(--bg-elev)", border: "1px solid var(--border)",
          display: "grid", placeItems: "center", fontSize: 18,
        }}
      >☰</button>

      {open && (
        <div onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 70, backdropFilter: "blur(2px)" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ position: "absolute", top: 0, left: 0, height: "100vh", width: "min(280px, 80vw)", background: "var(--bg)", borderRight: "1px solid var(--border)", overflowY: "auto" }}>
            {children}
          </div>
        </div>
      )}
    </>
  );
}
