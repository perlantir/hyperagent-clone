"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";

export default function IntegrationsPage() {
  return <Suspense fallback={null}><IntegrationsInner /></Suspense>;
}

function IntegrationsInner() {
  const toast = useToast();
  const [connectors, setConnectors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("connected");
  const [search, setSearch] = useState("");
  const [connecting, setConnecting] = useState<string | null>(null);
  const sp = useSearchParams();

  async function reload() {
    setLoading(true);
    const r = await (await fetch("/api/connectors")).json();
    setConnectors(r.connectors || []);
    setLoading(false);
  }
  useEffect(() => { reload(); }, []);
  // After OAuth callback, ?connected=slug is appended. Refresh to pick it up.
  useEffect(() => { if (sp?.get("connected")) reload(); }, [sp]);

  async function connect(slug: string) {
    setConnecting(slug);
    try {
      const r = await fetch(`/api/connectors/${slug}`, { method: "POST" });
      const j = await r.json();
      if (j.redirectUrl) {
        // Open Composio's hosted OAuth flow
        window.open(j.redirectUrl, "_blank", "width=540,height=720,popup");
        // Poll for connection completion
        const poll = window.setInterval(async () => {
          const re = await (await fetch("/api/connectors")).json();
          const c = (re.connectors || []).find((x: any) => x.slug === slug);
          if (c?.connected) {
            clearInterval(poll);
            setConnectors(re.connectors);
            setConnecting(null);
          }
        }, 2000);
        // Stop polling after 5 minutes
        setTimeout(() => { clearInterval(poll); setConnecting(null); }, 5 * 60 * 1000);
      } else {
        setConnecting(null);
        toast.error("Couldn't start connect flow", j.error || "No redirect URL returned.");
      }
    } catch (e: any) {
      setConnecting(null);
      toast.error("Connect failed", e.message);
    }
  }

  async function disconnect(slug: string) {
    await fetch(`/api/connectors/${slug}`, { method: "DELETE" });
    reload();
    toast.success(`Disconnected ${slug}`);
  }

  const filtered = connectors.filter(c => {
    if (filter === "connected" && !c.connected) return false;
    if (search && !c.name.toLowerCase().includes(search.toLowerCase()) && !c.slug.includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <AppShell>
      <Topbar title="Integrations" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <h1 className="h-display" style={{ fontSize: 44, marginBottom: 8 }}>Integrations</h1>
          <div style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 24, maxWidth: 640 }}>
            Connect Hyperagent to the tools where your work lives. OAuth-managed by Composio — paste no tokens, your agents get the right permissions automatically.
          </div>

          <div style={{ display: "flex", gap: 12, marginBottom: 24, alignItems: "center", flexWrap: "wrap" }}>
            <button className={`chip ${filter === "connected" ? "active" : ""}`} onClick={() => setFilter("connected")}>
              Connected · {connectors.filter(c => c.connected).length}
            </button>
            <button className={`chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>
              All · {connectors.length}
            </button>
            <input
              className="input"
              placeholder="Search 500+ apps…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ flex: 1, maxWidth: 320, padding: "7px 12px", fontSize: 13.5 }}
            />
          </div>

          {loading ? (
            <div style={{ padding: 64, textAlign: "center", color: "var(--text-faint)" }}>Loading toolkits from Composio…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 64, textAlign: "center", color: "var(--text-faint)" }}>
              {filter === "connected" ? "Nothing connected yet. Switch to All and pick a service." : "No matches."}
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px,1fr))", gap: 12 }}>
              {filtered.map(c => (
                <div key={c.slug} className="card" style={{ padding: 16, display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: 9,
                    background: "var(--bg-subtle)",
                    display: "grid", placeItems: "center",
                    fontSize: 18, fontWeight: 700,
                    overflow: "hidden",
                    flexShrink: 0,
                  }}>
                    {c.logo ? (
                      <img src={c.logo} alt={c.name} style={{ width: 28, height: 28, objectFit: "contain" }} />
                    ) : (
                      (c.name?.[0] || "?").toUpperCase()
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                    <div style={{ fontSize: 11.5, color: c.connected ? "var(--green)" : "var(--text-muted)" }}>
                      {c.connected ? "● Connected" : (c.categories?.[0] || "Available")}
                    </div>
                  </div>
                  {c.connected ? (
                    <button className="btn" onClick={() => disconnect(c.slug)}>Disconnect</button>
                  ) : (
                    <button className="btn btn-primary" disabled={connecting === c.slug} onClick={() => connect(c.slug)}>
                      {connecting === c.slug ? "Waiting…" : "Connect"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
