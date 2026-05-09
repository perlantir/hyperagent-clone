"use client";
import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";

interface SearchItem {
  type: "thread" | "agent" | "page";
  id: string;
  title: string;
  subtitle?: string;
  href: string;
}

const STATIC_PAGES: SearchItem[] = [
  { type: "page", id: "library",        title: "Library",        subtitle: "All artifacts",            href: "/library" },
  { type: "page", id: "learning",       title: "Learning",       subtitle: "Skills + memories",        href: "/learning" },
  { type: "page", id: "skills",         title: "Skills",         subtitle: "Browse templates",         href: "/skills" },
  { type: "page", id: "integrations",   title: "Integrations",   subtitle: "Connectors",               href: "/integrations" },
  { type: "page", id: "live",           title: "Live mode",      subtitle: "Automations",              href: "/live" },
  { type: "page", id: "command-center", title: "Command Center", subtitle: "Live ops dashboard",       href: "/command-center" },
  { type: "page", id: "costs",          title: "Costs",          subtitle: "Per-run + per-agent",      href: "/costs" },
  { type: "page", id: "billing",        title: "Billing",        subtitle: "Credits + top-up",         href: "/billing" },
  { type: "page", id: "settings",       title: "Settings",       subtitle: "Account + model",          href: "/settings" },
  { type: "page", id: "projects",       title: "Projects",       subtitle: "Folders for work",         href: "/projects" },
];

export function CommandK() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<SearchItem[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(prev => !prev);
      }
      if (e.key === "Escape" && open) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQ(""); setActiveIdx(0);
    setTimeout(() => inputRef.current?.focus(), 30);
    (async () => {
      const [tR, aR] = await Promise.all([fetch("/api/threads"), fetch("/api/agents")]);
      const t = await tR.json(); const a = await aR.json();
      const threads: SearchItem[] = (t.threads || []).map((x: any) => ({ type: "thread", id: x.id, title: x.title, subtitle: "Thread", href: `/threads/${x.id}` }));
      const agents: SearchItem[] = (a.agents || []).map((x: any) => ({ type: "agent", id: x.id, title: x.name, subtitle: x.description, href: `/agents/${x.id}` }));
      setItems([...STATIC_PAGES, ...threads, ...agents]);
    })();
  }, [open]);

  const filtered = items.filter(it =>
    !q.trim() ||
    it.title.toLowerCase().includes(q.toLowerCase()) ||
    (it.subtitle || "").toLowerCase().includes(q.toLowerCase())
  ).slice(0, 12);

  function go(i: number) {
    const it = filtered[i]; if (!it) return;
    setOpen(false);
    router.push(it.href);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); go(activeIdx); }
  }

  if (!open) return null;
  return (
    <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "grid", placeItems: "start center", zIndex: 200, paddingTop: "10vh", backdropFilter: "blur(6px)" }}>
      <div onClick={e => e.stopPropagation()} style={{ width: "min(580px, 92vw)", background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 14, boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden" }}>
        <input
          ref={inputRef}
          value={q}
          onChange={e => { setQ(e.target.value); setActiveIdx(0); }}
          onKeyDown={onKey}
          placeholder="Search threads, agents, pages…"
          style={{ width: "100%", padding: "16px 20px", border: "none", outline: "none", background: "transparent", color: "var(--text)", fontSize: 16, fontFamily: "inherit", borderBottom: "1px solid var(--border)" }}
        />
        <div style={{ maxHeight: 420, overflowY: "auto" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--text-faint)", fontSize: 13 }}>No matches.</div>
          ) : filtered.map((it, i) => (
            <button
              key={it.type + ":" + it.id}
              onClick={() => go(i)}
              onMouseEnter={() => setActiveIdx(i)}
              style={{ display: "flex", alignItems: "center", width: "100%", padding: "10px 18px", border: "none", background: i === activeIdx ? "var(--bg-subtle)" : "transparent", color: "var(--text)", textAlign: "left", cursor: "pointer", gap: 12 }}>
              <span style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "JetBrains Mono, monospace", textTransform: "uppercase", width: 60 }}>{it.type}</span>
              <span style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>{it.title}</span>
              {it.subtitle && <span style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{it.subtitle}</span>}
            </button>
          ))}
        </div>
        <div style={{ padding: "8px 18px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-faint)", display: "flex", justifyContent: "space-between" }}>
          <span>↑↓ navigate · ↵ select · esc close</span>
          <span>⌘K to toggle</span>
        </div>
      </div>
    </div>
  );
}
