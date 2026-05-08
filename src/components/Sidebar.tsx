"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";

interface NavLink { href: string; label: string; icon: string; }
const NAV: NavLink[] = [
  { href: "/library",      label: "Library",      icon: "▤" },
  { href: "/learning",     label: "Learning",     icon: "◇" },
  { href: "/skills",       label: "Skills",       icon: "⚙" },
  { href: "/integrations", label: "Integrations", icon: "⊟" },
  { href: "/live",         label: "Live mode",    icon: "●" },
  { href: "/billing",      label: "Billing",      icon: "$" },
  { href: "/settings",     label: "Settings",     icon: "⚙" },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<{ name: string } | null>(null);
  const [threads, setThreads] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [balance, setBalance] = useState(0);

  useEffect(() => {
    let alive = true;
    async function load() {
      const [meR, tR, aR, pR, cR] = await Promise.all([
        fetch("/api/auth/me"), fetch("/api/threads"), fetch("/api/agents"),
        fetch("/api/projects"), fetch("/api/credits"),
      ]);
      if (!alive) return;
      const me = await meR.json(); const t = await tR.json(); const a = await aR.json();
      const p = await pR.json(); const c = await cR.json();
      setUser(me.user); setThreads(t.threads || []); setAgents(a.agents || []);
      setProjects(p.projects || []); setBalance(c.balance || 0);
    }
    load();
    const int = setInterval(load, 5000);
    return () => { alive = false; clearInterval(int); };
  }, [pathname]);

  async function newThread() {
    const r = await fetch("/api/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const j = await r.json();
    if (j.thread?.id) router.push(`/threads/${j.thread.id}`);
  }

  return (
    <aside style={{ borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", padding: "14px 12px 12px", overflowY: "auto", background: "var(--bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px 14px" }}>
        <Link href="/" style={{ width: 24, height: 24, background: "var(--text)", color: "var(--bg)", borderRadius: 6, display: "grid", placeItems: "center", fontSize: 12, fontWeight: 800 }}>H</Link>
        <span style={{ fontWeight: 600, fontSize: 14.5, letterSpacing: "-0.01em" }}>Hyperagent</span>
      </div>
      <button onClick={newThread} style={{ marginBottom: 10, padding: "9px 11px", background: "var(--text)", color: "var(--bg)", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 14, lineHeight: 1 }}>+</span> New thread
      </button>

      {NAV.map(n => (
        <NavItem key={n.href} {...n} active={pathname.startsWith(n.href)} />
      ))}

      <SectionLabel>Threads</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {threads.slice(0, 12).map(t => (
          <Link key={t.id} href={`/threads/${t.id}`} className="side-row" style={rowStyle(pathname === `/threads/${t.id}`, true)}>
            {t.title}
          </Link>
        ))}
        {threads.length === 0 && <div style={{ padding: "6px 12px", color: "var(--text-faint)", fontSize: 12 }}>No threads yet</div>}
      </div>

      <SectionLabel>Agents</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {agents.map(a => (
          <Link key={a.id} href={`/agents/${a.id}`} style={rowStyle(pathname === `/agents/${a.id}`)}>
            <span style={{ width: 18, height: 18, borderRadius: 5, background: agentBg(a.color), color: agentFg(a.color), display: "grid", placeItems: "center", fontSize: 10.5, fontWeight: 700, flexShrink: 0 }}>{a.icon}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
          </Link>
        ))}
        <Link href="/agents/new" style={{ ...rowStyle(false), color: "var(--text-faint)", fontStyle: "italic" }}>+ New agent</Link>
      </div>

      <SectionLabel>Projects</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {projects.map(p => (
          <Link key={p.id} href={`/projects/${p.id}`} style={rowStyle(pathname === `/projects/${p.id}`)}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: agentFg(p.color), flexShrink: 0 }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
          </Link>
        ))}
        <Link href="/projects" style={{ ...rowStyle(false), color: "var(--text-faint)", fontStyle: "italic" }}>+ New project</Link>
      </div>

      <div style={{ marginTop: "auto", paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 9, padding: "12px 8px 4px" }}>
        <div style={{ width: 28, height: 28, borderRadius: 7, background: "linear-gradient(135deg, var(--accent), #f97316)", color: "white", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
          {(user?.name || "?")[0]}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.name || "—"}</div>
          <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{balance.toLocaleString()} credits</div>
        </div>
        <ThemeToggle />
        <button onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.href = "/login"; }}
          style={{ width: 26, height: 26, borderRadius: 6, background: "transparent", border: "none", color: "var(--text-muted)", fontSize: 12 }} title="Sign out">⏻</button>
      </div>
    </aside>
  );
}

function NavItem({ href, label, icon, active }: NavLink & { active: boolean }) {
  return (
    <Link href={href} style={rowStyle(active)}>
      <span style={{ width: 16, opacity: 0.85, fontSize: 13 }}>{icon}</span>
      {label}
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ marginTop: 12, padding: "6px 10px 4px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-faint)", fontWeight: 600 }}>{children}</div>;
}

function rowStyle(active: boolean, indent = false): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: 9,
    padding: indent ? "6px 10px 6px 28px" : "6px 10px",
    borderRadius: 6, fontSize: 13,
    color: active ? "var(--text)" : "var(--text-muted)",
    background: active ? "var(--bg-subtle)" : "transparent",
    fontWeight: active ? 500 : 400,
    cursor: "pointer", lineHeight: 1.35,
  };
}

function agentBg(color: string): string {
  return ({ orange: "#fed7aa", blue: "#bae6fd", green: "#bbf7d0", purple: "#ddd6fe" } as any)[color] || "#fed7aa";
}
function agentFg(color: string): string {
  return ({ orange: "#c2410c", blue: "#1d4ed8", green: "#15803d", purple: "#6d28d9" } as any)[color] || "#c2410c";
}
