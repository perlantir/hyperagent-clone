"use client";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Topbar } from "@/components/Topbar";

const PACKAGES = [
  { id: "starter", name: "Starter", credits: 5000, priceUsd: 5, blurb: "~100 medium chats" },
  { id: "pro", name: "Pro", credits: 25000, priceUsd: 20, blurb: "~500 medium chats", popular: true },
  { id: "team", name: "Team", credits: 100000, priceUsd: 75, blurb: "~2,000 chats + automations" },
  { id: "scale", name: "Scale", credits: 500000, priceUsd: 300, blurb: "~10,000 chats — heavy users" },
];

export default function BillingPage() {
  const [balance, setBalance] = useState(0);
  const [tx, setTx] = useState<any[]>([]);

  async function reload() {
    const r = await (await fetch("/api/credits")).json();
    setBalance(r.balance || 0); setTx(r.transactions || []);
  }
  useEffect(() => { reload(); }, []);

  async function topup(packageId: string) {
    await fetch("/api/credits/topup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packageId }) });
    reload();
  }

  return (
    <AppShell>
      <Topbar title="Billing" />
      <div style={{ overflowY: "auto", padding: "32px 48px" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto" }}>
          <h1 className="h-display" style={{ fontSize: 44, marginBottom: 8 }}>Billing</h1>
          <div style={{ color: "var(--text-muted)", fontSize: 15, marginBottom: 32, maxWidth: 580 }}>Pay-as-you-go credits. 1 credit ≈ $0.001. Each chat costs about 50 credits + tokens.</div>

          <div className="card" style={{ padding: 24, marginBottom: 32, display: "flex", alignItems: "center", gap: 24 }}>
            <div style={{ flex: 1 }}>
              <div className="h-section">Current balance</div>
              <div className="h-display" style={{ fontSize: 56, marginTop: 4 }}>{balance.toLocaleString()}</div>
              <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>≈ ${(balance * 0.001).toFixed(2)} USD remaining</div>
            </div>
          </div>

          <div className="h-section" style={{ marginBottom: 12 }}>Top up</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px,1fr))", gap: 12, marginBottom: 32 }}>
            {PACKAGES.map(p => (
              <div key={p.id} className="card" style={{ padding: 20, position: "relative", borderColor: p.popular ? "var(--accent)" : undefined }}>
                {p.popular && <span style={{ position: "absolute", top: -8, right: 16, background: "var(--accent)", color: "white", fontSize: 10, padding: "2px 8px", borderRadius: 99, fontWeight: 600 }}>Popular</span>}
                <div style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</div>
                <div className="h-display" style={{ fontSize: 32, marginTop: 8 }}>${p.priceUsd}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>{p.credits.toLocaleString()} credits</div>
                <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginBottom: 16 }}>{p.blurb}</div>
                <button className="btn btn-primary" onClick={() => topup(p.id)} style={{ width: "100%", justifyContent: "center" }}>Buy</button>
              </div>
            ))}
          </div>

          <div className="h-section" style={{ marginBottom: 12 }}>Transactions</div>
          <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            {tx.length === 0 ? (
              <div style={{ padding: 32, textAlign: "center", color: "var(--text-faint)" }}>No transactions yet.</div>
            ) : tx.map((t, i) => (
              <div key={t.id} style={{ padding: "12px 18px", display: "flex", alignItems: "center", gap: 16, borderTop: i ? "1px solid var(--border)" : "none", fontSize: 13 }}>
                <div style={{ flex: 1 }}>
                  <div>{t.reason}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 2 }}>{new Date(t.createdAt).toLocaleString()}</div>
                </div>
                <div style={{ fontWeight: 600, color: t.amount > 0 ? "var(--green)" : "var(--text-muted)" }}>{t.amount > 0 ? "+" : ""}{t.amount.toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
