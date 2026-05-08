import { listMemories } from "./db";
import type { Memory } from "./types";

// Surface memories for a particular agent + project context. Used to extend
// the system prompt at chat time.
export function memoriesForContext(userId: string, agentId: string | null, projectId: string | null): Memory[] {
  const all = listMemories(userId);
  // Keep memories that are global (no agentId, no projectId) OR scoped to this agent OR this project.
  return all.filter(m =>
    (m.agentId === null || m.agentId === agentId) &&
    (m.projectId === null || m.projectId === projectId)
  ).slice(0, 12);
}

export function memoriesAsSystemBlock(memories: Memory[]): string {
  if (!memories.length) return "";
  const formatted = memories.map(m => `- ${m.content}`).join("\n");
  return `\n\n# Memories about the user\n${formatted}\n`;
}
