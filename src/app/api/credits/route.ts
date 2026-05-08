import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getCreditBalance, listCreditTransactions } from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({
    balance: await getCreditBalance(user.id),
    transactions: await listCreditTransactions(user.id),
  });
}
