"use client";
// P53 — Full Project workspace. Tabs: Overview / Chat / Canvas / Knowledge / Settings.
//
// Closes the parity gap with Hyperagent's project surface where every
// project is a working hub: a chat that retains the project's memories
// + artifacts, a canvas of every artifact emitted from any thread in
// the project, knowledge docs scoped to the project, and editable
// metadata (rename, color, archive, delete).

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { Skeleton } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";

type Tab = "overview" | "chat" | "canvas" | "knowledge" | "settings";

const COLOR_DOT: Record<string, string> = {
  orange: "linear-gradient(135deg,#c2410c,#f97316)",
  blue:   "linear-gradient(135deg,#1d4ed8,#3b82f6)",
  green:  "linear-gradient(135deg,#15803d,#22c55e)",
  purple: "linear-gradient(135deg,#6d28d9,#a78bfa)",
};

export default function ProjectPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const j = await fetch(`/api/projects/${params.id}`).then(r => r.json());
    setData(j);
  }, [params.id]);

  useEffect(() => { load(); }, [load]);

  // Hash-based tab routing so back/forward + sharing a tab url works.
  useEffect(() => {
    const sync = () => {
      const h = window.location.hash.slice(1) as Tab;
      if (["overview", "chat", "canvas", "knowledge", "settings"].includes(h)) setTab(h);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  function go(next: Tab) {
    setTab(next);
    if (typeof window !== "undefined") {
      history.replaceState(null, "", `#${next}`);
    }
  }

  async function openProjectChat() {
    setBusy(true);
    const r = await fetch(`/api/projects/${params.id}/chat-thread`, { method: "POST" });
    const j = await r.json();
    setBusy(false);
    if (j.thread?.id) router.push(`/threads/${j.thread.id}`);
    else toast.error("Could not open project chat", j.error || "");
  }

  async function newThreadInProject() {
    setBusy(true);
    const r = await fetch("/api/threads", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: params.id }),
    });
    const j = await r.json();
    setBusy(false);
    if (j.thread?.id) router.push(`/threads/${j.thread.id}`);
  }

  if (!data?.project) {
    return (
      <AppShell>
        <Topbar title="…" />
        <div style={{ padding: 32 }}><Skeleton height={400} /></div>
      </AppShell>
    );
  }
  const p = data.project;

  return (
    <AppShell>
      <Topbar
        breadcrumb={
          <div style={{ fontSize: 13, color: "var(--text-muted)", display: "flex", gap: 8, alignItems: "center" }}>
            <Link href="/projects" style={{ color: "var(--text-muted)", textDecoration: "none" }}>Projects</Link>
            <span style={{ opacity: 0.4 }}>/</span>
            <span style={{
              width: 12, height: 12, borderRadius: 3,
              background: COLOR_DOT[p.color] || COLOR_DOT.orange,
            }} />
            <span style={{ color: "var(--text)", fontWeight: 500 }}>{p.name}</span>
          </div>
        }
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" disabled={busy} onClick={openProjectChat}>+ Project chat</button>
            <button className="btn btn-primary" disabled={busy} onClick={newThreadInProject}>+ New thread</button>
          </div>
        }
      />

      {/* Tab nav */}
      <div style={{
        display: "flex", gap: 4, padding: "12px 32px 0",
        borderBottom: "1px solid var(--border)",
      }}>
        {(["overview", "chat", "canvas", "knowledge", "settings"] as Tab[]).map(t => (
          <button key={t} onClick={() => go(t)}
            style={{
              padding: "10px 14px", border: "none", background: "transparent",
              fontSize: 13, fontWeight: tab === t ? 600 : 500,
              color: tab === t ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", textTransform: "capitalize",
              borderBottom: `2px solid ${tab === t ? "var(--text)" : "transparent"}`,
              marginBottom: -1,
            }}>
            {t}
          </button>
        ))}
      </div>

      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          {tab === "overview" && <OverviewTab data={data} onChanged={load} />}
          {tab === "chat" && <ChatTab projectId={params.id} threads={data.threads} onOpenProjectChat={openProjectChat} />}
          {tab === "canvas" && <CanvasTab artifacts={data.artifacts || []} />}
          {tab === "knowledge" && <KnowledgeTab projectId={params.id} />}
          {tab === "settings" && <SettingsTab project={p} onChanged={load} onDeleted={() => router.push("/projects")} confirm={confirm} toast={toast} />}
        </div>
      </div>
    </AppShell>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────

