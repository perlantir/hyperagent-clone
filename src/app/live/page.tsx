"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

export default function LivePage() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [schedules, setSchedules] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [openTpl, setOpenTpl] = useState<any | null>(null);
  const [openCustom, setOpenCustom] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [name, setName] = useState(""); const [prompt, setPrompt] = useState(""); const [agentId, setAgentId] = useState(""); const [intervalMin, setIntervalMin] = useState(60);

  async function reload() {
    const [s, r, a, t] = await Promise.all([
      fetch("/api/schedules"), fetch("/api/runs"), fetch("/api/agents"), fetch("/api/automations/templates"),
    ]);
    setSchedules((await s.json()).schedules || []);
    setRuns((await r.json()).runs || []);
    setAgents((await a.json()).agents || []);
    setTemplates((await t.json()).templates || []);
  }
  useEffect(() => { reload(); const i = window.setInterval(reload, 10000); return () => clearInterval(i); }, []);

  async function createSchedule(payload: { agentId: string; prompt: string; intervalMinutes: number; name: string }) {
    const r = await fetch("/api/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!r.ok) { toast.error("Could not create schedule"); return; }
    toast.success("Activated", `${payload.name} will run every ${payload.intervalMinutes}m.`);
    setOpenTpl(null); setOpenCustom(false); setName(""); setPrompt(""); reload();
  }
  async function saveEdit() {
    if (!editing) return;
    const r = await fetch(`/api/schedules/${editing.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, prompt, intervalMinutes: intervalMin }),
    });
    if (!r.ok) { toast.error("Save failed"); return; }
    toast.success("Saved");
    setEditing(null); reload();
  }
  async function toggle(id: string, active: number) {
    await fetch(`/api/schedules/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: active ? 0 : 1 }) });
    reload();
  }
  async function runNow(id: string) {
    setRunning(id);
    try {
      const r = await fetch(`/api/schedules/${id}/run`, { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        toast.error("Run failed", j.error || "Check your agent configuration and credit balance.");
      } else {
        toast.success("Run completed", j.threadId ? "Open the thread to inspect the output." : "Output captured.");
        if (j.threadId) router.push(`/threads/${j.threadId}`);
      }
      reload();
    } finally {
      setRunning(null);
    }
  }
  async function del(id: string) {
    const ok = await confirm({
      title: "Delete this schedule?",
      body: "Removes the schedule and all its run history.",
      confirmLabel: "Delete", variant: "destructive",
    });
    if (!ok) return;
    await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    toast.success("Deleted"); reload();
  }

  return (
    <AppShell>
      <Topbar title="Live mode" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <h1 className="h-display" style={{ fontSize: 44, marginBottom: 8 }}>Live mode</h1>
          <div style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 32, maxWidth: 580 }}>Automations that run on a schedule. Each one carries a prompt and a delivery target.</div>

          <div className="h-section" style={{ marginBottom: 12 }}>Active automations</div>
          {schedules.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: "center", color: "var(--text-faint)" }}>No automations yet. Pick a template below.</div>
          ) : schedules.map(s => {
            const a = agents.find(x => x.id === s.agentId);
            return (
              <div key={s.id} className="card" style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 12, padding: "14px 18px" }}>
                <div style={{ width: 10, height: 10, borderRadius: 99, background: s.active ? "var(--green)" : "var(--text-faint)", boxShadow: s.active ? "0 0 0 4px var(--green-bg)" : "none" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 600 }}>{s.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a?.name || "—"} · every {s.intervalMinutes}m · last run {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "never"}</div>
                </div>
                <button className="chip" onClick={() => runNow(s.id)} disabled={running === s.id}
                  title="Run this schedule now and route to the resulting thread">
                  {running === s.id ? "Running…" : "▶ Run now"}
                </button>
                <button className="chip" onClick={() => { setEditing(s); setName(s.name); setPrompt(s.prompt); setIntervalMin(s.intervalMinutes); }}>Edit</button>
                <button className="chip" onClick={() => toggle(s.id, s.active)}>{s.active ? "Pause" : "Resume"}</button>
                <button className="chip" onClick={() => del(s.id)}>Delete</button>
              </div>
            );
          })}

          {/* P51 — cron cadence note. On Vercel Hobby, cron fires daily;
              opening this page also opportunistically fires due schedules
              (rate-limited to once per 30s globally). For minute-grade
              cadence, hit /api/cron?token=$CRON_SECRET from an external
              cron service like cron-job.org. Click Run now anytime. */}
          <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 10, lineHeight: 1.5 }}>
            Vercel cron fires once per day on the Hobby plan. Opening this page kicks any due schedules immediately — and Run now bypasses cron entirely. For fine-grained cadence, point an external scheduler at <code className="mono" style={{ background: "var(--bg-subtle)", padding: "1px 6px", borderRadius: 4 }}>/api/cron?token=$CRON_SECRET</code>.
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 40, marginBottom: 12 }}>
            <div className="h-section">Templates</div>
            <button className="btn btn-primary" onClick={() => setOpenCustom(true)}>+ Custom automation</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px,1fr))", gap: 12 }}>
            {templates.map(t => (
              <div key={t.id} className="card" style={{ cursor: "pointer" }} onClick={() => { setOpenTpl(t); setName(t.name); setPrompt(t.prompt); setIntervalMin(t.defaultIntervalMinutes); setAgentId(agents[0]?.id || ""); }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{t.category}</span>
                </div>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{t.name}</div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>{t.description}</div>
                <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>Every {t.defaultIntervalMinutes}m · {t.recommendedTools.join(", ")}</div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 40 }}>
            <div className="h-section" style={{ marginBottom: 12 }}>Recent runs</div>
            {runs.length === 0 ? (
              <div className="card" style={{ padding: 24, textAlign: "center", color: "var(--text-faint)" }}>No runs yet.</div>
            ) : runs.slice(0, 20).map(r => (
              <div key={r.id} className="card" style={{ marginBottom: 6, padding: "12px 16px", fontSize: 13 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: r.status === "ok" ? "var(--green)" : r.status === "error" ? "#dc2626" : "var(--text-faint)" }} />
                  <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{new Date(r.startedAt).toLocaleString()} · {r.status}</span>
                  {r.threadId && <a style={{ marginLeft: "auto", color: "var(--accent)", fontSize: 12 }} href={`/threads/${r.threadId}`}>Open thread →</a>}
                </div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", maxHeight: 80, overflow: "hidden" }}>{r.output.slice(0, 300)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {(openTpl || openCustom) && (
        <div onClick={() => { setOpenTpl(null); setOpenCustom(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "grid", placeItems: "center", zIndex: 100, backdropFilter: "blur(4px)" }}>
          <div onClick={e => e.stopPropagation()} className="card" style={{ width: 540, padding: 24, maxHeight: "80vh", overflowY: "auto" }}>
            <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>{openTpl ? `Set up: ${openTpl.name}` : "Custom automation"}</h2>
            <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>Customize the prompt and schedule, then activate.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div><label className="h-section">Name</label><input className="input" value={name} onChange={e => setName(e.target.value)} style={{ marginTop: 6 }} /></div>
              <div><label className="h-section">Agent</label>
                <select className="input" value={agentId} onChange={e => setAgentId(e.target.value)} style={{ marginTop: 6 }}>
                  <option value="">— pick an agent —</option>
                  {agents.filter(a => a.name.toLowerCase() !== "router").map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div><label className="h-section">Prompt</label><textarea className="input" rows={5} value={prompt} onChange={e => setPrompt(e.target.value)} style={{ marginTop: 6, fontFamily: "JetBrains Mono, monospace", fontSize: 12.5 }} /></div>
              <div><label className="h-section">Interval (minutes)</label><input className="input" type="number" value={intervalMin} onChange={e => setIntervalMin(parseInt(e.target.value || "60"))} style={{ marginTop: 6 }} /></div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
              <button className="btn" onClick={() => { setOpenTpl(null); setOpenCustom(false); }}>Cancel</button>
              <button className="btn btn-primary" disabled={!agentId || !prompt || !name} onClick={() => createSchedule({ agentId, prompt, intervalMinutes: intervalMin, name })}>Activate</button>
            </div>
          </div>
        </div>
      )}

      {/* P51 — Edit-existing-schedule modal. Reuses the name/prompt/interval
          inputs but doesn't change the agent (creating a fresh schedule is
          still the path for "swap to a different agent"). */}
      {editing && (
        <div onClick={() => setEditing(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "grid", placeItems: "center", zIndex: 100, backdropFilter: "blur(4px)" }}>
          <div onClick={e => e.stopPropagation()} className="card" style={{ width: 540, padding: 24, maxHeight: "80vh", overflowY: "auto" }}>
            <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Edit schedule</h2>
            <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>Update the name, prompt, or cadence. To swap agents, delete and recreate.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div><label className="h-section">Name</label><input className="input" value={name} onChange={e => setName(e.target.value)} style={{ marginTop: 6 }} /></div>
              <div><label className="h-section">Prompt</label><textarea className="input" rows={5} value={prompt} onChange={e => setPrompt(e.target.value)} style={{ marginTop: 6, fontFamily: "JetBrains Mono, monospace", fontSize: 12.5 }} /></div>
              <div><label className="h-section">Interval (minutes)</label><input className="input" type="number" value={intervalMin} onChange={e => setIntervalMin(parseInt(e.target.value || "60"))} style={{ marginTop: 6 }} /></div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={!prompt || !name} onClick={saveEdit}>Save</button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
