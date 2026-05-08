// Credit accounting. 1 credit ≈ $0.001. Per-message costs depend on input/output tokens.
// We charge a flat 50 credits per assistant message + estimated token costs.

import { addCredits, getCreditBalance } from "./db";

// Approximate token cost (Sonnet 4.5 pricing, May 2026):
// $3 / M input tokens   → 3 credits per 1k input
// $15 / M output tokens → 15 credits per 1k output
export function computeCost(inputTokens: number, outputTokens: number): number {
  const flat = 50;
  const inCost = Math.ceil((inputTokens / 1000) * 3);
  const outCost = Math.ceil((outputTokens / 1000) * 15);
  return flat + inCost + outCost;
}

export async function chargeCredits(userId: string, amount: number, reason: string, ref: string | null = null) {
  await addCredits(userId, -Math.abs(amount), reason, ref);
}

export async function topUp(userId: string, amount: number, reason = "Top-up") {
  await addCredits(userId, Math.abs(amount), reason, null);
}

export async function balance(userId: string): Promise<number> {
  return await getCreditBalance(userId);
}

// Top-up packages (used by the billing page)
export const PACKAGES = [
  { id: "starter", name: "Starter", credits: 5000, priceUsd: 5, blurb: "~100 medium chats" },
  { id: "pro", name: "Pro", credits: 25000, priceUsd: 20, blurb: "~500 medium chats", popular: true },
  { id: "team", name: "Team", credits: 100000, priceUsd: 75, blurb: "~2,000 chats + automations" },
  { id: "scale", name: "Scale", credits: 500000, priceUsd: 300, blurb: "~10,000 chats — heavy users" },
];
