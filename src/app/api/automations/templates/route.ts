import { NextResponse } from "next/server";
import { AUTOMATION_TEMPLATES } from "@/lib/automation-templates";

export async function GET() {
  return NextResponse.json({ templates: AUTOMATION_TEMPLATES });
}
