"use client";
// P36 — All non-Config tabs in the agent builder.
//
// Bundled into one file so each tab is a thin component and reviewers can
// see the whole new surface in a single read. Tabs that need substantial
// new infrastructure (Knowledge retrieval) ship as honest UI shells with
// a banner pointing to the phase that will land the backend.

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Skeleton } from "@/components/Skeleton";
import type { AgentLike } from "./types";
import { NATIVE_TOOL_CATALOG } from "./types";

// ============ Invocations Tab ============
//
// Shows all five trigger channels. Thread = always available; Webhook is
// production; Schedule + Slack are wired; Email is a UI shell pointing
// to P41. Each row reveals action-buttons + last-fired info.

export function InvocationsTab({ agent }: { agent: AgentLike }) {
  const [origin, setOrigin] = useState("");
  const [schedules, setSchedules] = useState<any[]>([]);
  const [slackWorkspaces, setSlackWorkspaces] = useState<any[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
    fetch("/api/schedules").then(r => r.json()).then(j => setSchedules((j.schedules || []).filter((s: any) => s.agentId === agent.id)));
    fetch("/api/settings/slack-workspaces").then(r => r.json()).then(j => setSlackWorkspaces((j.workspaces || []).filter((w: any) => w.agentId === agent.id)));
  }, [agent.id]);

  function copy(value: string, label: string) {
    try {
      navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1200);
    } catch {}
  }

  const webhookUrl = `${origin}/api/v1/agents/${agent.id}/invoke`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 800 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Invocations</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>How this agent gets triggered. All channels share the same execution path — same memory, same tools, same audit.</div>
      </div>

      <ChannelRow
        title="Thread"
        sub="Interactive chat — what users see when they open this agent."
        status="active"
        statusLabel="ACTIVE"
        body={
          <Link href={`/threads/new?agentId=${agent.id}`} className="btn"
            style={{ fontSize: 12, padding: "5px 12px" }}>+ New thread</Link>
        }
      />

      <ChannelRow
        title="Webhook"
        sub="Per-agent public URL. Pair with an API key from Settings."
        status="active" statusLabel="PROD"
        body={
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <code className="mono" style={{
                flex: 1, padding: "8px 10px", background: "var(--bg-subtle)",
                border: "1px solid var(--border)", borderRadius: 6,
                fontSize: 11.5, overflow: "auto", whiteSpace: "nowrap",
              }}>{webhookUrl}</code>
              <button className="btn" onClick={() => copy(webhookUrl, "url")}
                style={{ fontSize: 11, padding: "5px 12px" }}>
                {copied === "url" ? "✓" : "Copy"}
              </button>
              <Link href="/settings" className="btn"
                style={{ fontSize: 11, padding: "5px 12px" }}>API keys</Link>
            </div>
          </div>
        }
      />

      <ChannelRow
        title="Schedules"
        sub="Cron-driven runs. Each execution writes a fresh thread."
        status={schedules.length > 0 ? "active" : "inactive"}
        statusLabel={schedules.length > 0 ? `${schedules.length} ACTIVE` : "NONE"}
        body={
          <div>
            {schedules.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {schedules.map(s => (
                  <div key={s.id} style={{
                    fontSize: 12, color: "var(--text-muted)",
                    padding: "6px 10px", background: "var(--bg-subtle)",
                    borderRadius: 6, display: "flex", justifyContent: "space-between",
                  }}>
                    <span>{s.name} — every {s.intervalMinutes}m</span>
                    <span style={{ color: s.active ? "var(--green)" : "var(--text-faint)", fontSize: 11 }}>
                      {s.active ? "ACTIVE" : "PAUSED"}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            <Link href="/live" className="btn" style={{ fontSize: 11, padding: "5px 12px", marginTop: schedules.length > 0 ? 8 : 0 }}>
              Manage schedules
            </Link>
          </div>
        }
      />

      <ChannelRow
        title="Slack"
        sub="Inbound messages from a connected Slack workspace route to this agent."
        status={slackWorkspaces.length > 0 ? "active" : "inactive"}
        statusLabel={slackWorkspaces.length > 0 ? `${slackWorkspaces.length} CONNECTED` : "NOT BOUND"}
        body={
          <Link href="/settings" className="btn" style={{ fontSize: 11, padding: "5px 12px" }}>
            Manage workspaces
          </Link>
        }
      />

      <ChannelRow
        title="Email"
        sub="Forward an email to a per-agent address; the agent replies inline."
        status="planned" statusLabel="P41"
        body={
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Inbound-email infra (SendGrid Inbound Parse / SES) lands in P41. The execution path is identical to webhook + thread, just bridged through email.
          </div>
        }
      />
    </div>
  );
}

function ChannelRow({ title, sub, status, statusLabel, body }: {
  title: string; sub: string;
  status: "active" | "inactive" | "planned";
  statusLabel: string;
  body: React.ReactNode;
}) {
  const colors: Record<string, { bg: string; fg: string }> = {
    active:   { bg: "rgba(34,197,94,0.10)", fg: "#22c55e" },
    inactive: { bg: "var(--bg-subtle)",     fg: "var(--text-muted)" },
    planned:  { bg: "rgba(168,85,247,0.10)", fg: "#a855f7" },
  };
  const c = colors[status];
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
          background: c.bg, color: c.fg, letterSpacing: 0.5,
        }}>{statusLabel}</span>
      </div>
      {body}
    </div>
  );
}