function OverviewTab({ data, onChanged: _onChanged }: { data: any; onChanged: () => void }) {
  const p = data.project;
  return (
    <div>
      <h1 className="h-display" style={{ fontSize: 36, marginBottom: 6 }}>{p.name}</h1>
      <div style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 32, maxWidth: 720 }}>{p.description || "No description"}</div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 28 }}>
        <Card label="Threads" value={(data.threads || []).length} />
        <Card label="Agents" value={(data.agents || []).length} />
        <Card label="Memories" value={(data.memories || []).length} />
        <Card label="Artifacts" value={(data.artifacts || []).length} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32 }}>
        <div>
          <div className="h-section" style={{ marginBottom: 12 }}>Threads</div>
          {(data.threads || []).length ? data.threads.slice(0, 10).map((t: any) => (
            <Link key={t.id} href={`/threads/${t.id}`} className="card"
              style={{ display: "block", padding: "12px 16px", marginBottom: 6, textDecoration: "none", color: "inherit", fontSize: 13.5 }}>
              <div style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>{new Date(t.updatedAt).toLocaleDateString()}</div>
            </Link>
          )) : <Empty>No threads in this project yet.</Empty>}
        </div>
        <div>
          <div className="h-section" style={{ marginBottom: 12 }}>Agents</div>
          {(data.agents || []).length ? data.agents.map((a: any) => (
            <Link key={a.id} href={`/agents/${a.id}`} className="card"
              style={{ display: "block", padding: "12px 16px", marginBottom: 6, textDecoration: "none", color: "inherit", fontSize: 13.5 }}>
              <div style={{ fontWeight: 500 }}>{a.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>{a.description || "—"}</div>
            </Link>
          )) : <Empty>No project-scoped agents.</Empty>}
          <div className="h-section" style={{ marginTop: 28, marginBottom: 12 }}>Project memories</div>
          {(data.memories || []).length ? data.memories.slice(0, 8).map((m: any) => (
            <div key={m.id} style={{ padding: "10px 14px", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 6, fontSize: 13 }}>{m.content}</div>
          )) : <Empty>No project memories yet. Save anything from a chat with the + Save as memory button.</Empty>}
        </div>
      </div>
    </div>
  );
}

