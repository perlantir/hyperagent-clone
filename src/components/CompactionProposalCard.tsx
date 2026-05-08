"use client";
import { useState } from "react";

interface CompactionProposal {
  id: string;
  similarity: number;
  memoryAContent: string;
  memoryBContent: string;
  mergedContent: string;
  reasoning: string;
  status: string;
}

export function CompactionProposalCard({ proposal, onChange }: { proposal: CompactionProposal; onChange: () => void }) {
  const [busy, setBusy] = useState(false);

  async function resolve(action: "accept" | "reject") {
    setBusy(true);
    await fetch("/api/memories/compact", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId: proposal.id, action }),
    });
    setBusy(false);
    onChange();
  }

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Memory pair · similarity {(proposal.similarity * 100).toFixed(1)}%</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{proposal.reasoning}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
        <div style={{ padding: 10, borderRadius: 6, background: "var(--bg-elevated)", fontSize: 12.5 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)", marginBottom: 4, letterSpacing: 0.5 }}>MEMORY A</div>
          {proposal.memoryAContent}
        </div>
        <div style={{ padding: 10, borderRadius: 6, background: "var(--bg-elevated)", fontSize: 12.5 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)", marginBottom: 4, letterSpacing: 0.5 }}>MEMORY B</div>
          {proposal.memoryBContent}
        </div>
      </div>

      <div style={{ padding: 10, borderRadius: 6, background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.20)", fontSize: 12.5, marginBottom: 10 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#22c55e", marginBottom: 4, letterSpacing: 0.5 }}>PROPOSED MERGE →</div>
        {proposal.mergedContent}
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => resolve("accept")}
          style={{ fontSize: 11, padding: "4px 10px" }}>Merge</button>
        <button className="btn" disabled={busy} onClick={() => resolve("reject")}
          style={{ fontSize: 11, padding: "4px 10px" }}>Keep separate</button>
      </div>
    </div>
  );
}