// ============ Integrations Tab ============
//
// Lists Composio-backed connectors with toggle-to-bind to this agent.
// Connecting a new account redirects to the existing /integrations OAuth
// flow — we don't reinvent the auth dance here.

export function IntegrationsTab({ agent, onSave }: {
  agent: AgentLike;
  onSave: (patch: Partial<AgentLike>) => Promise<void>;
}) {
  const [connectors, setConnectors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [bound, setBound] = useState<string[]>(agent.connectorIds || []);
  const toast = useToast();

  useEffect(() => {
    fetch("/api/connectors").then(r => r.json()).then(j => {
      setConnectors(j.connectors || []);
      setLoading(false);
    });
  }, []);

  async function toggle(slug: string) {
    const next = bound.includes(slug)
      ? bound.filter(x => x !== slug)
      : [...bound, slug];
    setBound(next);
    await onSave({ connectorIds: next });
  }

  const connected = connectors.filter(c => c.connected);
  const available = connectors.filter(c => !c.connected);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 880 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Integrations</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Bind connector accounts to this agent. Tools from each connector become callable inside agent turns.</div>
      </div>

      {loading ? (
        <Skeleton height={120} />
      ) : (
        <>
          {connected.length > 0 && (
            <div>
              <h3 className="h-section" style={{ marginBottom: 8 }}>Connected ({connected.length})</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
                {connected.map(c => (
                  <ConnectorCard key={c.slug} c={c} bound={bound.includes(c.slug)} onToggle={() => toggle(c.slug)} />
                ))}
              </div>
            </div>
          )}

          <div>
            <h3 className="h-section" style={{ marginBottom: 8 }}>Available ({available.length})</h3>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
              Connect via OAuth to enable per-agent binding.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10 }}>
              {available.map(c => (
                <ConnectorCard key={c.slug} c={c} bound={false} onToggle={() => {
                  toast.info("Connect first", "Open Integrations to authorize this account.");
                }} />
              ))}
            </div>
            <Link href="/integrations" className="btn" style={{ marginTop: 14, fontSize: 12, padding: "6px 14px" }}>
              Open integrations →
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function ConnectorCard({ c, bound, onToggle }: { c: any; bound: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} className="card"
      style={{
        padding: 12, textAlign: "left", cursor: "pointer",
        borderColor: bound ? "var(--accent)" : "var(--border)",
        borderWidth: bound ? 2 : 1,
        background: bound ? "var(--accent-bg)" : "var(--bg-elev)",
        position: "relative",
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{
          width: 32, height: 32, borderRadius: 7,
          background: c.color || "var(--bg-subtle)",
          color: c.textColor || "var(--text)",
          display: "grid", placeItems: "center", fontSize: 14, fontWeight: 700,
          flexShrink: 0,
        }}>{c.icon || c.name?.[0] || "?"}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</div>
          <div style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 1 }}>
            {c.connected ? (bound ? "Bound" : "Connected") : "Not connected"}
          </div>
        </div>
        {bound && <span style={{ fontSize: 14, color: "var(--accent)" }}>✓</span>}
      </div>
    </button>
  );
}

// ============ Tools Tab ============
//
// Native tool catalog grouped by category. Toggle-to-bind. Persists into
// agents.tools through the existing PATCH endpoint.

