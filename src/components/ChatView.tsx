"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter as useNextRouter } from "next/navigation";
import { SaveMemoryButton } from "@/components/SaveMemoryButton";
import { useToast } from "@/components/Toast";
import { AddMenu, RunModeMenu, type RunMode } from "@/components/ComposerMenu";
import { MODELS, modelsByProvider, getModel } from "@/lib/models";

interface Attachment {
  kind: "image" | "file";
  name: string;
  contentType: string;
  size: number;
  dataUrl?: string;
  textPreview?: string;
}

interface Msg {
  id?: string; role: "user" | "assistant"; content: string;
  toolCalls?: any[]; artifactIds?: string[]; attachments?: Attachment[];
  streaming?: boolean; costCredits?: number; runId?: string;
  // P44 — flagged when the user sent runMode=plan_first; surfaces the
  // approve/edit/reject controls under the assistant's plan summary.
  wasPlanFirst?: boolean;
  planResolved?: boolean;
}

export function ChatView({ threadId, agentId }: { threadId: string; agentId: string | null }) {
  const toast = useToast();
  const nextRouter = useNextRouter();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [routerNote, setRouterNote] = useState<string | null>(null);
  const [agents, setAgents] = useState<any[]>([]);
  const [useRouter, setUseRouter] = useState(false);
  // P55 — per-thread model override. Persisted to localStorage so reopening
  // the thread keeps your selection. "" means "use the agent / account default".
  const [modelOverride, setModelOverride] = useState<string>("");
  useEffect(() => {
    try {
      const v = localStorage.getItem(`chat-model:${threadId}`);
      if (v !== null) setModelOverride(v);
    } catch {}
  }, [threadId]);
  function pickModel(id: string) {
    setModelOverride(id);
    try { localStorage.setItem(`chat-model:${threadId}`, id); } catch {}
  }
  // P31 — pending attachments staged on the composer.
  const [pending, setPending] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  // P38 — run-mode for the next send. Plan-first triggers a planning-only
  // turn server-side; subsequent turns default back to "execute".
  const [runMode, setRunMode] = useState<RunMode>("execute");
  // Track the last completed assistant runId so the "Run evaluation" /
  // "Give feedback" actions in RunModeMenu have a target.
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  // P43 — track the in-flight runId so the Stop button can hit
  // /api/runs/[id]/cancel and short-circuit the loop between iterations.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const r = await fetch(`/api/threads/${threadId}`); const j = await r.json();
    if (j.messages) setMessages(j.messages);
  }, [threadId]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { fetch("/api/agents").then(r => r.json()).then(j => setAgents(j.agents || [])); }, []);
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);
  // P28b — pre-fill the input from a #seed=... URL hash.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const m = window.location.hash.match(/^#seed=(.+)$/);
    if (m) {
      try { setInput(decodeURIComponent(m[1])); } catch {}
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, [threadId]);

  // P31 — upload a file and stage it as a pending attachment. Routes to
  // the upload endpoint with attachToMessage=1 so the server returns the
  // attachment metadata without creating a separate message/artifact.
  async function uploadAttachment(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("threadId", threadId);
      fd.append("file", file);
      fd.append("attachToMessage", "1");
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok || !j.attachment) {
        toast.error("Upload failed", j.error || j.hint || `Unsupported: ${file.type}`);
        return;
      }
      setPending(p => [...p, j.attachment]);
    } catch (e: any) {
      toast.error("Upload failed", e.message);
    } finally {
      setUploading(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files || []);
    for (const f of files) uploadAttachment(f);
  }

  function onPaste(e: React.ClipboardEvent) {
    const items = Array.from(e.clipboardData?.items || []);
    for (const it of items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) uploadAttachment(f);
      }
    }
  }

  async function send() {
    const text = input.trim();
    if ((!text && pending.length === 0) || streaming) return;
    setInput("");
    setStreaming(true);
    setRouterNote(null);
    const attachmentsForSend = pending;
    setPending([]);

    setMessages(m => [
      ...m,
      { role: "user", content: text, attachments: attachmentsForSend },
      { role: "assistant", content: "", streaming: true },
    ]);

    // P43 — abort controller so the Stop button can interrupt the SSE stream
    // on the client. We also fire a /cancel on the runId once we know it
    // (server-side cooperative cancel between iterations).
    abortRef.current = new AbortController();
    setActiveRunId(null);

    try {
      const r = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          threadId, content: text, useRouter: useRouter && !agentId,
          attachments: attachmentsForSend.length > 0 ? attachmentsForSend : undefined,
          runMode,
          modelId: modelOverride || undefined,
        }),
      });
      if (!r.ok || !r.body) throw new Error("Chat request failed");
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let assistantText = "";
      const toolCalls: any[] = [];
      const artifactIds: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          const json = part.slice(6).trim();
          if (!json) continue;
          let ev: any;
          try { ev = JSON.parse(json); } catch { continue; }
          if (ev.type === "started") {
            // P43 — capture the runId early so the Stop button can target it.
            if (ev.runId) setActiveRunId(ev.runId);
          } else if (ev.type === "delta") {
            assistantText += ev.text;
            setMessages(m => {
              const c = [...m];
              c[c.length - 1] = { ...c[c.length - 1], content: assistantText, streaming: true };
              return c;
            });
          } else if (ev.type === "tool_use") {
            toolCalls.push({ id: ev.id, name: ev.name, args: ev.input });
            setMessages(m => {
              const c = [...m];
              c[c.length - 1] = { ...c[c.length - 1], toolCalls: [...toolCalls], streaming: true };
              return c;
            });
          } else if (ev.type === "tool_result") {
            const idx = toolCalls.findIndex(t => t.id === ev.id);
            if (idx >= 0) toolCalls[idx] = { ...toolCalls[idx], result: ev.result, durationMs: ev.durationMs };
            setMessages(m => {
              const c = [...m];
              c[c.length - 1] = { ...c[c.length - 1], toolCalls: [...toolCalls], streaming: true };
              return c;
            });
          } else if (ev.type === "artifact") {
            artifactIds.push(ev.artifactId);
            setMessages(m => {
              const c = [...m];
              c[c.length - 1] = { ...c[c.length - 1], artifactIds: [...artifactIds], streaming: true };
              return c;
            });
          } else if (ev.type === "router") {
            setRouterNote(ev.reason);
          } else if (ev.type === "done") {
            // P44 — tag the just-completed assistant message as a plan
            // summary if this turn was plan-first. The flag drives the
            // Approve / Edit / Reject controls in MessageView.
            const wasPlanFirst = runMode === "plan_first";
            setMessages(m => {
              const c = [...m];
              c[c.length - 1] = { ...c[c.length - 1], streaming: false, costCredits: ev.costCredits, runId: ev.runId, wasPlanFirst };
              return c;
            });
            // P38 — capture the completed runId so RunModeMenu actions
            // (Run eval / Give feedback) have a target. Plan-first auto-
            // resets to execute so the user's next turn runs normally.
            if (ev.runId) setLastRunId(ev.runId);
            if (runMode === "plan_first") setRunMode("execute");
          } else if (ev.type === "error") {
            setMessages(m => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: assistantText + "\n\n[error: " + ev.message + "]", streaming: false }; return c; });
          }
        }
      }
      reload();
    } catch (e: any) {
      // P43 — AbortController-triggered aborts surface as "AbortError" or
      // a network failure. Don't surface those as errors — the user clicked
      // Stop on purpose.
      if (e.name === "AbortError" || /aborted/i.test(e.message || "")) {
        setMessages(m => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], streaming: false, content: (c[c.length - 1].content || "") + "\n\n[Stopped]" }; return c; });
      } else {
        setMessages(m => { const c = [...m]; c[c.length - 1] = { role: "assistant", content: "Error: " + e.message }; return c; });
      }
    } finally {
      setStreaming(false);
      setActiveRunId(null);
      abortRef.current = null;
    }
  }

  // P43 — Stop the in-flight turn. Aborts the client-side SSE stream and
  // fires a cooperative cancel on the server (chat loop checks
  // isRunCancelled between iterations and exits cleanly).
  async function stop() {
    abortRef.current?.abort();
    if (activeRunId) {
      try { await fetch(`/api/runs/${activeRunId}/cancel`, { method: "POST" }); }
      catch (e) { /* best effort */ }
    }
  }

  // P44 — Plan approval. After a plan-first turn lands, the user can
  // approve (sends "go" with runMode=execute), or reject (just hides the
  // controls). Edit isn't a separate action — the user can simply type a
  // new message that revises the plan.
  async function approvePlan(index: number) {
    setMessages(m => { const c = [...m]; c[index] = { ...c[index], planResolved: true }; return c; });
    setRunMode("execute");
    setInput("go");
    // Slight delay so React commits the input before send reads it
    setTimeout(() => send(), 30);
  }
  function rejectPlan(index: number) {
    setMessages(m => { const c = [...m]; c[index] = { ...c[index], planResolved: true }; return c; });
  }

  // P49 — Fork from a specific user message. Creates a new thread with all
  // messages up to (and including) the chosen message, then routes there.
  async function forkFromMessage(messageId: string) {
    const r = await fetch(`/api/threads/${threadId}/fork`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromMessageId: messageId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.threadId) {
      toast.error("Fork failed", j.error || "could not fork from this message");
      return;
    }
    toast.success("Forked", `Copied ${j.copiedMessages} message${j.copiedMessages === 1 ? "" : "s"} to a new thread.`);
    nextRouter.push(`/threads/${j.threadId}`);
  }

  return (
    <div
      style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}
      onDragEnter={e => { e.preventDefault(); setDragging(true); }}
      onDragOver={e => { e.preventDefault(); }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}>
      {dragging && (
        <div style={{
          position: "absolute", inset: 12, zIndex: 50,
          border: "2px dashed var(--accent)", borderRadius: 14,
          background: "var(--accent-bg)",
          display: "grid", placeItems: "center",
          color: "var(--accent)", fontSize: 14, fontWeight: 500,
          pointerEvents: "none",
        }}>
          Drop files here — images attach to your message; other types become artifacts.
        </div>
      )}
      {/* P55 — Model picker pill, upper-right of the chat. Per-thread, persisted
          in localStorage. "Default" = use the agent/account model. Selecting a
          non-Anthropic model shows a hint badge since the chat tool-loop falls
          back to the default for those (see chat/route.ts P54 guard). */}
      <ChatModelPicker selected={modelOverride} onChange={pickModel} />

      <div ref={messagesRef} style={{ flex: 1, overflowY: "auto", padding: "32px 32px 8px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
          {messages.length === 0 && (
            <div style={{ textAlign: "center", padding: "64px 24px" }}>
              <div className="h-display" style={{ fontSize: 48, marginBottom: 12 }}>What can <em>Hyperagent</em> do for you?</div>
              <div style={{ color: "var(--text-muted)", fontSize: 16, marginBottom: 24, maxWidth: 520, marginLeft: "auto", marginRight: "auto" }}>Ask anything. Hyperagent can search, write, build artifacts, and run tools.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 520, margin: "0 auto" }}>
                {[
                  "Pull together a brief on the EU AI Act",
                  "Find me 5 dinner spots in NYC for Friday night",
                  "Summarize the news about AI regulation today",
                  "Build a competitive teardown of Linear",
                ].map(p => (
                  <button key={p} onClick={() => setInput(p)} className="btn" style={{ textAlign: "left", padding: "12px 18px", borderRadius: 10 }}>{p}</button>
                ))}
              </div>
              <div style={{ marginTop: 28, fontSize: 12, color: "var(--text-faint)" }}>
                Press <kbd style={{ padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-elev)", fontSize: 11, fontFamily: "JetBrains Mono, monospace" }}>⌘K</kbd> to search threads, agents, and pages.
              </div>
            </div>
          )}
          {routerNote && (
            <div style={{ background: "var(--accent-bg)", color: "var(--accent)", padding: "8px 12px", borderRadius: 8, fontSize: 12, alignSelf: "flex-start" }}>
              ◆ Router picked an agent — {routerNote}
            </div>
          )}
          {messages.map((m, i) => (
            <MessageView key={i} m={m}
              onApprovePlan={() => approvePlan(i)}
              onRejectPlan={() => rejectPlan(i)}
              onFork={m.id ? () => forkFromMessage(m.id!) : undefined}
            />
          ))}
        </div>
      </div>
      <div style={{ padding: "0 32px 24px", maxWidth: 760, width: "100%", margin: "0 auto", flexShrink: 0 }}>
        <div style={{ border: "1px solid var(--border-strong)", borderRadius: 14, background: "var(--bg-elev)", padding: "14px 16px", boxShadow: "0 4px 24px rgba(28,25,23,0.04)" }}>
          {/* P31 — staged attachment pills */}
          {pending.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {pending.map((a, i) => (
                <AttachmentPill key={i} a={a} onRemove={() => setPending(p => p.filter((_, j) => j !== i))} />
              ))}
            </div>
          )}
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            onPaste={onPaste}
            placeholder={pending.length > 0 ? "Add a message about the attachment…" : "Reply to Hyperagent…"}
            disabled={streaming}
            rows={1}
            style={{ width: "100%", border: "none", outline: "none", background: "transparent", color: "var(--text)", resize: "none", fontSize: 14.5, fontFamily: "inherit", lineHeight: 1.55, minHeight: 22, maxHeight: 200 }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
            <input ref={fileInputRef} type="file" multiple accept="image/*,.txt,.md,.csv,.json,.tsv,.log"
              style={{ display: "none" }}
              onChange={async e => {
                const files = Array.from(e.target.files || []);
                for (const f of files) await uploadAttachment(f);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }} />
            {/* P38 — sectioned + button menu (uploads / outputs / memories / skills / integrations / assets) */}
            <AddMenu
              threadId={threadId}
              onPickFile={() => fileInputRef.current?.click()}
              onInsertReference={(token) => setInput(prev => prev ? `${prev} ${token} ` : `${token} `)}
            />
            {!agentId && (
              <label style={{ fontSize: 11.5, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 7, cursor: "pointer" }}>
                <input type="checkbox" checked={useRouter} onChange={e => setUseRouter(e.target.checked)} style={{ margin: 0 }} />
                Smart route
              </label>
            )}
            <span style={{ fontSize: 11.5, color: "var(--text-faint)", padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 7 }}>
              {agentId ? agents.find((a: any) => a.id === agentId)?.name || "Agent" : "Default"}
            </span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
              {/* P43 — Stop button visible mid-stream so users can interrupt
                  without leaving the thread. Aborts client + fires cooperative
                  cancel server-side. */}
              {streaming && (
                <button onClick={stop} title="Stop the agent"
                  style={{
                    padding: "0 12px", fontSize: 12.5, fontWeight: 500,
                    background: "#dc2626", color: "white",
                    border: "none", borderRadius: 8,
                    cursor: "pointer", height: 32,
                    display: "flex", alignItems: "center", gap: 6,
                  }}>
                  <span style={{ fontSize: 11 }}>■</span>
                  Stop
                </button>
              )}
              {/* P38 — run-mode menu (Plan first / Execute / actions) replaces the bare Send button */}
              <RunModeMenu
                threadId={threadId}
                agentId={agentId}
                lastRunId={lastRunId}
                runMode={runMode}
                onChangeRunMode={setRunMode}
                onSend={send}
                disabled={streaming || (!input.trim() && pending.length === 0)}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AttachmentPill({ a, onRemove }: { a: Attachment; onRemove: () => void }) {
  const sizeKb = (a.size / 1024).toFixed(1);
  if (a.kind === "image" && a.dataUrl) {
    return (
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <img src={a.dataUrl} alt={a.name} style={{
          height: 56, maxWidth: 120, objectFit: "cover",
          borderRadius: 8, border: "1px solid var(--border)",
        }} />
        <button onClick={onRemove} title="Remove" style={{
          position: "absolute", top: -6, right: -6,
          width: 18, height: 18, borderRadius: 99,
          background: "var(--text)", color: "var(--bg)",
          border: "1px solid var(--bg-elev)", fontSize: 11, lineHeight: 1,
          padding: 0, display: "grid", placeItems: "center",
        }}>×</button>
      </div>
    );
  }
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "6px 10px", border: "1px solid var(--border)",
      borderRadius: 7, background: "var(--bg-subtle)", fontSize: 12,
    }}>
      <span style={{ color: "var(--text-faint)" }}>📎</span>
      <span style={{ fontWeight: 500, maxWidth: 180, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</span>
      <span style={{ color: "var(--text-faint)", fontSize: 11 }}>{sizeKb} KB</span>
      <button onClick={onRemove} title="Remove" style={{
        background: "transparent", border: "none", color: "var(--text-faint)",
        fontSize: 13, padding: 0, marginLeft: 2,
      }}>×</button>
    </div>
  );
}