function ChatTab({ projectId: _projectId, threads, onOpenProjectChat }: {
  projectId: string; threads: any[]; onOpenProjectChat: () => void;
}) {
  const projectChat = (threads || []).find(t => t.title?.startsWith("Project chat:"));
  const otherThreads = (threads || []).filter(t => !t.title?.startsWith("Project chat:"));
  return (
    <div>
      <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Chat</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 24 }}>
        Project chat is a single persistent conversation that retains the project&apos;s memories and artifacts.
        Other threads inside the project show below.
      </p>
      <div className="card" style={{ padding: 20, marginBottom: 24, display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{
          width: 48, height: 48, borderRadius: 12,
          background: "var(--accent-bg)", color: "var(--accent)",
          display: "grid", placeItems: "center", fontSize: 22, fontWeight: 700,
        }}>◇</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{projectChat ? "Continue project chat" : "Start the project chat"}</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
            {projectChat ? `Last updated ${new Date(projectChat.updatedAt).toLocaleString()}` : "Auto-created on first open."}
          </div>
        </div>
        <button onClick={onOpenProjectChat} className="btn btn-primary" style={{ fontSize: 13 }}>
          {projectChat ? "Open chat →" : "Start chat →"}
        </button>
      </div>

      {otherThreads.length > 0 && (
        <>
          <div className="h-section" style={{ marginBottom: 10 }}>Other threads in project</div>
          <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            {otherThreads.map((t: any, i: number) => (
              <Link key={t.id} href={`/threads/${t.id}`} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "10px 14px", textDecoration: "none", color: "inherit", fontSize: 13,
                borderTop: i === 0 ? "none" : "1px solid var(--border)",
              }}>
                <span style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", paddingRight: 12 }}>{t.title}</span>
                <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{new Date(t.updatedAt).toLocaleDateString()}</span>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CanvasTab({ artifacts }: { artifacts: any[] }) {
  if (artifacts.length === 0) {
    return (
      <div>
        <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Canvas</h2>
        <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 24 }}>Every artifact emitted from any thread in this project lands here.</p>
        <Empty>No artifacts yet. Generate something in the project chat or any project thread and it&apos;ll appear here.</Empty>
      </div>
    );
  }
  return (
    <div>
      <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Canvas</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 24 }}>{artifacts.length} artifact{artifacts.length === 1 ? "" : "s"} across this project&apos;s threads.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
        {artifacts.map((a: any) => (
          <Link key={a.id} href={`/library/${a.id}`} className="card"
            style={{ padding: 14, display: "block", textDecoration: "none", color: "inherit" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
              {a.kind || "artifact"}
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.title || "(untitled)"}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {new Date(a.createdAt).toLocaleDateString()}
              {a.agentName && ` · ${a.agentName}`}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function KnowledgeTab({ projectId: _projectId }: { projectId: string }) {
  return (
    <div>
      <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Knowledge</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 24 }}>
        Project-scoped knowledge docs land here. Per-agent knowledge is configured on each agent&apos;s Knowledge tab.
      </p>
      <Empty>Project-level knowledge docs aren&apos;t implemented yet — bind docs at the agent level for now and they&apos;ll be retrievable from any thread that runs that agent.</Empty>
    </div>
  );
}

function SettingsTab({ project, onChanged, onDeleted, confirm, toast }: {
  project: any; onChanged: () => void; onDeleted: () => void;
  confirm: any; toast: any;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description || "");
  const [color, setColor] = useState(project.color);
  const [saving, setSaving] = useState(false);

  const dirty = name !== project.name || description !== (project.description || "") || color !== project.color;

  async function save() {
    setSaving(true);
    const r = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), description, color }),
    });
    setSaving(false);
    if (r.ok) { toast.success("Saved"); onChanged(); }
    else { toast.error("Save failed"); }
  }

  async function destroy() {
    const ok = await confirm({
      title: `Delete project "${project.name}"?`,
      body: "Threads and agents in this project will become un-projected (not deleted). Memories scoped to the project are deleted.",
      confirmLabel: "Delete project",
      variant: "destructive",
    });
    if (!ok) return;
    const r = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
    if (r.ok) { toast.success("Deleted"); onDeleted(); }
    else toast.error("Delete failed");
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <h2 className="h-display" style={{ fontSize: 28, marginBottom: 4 }}>Settings</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 24 }}>Edit project metadata or delete it.</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <label className="h-section">Name</label>
          <input className="input" value={name} onChange={e => setName(e.target.value)}
            style={{ marginTop: 6 }} />
        </div>
        <div>
          <label className="h-section">Description</label>
          <textarea className="input" rows={3} value={description} onChange={e => setDescription(e.target.value)}
            style={{ marginTop: 6, resize: "vertical" }} />
        </div>
        <div>
          <label className="h-section">Color</label>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {Object.keys(COLOR_DOT).map(c => (
              <button key={c} type="button" onClick={() => setColor(c)}
                style={{
                  width: 40, height: 40, borderRadius: 10, padding: 0,
                  border: color === c ? "2px solid var(--text)" : "2px solid transparent",
                  background: COLOR_DOT[c], cursor: "pointer",
                }} />
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
        <button onClick={save} disabled={!dirty || saving || !name.trim()}
          className="btn btn-primary" style={{ fontSize: 13 }}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>

      <div style={{ marginTop: 40, padding: 18, border: "1px solid rgba(220,38,38,0.30)", borderRadius: 10, background: "rgba(220,38,38,0.04)" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#dc2626", marginBottom: 4 }}>Danger zone</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
          Deleting a project doesn&apos;t delete its threads — they revert to no-project status.
        </div>
        <button onClick={destroy} className="btn"
          style={{ fontSize: 12.5, color: "#dc2626", borderColor: "rgba(220,38,38,0.30)" }}>
          Delete project
        </button>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function Card({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.1 }}>{value}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 24, fontSize: 13, color: "var(--text-faint)", border: "1px dashed var(--border)", borderRadius: 10, textAlign: "center" }}>
      {children}
    </div>
  );
}