export function ToolsTab({ agent, onSave }: {
  agent: AgentLike;
  onSave: (patch: Partial<AgentLike>) => Promise<void>;
}) {
  const [bound, setBound] = useState<string[]>(agent.tools || []);
  async function toggle(name: string) {
    const next = bound.includes(name) ? bound.filter(x => x !== name) : [...bound, name];
    setBound(next);
    await onSave({ tools: next });
  }
  const byCategory = NATIVE_TOOL_CATALOG.reduce((acc: any, t) => {
    (acc[t.category] = acc[t.category] || []).push(t); return acc;
  }, {});

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 880 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Tools</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Native tools the agent can call. {bound.length} of {NATIVE_TOOL_CATALOG.length} enabled.
        </div>
      </div>
      {Object.entries(byCategory).map(([cat, tools]: [string, any]) => (
        <div key={cat}>
          <h3 className="h-section" style={{ marginBottom: 10 }}>{cat}</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
            {tools.map((t: any) => (
              <button key={t.name} onClick={() => toggle(t.name)} className="card"
                style={{
                  padding: 12, textAlign: "left", cursor: "pointer",
                  borderColor: bound.includes(t.name) ? "var(--accent)" : "var(--border)",
                  borderWidth: bound.includes(t.name) ? 2 : 1,
                  background: bound.includes(t.name) ? "var(--accent-bg)" : "var(--bg-elev)",
                }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</div>
                  {bound.includes(t.name) && <span style={{ fontSize: 12, color: "var(--accent)" }}>✓</span>}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.4 }}>{t.description}</div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ============ Memory Tab ============

export function MemoryTab({ agent }: { agent: AgentLike }) {
  const [memories, setMemories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    fetch(`/api/memories?agentId=${agent.id}&filter=accepted`).then(r => r.json()).then(j => {
      setMemories(j.memories || []);
      setLoading(false);
    });
  }, [agent.id]);
  useEffect(() => { reload(); }, [reload]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 800 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Memory</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Memories scoped to this agent. Plus all global memories that apply to every agent.</div>
      </div>
      {loading ? <Skeleton height={120} /> : memories.length === 0 ? (
        <EmptyState
          title="No agent-scoped memories yet"
          body="Memories saved with this agent's id will appear here. Save anything from a chat with the + Save as memory button."
          ctaLabel="Open Learning"
          ctaHref="/learning"
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {memories.map(m => (
            <div key={m.id} className="card" style={{ padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: "rgba(34,197,94,0.10)", color: "#22c55e" }}>
                  ACCEPTED
                </span>
                {m.pinned && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: "rgba(59,130,246,0.10)", color: "#3b82f6" }}>📌 PINNED</span>}
                <span style={{ fontSize: 10, color: "var(--text-faint)" }}>importance {m.importance}/10</span>
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>{m.content}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ Skills Tab ============

export function SkillsTab({ agent }: { agent: AgentLike }) {
  const [skills, setSkills] = useState<any[]>([]);
  useEffect(() => {
    fetch("/api/skills").then(r => r.json()).then(j => setSkills(j.skills || []));
  }, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 800 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Skills</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Reusable system-prompt additions. {skills.length} installed.</div>
      </div>
      {skills.length === 0 ? (
        <EmptyState
          title="No skills installed"
          body="Browse the template gallery and install skills like Stripe operator, Board memo writer, Competitive teardown."
          ctaLabel="Browse skill templates"
          ctaHref="/skills"
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
          {skills.map(s => (
            <div key={s.id} className="card" style={{ padding: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 4 }}>{s.description}</div>
              <div style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 6 }}>{s.category}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ Knowledge Tab (deferred to P40) ============

export function KnowledgeTab() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Knowledge</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Documents the agent can read and retrieve from.</div>
      </div>
      <div className="card" style={{
        padding: 24, textAlign: "center",
        background: "rgba(168,85,247,0.06)",
        borderColor: "rgba(168,85,247,0.30)",
      }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: "#a855f7", letterSpacing: 0.5, marginBottom: 8 }}>COMING IN P40</div>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>Document upload + chunked retrieval</div>
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", maxWidth: 480, margin: "0 auto", lineHeight: 1.55 }}>
          Knowledge mirrors the memory subsystem at the document-chunk level: upload PDFs / docs / pages, the system chunks and embeds them, and the agent retrieves the most-relevant chunks at run-time. Auth, audit, and budget all flow through the existing pipeline.
        </div>
      </div>
    </div>
  );
}

// ============ Rubrics Tab ============

export function RubricsTab({ agent }: { agent: AgentLike }) {
  const [rubrics, setRubrics] = useState<any[]>([]);
  useEffect(() => {
    fetch("/api/rubrics").then(r => r.json()).then(j => setRubrics(j.rubrics || []));
  }, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 800 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Rubrics</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Evaluation criteria applied to multi-step runs. Pinned rubrics auto-fire after each turn.</div>
      </div>
      {rubrics.length === 0 ? (
        <EmptyState
          title="No rubrics yet"
          body="Build a rubric and pin it to evaluate every multi-step run automatically."
          ctaLabel="Open Learning"
          ctaHref="/learning"
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rubrics.map(r => (
            <div key={r.id} className="card" style={{ padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{r.name}</span>
                {r.isBuiltin && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: "rgba(168,85,247,0.10)", color: "#a855f7" }}>BUILT-IN</span>}
                {r.isPinned && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: "rgba(59,130,246,0.10)", color: "#3b82f6" }}>📌 PINNED</span>}
              </div>
              {r.description && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{r.description}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ Library Tab ============

export function LibraryTab({ agent }: { agent: AgentLike }) {
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch("/api/library").then(r => r.json()).then(j => {
      setArtifacts((j.artifacts || []).filter((a: any) => a.agentId === agent.id));
      setLoading(false);
    });
  }, [agent.id]);
  const colors: any = {
    webpage: { bg: "linear-gradient(135deg,#fed7aa,#fdba74)", fg: "#c2410c" },
    document: { bg: "linear-gradient(135deg,#d1fae5,#6ee7b7)", fg: "#15803d" },
    table: { bg: "linear-gradient(135deg,#bae6fd,#7dd3fc)", fg: "#1d4ed8" },
    image: { bg: "linear-gradient(135deg,#ddd6fe,#c4b5fd)", fg: "#6d28d9" },
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1100 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Library</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Artifacts produced in threads bound to this agent.</div>
      </div>
      {loading ? <Skeleton height={140} /> : artifacts.length === 0 ? (
        <EmptyState
          title="No artifacts yet"
          body="Artifacts created in this agent's threads — webpages, documents, tables, images — will appear here."
          ctaLabel="Open Library"
          ctaHref="/library"
        />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
          {artifacts.slice(0, 50).map(a => {
            const c = colors[a.type] || colors.webpage;
            return (
              <Link key={a.id} href={`/library/${a.id}`} className="card"
                style={{ padding: 0, overflow: "hidden", textDecoration: "none", color: "inherit" }}>
                <div style={{ height: 100, background: c.bg, color: c.fg, display: "grid", placeItems: "center", fontFamily: "Instrument Serif,serif", fontSize: 16, padding: 12, textAlign: "center" }}>{a.title}</div>
                <div style={{ padding: "8px 12px" }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.title}</div>
                  <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{a.type} · {new Date(a.createdAt).toLocaleDateString()}</div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============ Security / Budget Tab ============

export function SecurityTab({ agent, onSave }: {
  agent: AgentLike;
  onSave: (patch: Partial<AgentLike>) => Promise<void>;
}) {
  const [budget, setBudget] = useState<number | "">(agent.maxRunBudgetCredits ?? "");
  const [extendedThinking, setExtendedThinking] = useState(!!agent.extendedThinking);
  const dirty = budget !== (agent.maxRunBudgetCredits ?? "") ||
    extendedThinking !== !!agent.extendedThinking;

  async function commit() {
    await onSave({
      maxRunBudgetCredits: budget === "" ? null : Number(budget),
      extendedThinking,
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Budget &amp; Security</h2>
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Per-agent overrides. Account-default sandbox policy still applies — manage in Settings.</div>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>Budget cap per run</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
          Hard ceiling — when reached the run exits cleanly. Default 5,000 credits (~$5).
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            type="number" min={100} max={50000} step={100}
            value={budget} onChange={e => setBudget(e.target.value === "" ? "" : Number(e.target.value))}
            placeholder="No cap (use account default)"
            style={{
              width: 200, padding: "8px 12px",
              border: "1px solid var(--border)", borderRadius: 7,
              background: "var(--bg)", color: "var(--text)", fontSize: 13,
            }}
          />
          {budget !== "" && (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              ≈ ${(Number(budget) * 0.001).toFixed(2)} per run
            </span>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button" onClick={() => setExtendedThinking(!extendedThinking)}
            style={{
              position: "relative", width: 36, height: 22, borderRadius: 99,
              background: extendedThinking ? "var(--text)" : "var(--bg-subtle)",
              border: `1px solid ${extendedThinking ? "var(--text)" : "var(--border)"}`,
              cursor: "pointer", flexShrink: 0,
            }}
          >
            <span style={{
              position: "absolute", top: 2, left: extendedThinking ? 16 : 2,
              width: 16, height: 16, borderRadius: 99,
              background: extendedThinking ? "var(--bg)" : "var(--text)",
            }} />
          </button>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Extended thinking</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
              Adaptive reasoning that auto-adjusts depth. Higher quality, slightly higher cost.
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>Sandbox policy</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
          Domain allowlist + concurrency cap apply across all your agents.
        </div>
        <Link href="/settings" className="btn" style={{ fontSize: 11.5, padding: "5px 12px" }}>
          Manage sandbox policy →
        </Link>
      </div>

      {dirty && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn btn-primary" onClick={commit}>Save changes</button>
        </div>
      )}
    </div>
  );
}

// ============ Shared empty-state ============

function EmptyState({ title, body, ctaLabel, ctaHref }: {
  title: string; body: string; ctaLabel: string; ctaHref: string;
}) {
  return (
    <div className="card" style={{ padding: 32, textAlign: "center" }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 16, maxWidth: 460, margin: "0 auto 16px", lineHeight: 1.5 }}>{body}</div>
      <Link href={ctaHref} className="btn" style={{ fontSize: 12, padding: "6px 14px" }}>{ctaLabel}</Link>
    </div>
  );
}
