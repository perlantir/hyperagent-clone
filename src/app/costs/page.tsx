"use client";
// P27b — /costs page: full cost surface for the user.
// Top stats + per-day chart + per-agent breakdown + recent runs table.

import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { Skeleton, SkeletonStatGrid, SkeletonRow } from "@/components/Skeleton";

interface CostsResponse {
  summary: {
    totalRuns: number;
    totalCostCredits: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreateTokens: number;
    cacheHitRate: number;
    avgRunCostCredits: number;
    avgLatencyMs: number | null;
  };
  balance: number;
  perAgent: Array<{
    agentId: string | null;
    agentName: string | null;
    runs: number;
    costCredits: number;
    avgLatencyMs: number | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  }>;
  perDay: Array<{ day: string; runs: number; costCredits: number }>;
  recent: Array<{
    runId: string; threadId: string | null; agentId: string | null; agentName: string | null;
    kind: string; status: string; startedAt: number; endedAt: number | null;
    costCredits: number; inputTokens: number; outputTokens: number; cacheReadTokens: number;
  }>;
  // P45 — per-model + per-tool rollups
  perModel?: Array<{ model: string; runs: number; inputTokens: number; outputTokens: number; costCredits: number }>;
  perTool?: Array<{ tool: string; calls: number; totalMs: number; avgMs: number }>;
}

type Window = "24h" | "7d" | "30d" | "all";

