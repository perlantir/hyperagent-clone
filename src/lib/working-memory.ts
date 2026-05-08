// P24 — Working memory: per-thread structured doc that survives conversation
// compaction and renders in the UI.
//
// Each thread has a "working doc" with named sections. Agents update them via
// the update_working_memory tool during multi-step work — write a plan
// before starting, tick off Plan Tasks as steps complete, record key
// findings/decisions/numbers/corrections.
//
// Design choices:
//   - Storage: a single JSONB column on the threads table, not a separate
//     documents table. Working docs are 1:1 with threads, never shared.
//   - Sections are append-only by default (prepend/replace also supported).
//   - check_task is a special op that finds "- [ ] foo" and rewrites to
//     "- [x] foo" — drives the streaming PlanTasks UI.
//   - Auto-creates default sections on first read so any thread has the
//     standard layout without mass-migration.
//   - Compaction-survival is the killer feature: this doc is the canonical
//     place for plans + decisions + findings, so when older messages get
//     summarized away, the substance lives here.

import { pool } from "./db";

export interface WorkingDocSection {
  name: string;
  content: string;
  updatedAt: number;
}

export interface WorkingDoc {
  threadId: string;
  sections: WorkingDocSection[];
  updatedAt: number;
}

const DEFAULT_SECTIONS: Omit<WorkingDocSection, "updatedAt">[] = [
  { name: "Plan Overview", content: "" },
  { name: "Plan Tasks", content: "" },
  { name: "Findings", content: "" },
  { name: "Decisions", content: "" },
  { name: "Notes", content: "" },
];

let _initialized = false;

async function ensureSchema() {
  if (_initialized) return;
  await pool().query(`
    ALTER TABLE threads ADD COLUMN IF NOT EXISTS "workingDocSections" JSONB;
  `);
  _initialized = true;
}

// Return the working doc for a thread, creating default sections on first read.
// Caller must verify thread ownership separately (via getThread(id, userId)).
export async function getWorkingDoc(threadId: string): Promise<WorkingDoc | null> {
  await ensureSchema();
  const r = await pool().query(
    `SELECT "workingDocSections" FROM threads WHERE id=$1`,
    [threadId],
  );
  if (!r.rows[0]) return null;
  let sections = r.rows[0].workingDocSections as WorkingDocSection[] | null;
  if (!sections || sections.length === 0) {
    sections = DEFAULT_SECTIONS.map(s => ({ ...s, updatedAt: 0 }));
    await pool().query(
      `UPDATE threads SET "workingDocSections"=$1 WHERE id=$2`,
      [JSON.stringify(sections), threadId],
    );
  }
  return { threadId, sections, updatedAt: Date.now() };
}

export type SectionOperation = "append" | "prepend" | "replace" | "check_task";

export interface UpdateResult {
  ok: boolean;
  section?: WorkingDocSection;
  reason?: string;
}

// Update a section. Auto-creates the section if it doesn't exist.
// `check_task` ticks off "- [ ] X" → "- [x] X" matching the content as the task text.
export async function updateSection(
  threadId: string,
  sectionName: string,
  operation: SectionOperation,
  content: string,
): Promise<UpdateResult> {
  await ensureSchema();
  const doc = await getWorkingDoc(threadId);
  if (!doc) return { ok: false, reason: "thread not found" };

  const idx = doc.sections.findIndex(s => s.name.toLowerCase() === sectionName.toLowerCase());
  let section: WorkingDocSection;
  if (idx === -1) {
    section = { name: sectionName, content: "", updatedAt: Date.now() };
    doc.sections.push(section);
  } else {
    section = doc.sections[idx];
  }

  switch (operation) {
    case "append":
      section.content = section.content ? section.content + "\n" + content : content;
      break;
    case "prepend":
      section.content = content + (section.content ? "\n" + section.content : "");
      break;
    case "replace":
      section.content = content;
      break;
    case "check_task":
      // Find "- [ ] {content}" and rewrite to "- [x] {content}". Match is
      // line-anchored to avoid partial replacements.
      section.content = section.content.replace(
        new RegExp(`(^|\\n)\\s*-\\s*\\[\\s\\]\\s*${escapeRegex(content)}\\s*($|\\n)`, "g"),
        (_, before, after) => `${before}- [x] ${content}${after}`,
      );
      break;
    default:
      return { ok: false, reason: `unknown operation: ${operation}` };
  }
  section.updatedAt = Date.now();

  await pool().query(
    `UPDATE threads SET "workingDocSections"=$1, "updatedAt"=$2 WHERE id=$3`,
    [JSON.stringify(doc.sections), Date.now(), threadId],
  );
  return { ok: true, section };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =================== PLAN TASK PARSING ===================
// Re-exported from working-memory-parse.ts (which has no DB import) so
// tests + UI components can use the parser without pulling in Postgres.

export { parsePlanTasks, planProgress } from "./working-memory-parse";
export type { PlanTask } from "./working-memory-parse";
