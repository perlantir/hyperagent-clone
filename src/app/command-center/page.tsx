"use client";
// P32 — Command Center.
//
// Live operational dashboard, polled every 5 seconds:
//   - Active runs (with cancel buttons)
//   - 24h health snapshot (failure rate, retries, DLQ, cron pulse)
//   - Hourly burn-rate sparkline
//   - Schedule fleet (active automations + last/next fire + recent failures)
//
// Per-user only — this isn't a global admin view. Each user sees their own
// runs, schedules, failure rates, etc.

import { useEffect, useState, useMemo, useCallback } from "react";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { Skeleton, SkeletonStatGrid } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

interface ActiveRun {
  runId: string; threadId: string | null; agentId: string | null; agentName: string | null;
  parentRunId: string | null; kind: string; startedAt: number; ageMs: number;
  spentCredits: number; budgetCapCredits: number | null; reservedCredits: number;
}
interface HealthSnapshot {
  last24hRuns: number; last24hFailures: number; last24hCancelled: number;
  last24hTimeout: number; failureRate: number; last24hRetries: number;
  auditDlqDepth: number; last24hRollbacks: number; lastCronFireAt: number | null;
}
interface BurnPoint { hour: string; runs: number; costCredits: number; }
interface SchedEntry {
  scheduleId: string; agentId: string; agentName: string | null; name: string;
  intervalMinutes: number; active: boolean; lastRunAt: number | null;
  nextRunAt: number | null; recentFailures: number; recentRuns: number;
}
interface Snapshot {
  activeRuns: ActiveRun[]; health: HealthSnapshot; burnRate: BurnPoint[];
  schedules: SchedEntry[]; balance: number; serverTime: number;
}

const POLL_MS = 5000;