export default function CostsPage() {
  const [data, setData] = useState<CostsResponse | null>(null);
  const [window, setWindow] = useState<Window>("30d");

  async function load() {
    const now = Date.now();
    const fromMap: Record<Window, number | undefined> = {
      "24h": now - 24 * 3600_000,
      "7d":  now - 7 * 24 * 3600_000,
      "30d": now - 30 * 24 * 3600_000,
      "all": undefined,
    };
    const params = new URLSearchParams({ groupBy: "all" });
    if (fromMap[window]) params.set("from", String(fromMap[window]));
    const r = await fetch(`/api/costs?${params}`).then(r => r.json());
    setData(r);
  }
  useEffect(() => { load(); }, [window]);

  return (
    <AppShell>
      <Topbar title="Costs" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <h1 className="h-display" style={{ fontSize: 44, marginBottom: 8 }}>Costs</h1>
          <div style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 24 }}>
            Per-run, per-agent, per-day spend. Cache hits show up as zero-cost reads.
          </div>

          {/* Window filter */}
          <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
            {(["24h","7d","30d","all"] as Window[]).map(w => (
              <button key={w} className={`chip ${window === w ? "active" : ""}`}
                onClick={() => setWindow(w)}>{w}</button>
            ))}
          </div>

          {!data ? (
            <>
              <SkeletonStatGrid count={5} minW={180} />
              <div style={{ height: 24 }} />
              <Skeleton width={120} height={12} style={{ marginBottom: 12 }} />
              <div className="card" style={{ padding: 16 }}>
                <Skeleton height={120} />
              </div>
              <div style={{ height: 24 }} />
              <Skeleton width={100} height={12} style={{ marginBottom: 12 }} />
              <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                {Array.from({ length: 4 }).map((_, i) => <SkeletonRow key={i} cols={5} />)}
              </div>
            </>
          ) : (
            <>
              {/* Summary stats */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 32 }}>
                <Stat label="Balance" value={`${data.balance.toLocaleString()} credits`} sub={`$${(data.balance * 0.001).toFixed(2)}`} />
                <Stat label="Spent" value={`${data.summary.totalCostCredits.toLocaleString()}`} sub={`$${(data.summary.totalCostCredits * 0.001).toFixed(2)} · ${data.summary.totalRuns} runs`} />
                <Stat label="Avg run cost" value={`${data.summary.avgRunCostCredits.toLocaleString()}`} sub={`$${(data.summary.avgRunCostCredits * 0.001).toFixed(3)}/run`} />
                <Stat label="Cache hit rate" value={`${(data.summary.cacheHitRate * 100).toFixed(0)}%`}
                  sub={`${data.summary.totalCacheReadTokens.toLocaleString()} cached tokens`} />
                <Stat label="Avg latency" value={data.summary.avgLatencyMs ? `${(data.summary.avgLatencyMs / 1000).toFixed(1)}s` : "—"}
                  sub="end-to-end per run" />
              </div>

              {/* Per-day chart */}
              {data.perDay.length > 0 && (
                <div style={{ marginBottom: 32 }}>
                  <div className="h-section" style={{ marginBottom: 12 }}>Daily spend</div>
                  <DailyBars data={data.perDay} />
                </div>
              )}

              {/* Per-agent breakdown */}
              {data.perAgent.length > 0 && (
                <div style={{ marginBottom: 32 }}>
                  <div className="h-section" style={{ marginBottom: 12 }}>Per agent</div>
                  <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1.4fr 70px 90px 100px 80px", padding: "10px 14px", background: "var(--bg-elevated)", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", letterSpacing: 0.5 }}>
                      <span>AGENT</span>
                      <span style={{ textAlign: "right" }}>RUNS</span>
                      <span style={{ textAlign: "right" }}>TOKENS</span>
                      <span style={{ textAlign: "right" }}>COST</span>
                      <span style={{ textAlign: "right" }}>AVG LAT</span>
                    </div>
                    {data.perAgent.map(a => (
                      <div key={a.agentId || "unassigned"} style={{
                        display: "grid", gridTemplateColumns: "1.4fr 70px 90px 100px 80px",
                        padding: "10px 14px", borderTop: "1px solid var(--border)",
                        fontSize: 13, alignItems: "center",
                      }}>
                        <span style={{ fontWeight: 500 }}>{a.agentName || <em style={{ color: "var(--text-muted)" }}>(unassigned)</em>}</span>
                        <span style={{ textAlign: "right" }}>{a.runs.toLocaleString()}</span>
                        <span style={{ textAlign: "right", fontSize: 12, color: "var(--text-muted)" }}>
                          {(a.inputTokens + a.outputTokens).toLocaleString()}
                        </span>
                        <span style={{ textAlign: "right", fontWeight: 500 }}>
                          ${(a.costCredits * 0.001).toFixed(3)}
                        </span>
                        <span style={{ textAlign: "right", fontSize: 12, color: "var(--text-muted)" }}>
                          {a.avgLatencyMs ? `${(a.avgLatencyMs / 1000).toFixed(1)}s` : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* P45 — Per-model breakdown */}
              {data.perModel && data.perModel.length > 0 && (
                <div style={{ marginBottom: 32 }}>
                  <div className="h-section" style={{ marginBottom: 12 }}>Per model</div>
                  <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1.4fr 70px 110px 100px",
                      padding: "10px 14px", background: "var(--bg-elevated)", fontSize: 11, fontWeight: 600,
                      color: "var(--text-muted)", letterSpacing: 0.5 }}>
                      <span>MODEL</span>
                      <span style={{ textAlign: "right" }}>RUNS</span>
                      <span style={{ textAlign: "right" }}>TOKENS</span>
                      <span style={{ textAlign: "right" }}>COST</span>
                    </div>
                    {data.perModel.map((m: any) => (
                      <div key={m.model} style={{
                        display: "grid", gridTemplateColumns: "1.4fr 70px 110px 100px",
                        padding: "10px 14px", borderTop: "1px solid var(--border)",
                        fontSize: 13, alignItems: "center",
                      }}>
                        <span style={{ fontWeight: 500, fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}>{m.model}</span>
                        <span style={{ textAlign: "right" }}>{m.runs.toLocaleString()}</span>
                        <span style={{ textAlign: "right", fontSize: 12, color: "var(--text-muted)" }}>
                          {(m.inputTokens + m.outputTokens).toLocaleString()}
                        </span>
                        <span style={{ textAlign: "right", fontWeight: 500 }}>
                          ${(m.costCredits * 0.001).toFixed(3)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* P45 — Per-tool usage */}
              {data.perTool && data.perTool.length > 0 && (
                <div style={{ marginBottom: 32 }}>
                  <div className="h-section" style={{ marginBottom: 12 }}>Tool usage</div>
                  <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1.4fr 70px 90px 100px",
                      padding: "10px 14px", background: "var(--bg-elevated)", fontSize: 11, fontWeight: 600,
                      color: "var(--text-muted)", letterSpacing: 0.5 }}>
                      <span>TOOL</span>
                      <span style={{ textAlign: "right" }}>CALLS</span>
                      <span style={{ textAlign: "right" }}>AVG</span>
                      <span style={{ textAlign: "right" }}>TOTAL TIME</span>
                    </div>
                    {data.perTool.map((t: any) => (
                      <div key={t.tool} style={{
                        display: "grid", gridTemplateColumns: "1.4fr 70px 90px 100px",
                        padding: "10px 14px", borderTop: "1px solid var(--border)",
                        fontSize: 13, alignItems: "center",
                      }}>
                        <span style={{ fontWeight: 500, fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}>{t.tool}</span>
                        <span style={{ textAlign: "right" }}>{t.calls.toLocaleString()}</span>
                        <span style={{ textAlign: "right", fontSize: 12, color: "var(--text-muted)" }}>
                          {(t.avgMs / 1000).toFixed(2)}s
                        </span>
                        <span style={{ textAlign: "right", fontWeight: 500 }}>
                          {(t.totalMs / 1000).toFixed(1)}s
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent runs */}
              {data.recent.length > 0 && (
                <div>
                  <div className="h-section" style={{ marginBottom: 12 }}>Recent runs</div>
                  <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                    {data.recent.map(r => (
                      <div key={r.runId} style={{
                        padding: "10px 14px", borderBottom: "1px solid var(--border)",
                        display: "flex", alignItems: "center", gap: 12, fontSize: 13,
                      }}>
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                          background: r.status === "succeeded" ? "rgba(34,197,94,0.10)" : "rgba(220,38,38,0.10)",
                          color: r.status === "succeeded" ? "#22c55e" : "#dc2626",
                        }}>{r.status.toUpperCase()}</span>
                        <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 80 }}>{r.kind}</span>
                        <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {r.agentName || <em style={{ color: "var(--text-muted)" }}>(no agent)</em>}
                        </span>
                        <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                          {(r.inputTokens + r.outputTokens).toLocaleString()} tok
                        </span>
                        <span style={{ minWidth: 70, textAlign: "right", fontWeight: 500 }}>
                          ${(r.costCredits * 0.001).toFixed(3)}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--text-faint)", minWidth: 80, textAlign: "right" }}>
                          {new Date(r.startedAt).toLocaleString()}
                        </span>
                        <a href={`/api/traces/${r.runId}`} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none" }}>trace</a>
                      </div>
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

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: 0.5, fontWeight: 600, textTransform: "uppercase" }}>{label}</div>
      <div className="h-display" style={{ fontSize: 24, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function DailyBars({ data }: { data: Array<{ day: string; runs: number; costCredits: number }> }) {
  const max = Math.max(...data.map(d => d.costCredits), 1);
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120 }}>
        {data.map(d => {
          const h = (d.costCredits / max) * 100;
          return (
            <div key={d.day} title={`${d.day}: ${d.costCredits} credits, ${d.runs} runs`}
              style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
              <div style={{
                height: `${h}%`, minHeight: d.costCredits > 0 ? 2 : 0,
                background: "var(--accent, #3b82f6)", borderRadius: "4px 4px 0 0",
                opacity: 0.85,
              }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 10, color: "var(--text-faint)" }}>
        <span>{data[0]?.day}</span>
        <span>{data[data.length - 1]?.day}</span>
      </div>
    </div>
  );
}
