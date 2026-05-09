"use client";
// P30 — First-run onboarding tour.
//
// Mounted globally in AppShell. On mount, fetches /api/auth/me and shows
// the modal if the user has no onboardedAt timestamp. Four bite-sized
// steps oriented around the actual product surfaces:
//
//   1. Welcome + what Hyperagent is
//   2. Agents — specialized assistants you can build
//   3. Memory — the agent learns + carries context across threads
//   4. Tools + Library — connect, run, ship artifacts
//
// "Skip" closes immediately; "Get started" walks through. Either path
// POSTs to /api/auth/onboarded so the modal doesn't fire again.
//
// The demo seed user (demo@hyperagent.local) gets pre-marked onboarded
// in seedIfEmpty, so they don't see this — only real new accounts do.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Step {
  title: string;
  body: string;
  icon: string;
  tint: string;
  cta?: { label: string; href?: string };
}

const STEPS: Step[] = [
  {
    title: "Welcome to Hyperagent.",
    body: "Build, run, and improve AI agents for any workflow. Each agent has its own personality, tools, and memory — and gets better the more you use it.",
    icon: "H",
    tint: "linear-gradient(135deg, #c2410c, #f97316)",
  },
  {
    title: "Agents do focused work.",
    body: "We seeded you with a Research Analyst, a Writing Assistant, and a Pricing Watch agent. Build your own at any time — drop in a system prompt, pick the tools, ship.",
    icon: "A",
    tint: "linear-gradient(135deg, #1d4ed8, #3b82f6)",
    cta: { label: "Browse agents", href: "/agents/new" },
  },
  {
    title: "Agents remember.",
    body: "Save anything as a memory and the agent will lean on it next time — your name, formatting preferences, project context. Memories accept, decay, and compact automatically.",
    icon: "M",
    tint: "linear-gradient(135deg, #15803d, #22c55e)",
    cta: { label: "See your memory store", href: "/learning" },
  },
  {
    title: "Connect, run, ship.",
    body: "Wire in Slack, Gmail, GitHub, and 500+ tools through Integrations. Every artifact your agent makes — webpages, docs, charts — lives in your Library.",
    icon: "▤",
    tint: "linear-gradient(135deg, #6d28d9, #a78bfa)",
    cta: { label: "Open the Library", href: "/library" },
  },
];

export function OnboardingModal() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me").then(r => r.json()).then(j => {
      if (!alive) return;
      if (j.user && j.user.onboardedAt == null) setOpen(true);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  async function complete(finalStep = false) {
    if (closing) return;
    setClosing(true);
    // Fire-and-forget mark — UI closes optimistically.
    fetch("/api/auth/onboarded", { method: "POST" }).catch(() => {});
    setOpen(false);
  }

  function next() {
    if (step < STEPS.length - 1) setStep(step + 1);
    else complete(true);
  }

  function jump(href: string) {
    fetch("/api/auth/onboarded", { method: "POST" }).catch(() => {});
    setOpen(false);
    router.push(href);
  }

  if (!open) return null;
  const s = STEPS[step];

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
      display: "grid", placeItems: "center", zIndex: 280,
      backdropFilter: "blur(8px)",
    }}>
      <div style={{
        width: "min(520px, 92vw)",
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        boxShadow: "0 32px 80px rgba(0,0,0,0.30)",
        padding: 0,
        overflow: "hidden",
        animation: "onboard-pop-in 0.22s ease-out",
      }}>
        {/* Hero */}
        <div style={{ height: 160, background: s.tint, display: "grid", placeItems: "center", position: "relative" }}>
          <div style={{
            width: 64, height: 64, borderRadius: 18,
            background: "rgba(255,255,255,0.18)",
            color: "white",
            display: "grid", placeItems: "center",
            fontSize: 32, fontWeight: 700,
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(255,255,255,0.3)",
          }}>{s.icon}</div>
          <button onClick={() => complete()}
            style={{
              position: "absolute", top: 12, right: 14,
              background: "rgba(255,255,255,0.18)", color: "white",
              border: "1px solid rgba(255,255,255,0.3)", borderRadius: 6,
              padding: "4px 10px", fontSize: 11.5,
              backdropFilter: "blur(8px)",
            }}>Skip</button>
        </div>

        <div style={{ padding: "28px 32px 24px" }}>
          <h2 className="h-display" style={{ fontSize: 30, marginBottom: 10 }}>{s.title}</h2>
          <p style={{ fontSize: 14.5, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 24 }}>{s.body}</p>

          {/* Step dots */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", gap: 6 }}>
              {STEPS.map((_, i) => (
                <button key={i} onClick={() => setStep(i)}
                  style={{
                    width: i === step ? 22 : 6, height: 6, borderRadius: 99,
                    background: i === step ? "var(--text)" : "var(--border-strong)",
                    border: "none", padding: 0, transition: "width 0.2s",
                  }} />
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {s.cta && (
                <button className="btn" onClick={() => jump(s.cta!.href!)}>{s.cta.label}</button>
              )}
              <button className="btn btn-primary" onClick={next}>
                {step < STEPS.length - 1 ? "Next →" : "Get started"}
              </button>
            </div>
          </div>
        </div>
      </div>
      <style>{`@keyframes onboard-pop-in { from { opacity: 0; transform: scale(0.95) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }`}</style>
    </div>
  );
}
