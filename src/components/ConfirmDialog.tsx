"use client";
// P30 — Promisified confirm dialog.
//
// Replaces the browser-native confirm() with a styled modal that:
//   - returns a Promise<boolean>
//   - supports a destructive variant (red confirm button)
//   - traps Escape (cancel) and Enter (confirm)
//   - blocks scroll while open
//
// Usage: const ok = await confirm({ title: "...", body: "..." });
// The hook useConfirm() is the React-friendly entry point. The singleton
// `confirm()` export is the escape hatch for non-React code.

import { createContext, useContext, useState, useCallback, useEffect } from "react";

interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
}

type Resolver = (ok: boolean) => void;

const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  return ctx || globalConfirm;
}

let globalConfirm: (opts: ConfirmOptions) => Promise<boolean> = async () => false;

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [resolver, setResolver] = useState<Resolver | null>(null);

  const ask = useCallback((o: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>(resolve => {
      setOpts(o);
      setResolver(() => resolve);
    });
  }, []);

  useEffect(() => {
    globalConfirm = ask;
    return () => { globalConfirm = async () => false; };
  }, [ask]);

  function close(ok: boolean) {
    if (resolver) resolver(ok);
    setOpts(null);
    setResolver(null);
  }

  // Escape / Enter handling
  useEffect(() => {
    if (!opts) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      else if (e.key === "Enter") { e.preventDefault(); close(true); }
    }
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts]);

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {opts && (
        <div onClick={() => close(false)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
          display: "grid", placeItems: "center", zIndex: 250,
          backdropFilter: "blur(4px)",
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            width: "min(440px, 92vw)", background: "var(--bg-elev)",
            border: "1px solid var(--border)", borderRadius: 12,
            boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
            padding: 24,
            animation: "confirm-pop-in 0.16s ease-out",
          }}>
            <h2 className="h-display" style={{ fontSize: 22, marginBottom: 8 }}>{opts.title}</h2>
            {opts.body && (
              <div style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.55, marginBottom: 20 }}>
                {opts.body}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => close(false)}
                style={{ padding: "8px 16px" }}>
                {opts.cancelLabel || "Cancel"}
              </button>
              <button
                className={opts.variant === "destructive" ? "btn" : "btn btn-primary"}
                onClick={() => close(true)}
                style={{
                  padding: "8px 16px",
                  ...(opts.variant === "destructive" ? {
                    background: "#dc2626", color: "white", borderColor: "#dc2626",
                  } : {}),
                }}>
                {opts.confirmLabel || "Confirm"}
              </button>
            </div>
          </div>
          <style>{`@keyframes confirm-pop-in { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }`}</style>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
