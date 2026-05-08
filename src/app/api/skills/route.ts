import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listSkillTemplates, listUserSkills, createSkill, installSkillFromTemplate } from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({
    templates: await listSkillTemplates(),
    skills: await listUserSkills(user.id),
  });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (body.installFromTemplate) {
    const s = await installSkillFromTemplate(user.id, body.installFromTemplate);
    if (!s) return NextResponse.json({ error: "template not found" }, { status: 404 });
    return NextResponse.json({ skill: s });
  }
  if (!body.name || !body.systemPromptAddition) {
    return NextResponse.json({ error: "name and systemPromptAddition required" }, { status: 400 });
  }
  const s = await createSkill({
    userId: user.id, name: body.name,
    description: body.description || "", category: body.category || "Custom",
    systemPromptAddition: body.systemPromptAddition,
    toolHints: body.toolHints || [], isTemplate: 0, installedFromTemplate: null,
  });
  return NextResponse.json({ skill: s });
}
