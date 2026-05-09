"use client";
// P46 — Inline test panel in the agent builder.
//
// Quick test drawer that lets the operator send a message to the agent
// and watch the response stream without leaving the builder. Avoids the
// "edit → save → click + New thread → switch tabs → wait" loop.
//
// Mechanics:
// - One ephemeral thread per builder session (created lazily on first
//   message). Subsequent messages reuse the thread so multi-turn flows
//   work. "Clear" deletes the thread + starts a fresh one.
// - Streams via the same /api/chat SSE endpoint as the real chat view —
//   we render delta text, surface tool_use cards, and display tool_result
//   summaries. No artifact iframes, no plan-approval UI — strictly the
//   "did the prompt change land?" preview surface.
// - AbortController-cancel on Stop / unmount so the panel never leaks
//   a runaway request when the user toggles it closed mid-stream.

import { useEffect, useRef, useState, useCallback } from "react";

interface TestMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  toolCalls: { name: string; args: any; result?: string }[];
  done?: boolean;
}

export function InlineTestPanel({
  agentId,
  systemPromptVersion,
  onClose,
}: {
  agentId: string;
  // Bumped by parent whenever the system prompt is saved — we use it to
  // show the "prompt changed, restart for a clean test" hint.
  systemPromptVersion: number;
  onClose: () => void;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TestMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [lastSavedVersion] = useState(systemPromptVersion);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Cancel in-flight stream on unmount / close.
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const ensureThread = useCallback(async (): Promise<string> => {
    if (threadId) return threadId;
    const r = await fetch("/api/threads", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, title: "[Test] Builder preview" }),
    });
    const j = await r.json();
    setThreadId(j.thread.id);
    return j.thread.id;
  }, [threadId, agentId]);

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    const userMsg: TestMessage = { id: `u-${Date.now()}`, role: "user", text, toolCalls: [] };
    const aMsg: TestMessage = { id: `a-${Date.now()}`, role: "assistant", text: "", toolCalls: [] };
    setMessages(m => [...m, userMsg, aMsg]);
    setStreaming(true);

    try {
      const tid = await ensureThread();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const r = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: tid, content: text, runMode: "execute" }),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) throw new Error("chat failed");
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for (const ev of events) {
          if (!ev.startsWith("data: ")) continue;
          let data: any;
          try { data = JSON.parse(ev.slice(6)); } catch { continue; }

          if (data.type === "delta" && data.text) {
            setMessages(m => m.map(msg => msg.id === aMsg.id
              ? { ...msg, text: msg.text + data.text } : msg));
          } else if (data.type === "tool_use") {
            setMessages(m => m.map(msg => msg.id === aMsg.id
              ? { ...msg, toolCalls: [...msg.toolCalls, { name: data.name, args: data.args }] } : msg));
          } else if (data.type === "tool_result") {
            setMessages(m => m.map(msg => {
              if (msg.id !== aMsg.id) return msg;
              const updated = [...msg.toolCalls];
              const last = updated[updated.length - 1];
              if (last) last.result = typeof data.result === "string" ? data.result : JSON.stringify(data.result);
              return { ...msg, toolCalls: updated };
            }));
          } else if (data.type === "done" || data.type === "error") {
            setMessages(m => m.map(msg => msg.id === aMsg.id ? { ...msg, done: true } : msg));
          }
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") {
        setMessages(m => m.map(msg => msg.id === aMsg.id
          ? { ...msg, text: msg.text + `\n\n[Error: ${e.message || e}]`, done: true } : msg));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function stopStream() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  async function clear() {
    abortRef.current?.abort();
    setStreaming(false);
    if (threadId) {
      // Best-effort delete of the test thread so they don't accumulate
      // in the user's sidebar. Failure is silent — worst case is a stray
      // [Test] thread the user can clear manually.
      fetch(`/api/threads/${threadId}`, { method: "DELETE" }).catch(() => {});
    }
    setThreadId(null);
    setMessages([]);
  }

  const hasPromptDrift = systemPromptVersion !== lastSavedVersion && messages.length > 0;

  return (
    <div style={{
      width: 360, flexShrink: 0,
      display: "flex", flexDirection: "column",
      borderLeft: "1px solid var(--border)",
      background: "var(--bg)",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--border)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 1,
            color: "var(--accent)", textTransform: "uppercase",
          }}>● Test</span>
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
            {messages.length === 0 ? "ready" : `${messages.filter(m => m.role === "assistant").length} turn${messages.filter(m => m.role === "assistant").length === 1 ? "" : "s"}`}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={clear} disabled={messages.length === 0 && !streaming}
            className="btn" style={{ fontSize: 11, padding: "3px 8px" }}>Clear</button>
          <button onClick={onClose} className="btn" style={{ fontSize: 11, padding: "3px 8px" }}>×</button>
        </div>
      </div>

      {/* Drift warning */}
      {hasPromptDrift && (
        <div style={{
          padding: "8px 14px", fontSize: 11, lineHeight: 1.4,
          background: "rgba(234,179,8,0.08)",
          color: "#b45309",
          borderBottom: "1px solid var(--border)",
        }}>
          Prompt has changed since this conversation started. Clear to test against the latest version.
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "14px 16px" }}>
        {messages.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-faint)", lineHeight: 1.5 }}>
            Quick test loop. Send a prompt to preview the agent without opening a full thread. Tools run live, memory + skills resolve, but no artifact iframes are rendered here.
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} style={{
            marginBottom: 14, fontSize: 12.5, lineHeight: 1.55,
          }}>
            <div style={{
              fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
              color: "var(--text-faint)", marginBottom: 4, textTransform: "uppercase",
            }}>{msg.role === "user" ? "You" : "Agent"}</div>
            <div style={{
              whiteSpace: "pre-wrap", color: "var(--text)",
              ...(msg.role === "user" ? {
                background: "var(--bg-elevated)",
                padding: "8px 11px", borderRadius: 8,
              } : {}),
            }}>
              {msg.text || (msg.role === "assistant" && !msg.done ? <em style={{ color: "var(--text-faint)" }}>thinking…</em> : null)}
            </div>
            {msg.toolCalls.length > 0 && (
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                {msg.toolCalls.map((tc, i) => (
                  <div key={i} style={{
                    fontSize: 11, fontFamily: "JetBrains Mono, monospace",
                    padding: "5px 8px", borderRadius: 5,
                    background: "var(--bg-subtle)",
                    border: "1px solid var(--border)",
                    color: "var(--text-muted)",
                  }}>
                    <div style={{ color: "var(--accent)", fontWeight: 600 }}>↳ {tc.name}</div>
                    {tc.result !== undefined && (
                      <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-faint)",
                        maxHeight: 60, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {tc.result.slice(0, 240)}{tc.result.length > 240 ? "…" : ""}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Composer */}
      <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border)" }}>
        <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Test a prompt…"
          disabled={streaming}
          rows={2}
          style={{
            width: "100%", padding: "8px 10px", fontSize: 12.5,
            border: "1px solid var(--border)", borderRadius: 8,
            background: "var(--bg)", color: "var(--text)",
            fontFamily: "inherit", resize: "none", outline: "none",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
          {streaming ? (
            <button onClick={stopStream} className="btn"
              style={{ fontSize: 11.5, padding: "4px 12px",
                background: "rgba(220,38,38,0.1)", color: "#dc2626",
                borderColor: "rgba(220,38,38,0.3)" }}>■ Stop</button>
          ) : (
            <button onClick={send} disabled={!input.trim()} className="btn btn-primary"
              style={{ fontSize: 11.5, padding: "4px 14px" }}>Send ↵</button>
          )}
        </div>
      </div>
    </div>
  );
}
