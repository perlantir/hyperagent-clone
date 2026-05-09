export type Role = "user" | "assistant";

export interface User { id: string; email: string; name: string; createdAt: number; onboardedAt?: number | null; }
export interface Session { id: string; userId: string; expiresAt: number; }

export interface Project { id: string; userId: string; name: string; description: string; color: string; createdAt: number; }

export interface Thread {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  agentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  threadId: string;
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  artifactIds?: string[];
  model?: string;
  costCredits?: number;
  createdAt: number;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  durationMs?: number;
}

export interface Artifact {
  id: string;
  threadId: string;
  messageId: string;
  type: "webpage" | "image" | "table" | "document";
  title: string;
  body: string;
  createdAt: number;
}

export interface Agent {
  id: string;
  userId: string;
  projectId: string | null;
  name: string;
  icon: string;
  color: "orange" | "blue" | "green" | "purple";
  description: string;
  systemPrompt: string;
  tools: string[];
  connectorIds: string[];
  routerHint: string;
  createdAt: number;
}

export interface Memory {
  id: string;
  userId: string;
  agentId: string | null;
  projectId: string | null;
  content: string;
  importance: number;
  createdAt: number;
}

export interface Connector {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  color: string;
  textColor: string;
  credentialFields: { name: string; label: string; type: "text" | "password" }[];
  tools: string[];
}

export interface ConnectorCredential {
  id: string;
  userId: string;
  connectorId: string;
  label: string;
  credentials: Record<string, string>;
  createdAt: number;
}

export interface Skill {
  id: string;
  userId: string | null;
  name: string;
  description: string;
  category: string;
  systemPromptAddition: string;
  toolHints: string[];
  isTemplate: number;
  installedFromTemplate: string | null;
  createdAt: number;
}

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  agentColor: string;
  defaultIntervalMinutes: number;
  prompt: string;
  recommendedTools: string[];
}

export interface CreditTransaction {
  id: string;
  userId: string;
  amount: number;
  reason: string;
  ref: string | null;
  createdAt: number;
}

export interface Schedule {
  id: string;
  userId: string;
  agentId: string;
  name: string;
  prompt: string;
  intervalMinutes: number;
  active: number;
  lastRunAt: number | null;
  createdAt: number;
}

export interface Run {
  id: string;
  scheduleId: string;
  threadId: string | null;
  status: "running" | "ok" | "error";
  output: string;
  startedAt: number;
  endedAt: number | null;
}