function MessageView({ m, onApprovePlan, onRejectPlan, onFork }: {
  m: Msg;
  onApprovePlan?: () => void;
  onRejectPlan?: () => void;
  onFork?: () => void;
}) {
  if (m.role === "user") {
    return (
      <div className="msg-user-row" style={{ alignSelf: "flex-end", maxWidth: "75%", display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end", position: "relative" }}>
        {m.attachments && m.attachments.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
            {m.attachments.map((a, i) => (
              a.kind === "image" && a.dataUrl ? (
                <img key={i} src={a.dataUrl} alt={a.name} style={{
                  maxWidth: 280, maxHeight: 220, objectFit: "cover",
                  borderRadius: 10, border: "1px solid var(--border)",
                }} />
              ) : (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 12px", border: "1px solid var(--border)",
                  borderRadius: 8, background: "var(--bg-elev)", fontSize: 12.5,
                }}>
                  <span style={{ color: "var(--text-faint)" }}>📎</span>
                  <span style={{ fontWeight: 500 }}>{a.name}</span>
                  <span style={{ color: "var(--text-faint)", fontSize: 11 }}>{(a.size / 1024).toFixed(1)} KB</span>
                </div>
              )
            ))}
          </div>
        )}
        {m.content && (
          <div style={{ background: "var(--bg-subtle)", padding: "11px 16px", borderRadius: "16px 16px 4px 16px", fontSize: 14.5, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{m.content}</div>
        )}
        {/* P49 — fork button: branches a new thread from this point. Hover-only
            to keep the message column clean; falls back to always-visible
            on touch devices via @media. */}
        {onFork && (
          <button onClick={onFork} className="msg-fork-btn" title="Fork from here — branch a new thread"
            style={{
              position: "absolute", top: -4, right: -32,
              width: 26, height: 26, borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)", color: "var(--text-muted)",
              display: "grid", placeItems: "center", cursor: "pointer",
              fontSize: 12, opacity: 0, transition: "opacity 0.15s",
            }}>⤴</button>
        )}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ width: 28, height: 28, borderRadius: 8, background: "var(--text)", color: "var(--bg)", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>H</div>
      <div style={{ flex: 1, minWidth: 0, fontSize: 14.5, lineHeight: 1.65 }}>
        {m.content && <div className={m.streaming ? "typing-cursor" : ""} style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>}
        {m.toolCalls?.map((tc, i) => <ToolCard key={i} tc={tc} />)}
        {m.artifactIds?.map(aid => <ArtifactRef key={aid} artifactId={aid} />)}
        {/* P44 — Plan approval controls. Shown under a plan-first message
            until the user approves (sends 'go') or rejects. Edit is implicit:
            type a message to revise. */}
        {m.wasPlanFirst && !m.planResolved && !m.streaming && (
          <div style={{
            marginTop: 12, padding: 12,
            background: "rgba(168,85,247,0.06)",
            border: "1px solid rgba(168,85,247,0.30)",
            borderRadius: 10,
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <div style={{ flex: 1, fontSize: 12.5, color: "var(--text-muted)" }}>
              Plan ready. Approve to execute, or type a message below to revise.
            </div>
            <button onClick={onRejectPlan} className="btn"
              style={{ fontSize: 12, padding: "5px 12px" }}>
              Skip
            </button>
            <button onClick={onApprovePlan} className="btn btn-primary"
              style={{ fontSize: 12, padding: "5px 14px" }}>
              ▶ Approve &amp; execute
            </button>
          </div>
        )}
        {/* P25b + P27b — save-as-memory + cost footer on completed assistant messages */}
        {m.content && !m.streaming && (
          <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <SaveMemoryButton messageText={m.content} />
            {typeof m.costCredits === "number" && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {m.costCredits.toLocaleString()} credits · ${(m.costCredits * 0.001).toFixed(3)}
              </span>
            )}
            {m.runId && (
              <a href={`/api/traces/${m.runId}`} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 11, color: "var(--text-faint)", textDecoration: "none" }}>
                trace →
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCard({ tc }: { tc: any }) {
  const [open, setOpen] = useState(false);
  const argSummary = Object.values(tc.args || {}).map(v => typeof v === "string" ? `"${v.slice(0, 40)}"` : "").filter(Boolean).join(", ");
  return (
    <div style={{ margin: "12px 0", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", background: "var(--bg-elev)" }}>
      <div onClick={() => setOpen(!open)} style={{ padding: "9px 14px", display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, background: "var(--bg-subtle)", cursor: "pointer", borderBottom: open ? "1px solid var(--border)" : "none" }}>
        <span style={{ width: 6, height: 6, borderRadius: 99, background: tc.result ? "var(--green)" : "var(--text-faint)", boxShadow: tc.result ? "0 0 0 3px var(--green-bg)" : "none" }} />
        <span style={{ fontWeight: 600 }}>{tc.name}</span>
        <span className="mono" style={{ color: "var(--text-muted)", fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{argSummary}</span>
        {tc.durationMs && <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>{(tc.durationMs / 1000).toFixed(1)}s</span>}
        <span style={{ fontSize: 10, opacity: 0.5, transform: open ? "none" : "rotate(-90deg)" }}>▾</span>
      </div>
      {open && tc.result && (
        <pre style={{ padding: "12px 14px", fontSize: 12, color: "var(--text-muted)", whiteSpace: "pre-wrap", fontFamily: "JetBrains Mono, monospace", lineHeight: 1.6, margin: 0, maxHeight: 320, overflow: "auto" }}>{tc.result}</pre>
      )}
    </div>
  );
}

function ArtifactRef({ artifactId }: { artifactId: string }) {
  const [art, setArt] = useState<any>(null);
  useEffect(() => { fetch(`/api/artifacts/${artifactId}`).then(r => r.json()).then(j => setArt(j.artifact)); }, [artifactId]);
  if (!art) return null;
  const colors: any = {
    webpage: "linear-gradient(135deg, #fed7aa, #fdba74)",
    document: "linear-gradient(135deg, #d1fae5, #6ee7b7)",
    table: "linear-gradient(135deg, #bae6fd, #7dd3fc)",
    image: "linear-gradient(135deg, #ddd6fe, #c4b5fd)",
  };
  const fg: any = { webpage: "#c2410c", document: "#15803d", table: "#1d4ed8", image: "#6d28d9" };
  return (
    <a href={`/library/${art.id}`} style={{ display: "block", margin: "12px 0", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", background: "var(--bg-elev)", textDecoration: "none", color: "inherit" }}>
      <div style={{ height: 160, background: colors[art.type], color: fg[art.type], display: "grid", placeItems: "center", fontFamily: "Instrument Serif, serif", fontSize: 22, padding: 16, textAlign: "center" }}>{art.title}</div>
      <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{art.title}</div>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{art.type}</div>
        </div>
        <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Open ↗</span>
      </div>
    </a>
  );
}

// ────────────────────────────────────────────────────────────────────────
// P55 — Chat model picker (upper-right floating pill).
//
// Per-thread, localStorage-persisted. Selecting a non-Anthropic model shows
// a "via fallback" badge because the chat tool-loop currently always uses
// Claude for tool calling — non-Claude selections silently fall back via the
// chat/route.ts guard. The picker still lets the user express intent for
// the moment when full multi-provider chat lands.
function ChatModelPicker({ selected, onChange }: {
  selected: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as any)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);
  const groups = modelsByProvider();
  const current = selected ? getModel(selected) : null;
  const isFallback = current ? current.provider !== "anthropic" : false;
  return (
    <div ref={ref} style={{
      position: "absolute", top: 12, right: 16, zIndex: 30,
    }}>
      <button onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "5px 11px", borderRadius: 999,
          border: "1px solid var(--border)",
          background: "var(--bg-elev)", color: "var(--text-muted)",
          fontSize: 11.5, fontWeight: 500, cursor: "pointer",
        }}>
        <span style={{ width: 6, height: 6, borderRadius: 99,
          background: isFallback ? "#f59e0b" : "var(--green)" }} />
        <span>{current ? current.label : "Default model"}</span>
        <span style={{ fontSize: 9, opacity: 0.5 }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", right: 0,
          width: 260, maxHeight: 380, overflowY: "auto",
          background: "var(--bg)", border: "1px solid var(--border)",
          borderRadius: 10, boxShadow: "0 10px 40px rgba(0,0,0,0.18)",
          padding: 4,
        }}>
          <PickerRow label="Default" sub="Agent / account default"
            active={!selected} onClick={() => { onChange(""); setOpen(false); }} />
          <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
          {(["anthropic", "openai", "google"] as const).map(p => (
            <div key={p}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6,
                color: "var(--text-faint)", textTransform: "uppercase",
                padding: "8px 10px 4px" }}>{p}</div>
              {groups[p].map(m => (
                <PickerRow key={m.id} label={m.label}
                  sub={`${(m.contextWindow / 1000).toFixed(0)}k ctx · $${m.inputPer1k}/$${m.outputPer1k} per 1k`}
                  active={selected === m.id}
                  fallback={p !== "anthropic"}
                  onClick={() => { onChange(m.id); setOpen(false); }} />
              ))}
            </div>
          ))}
          <div style={{ padding: "8px 10px", fontSize: 10.5, color: "var(--text-faint)", lineHeight: 1.4, borderTop: "1px solid var(--border)" }}>
            Non-Claude selections need a key in <a href="/settings#api-keys" style={{ color: "var(--accent)" }} target="_blank" rel="noreferrer">Settings</a>. Tool-loop currently uses Claude internally.
          </div>
        </div>
      )}
    </div>
  );
}

function PickerRow({ label, sub, active, fallback, onClick }: {
  label: string; sub: string; active: boolean; fallback?: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={{
      display: "flex", alignItems: "center", gap: 8, width: "100%",
      padding: "7px 10px", borderRadius: 6,
      border: active ? "1px solid var(--accent)" : "1px solid transparent",
      background: active ? "var(--accent-bg)" : "transparent",
      color: "var(--text)", fontSize: 12, textAlign: "left", cursor: "pointer",
    }} onMouseEnter={e => { if (!active) e.currentTarget.style.background = "var(--bg-subtle)"; }}
       onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
          {label}
          {fallback && <span style={{ fontSize: 9, color: "#f59e0b", fontWeight: 700, letterSpacing: 0.4 }}>FALLBACK</span>}
        </div>
        <div style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 1 }}>{sub}</div>
      </span>
      {active && <span style={{ color: "var(--accent)", fontSize: 12 }}>✓</span>}
    </button>
  );
}
