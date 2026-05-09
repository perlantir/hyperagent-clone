"use client";
// P48 — eval-history aggregate dashboard.
//
// Single-page rollup of every rubric_evaluations row over a configurable
// window. Operators land here to answer:
//   - is the agent getting better or worse over time?
//   - which criteria fail most often?
//   - which rubrics are even being run?
//   - what was the most recent failure and why?
//
// Each section renders pure SVG + CSS (no chart library) so the page
// stays small and the dashboard never crashes on bad data.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { Skeleton } from "@/components/Skeleton";

interface AggregateResponse {
  summary: { total: number; passed: number; failed: number; avgScore: number | null; passRate: number | null };
  daily: Array<{ date: string; count: number; passed: number; avgScore: number | null }>;
  perCriterion: Array<{ name: string; count: number; avgScore: number; passRate: number; failCount: number }>;
  perRubric: Array<{ rubricId: string; rubricName: string; count: number; passRate: number | null; avgScore: number | null }>;
  topFailing: Array<{ id: string; rubricId: string; rubricName: string; runId: string | null; agentId: string | null; overallScore: number | null; evaluatedAt: number; firstFailing: { criterion: string; reasoning: string } | null }>;
}

type WindowKey = "7d" | "30d" | "90d" | "all";

const WINDOWS: Record<WindowKey, { label: string; ms: number | null }> = {
  "7d":  { label: "Last 7 days",  ms: 7 * 24 * 60 * 60 * 1000 },
  "30d": { label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  "90d": { label: "Last 90 days", ms: 90 * 24 * 60 * 60 * 1000 },
  "all": { label: "All time",     ms: null },
};

export default function EvalsDashboardPage() {
  const [data, setData] = useState<AggregateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [windowKey, setWindowKey] = useState<WindowKey>("30d");
  const [rubricFilter, setRubricFilter] = useState<string>("");
  const [rubrics, setRubrics] = useState<Array<{ id: string; name: string }>>([]);

  // Load rubric options once for the filter dropdown.
  useEffect(() => {
    fetch("/api/rubrics").then(r => r.json()).then(j => {
      setRubrics((j.rubrics || []).map((r: any) => ({ id: r.id, name: r.name })));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    const win = WINDOWS[windowKey];
    if (win.ms !== null) params.set("from", String(Date.now() - win.ms));
    if (rubricFilter) params.set("rubricId", rubricFilter);
    fetch(`/api/rubrics/aggregate?${params}`).then(r => r.json()).then(j => {
      setData(j);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [windowKey, rubricFilter]);

  return (
    <AppShell>
      <Topbar title="Evaluations" />
      <div style={{ padding: "24px 32px 64px", maxWidth: 1200, margin: "0 auto" }}>
        <div style={{ marginBottom: 20 }}>
          <h1 className="h-display" style={{ fontSize: 36, marginBottom: 6 }}>Evaluations</h1>
          <div style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 720 }}>
            How your agents are scoring against rubrics. Use this to spot regressions after prompt edits, find criteria that consistently fail, and find specific runs to investigate.
          </div>
        </div>

        {/* Filters */}
        <div style={{
          display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
          marginBottom: 24,
        }}>
          {(Object.keys(WINDOWS) as WindowKey[]).map(k => (
            <button key={k} onClick={() => setWindowKey(k)}
              className={`chip ${windowKey === k ? "active" : ""}`}
              style={{
                fontSize: 12, padding: "5px 11px", borderRadius: 999,
                border: "1px solid var(--border)",
                background: windowKey === k ? "var(--accent-bg)" : "transparent",
                color: windowKey === k ? "var(--accent)" : "var(--text-muted)",
                fontWeight: windowKey === k ? 600 : 500, cursor: "pointer",
              }}>
              {WINDOWS[k].label}
            </button>
          ))}
          <div style={{ width: 1, height: 22, background: "var(--border)", margin: "0 4px" }} />
          <select value={rubricFilter} onChange={e => setRubricFilter(e.target.value)}
            style={{
              fontSize: 12, padding: "6px 10px", borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-subtle)", color: "var(--text)",
              outline: "none",
            }}>
            <option value="">All rubrics</option>
            {rubrics.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>

        {loading ? (
          <>
            <Skeleton height={120} style={{ marginBottom: 16 }} />
            <Skeleton height={240} style={{ marginBottom: 16 }} />
            <Skeleton height={180} />
          </>
        ) : !data || data.summary.total === 0 ? (
          <EmptyDashboard />
        ) : (
          <>
            <SummaryCards s={data.summary} />
            <DailySeries daily={data.daily} />
            <PerCriterion list={data.perCriterion} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginBottom: 24 }}>
              <PerRubric list={data.perRubric} />
              <TopFailing list={data.topFailing} />
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

// ─── Summary cards ────────────────────────────────────────────────────────

function SummaryCards({ s }: { s: AggregateResponse["summary"] }) {
  const passColor = s.passRate !== null && s.passRate >= 0.8 ? "#22c55e"
    : s.passRate !== null && s.passRate >= 0.5 ? "#f59e0b" : "#ef4444";
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12,
      marginBottom: 24,
    }}>
      <Card label="Total evaluations" value={s.total.toLocaleString()} />
      <Card label="Pass rate"
        value={s.passRate !== null ? `${Math.round(s.passRate * 100)}%` : "—"}
        valueColor={passColor}
        sub={`${s.passed.toLocaleString()} passed · ${s.failed.toLocaleString()} failed`}
      />
      <Card label="Avg overall score"
        value={s.avgScore !== null ? s.avgScore.toFixed(2) : "—"}
        sub="Score range 0.0–5.0"
      />
      <Card label="Failed evaluations"
        value={s.failed.toLocaleString()}
        valueColor={s.failed > 0 ? "#ef4444" : "var(--text)"}
      />
    </div>
  );
}

function Card({ label, value, valueColor, sub }: { label: string; value: string; valueColor?: string; sub?: string }) {
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)",
        textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: valueColor || "var(--text)", lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ─── Daily series (custom SVG) ────────────────────────────────────────────

function DailySeries({ daily }: { daily: AggregateResponse["daily"] }) {
  const padded = useMemo(() => fillMissingDays(daily), [daily]);
  if (padded.length === 0) return null;

  const maxCount = Math.max(...padded.map(d => d.count), 1);
  const W = 1100, H = 200, padL = 36, padR = 16, padT = 14, padB = 28;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const barW = innerW / padded.length;

  return (
    <div className="card" style={{ padding: "14px 16px", marginBottom: 24 }}>
      <div className="h-section" style={{ marginBottom: 4 }}>Daily activity</div>
      <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginBottom: 10 }}>
        Count of evaluations per day · pass rate overlaid as a line
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H, display: "block" }}>
        {/* gridlines + y-axis labels for count */}
        {[0, 0.25, 0.5, 0.75, 1].map(p => {
          const y = padT + innerH * (1 - p);
          return (
            <g key={p}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--border)" strokeDasharray="2 4" />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize="10" fill="var(--text-faint)">
                {Math.round(maxCount * p)}
              </text>
            </g>
          );
        })}

        {/* bars */}
        {padded.map((d, i) => {
          const h = (d.count / maxCount) * innerH;
          const x = padL + i * barW;
          const passRate = d.count > 0 ? d.passed / d.count : null;
          const fill = passRate === null ? "var(--bg-subtle)"
            : passRate >= 0.8 ? "#22c55e"
            : passRate >= 0.5 ? "#f59e0b"
            : "#ef4444";
          return (
            <g key={d.date}>
              <title>{`${d.date} · ${d.count} eval${d.count === 1 ? "" : "s"}, ${passRate !== null ? Math.round(passRate * 100) + "% pass" : "no data"}`}</title>
              <rect x={x + 1} y={padT + innerH - h} width={Math.max(barW - 2, 1)} height={h}
                fill={fill} fillOpacity={d.count > 0 ? 0.85 : 0} rx={1.5} />
            </g>
          );
        })}

        {/* x-axis labels — every 5th bucket */}
        {padded.map((d, i) => {
          if (i % Math.max(1, Math.ceil(padded.length / 8)) !== 0) return null;
          const x = padL + i * barW + barW / 2;
          return (
            <text key={d.date} x={x} y={H - 8} textAnchor="middle" fontSize="9.5" fill="var(--text-faint)">
              {d.date.slice(5)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

// Pad missing dates so a sparse series doesn't compress into 2 bars.
function fillMissingDays(daily: AggregateResponse["daily"]): AggregateResponse["daily"] {
  if (daily.length === 0) return [];
  const byDate = new Map(daily.map(d => [d.date, d]));
  const start = new Date(daily[0].date + "T00:00:00Z").getTime();
  const end = new Date(daily[daily.length - 1].date + "T00:00:00Z").getTime();
  const out: AggregateResponse["daily"] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    const dateStr = new Date(t).toISOString().slice(0, 10);
    const existing = byDate.get(dateStr);
    if (existing) out.push(existing);
    else out.push({ date: dateStr, count: 0, passed: 0, avgScore: null });
    if (out.length > 90) break;
  }
  return out;
}

// ─── Per-criterion table ──────────────────────────────────────────────────

function PerCriterion({ list }: { list: AggregateResponse["perCriterion"] }) {
  if (list.length === 0) return null;
  return (
    <div className="card" style={{ padding: 0, marginBottom: 18, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
        <div className="h-section">Per-criterion breakdown</div>
        <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 2 }}>
          How each criterion has scored across every rubric in the window
        </div>
      </div>
      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(180px, 1.6fr) 70px 110px 1fr 90px",
        padding: "8px 16px", background: "var(--bg-elevated)",
        fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: 0.5,
      }}>
        <span>CRITERION</span>
        <span style={{ textAlign: "right" }}>EVALS</span>
        <span style={{ textAlign: "right" }}>AVG SCORE</span>
        <span>PASS RATE</span>
        <span style={{ textAlign: "right" }}>FAILS</span>
      </div>
      {list.map((c, i) => {
        const passColor = c.passRate >= 0.8 ? "#22c55e"
          : c.passRate >= 0.5 ? "#f59e0b" : "#ef4444";
        return (
          <div key={c.name} style={{
            display: "grid",
            gridTemplateColumns: "minmax(180px, 1.6fr) 70px 110px 1fr 90px",
            padding: "9px 16px", alignItems: "center",
            borderTop: i === 0 ? "none" : "1px solid var(--border)",
            fontSize: 12,
          }}>
            <span style={{ color: "var(--text)", fontWeight: 500 }}>{c.name}</span>
            <span style={{ textAlign: "right", color: "var(--text-muted)" }}>{c.count.toLocaleString()}</span>
            <span style={{ textAlign: "right", color: "var(--text-muted)" }}>{c.avgScore.toFixed(2)}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                position: "relative", flex: 1, height: 6,
                borderRadius: 3, background: "var(--bg-elevated)",
              }}>
                <span style={{
                  position: "absolute", inset: 0,
                  width: `${Math.round(c.passRate * 100)}%`,
                  background: passColor, borderRadius: 3,
                }} />
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 30, textAlign: "right" }}>
                {Math.round(c.passRate * 100)}%
              </span>
            </span>
            <span style={{ textAlign: "right", color: c.failCount > 0 ? "#ef4444" : "var(--text-muted)", fontWeight: c.failCount > 0 ? 600 : 400 }}>
              {c.failCount.toLocaleString()}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Per-rubric ───────────────────────────────────────────────────────────

function PerRubric({ list }: { list: AggregateResponse["perRubric"] }) {
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
        <div className="h-section">Per-rubric totals</div>
      </div>
      {list.length === 0 ? (
        <div style={{ padding: 24, fontSize: 12, color: "var(--text-faint)", textAlign: "center" }}>
          No rubric runs in this window.
        </div>
      ) : list.map((r, i) => (
        <Link key={r.rubricId} href={`/learning?tab=rubrics`}
          style={{
            display: "grid", gridTemplateColumns: "1fr 60px 80px",
            padding: "10px 16px", alignItems: "center",
            borderTop: i === 0 ? "none" : "1px solid var(--border)",
            fontSize: 12, color: "var(--text)", textDecoration: "none",
            transition: "background 0.1s",
          }}
          onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-subtle)")}
          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
          <span style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", paddingRight: 8 }}>
            {r.rubricName}
          </span>
          <span style={{ textAlign: "right", color: "var(--text-muted)" }}>{r.count}</span>
          <span style={{ textAlign: "right",
            color: r.passRate === null ? "var(--text-faint)"
              : r.passRate >= 0.8 ? "#22c55e"
              : r.passRate >= 0.5 ? "#f59e0b"
              : "#ef4444", fontWeight: 600 }}>
            {r.passRate !== null ? `${Math.round(r.passRate * 100)}%` : "—"}
          </span>
        </Link>
      ))}
    </div>
  );
}

// ─── Top failing feed ─────────────────────────────────────────────────────

function TopFailing({ list }: { list: AggregateResponse["topFailing"] }) {
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
        <div className="h-section">Recent failures</div>
        <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 2 }}>
          Most-recent evaluations that didn&apos;t pass
        </div>
      </div>
      {list.length === 0 ? (
        <div style={{ padding: 24, fontSize: 12, color: "var(--text-faint)", textAlign: "center" }}>
          No failing evaluations in this window. ✓
        </div>
      ) : list.map((f, i) => (
        <div key={f.id} style={{
          padding: "10px 16px",
          borderTop: i === 0 ? "none" : "1px solid var(--border)",
          fontSize: 12,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontWeight: 600, color: "var(--text)" }}>{f.rubricName}</span>
            <span style={{ fontSize: 10.5, color: "var(--text-faint)" }}>
              {new Date(f.evaluatedAt).toLocaleString()}
            </span>
          </div>
          {f.firstFailing && (
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.45 }}>
              <span style={{ color: "#ef4444", fontWeight: 600 }}>{f.firstFailing.criterion}: </span>
              {f.firstFailing.reasoning}
            </div>
          )}
          {f.runId && (
            <Link href={`/traces/${f.runId}`} style={{ fontSize: 10.5, color: "var(--accent)", marginTop: 4, display: "inline-block" }}>
              View run →
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────

function EmptyDashboard() {
  return (
    <div className="card" style={{ padding: 40, textAlign: "center" }}>
      <div style={{ fontSize: 36, marginBottom: 8 }}>★</div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>No evaluations yet</div>
      <div style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 480, margin: "0 auto 18px", lineHeight: 1.5 }}>
        Rubric evaluations run automatically when you click <em>Run evaluation</em> in the chat composer. Once you have a few runs, this dashboard fills with score trends, per-criterion breakdowns, and a feed of the most recent failures.
      </div>
      <Link href="/learning?tab=rubrics" className="btn btn-primary" style={{ fontSize: 12, padding: "6px 14px" }}>
        Manage rubrics →
      </Link>
    </div>
  );
}
