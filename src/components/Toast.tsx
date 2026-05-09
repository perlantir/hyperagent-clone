"use client";
// P30 — Toast notifications.
//
// Replaces the scattered alert() calls with a styled toast that:
//   - stacks (multiple visible at once)
//   - auto-dismisses on a per-toast timeout (default 4s)
//   - dismissible by click
//   - exposes a singleton API via window.__hyperToast so non-React modules
//     can fire toasts without prop-drilling. The hook useToast() is the
//     React-friendly way; the singleton is the escape hatch.
//
// Design: a stack docked bottom-right. Variant colors map to the existing
// CSS vars (accent / green / red / muted). Icons are unicode glyphs to
// stay consistent with the rest of the app.

import { useEffect, useState, createContext, useContext, useCallback, useRef } from "react";

export type ToastVariant = "info" | "success" | "error" | "warning";
export interface Toast {
  id: string;
  variant: ToastVariant;
  message: string;
  description?: string;
  durationMs?: number;
}

interface ToastContextValue {
  toast: (t: Omit<Toast, "id">) => void;
  success: (message: string, description?: string) => void;
  error: (message: string, description?: string) => void;
  info: (message: string, description?: string) => void;
  warning: (message: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx;
  // Fallback to the global singleton (works outside the provider tree —
  // e.g. non-React code calling toast.error() directly).
  return {
    toast: (t) => globalToast(t),
    success: (m, d) => globalToast({ variant: "success", message: m, description: d }),
    error:   (m, d) => globalToast({ variant: "error",   message: m, description: d }),
    info:    (m, d) => globalToast({ variant: "info",    message: m, description: d }),
    warning: (m, d) => globalToast({ variant: "warning", message: m, description: d }),
  };
}

// Singleton fallback — set by the provider on mount, cleared on unmount.
let globalToast: (t: Omit<Toast, "id">) => void = () => {};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts(t => t.filter(x => x.id !== id));
    const tm = timers.current.get(id);
    if (tm) { clearTimeout(tm); timers.current.delete(id); }
  }, []);

  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const toast: Toast = { id, durationMs: 4000, ...t };
    setToasts(prev => [...prev, toast]);
    const tm = setTimeout(() => dismiss(id), toast.durationMs);
    timers.current.set(id, tm);
  }, [dismiss]);

  useEffect(() => {
    globalToast = push;
    return () => { globalToast = () => {}; };
  }, [push]);

  // Cleanup all timers on unmount.
  useEffect(() => {
    return () => { timers.current.forEach(t => clearTimeout(t)); timers.current.clear(); };
  }, []);

  const value: ToastContextValue = {
    toast: push,
    success: (m, d) => push({ variant: "success", message: m, description: d }),
    error:   (m, d) => push({ variant: "error",   message: m, description: d }),
    info:    (m, d) => push({ variant: "info",    message: m, description: d }),
    warning: (m, d) => push({ variant: "warning", message: m, description: d }),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

const VARIANT_STYLES: Record<ToastVariant, { bg: string; fg: string; icon: string; border: string }> = {
  info:    { bg: "var(--bg-elev)", fg: "var(--text)", border: "var(--border-strong)", icon: "ⓘ" },
  success: { bg: "var(--bg-elev)", fg: "var(--green)", border: "var(--green)", icon: "✓" },
  error:   { bg: "var(--bg-elev)", fg: "#dc2626", border: "#dc2626", icon: "✕" },
  warning: { bg: "var(--bg-elev)", fg: "#d97706", border: "#d97706", icon: "⚠" },
};

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div style={{
      position: "fixed", bottom: 20, right: 20, zIndex: 300,
      display: "flex", flexDirection: "column", gap: 8,
      pointerEvents: "none",
    }}>
      {toasts.map(t => {
        const v = VARIANT_STYLES[t.variant];
        return (
          <button key={t.id} onClick={() => onDismiss(t.id)}
            style={{
              pointerEvents: "auto",
              minWidth: 280, maxWidth: 420,
              padding: "12px 14px",
              background: v.bg, color: "var(--text)",
              border: `1px solid ${v.border}`,
              borderLeftWidth: 3,
              borderRadius: 8,
              boxShadow: "0 4px 16px rgba(28,25,23,0.10)",
              display: "flex", alignItems: "flex-start", gap: 10,
              fontSize: 13, lineHeight: 1.4,
              textAlign: "left", cursor: "pointer",
              animation: "toast-slide-in 0.18s ease-out",
            }}>
            <span style={{ color: v.fg, fontSize: 14, fontWeight: 700, marginTop: 1, lineHeight: 1, flexShrink: 0 }}>{v.icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>{t.message}</div>
              {t.description && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{t.description}</div>}
            </div>
            <span style={{ color: "var(--text-faint)", fontSize: 11, marginTop: 2, flexShrink: 0 }}>×</span>
          </button>
        );
      })}
      <style>{`@keyframes toast-slide-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  );
}
