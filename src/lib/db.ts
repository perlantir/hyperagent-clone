import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type {
  User, Thread, Message, Agent, Artifact, Schedule, Run,
  Project, Memory, ConnectorCredential, Skill, CreditTransaction,
} from "./types";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "hyperagent.db");
let _db: Database.Database | null = null;

export function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  initSchema(_db);
  seedIfEmpty(_db);
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, passwordHash TEXT NOT NULL,
      name TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), expiresAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL, description TEXT NOT NULL, color TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id),
      projectId TEXT REFERENCES projects(id) ON DELETE SET NULL,
      name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
      description TEXT NOT NULL, systemPrompt TEXT NOT NULL,
      tools TEXT NOT NULL, connectorIds TEXT NOT NULL DEFAULT '[]',
      routerHint TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id),
      projectId TEXT REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL, agentId TEXT REFERENCES agents(id) ON DELETE SET NULL,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, threadId TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL,
      toolCalls TEXT, artifactIds TEXT, model TEXT, costCredits INTEGER,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      threadId TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id),
      agentId TEXT REFERENCES agents(id) ON DELETE CASCADE,
      projectId TEXT REFERENCES projects(id) ON DELETE CASCADE,
      content TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 5, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connector_credentials (
      id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id),
      connectorId TEXT NOT NULL, label TEXT NOT NULL,
      credentials TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY, userId TEXT REFERENCES users(id),
      name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
      systemPromptAddition TEXT NOT NULL, toolHints TEXT NOT NULL DEFAULT '[]',
      isTemplate INTEGER NOT NULL DEFAULT 0,
      installedFromTemplate TEXT, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id),
      amount INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id),
      agentId TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Automation',
      prompt TEXT NOT NULL, intervalMinutes INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, lastRunAt INTEGER, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      scheduleId TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      threadId TEXT, status TEXT NOT NULL, output TEXT NOT NULL,
      startedAt INTEGER NOT NULL, endedAt INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(userId, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(threadId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_artifacts_thread ON artifacts(threadId);
    CREATE INDEX IF NOT EXISTS idx_runs_schedule ON runs(scheduleId, startedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(userId, importance DESC);
    CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(userId, createdAt DESC);
  `);
}

function seedIfEmpty(db: Database.Database) {
  const userCount = (db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }).c;
  if (userCount > 0) return;
  const id = "u_demo";
  const pw = hashPassword("demo");
  db.prepare("INSERT INTO users (id,email,passwordHash,name,createdAt) VALUES (?,?,?,?,?)").run(
    id, "demo@hyperagent.local", pw, "Demo User", Date.now(),
  );

  // Seed projects
  const projWork = uid("p");
  db.prepare("INSERT INTO projects (id,userId,name,description,color,createdAt) VALUES (?,?,?,?,?,?)")
    .run(projWork, id, "Work", "Day-to-day work threads", "orange", Date.now());

  // Seed agents
  const agents = [
    { id: "a_research", name: "Research Analyst", icon: "R", color: "orange",
      description: "Reads news, papers, and filings. Cites sources. Skeptical by default.",
      systemPrompt: "You are a research analyst. Reason carefully and cite sources. Lead with the takeaway, then offer evidence. Surface contradictions in source material rather than smoothing them over.",
      tools: ["web_search","generate_artifact"], connectorIds: [],
      routerHint: "Choose me for: research, news, briefings, market analysis, regulatory or policy questions, comparing options, sourcing facts." },
    { id: "a_writer", name: "Writing Assistant", icon: "W", color: "blue",
      description: "Drafts memos, narratives, and emails in your voice. Cuts filler.",
      systemPrompt: "You are a writing assistant. Draft in a crisp, declarative voice. Avoid hedging. Sentences under 22 words when possible.",
      tools: ["generate_artifact"], connectorIds: [],
      routerHint: "Choose me for: drafting memos, emails, narratives, blog posts, rewriting, copy editing, tone adjustments." },
    { id: "a_pricing", name: "Pricing Watch", icon: "P", color: "green",
      description: "Monitors competitor pricing and posts changes.",
      systemPrompt: "You watch competitor pricing pages and surface material changes only. Skip cosmetic edits.",
      tools: ["web_search","slack_notify"], connectorIds: [],
      routerHint: "Choose me for: competitor monitoring, pricing changes, product launches detection." },
    { id: "a_router", name: "Router", icon: "◆", color: "purple",
      description: "Meta-agent that routes incoming requests to the best specialist.",
      systemPrompt: "You are a router. Read each user message, decide which specialist agent should handle it, and respond with JSON: { \"agentId\": \"...\", \"reason\": \"...\" }.",
      tools: [], connectorIds: [], routerHint: "(reserved)" },
  ];
  const insAgent = db.prepare(
    "INSERT INTO agents (id,userId,projectId,name,icon,color,description,systemPrompt,tools,connectorIds,routerHint,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const a of agents) {
    insAgent.run(a.id, id, null, a.name, a.icon, a.color, a.description, a.systemPrompt,
      JSON.stringify(a.tools), JSON.stringify(a.connectorIds), a.routerHint, Date.now());
  }

  // Seed memories
  const insMem = db.prepare("INSERT INTO memories (id,userId,agentId,projectId,content,importance,createdAt) VALUES (?,?,?,?,?,?,?)");
  insMem.run(uid("mem"), id, null, null, "User name is Mira Chen. Prefers takeaway-first format. Skip filler — she edits hard.", 9, Date.now());
  insMem.run(uid("mem"), id, null, null, "Citations as footnotes, not inline.", 7, Date.now());
  insMem.run(uid("mem"), id, "a_research", null, "Surface contradictions in evidence rather than smoothing them over.", 8, Date.now());

  // Seed skill templates (global, userId NULL)
  const skillTemplates = [
    { name: "Stripe operator", category: "Developer",
      description: "Read charges, customers, and subscription data via the Stripe API.",
      systemPromptAddition: "When working with payments data, use the Stripe API. Always confirm whether to operate in test or live mode before mutating state.",
      toolHints: ["http_fetch"] },
    { name: "Board memo writer", category: "Writing",
      description: "Format Q-end narratives in three pillars: results, learnings, plan changes.",
      systemPromptAddition: "Structure board memos in three sections: 1. Results vs. plan (numbers first), 2. What we learned (specific, candid), 3. What changes (actionable, owned). Lead with the bottom line.",
      toolHints: ["generate_artifact"] },
    { name: "Competitive teardown", category: "Research",
      description: "Pull pricing, positioning, and GTM motion from a public site.",
      systemPromptAddition: "When teardowns are requested, structure as: Positioning, Product, Pricing, GTM motion. Cite the URL for every claim.",
      toolHints: ["web_search","generate_artifact"] },
    { name: "Linear status digest", category: "Productivity",
      description: "Group cycles by team, surface blockers and overdue items.",
      systemPromptAddition: "Format Linear digests as: section per team, bullet per cycle, flag blockers with ⚠. Show completion ratio.",
      toolHints: [] },
    { name: "PII redactor", category: "Compliance",
      description: "Scan documents for emails, phone numbers, addresses; produce redacted copies.",
      systemPromptAddition: "Identify and redact emails, phone numbers, full names, and street addresses. Replace with [REDACTED-EMAIL], etc.",
      toolHints: [] },
    { name: "SQL query builder", category: "Developer",
      description: "Translate natural-language questions into Postgres-compatible SQL.",
      systemPromptAddition: "Translate plain English to Postgres SQL. Always explain joins, qualify columns, and add LIMIT 100 to exploratory queries.",
      toolHints: [] },
    { name: "Email thread summary", category: "Productivity",
      description: "Distill long email threads to a 3-bullet summary plus a one-line ask.",
      systemPromptAddition: "Summarize email threads as three bullets followed by 'The ask:' on the last line.",
      toolHints: [] },
    { name: "Resume rewriter", category: "Writing",
      description: "Tighten resumes per role type. Quantifies impact, removes filler.",
      systemPromptAddition: "Rewrite resume bullets to be impact-first, quantified, in past tense. Remove adjectives. One line per bullet.",
      toolHints: [] },
    { name: "Meeting notes formatter", category: "Productivity",
      description: "Format raw transcripts into structured meeting notes with action items.",
      systemPromptAddition: "Output: # Decisions, # Open questions, # Action items (owner, item, due). No filler.",
      toolHints: [] },
  ];
  const insSkill = db.prepare(
    "INSERT INTO skills (id,userId,name,description,category,systemPromptAddition,toolHints,isTemplate,installedFromTemplate,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  for (const s of skillTemplates) {
    insSkill.run(uid("sk"), null, s.name, s.description, s.category, s.systemPromptAddition,
      JSON.stringify(s.toolHints), 1, null, Date.now());
  }

  // Seed credits
  db.prepare("INSERT INTO credit_transactions (id,userId,amount,reason,ref,createdAt) VALUES (?,?,?,?,?,?)").run(
    uid("ct"), id, 10000, "Welcome bonus", null, Date.now(),
  );
}

export function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
export function verifyPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
}
export function uid(prefix = "x") { return `${prefix}_${crypto.randomBytes(8).toString("hex")}`; }

// USERS
export function getUserByEmail(email: string): (User & { passwordHash: string }) | null {
  return getDb().prepare("SELECT * FROM users WHERE email = ?").get(email) as any || null;
}
export function getUserById(id: string): User | null {
  return getDb().prepare("SELECT id,email,name,createdAt FROM users WHERE id = ?").get(id) as any || null;
}
export function createUser(email: string, password: string, name: string): User {
  const id = uid("u"); const now = Date.now();
  getDb().prepare("INSERT INTO users (id,email,passwordHash,name,createdAt) VALUES (?,?,?,?,?)")
    .run(id, email, hashPassword(password), name, now);
  // Welcome credits
  getDb().prepare("INSERT INTO credit_transactions (id,userId,amount,reason,ref,createdAt) VALUES (?,?,?,?,?,?)")
    .run(uid("ct"), id, 5000, "Welcome bonus", null, now);
  return { id, email, name, createdAt: now };
}

// SESSIONS
export function createSession(userId: string): string {
  const id = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 30;
  getDb().prepare("INSERT INTO sessions (id,userId,expiresAt) VALUES (?,?,?)").run(id, userId, expiresAt);
  return id;
}
export function getSessionUser(sessionId: string): User | null {
  return getDb().prepare(`SELECT u.id,u.email,u.name,u.createdAt FROM sessions s JOIN users u ON u.id=s.userId WHERE s.id=? AND s.expiresAt>?`).get(sessionId, Date.now()) as any || null;
}
export function destroySession(sessionId: string) {
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

// PROJECTS
export function listProjects(userId: string): Project[] {
  return getDb().prepare("SELECT * FROM projects WHERE userId=? ORDER BY createdAt").all(userId) as Project[];
}
export function getProject(id: string, userId: string): Project | null {
  return getDb().prepare("SELECT * FROM projects WHERE id=? AND userId=?").get(id, userId) as any || null;
}
export function createProject(p: Omit<Project,"id"|"createdAt">): Project {
  const id = uid("p"); const createdAt = Date.now();
  getDb().prepare("INSERT INTO projects (id,userId,name,description,color,createdAt) VALUES (?,?,?,?,?,?)")
    .run(id, p.userId, p.name, p.description, p.color, createdAt);
  return { ...p, id, createdAt };
}
export function deleteProject(id: string, userId: string) {
  getDb().prepare("DELETE FROM projects WHERE id=? AND userId=?").run(id, userId);
}

// THREADS
export function listThreads(userId: string, projectId?: string | null): Thread[] {
  if (projectId === undefined) {
    return getDb().prepare("SELECT * FROM threads WHERE userId=? ORDER BY updatedAt DESC").all(userId) as Thread[];
  }
  return getDb().prepare("SELECT * FROM threads WHERE userId=? AND projectId IS ? ORDER BY updatedAt DESC").all(userId, projectId) as Thread[];
}
export function getThread(id: string, userId: string): Thread | null {
  return getDb().prepare("SELECT * FROM threads WHERE id=? AND userId=?").get(id, userId) as any || null;
}
export function createThread(userId: string, title: string, agentId: string | null, projectId: string | null = null): Thread {
  const id = uid("t"); const now = Date.now();
  getDb().prepare("INSERT INTO threads (id,userId,projectId,title,agentId,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)")
    .run(id, userId, projectId, title, agentId, now, now);
  return { id, userId, projectId, title, agentId, createdAt: now, updatedAt: now };
}
export function updateThread(id: string, userId: string, fields: { title?: string; updatedAt?: number; agentId?: string | null; projectId?: string | null }) {
  const cur = getThread(id, userId); if (!cur) return;
  const next = { ...cur, ...fields, updatedAt: Date.now() };
  getDb().prepare("UPDATE threads SET title=?,agentId=?,projectId=?,updatedAt=? WHERE id=? AND userId=?")
    .run(next.title, next.agentId, next.projectId, next.updatedAt, id, userId);
}
export function deleteThread(id: string, userId: string) {
  getDb().prepare("DELETE FROM threads WHERE id=? AND userId=?").run(id, userId);
}

// MESSAGES
export function listMessages(threadId: string): Message[] {
  const rows = getDb().prepare("SELECT * FROM messages WHERE threadId=? ORDER BY createdAt").all(threadId) as any[];
  return rows.map(r => ({
    ...r,
    toolCalls: r.toolCalls ? JSON.parse(r.toolCalls) : undefined,
    artifactIds: r.artifactIds ? JSON.parse(r.artifactIds) : undefined,
  }));
}
export function createMessage(m: Omit<Message,"id"|"createdAt">): Message {
  const id = uid("m"); const createdAt = Date.now();
  getDb().prepare("INSERT INTO messages (id,threadId,role,content,toolCalls,artifactIds,model,costCredits,createdAt) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, m.threadId, m.role, m.content,
      m.toolCalls ? JSON.stringify(m.toolCalls) : null,
      m.artifactIds ? JSON.stringify(m.artifactIds) : null,
      m.model || null, m.costCredits ?? null, createdAt);
  return { ...m, id, createdAt };
}
export function updateMessage(id: string, fields: Partial<Pick<Message,"content"|"toolCalls"|"artifactIds"|"costCredits">>) {
  const cur = getDb().prepare("SELECT * FROM messages WHERE id=?").get(id) as any;
  if (!cur) return;
  const content = fields.content !== undefined ? fields.content : cur.content;
  const toolCalls = fields.toolCalls !== undefined ? JSON.stringify(fields.toolCalls) : cur.toolCalls;
  const artifactIds = fields.artifactIds !== undefined ? JSON.stringify(fields.artifactIds) : cur.artifactIds;
  const costCredits = fields.costCredits !== undefined ? fields.costCredits : cur.costCredits;
  getDb().prepare("UPDATE messages SET content=?,toolCalls=?,artifactIds=?,costCredits=? WHERE id=?")
    .run(content, toolCalls, artifactIds, costCredits, id);
}

// ARTIFACTS
export function createArtifact(a: Omit<Artifact,"id"|"createdAt">): Artifact {
  const id = uid("art"); const createdAt = Date.now();
  getDb().prepare("INSERT INTO artifacts (id,threadId,messageId,type,title,body,createdAt) VALUES (?,?,?,?,?,?,?)")
    .run(id, a.threadId, a.messageId, a.type, a.title, a.body, createdAt);
  return { ...a, id, createdAt };
}
export function getArtifact(id: string): Artifact | null {
  return getDb().prepare("SELECT * FROM artifacts WHERE id=?").get(id) as any || null;
}
export function listArtifactsForUser(userId: string): Artifact[] {
  return getDb().prepare(`SELECT a.* FROM artifacts a JOIN threads t ON t.id=a.threadId WHERE t.userId=? ORDER BY a.createdAt DESC`).all(userId) as Artifact[];
}

// AGENTS
export function listAgents(userId: string): Agent[] {
  const rows = getDb().prepare("SELECT * FROM agents WHERE userId=? ORDER BY createdAt").all(userId) as any[];
  return rows.map(r => ({ ...r, tools: JSON.parse(r.tools), connectorIds: JSON.parse(r.connectorIds || "[]") }));
}
export function getAgent(id: string, userId: string): Agent | null {
  const row = getDb().prepare("SELECT * FROM agents WHERE id=? AND userId=?").get(id, userId) as any;
  if (!row) return null;
  return { ...row, tools: JSON.parse(row.tools), connectorIds: JSON.parse(row.connectorIds || "[]") };
}
export function createAgent(a: Omit<Agent,"id"|"createdAt">): Agent {
  const id = uid("a"); const createdAt = Date.now();
  getDb().prepare("INSERT INTO agents (id,userId,projectId,name,icon,color,description,systemPrompt,tools,connectorIds,routerHint,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, a.userId, a.projectId, a.name, a.icon, a.color, a.description, a.systemPrompt,
      JSON.stringify(a.tools), JSON.stringify(a.connectorIds), a.routerHint, createdAt);
  return { ...a, id, createdAt };
}
export function updateAgent(id: string, userId: string, fields: Partial<Omit<Agent,"id"|"userId"|"createdAt">>) {
  const cur = getAgent(id, userId); if (!cur) return;
  const n = { ...cur, ...fields };
  getDb().prepare("UPDATE agents SET projectId=?,name=?,icon=?,color=?,description=?,systemPrompt=?,tools=?,connectorIds=?,routerHint=? WHERE id=? AND userId=?")
    .run(n.projectId, n.name, n.icon, n.color, n.description, n.systemPrompt,
      JSON.stringify(n.tools), JSON.stringify(n.connectorIds), n.routerHint, id, userId);
}
export function deleteAgent(id: string, userId: string) {
  getDb().prepare("DELETE FROM agents WHERE id=? AND userId=?").run(id, userId);
}

// MEMORIES
export function listMemories(userId: string, opts: { agentId?: string | null; projectId?: string | null } = {}): Memory[] {
  const conds: string[] = ["userId=?"]; const vals: any[] = [userId];
  if (opts.agentId !== undefined) { conds.push("(agentId IS ? OR agentId IS NULL)"); vals.push(opts.agentId); }
  if (opts.projectId !== undefined) { conds.push("(projectId IS ? OR projectId IS NULL)"); vals.push(opts.projectId); }
  return getDb().prepare(`SELECT * FROM memories WHERE ${conds.join(" AND ")} ORDER BY importance DESC, createdAt DESC`).all(...vals) as Memory[];
}
export function createMemory(m: Omit<Memory,"id"|"createdAt">): Memory {
  const id = uid("mem"); const createdAt = Date.now();
  getDb().prepare("INSERT INTO memories (id,userId,agentId,projectId,content,importance,createdAt) VALUES (?,?,?,?,?,?,?)")
    .run(id, m.userId, m.agentId, m.projectId, m.content, m.importance, createdAt);
  return { ...m, id, createdAt };
}
export function deleteMemory(id: string, userId: string) {
  getDb().prepare("DELETE FROM memories WHERE id=? AND userId=?").run(id, userId);
}

// CONNECTOR CREDENTIALS
export function listConnectorCredentials(userId: string): ConnectorCredential[] {
  const rows = getDb().prepare("SELECT * FROM connector_credentials WHERE userId=?").all(userId) as any[];
  return rows.map(r => ({ ...r, credentials: JSON.parse(r.credentials) }));
}
export function getConnectorCredentialsForId(userId: string, connectorId: string): ConnectorCredential | null {
  const row = getDb().prepare("SELECT * FROM connector_credentials WHERE userId=? AND connectorId=? LIMIT 1").get(userId, connectorId) as any;
  if (!row) return null;
  return { ...row, credentials: JSON.parse(row.credentials) };
}
export function upsertConnectorCredentials(userId: string, connectorId: string, label: string, credentials: Record<string,string>): ConnectorCredential {
  const existing = getConnectorCredentialsForId(userId, connectorId);
  if (existing) {
    getDb().prepare("UPDATE connector_credentials SET label=?,credentials=? WHERE id=?").run(label, JSON.stringify(credentials), existing.id);
    return { ...existing, label, credentials };
  }
  const id = uid("cc"); const createdAt = Date.now();
  getDb().prepare("INSERT INTO connector_credentials (id,userId,connectorId,label,credentials,createdAt) VALUES (?,?,?,?,?,?)")
    .run(id, userId, connectorId, label, JSON.stringify(credentials), createdAt);
  return { id, userId, connectorId, label, credentials, createdAt };
}
export function deleteConnectorCredentials(userId: string, connectorId: string) {
  getDb().prepare("DELETE FROM connector_credentials WHERE userId=? AND connectorId=?").run(userId, connectorId);
}

// SKILLS
export function listSkillTemplates(): Skill[] {
  const rows = getDb().prepare("SELECT * FROM skills WHERE isTemplate=1 ORDER BY category, name").all() as any[];
  return rows.map(r => ({ ...r, toolHints: JSON.parse(r.toolHints) }));
}
export function listUserSkills(userId: string): Skill[] {
  const rows = getDb().prepare("SELECT * FROM skills WHERE userId=? ORDER BY createdAt DESC").all(userId) as any[];
  return rows.map(r => ({ ...r, toolHints: JSON.parse(r.toolHints) }));
}
export function getSkill(id: string): Skill | null {
  const row = getDb().prepare("SELECT * FROM skills WHERE id=?").get(id) as any;
  if (!row) return null;
  return { ...row, toolHints: JSON.parse(row.toolHints) };
}
export function installSkillFromTemplate(userId: string, templateId: string): Skill | null {
  const tpl = getSkill(templateId);
  if (!tpl || !tpl.isTemplate) return null;
  const id = uid("sk"); const createdAt = Date.now();
  getDb().prepare("INSERT INTO skills (id,userId,name,description,category,systemPromptAddition,toolHints,isTemplate,installedFromTemplate,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, userId, tpl.name, tpl.description, tpl.category, tpl.systemPromptAddition,
      JSON.stringify(tpl.toolHints), 0, templateId, createdAt);
  return { ...tpl, id, userId, isTemplate: 0, installedFromTemplate: templateId, createdAt };
}
export function createSkill(s: Omit<Skill,"id"|"createdAt">): Skill {
  const id = uid("sk"); const createdAt = Date.now();
  getDb().prepare("INSERT INTO skills (id,userId,name,description,category,systemPromptAddition,toolHints,isTemplate,installedFromTemplate,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, s.userId, s.name, s.description, s.category, s.systemPromptAddition,
      JSON.stringify(s.toolHints), s.isTemplate, s.installedFromTemplate, createdAt);
  return { ...s, id, createdAt };
}
export function deleteSkill(id: string, userId: string) {
  getDb().prepare("DELETE FROM skills WHERE id=? AND userId=?").run(id, userId);
}

// CREDITS
export function getCreditBalance(userId: string): number {
  const r = getDb().prepare("SELECT COALESCE(SUM(amount),0) as bal FROM credit_transactions WHERE userId=?").get(userId) as any;
  return r?.bal || 0;
}
export function listCreditTransactions(userId: string, limit = 50): CreditTransaction[] {
  return getDb().prepare("SELECT * FROM credit_transactions WHERE userId=? ORDER BY createdAt DESC LIMIT ?").all(userId, limit) as CreditTransaction[];
}
export function addCredits(userId: string, amount: number, reason: string, ref: string | null = null) {
  const id = uid("ct");
  getDb().prepare("INSERT INTO credit_transactions (id,userId,amount,reason,ref,createdAt) VALUES (?,?,?,?,?,?)")
    .run(id, userId, amount, reason, ref, Date.now());
}

// SCHEDULES
export function listSchedules(userId: string): Schedule[] {
  return getDb().prepare("SELECT * FROM schedules WHERE userId=? ORDER BY createdAt DESC").all(userId) as Schedule[];
}
export function listAllActiveSchedules(): Schedule[] {
  return getDb().prepare("SELECT * FROM schedules WHERE active=1").all() as Schedule[];
}
export function getSchedule(id: string): Schedule | null {
  return getDb().prepare("SELECT * FROM schedules WHERE id=?").get(id) as any || null;
}
export function createSchedule(s: Omit<Schedule,"id"|"createdAt"|"lastRunAt">): Schedule {
  const id = uid("sch"); const createdAt = Date.now();
  getDb().prepare("INSERT INTO schedules (id,userId,agentId,name,prompt,intervalMinutes,active,lastRunAt,createdAt) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, s.userId, s.agentId, s.name, s.prompt, s.intervalMinutes, s.active, null, createdAt);
  return { ...s, id, createdAt, lastRunAt: null };
}
export function updateSchedule(id: string, fields: Partial<Schedule>) {
  if (fields.active !== undefined) getDb().prepare("UPDATE schedules SET active=? WHERE id=?").run(fields.active, id);
  if (fields.lastRunAt !== undefined) getDb().prepare("UPDATE schedules SET lastRunAt=? WHERE id=?").run(fields.lastRunAt, id);
}
export function deleteSchedule(id: string, userId: string) {
  getDb().prepare("DELETE FROM schedules WHERE id=? AND userId=?").run(id, userId);
}

// RUNS
export function createRun(r: Omit<Run,"id">): Run {
  const id = uid("run");
  getDb().prepare("INSERT INTO runs (id,scheduleId,threadId,status,output,startedAt,endedAt) VALUES (?,?,?,?,?,?,?)")
    .run(id, r.scheduleId, r.threadId, r.status, r.output, r.startedAt, r.endedAt);
  return { ...r, id };
}
export function updateRun(id: string, fields: Partial<Run>) {
  const sets: string[] = []; const vals: any[] = [];
  for (const [k,v] of Object.entries(fields)) { sets.push(`${k}=?`); vals.push(v); }
  if (!sets.length) return;
  vals.push(id);
  getDb().prepare(`UPDATE runs SET ${sets.join(",")} WHERE id=?`).run(...vals);
}
export function listRuns(userId: string, limit = 50): Run[] {
  return getDb().prepare(`SELECT r.* FROM runs r JOIN schedules s ON s.id=r.scheduleId WHERE s.userId=? ORDER BY r.startedAt DESC LIMIT ?`).all(userId, limit) as Run[];
}
