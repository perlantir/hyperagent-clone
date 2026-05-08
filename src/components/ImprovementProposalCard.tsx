"use client";
import { useState } from "react";

interface Proposal {
  id: string;
  criterionName: string;
  occurrenceCount: number;
  proposedChange: { type: string; rationale: string; content: string };
  status: string;
  createdAt: number;
  evidence: any;
}

export function ImprovementProposalCard({ proposal, onChange }: { proposal: Proposal; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const change = proposal.proposedChange || { type: "?", rationale: "", content: "" };

  async function resolve(status: "accepted" | "rejected") {
    setBusy(true);
    await fetch("/api/improvement-proposals", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId: proposal.id, status }),
    });
    setBusy(false);
    onChange();
  }

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Recurring failure: <code style={{ fontSize: 12 }}>{proposal.criterionName}</code>
            </span>
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
              background: "rgba(220,38,38,0.10)", color: "#dc2626" }}>
              ×{proposal.occurrenceCount}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>· {change.type}</span>
          </div>

          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.45, marginBottom: 8 }}>
            {change.rationale}
          </div>

          <div style={{ padding: 12, borderRadius: 6, background: "var(--bg-elevated)", fontSize: 12.5, lineHeight: 1.5 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)", marginBottom: 6, letterSpacing: 0.5 }}>
              PROPOSED ADDITION
            </div>
            {change.content}
          </div>

          {expanded && proposal.evidence && Array.isArray(proposal.evidence) && (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 6, background: "var(--bg-elevated)", fontSize: 11.5, color: "var(--text-muted)" }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Evidence ({proposal.evidence.length} occurrence{proposal.evidence.length === 1 ? "" : "s"}):</div>
              {proposal.evidence.slice(0, 5).map((e: any, i: number) => (
                <div key={i} style={{ marginTop: 4, paddingLeft: 12 }}>
                  • {e.details}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => resolve("accepted")}
          style={{ fontSize: 11, padding: "4px 10px" }}>Accept</button>
        <button className="btn" disabled={busy} onClick={() => resolve("rejected")}
          style={{ fontSize: 11, padding: "4px 10px" }}>Reject</button>
        <button className="btn" onClick={() => setExpanded(!expanded)}
          style={{ fontSize: 11, padding: "4px 10px" }}>
          {expanded ? "Hide" : "Show"} evidence
        </button>
      </div>
    </div>
  );
}
