"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { SaveMemoryButton } from "@/components/SaveMemoryButton";

interface Msg { id?: string; role: "user" | "assistant"; content: string; toolCalls?: any[]; artifactIds?: string[]; streaming?: boolean; }

export function ChatView({ threadId, agentId }: { threadId: string; agentId: string | null }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [routerNote, setRouterNote] = useState<string | null>(null);
  const [agents, setAgents] = useState<any[]>([]);
  const [useRouter, setUseRouter] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);

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

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setStreaming(true);
    setRouterNote(null);

    setMessages(m => [...m, { role: "user", content: text }, { role: "assistant", content: "", streaming: true }]);

    try {
      const r = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, content: text, useRouter: useRouter && !agentId }),
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
          if (ev.type === "delta") {
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
            setMessages(m => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], streaming: false }; return c; });
          } else if (ev.type === "error") {
            setMessages(m => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: assistantText + "\n\n[error: " + ev.message + "]", streaming: false }; return c; });
          }
        }
      }
      reload();
    } catch (e: any) {
      setMessages(m => { const c = [...m]; c[c.length - 1] = { role: "assistant", content: "Error: " + e.message }; return c; });
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
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
            </div>
          )}
          {routerNote && (
            <div style={{ background: "var(--accent-bg)", color: "var(--accent)", padding: "8px 12px", borderRadius: 8, fontSize: 12, alignSelf: "flex-start" }}>
              ◆ Router picked an agent — {routerNote}
            </div>
          )}
          {messages.map((m, i) => <MessageView key={i} m={m} />)}
        </div>
      </div>
      <div style={{ padding: "0 32px 24px", maxWidth: 760, width: "100%", margin: "0 auto", flexShrink: 0 }}>
        <div style={{ border: "1px solid var(--border-strong)", borderRadius: 14, background: "var(--bg-elev)", padding: "14px 16px", boxShadow: "0 4px 24px rgba(28,25,23,0.04)" }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Reply to Hyperagent…"
            disabled={streaming}
            rows={1}
            style={{ width: "100%", border: "none", outline: "none", background: "transparent", color: "var(--text)", resize: "none", fontSize: 14.5, fontFamily: "inherit", lineHeight: 1.55, minHeight: 22, maxHeight: 200 }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
            {!agentId && (
              <label style={{ fontSize: 11.5, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 7, cursor: "pointer" }}>
                <input type="checkbox" checked={useRouter} onChange={e => setUseRouter(e.target.checked)} style={{ margin: 0 }} />
                Smart route
              </label>
            )}
            <span style={{ fontSize: 11.5, color: "var(--text-faint)", padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 7 }}>
              {agentId ? agents.find((a: any) => a.id === agentId)?.name || "Agent" : "Default"}
            </span>
            <button onClick={send} disabled={streaming || !input.trim()}
              style={{ marginLeft: "auto", width: 32, height: 32, borderRadius: 8, border: "none", background: "var(--text)", color: "var(--bg)", fontSize: 14, opacity: streaming || !input.trim() ? 0.3 : 1 }}>
              ↑
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageView({ m }: { m: Msg }) {
  if (m.role === "user") {
    return <div style={{ alignSelf: "flex-end", background: "var(--bg-subtle)", padding: "11px 16px", borderRadius: "16px 16px 4px 16px", fontSize: 14.5, maxWidth: "75%", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{m.content}</div>;
  }
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ width: 28, height: 28, borderRadius: 8, background: "var(--text)", color: "var(--bg)", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>H</div>
      <div style={{ flex: 1, minWidth: 0, fontSize: 14.5, lineHeight: 1.65 }}>
        {m.content && <div className={m.streaming ? "typing-cursor" : ""} style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>}
        {m.toolCalls?.map((tc, i) => <ToolCard key={i} tc={tc} />)}
        {m.artifactIds?.map(aid => <ArtifactRef key={aid} artifactId={aid} />)}
        {/* P25b — save-as-memory only on completed assistant messages with content */}
        {m.content && !m.streaming && (
          <div style={{ marginTop: 6 }}>
            <SaveMemoryButton messageText={m.content} />
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
    <a href={`/api/artifacts/${art.id}?render=1`} target="_blank" rel="noreferrer" style={{ display: "block", margin: "12px 0", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", background: "var(--bg-elev)", textDecoration: "none", color: "inherit" }}>
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