export default function CommandCenterPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/command-center");
    if (r.ok) setData(await r.json());
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function cancelRun(runId: string) {
    const ok = await confirm({
      title: "Cancel this run?",
      body: "The run will exit at the next iteration boundary. Tokens already streamed are charged; further work is skipped.",
      confirmLabel: "Cancel run",
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(runId);
    const r = await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
    setBusy(null);
    if (r.ok) {
      toast.success("Run cancelled", "Loop will exit at the next iteration boundary.");
      load();
    } else {
      toast.error("Cancel failed", (await r.json().catch(() => ({}))).error);
    }
  }

  return (
    <AppShell>
      <Topbar title="Command Center" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <h1 className="h-display" style={{ fontSize: 44, marginBottom: 8 }}>Command Center</h1>
          <div style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 24 }}>
            Live operational view across your runs, schedules, and burn rate. Refreshes every {POLL_MS / 1000}s.
          </div>

          {!data ? (
            <SkeletonStatGrid count={6} />
          ) : (
            <>
              {/* Top stats — quick at-a-glance */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 32 }}>
                <Stat label="Active runs" value={data.activeRuns.length.toString()}
                  warn={data.activeRuns.length > 5} />
                <Stat label="24h failure rate"
                  value={`${(data.health.failureRate * 100).toFixed(1)}%`}
                  sub={`${data.health.last24hFailures} of ${data.health.last24hRuns}`}
                  warn={data.health.failureRate > 0.10} />
                <Stat label="24h retries" value={data.health.last24hRetries.toLocaleString()}
                  warn={data.health.last24hRetries > 50} />
                <Stat label="Audit DLQ"
                  value={data.health.auditDlqDepth.toLocaleString()}
                  sub="unreplayed events"
                  warn={data.health.auditDlqDepth > 0} />
                <Stat label="Last cron fire"
                  value={data.health.lastCronFireAt ? formatRelative(data.serverTime - data.health.lastCronFireAt) : "never"}
                  warn={!data.health.lastCronFireAt || data.serverTime - (data.health.lastCronFireAt || 0) > 90 * 60_000} />
                <Stat label="Balance"
                  value={`${data.balance.toLocaleString()}`}
                  sub={`$${(data.balance * 0.001).toFixed(2)}`}
                  warn={data.balance < 1000} />
              </div>

              {/* Burn-rate sparkline */}
              <div style={{ marginBottom: 32 }}>
                <div className="h-section" style={{ marginBottom: 12 }}>Burn rate · last 24 hours</div>
                <BurnRateChart points={data.burnRate} />
              </div>

              {/* Active runs */}
              <div style={{ marginBottom: 32 }}>
                <div className="h-section" style={{ marginBottom: 12 }}>
                  Active runs · {data.activeRuns.length}
                </div>
                {data.activeRuns.length === 0 ? (
                  <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)", fontSize: 13, border: "1px solid var(--border)", borderRadius: 10 }}>
                    No runs in flight.
                  </div>
                ) : (
                  <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                    {data.activeRuns.map(r => (
                      <ActiveRunRow key={r.runId} run={r} now={data.serverTime}
                        busy={busy === r.runId} onCancel={() => cancelRun(r.runId)} />
                    ))}
                  </div>
                )}
              </div>

              {/* Schedules */}
              {data.schedules.length > 0 && (
                <div style={{ marginBottom: 32 }}>
                  <div className="h-section" style={{ marginBottom: 12 }}>Schedules · {data.schedules.length}</div>
                  <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 100px 100px 80px 80px",
                      padding: "10px 14px", background: "var(--bg-elevated)", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: 0.5 }}>
                      <span>SCHEDULE</span>
                      <span style={{ textAlign: "right" }}>INTERVAL</span>
                      <span style={{ textAlign: "right" }}>LAST</span>
                      <span style={{ textAlign: "right" }}>NEXT</span>
                      <span style={{ textAlign: "right" }}>FAILS</span>
                      <span style={{ textAlign: "right" }}>STATE</span>
                    </div>
                    {data.schedules.map(s => (
                      <ScheduleRow key={s.scheduleId} s={s} now={data.serverTime} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="card" style={{ padding: 14, borderColor: warn ? "#dc2626" : undefined }}>
      <div style={{ fontSize: 10.5, color: warn ? "#dc2626" : "var(--text-muted)", letterSpacing: 0.5, fontWeight: 600, textTransform: "uppercase" }}>{label}</div>
      <div className="h-display" style={{ fontSize: 22, marginTop: 4, color: warn ? "#dc2626" : undefined }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function BurnRateChart({ points }: { points: BurnPoint[] }) {
  const max = Math.max(...points.map(p => p.costCredits), 1);
  const totalCredits = points.reduce((s, p) => s + p.costCredits, 0);
  const totalRuns = points.reduce((s, p) => s + p.runs, 0);
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 100 }}>
        {points.map((p, i) => {
          const h = (p.costCredits / max) * 100;
          return (
            <div key={i} title={`${p.hour}: ${p.costCredits.toLocaleString()} credits, ${p.runs} runs`}
              style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
              <div style={{
                height: `${h}%`, minHeight: p.costCredits > 0 ? 2 : 0,
                background: "var(--accent)", borderRadius: "2px 2px 0 0",
                opacity: 0.85,
              }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 11, color: "var(--text-faint)" }}>
        <span>{points[0]?.hour.slice(11)} UTC</span>
        <span>
          {totalCredits.toLocaleString()} credits · {totalRuns} runs in 24h
        </span>
        <span>{points[points.length - 1]?.hour.slice(11)} UTC</span>
      </div>
    </div>
  );
}

function ActiveRunRow({ run, now, busy, onCancel }: {
  run: ActiveRun; now: number; busy: boolean; onCancel: () => void;
}) {
  const ageS = (now - run.startedAt) / 1000;
  const ageDisplay = ageS < 60 ? `${ageS.toFixed(0)}s` : `${(ageS / 60).toFixed(1)}m`;
  const isOldRun = ageS > 120;
  const overBudget = run.budgetCapCredits != null && run.spentCredits >= run.budgetCapCredits;
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "180px 1fr 110px 90px 100px 90px",
      padding: "10px 14px", borderTop: "1px solid var(--border)",
      fontSize: 13, alignItems: "center", gap: 12,
    }}>
      <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {run.runId.slice(0, 16)}…
      </span>
      <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {run.parentRunId && <span style={{ color: "var(--text-faint)", marginRight: 6 }}>↳</span>}
        {run.agentName || <em style={{ color: "var(--text-muted)" }}>(no agent)</em>}
        <span style={{ color: "var(--text-faint)", marginLeft: 6, fontSize: 11 }}>{run.kind}</span>
      </span>
      <span style={{ textAlign: "right", color: isOldRun ? "#dc2626" : "var(--text-muted)" }} className="mono">
        {ageDisplay}
      </span>
      <span style={{ textAlign: "right", color: overBudget ? "#dc2626" : "var(--text-muted)" }}>
        {run.spentCredits.toLocaleString()}
        {run.budgetCapCredits && <span style={{ color: "var(--text-faint)", fontSize: 11 }}> / {run.budgetCapCredits.toLocaleString()}</span>}
      </span>
      <a href={`/traces/${run.runId}`} style={{ fontSize: 11, color: "var(--accent)", textAlign: "right", textDecoration: "none" }}>
        trace →
      </a>
      <button onClick={onCancel} disabled={busy} className="btn"
        style={{ padding: "4px 10px", fontSize: 11, color: "#dc2626", borderColor: "#dc2626" }}>
        {busy ? "…" : "Cancel"}
      </button>
    </div>
  );
}

function ScheduleRow({ s, now }: { s: SchedEntry; now: number }) {
  const lastDisplay = s.lastRunAt ? formatRelative(now - s.lastRunAt) : "—";
  const nextDisplay = s.active && s.nextRunAt
    ? (s.nextRunAt > now ? `in ${formatRelative(s.nextRunAt - now)}` : "due now")
    : "paused";
  const overdue = s.active && s.nextRunAt && s.nextRunAt < now - 5 * 60_000;
  const failHigh = s.recentRuns >= 3 && s.recentFailures >= s.recentRuns / 2;
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "1fr 90px 100px 100px 80px 80px",
      padding: "10px 14px", borderTop: "1px solid var(--border)",
      fontSize: 13, alignItems: "center",
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
        {s.agentName && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{s.agentName}</div>}
      </div>
      <span style={{ textAlign: "right", color: "var(--text-muted)" }} className="mono">{s.intervalMinutes}m</span>
      <span style={{ textAlign: "right", color: "var(--text-muted)" }}>{lastDisplay}</span>
      <span style={{ textAlign: "right", color: overdue ? "#dc2626" : "var(--text-muted)" }}>{nextDisplay}</span>
      <span style={{ textAlign: "right", color: failHigh ? "#dc2626" : "var(--text-muted)" }}>
        {s.recentRuns > 0 ? `${s.recentFailures}/${s.recentRuns}` : "—"}
      </span>
      <span style={{
        textAlign: "right", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5,
        color: s.active ? "#22c55e" : "var(--text-faint)",
      }}>
        {s.active ? "ACTIVE" : "PAUSED"}
      </span>
    </div>
  );
}

function formatRelative(ms: number): string {
  const sec = Math.abs(ms) / 1000;
  if (sec < 60) return `${sec.toFixed(0)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(0)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}
