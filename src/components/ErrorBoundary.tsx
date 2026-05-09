"use client";
// P60 — Page-level error boundary.
//
// Catches client-side render errors so a single bad component doesn't
// blank the whole page with the generic Next.js "Application error".
// Shows the actual error message + a Retry button + a copy-to-clipboard
// helper so users can paste the stack into a bug report.
//
// Wrapped around <main> in AppShell so the sidebar stays usable even
// when the page content errors. Errors above the boundary (e.g. in
// AppShell itself) still bubble to the framework error overlay.

import React from "react";

interface State {
  hasError: boolean;
  error?: Error;
  componentStack?: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; resetKey?: string },
  State
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Send to console so devtools shows the full stack — and to the
    // server so we can audit recurring breakage.
    console.error("[ErrorBoundary] caught:", error, info);
    this.setState({ componentStack: info.componentStack || undefined });
    // Best-effort log to /api/errors. Failure is silent.
    try {
      fetch("/api/errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: error.message,
          name: error.name,
          stack: error.stack,
          componentStack: info.componentStack,
          url: typeof window !== "undefined" ? window.location.href : "",
          ts: Date.now(),
        }),
      }).catch(() => {});
    } catch {}
  }

  // Reset when the user explicitly clicks Retry, or when resetKey changes
  // (e.g. when navigating to a new route the parent forces a remount).
  componentDidUpdate(prevProps: { resetKey?: string }) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: undefined, componentStack: undefined });
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const err = this.state.error;
    const fullDetail = [
      err?.name + ": " + err?.message,
      err?.stack || "(no stack)",
      "",
      "Component stack:",
      this.state.componentStack || "(no component stack)",
    ].join("\n");

    return (
      <div style={{
        padding: 32, maxWidth: 720, margin: "40px auto",
        fontFamily: "Inter, system-ui, sans-serif",
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: 1,
          color: "#dc2626", textTransform: "uppercase", marginBottom: 8,
        }}>Page error</div>
        <h1 style={{ fontSize: 24, marginBottom: 8 }}>Something went wrong on this page.</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16, lineHeight: 1.5 }}>
          The rest of the app still works — try the sidebar to navigate elsewhere. If the same screen keeps failing, copy the diagnostic info below and share it.
        </p>
        <div style={{
          padding: 12, background: "var(--bg-subtle)", borderRadius: 8,
          fontFamily: "JetBrains Mono, monospace", fontSize: 11.5,
          color: "var(--text)", marginBottom: 16,
          maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap",
        }}>
          {err?.name}: {err?.message}
        </div>
        <details style={{ marginBottom: 16, fontSize: 12 }}>
          <summary style={{ cursor: "pointer", color: "var(--text-muted)", marginBottom: 6 }}>
            Show full stack
          </summary>
          <div style={{
            padding: 10, background: "var(--bg-subtle)", borderRadius: 8,
            fontFamily: "JetBrains Mono, monospace", fontSize: 10.5,
            color: "var(--text-muted)",
            maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap",
          }}>
            {fullDetail}
          </div>
        </details>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => this.setState({ hasError: false, error: undefined })}
            className="btn btn-primary" style={{ fontSize: 13 }}>
            Retry
          </button>
          <button onClick={() => {
            try { navigator.clipboard.writeText(fullDetail); } catch {}
          }} className="btn" style={{ fontSize: 13 }}>
            Copy diagnostics
          </button>
          <button onClick={() => { window.location.href = "/"; }}
            className="btn" style={{ fontSize: 13 }}>
            Home
          </button>
        </div>
      </div>
    );
  }
}
