// P24 — pure parsing helpers for working memory.
// Split out from working-memory.ts so test fixtures can import without
// pulling in the Postgres-dependent CRUD layer.

export interface PlanTask {
  text: string;
  done: boolean;
  index: number;
}

export function parsePlanTasks(content: string): PlanTask[] {
  if (!content) return [];
  const lines = content.split("\n");
  const tasks: PlanTask[] = [];
  let index = 0;
  for (const line of lines) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
    if (m) {
      tasks.push({ text: m[2].trim(), done: m[1].toLowerCase() === "x", index });
      index++;
    }
  }
  return tasks;
}

export function planProgress(tasks: PlanTask[]): { done: number; total: number; ratio: number } | null {
  if (!tasks.length) return null;
  const done = tasks.filter(t => t.done).length;
  return { done, total: tasks.length, ratio: done / tasks.length };
}
