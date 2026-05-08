// Postgres data layer (Phase 11 — Vercel migration).
// Uses node-postgres (pg). All functions are async. Schema is created lazily
// on first connection. Demo seed data is only inserted if the users table is
// empty.
//
// Set DATABASE_URL in env. For Vercel + Neon, paste the connection string.

import { Pool } from "pg";
import crypto from "node:crypto";
import type {
  User, Thread, Message, Agent, Artifact, Schedule, Run,
  Project, Memory, ConnectorCredential, Skill, CreditTransaction,
} from "./types";

let _pool: Pool | null = null;
let _initialized = false;

export function pool(): Pool {
  if (_pool) return _pool;
  const conn = process.env.DATABASE_URL;
  if (!conn) throw new Error("DATABASE_URL is required (Postgres connection string)");
  _pool = new Pool({
    connectionString: conn,
    ssl: conn.includes("localhost") ? false : { rejectUnauthorized: false },
    max: 10,
  });
  return _pool;
}

async function ensureInit() {
  if (_initialized) return;
  await initSchema();
  await seedIfEmpty();
  _initialized = true;
}

async function initSchema() {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, "passwordHash" TEXT NOT NULL,
      name TEXT NOT NULL, "createdAt" BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id), "expiresAt" BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL, description TEXT NOT NULL, color TEXT NOT NULL, "createdAt" BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id),
      "projectId" TEXT REFERENCES projects(id) ON DELETE SET NULL,
      name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
      description TEXT NOT NULL, "systemPrompt" TEXT NOT NULL,
      tools TEXT NOT NULL, "connectorIds" TEXT NOT NULL DEFAULT '[]',
      "routerHint" TEXT NOT NULL DEFAULT '',
      "createdAt" BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id),
      "projectId" TEXT REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL, "agentId" TEXT REFERENCES agents(id) ON DELETE SET NULL,
      "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, "threadId" TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL,
      "toolCalls" TEXT, "artifactIds" TEXT, model TEXT, "costCredits" INTEGER,
      "createdAt" BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      "threadId" TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      "messageId" TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, "createdAt" BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id),
      "agentId" TEXT REFERENCES agents(id) ON DELETE CASCADE,
      "projectId" TEXT REFERENCES projects(id) ON DELETE CASCADE,
      content TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 5, "createdAt" BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connector_credentials (
      id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id),
      "connectorId" TEXT NOT NULL, label TEXT NOT NULL,
      credentials TEXT NOT NULL, "createdAt" BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY, "userId" TEXT REFERENCES users(id),
      name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
      "systemPromptAddition" TEXT NOT NULL, "toolHints" TEXT NOT NULL DEFAULT '[]',
      "isTemplate" INTEGER NOT NULL DEFAULT 0,
      "installedFromTemplate" TEXT, "createdAt" BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id),
      amount INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT, "createdAt" BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id),
      "agentId" TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Automation',
      prompt TEXT NOT NULL, "intervalMinutes" INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, "lastRunAt" BIGINT, "createdAt" BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      "scheduleId" TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      "threadId" TEXT, status TEXT NOT NULL, output TEXT NOT NULL,
      "startedAt" BIGINT NOT NULL, "endedAt" BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_threads_user ON threads("userId", "updatedAt" DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages("threadId", "createdAt");
    CREATE INDEX IF NOT EXISTS idx_artifacts_thread ON artifacts("threadId");
    CREATE INDEX IF NOT EXISTS idx_runs_schedule ON runs("scheduleId", "startedAt" DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_user ON memories("userId", importance DESC);
    CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions("userId", "createdAt" DESC);
  `);
}

async function seedIfEmpty() {
  const r = await pool().query(`SELECT COUNT(*)::int as c FROM users`);
  if (r.rows[0]?.c > 0) return;
  const now = Date.now();
  const id = "u_demo";
  const pw = hashPassword("demo");
  await pool().query(
    `INSERT INTO users (id,email,"passwordHash",name,"createdAt") VALUES ($1,$2,$3,$4,$5)`,
    [id, "demo@hyperagent.local", pw, "Demo User", now],
  );

  const projWork = uid("p");
  await pool().query(
    `INSERT INTO projects (id,"userId",name,description,color,"createdAt") VALUES ($1,$2,$3,$4,$5,$6)`,
    [projWork, id, "Work", "Day-to-day work threads", "orange", now],
  );

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
  for (const a of agents) {
    await pool().query(
      `INSERT INTO agents (id,"userId","projectId",name,icon,color,description,"systemPrompt",tools,"connectorIds","routerHint","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [a.id, id, null, a.name, a.icon, a.color, a.description, a.systemPrompt,
       JSON.stringify(a.tools), JSON.stringify(a.connectorIds), a.routerHint, now],
    );
  }

  const memories = [
    { content: "User name is Mira Chen. Prefers takeaway-first format. Skip filler — she edits hard.", importance: 9, agentId: null },
    { content: "Citations as footnotes, not inline.", importance: 7, agentId: null },
    { content: "Surface contradictions in evidence rather than smoothing them over.", importance: 8, agentId: "a_research" },
  ];
  for (const m of memories) {
    await pool().query(
      `INSERT INTO memories (id,"userId","agentId","projectId",content,importance,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uid("mem"), id, m.agentId, null, m.content, m.importance, now],
    );
  }

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
  for (const s of skillTemplates) {
    await pool().query(
      `INSERT INTO skills (id,"userId",name,description,category,"systemPromptAddition","toolHints","isTemplate","installedFromTemplate","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [uid("sk"), null, s.name, s.description, s.category, s.systemPromptAddition,
       JSON.stringify(s.toolHints), 1, null, now],
    );
  }

  await pool().query(
    `INSERT INTO credit_transactions (id,"userId",amount,reason,ref,"createdAt") VALUES ($1,$2,$3,$4,$5,$6)`,
    [uid("ct"), id, 10000, "Welcome bonus", null, now],
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

async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  await ensureInit();
  const r = await pool().query(sql, params);
  return r.rows as T[];
}
async function qOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] || null;
}

// USERS
export async function getUserByEmail(email: string): Promise<(User & { passwordHash: string }) | null> {
  return qOne(`SELECT * FROM users WHERE email = $1`, [email]);
}
export async function getUserById(id: string): Promise<User | null> {
  return qOne(`SELECT id,email,name,"createdAt" FROM users WHERE id = $1`, [id]);
}
export async function createUser(email: string, password: string, name: string): Promise<User> {
  const id = uid("u"); const now = Date.now();
  await q(`INSERT INTO users (id,email,"passwordHash",name,"createdAt") VALUES ($1,$2,$3,$4,$5)`,
    [id, email, hashPassword(password), name, now]);
  await q(`INSERT INTO credit_transactions (id,"userId",amount,reason,ref,"createdAt") VALUES ($1,$2,$3,$4,$5,$6)`,
    [uid("ct"), id, 5000, "Welcome bonus", null, now]);
  return { id, email, name, createdAt: now };
}

// SESSIONS
export async function createSession(userId: string): Promise<string> {
  const id = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 30;
  await q(`INSERT INTO sessions (id,"userId","expiresAt") VALUES ($1,$2,$3)`, [id, userId, expiresAt]);
  return id;
}
export async function getSessionUser(sessionId: string): Promise<User | null> {
  return qOne(
    `SELECT u.id,u.email,u.name,u."createdAt" FROM sessions s JOIN users u ON u.id=s."userId" WHERE s.id=$1 AND s."expiresAt">$2`,
    [sessionId, Date.now()],
  );
}
export async function destroySession(sessionId: string) {
  await q(`DELETE FROM sessions WHERE id=$1`, [sessionId]);
}

// PROJECTS
export async function listProjects(userId: string): Promise<Project[]> {
  return q(`SELECT * FROM projects WHERE "userId"=$1 ORDER BY "createdAt"`, [userId]);
}
export async function getProject(id: string, userId: string): Promise<Project | null> {
  return qOne(`SELECT * FROM projects WHERE id=$1 AND "userId"=$2`, [id, userId]);
}
export async function createProject(p: Omit<Project,"id"|"createdAt">): Promise<Project> {
  const id = uid("p"); const createdAt = Date.now();
  await q(`INSERT INTO projects (id,"userId",name,description,color,"createdAt") VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, p.userId, p.name, p.description, p.color, createdAt]);
  return { ...p, id, createdAt };
}
export async function deleteProject(id: string, userId: string) {
  await q(`DELETE FROM projects WHERE id=$1 AND "userId"=$2`, [id, userId]);
}

// THREADS
export async function listThreads(userId: string, projectId?: string | null): Promise<Thread[]> {
  if (projectId === undefined) {
    return q(`SELECT * FROM threads WHERE "userId"=$1 ORDER BY "updatedAt" DESC`, [userId]);
  }
  return q(`SELECT * FROM threads WHERE "userId"=$1 AND "projectId" IS NOT DISTINCT FROM $2 ORDER BY "updatedAt" DESC`,
    [userId, projectId]);
}
export async function getThread(id: string, userId: string): Promise<Thread | null> {
  return qOne(`SELECT * FROM threads WHERE id=$1 AND "userId"=$2`, [id, userId]);
}
export async function createThread(userId: string, title: string, agentId: string | null, projectId: string | null = null): Promise<Thread> {
  const id = uid("t"); const now = Date.now();
  await q(`INSERT INTO threads (id,"userId","projectId",title,"agentId","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, userId, projectId, title, agentId, now, now]);
  return { id, userId, projectId, title, agentId, createdAt: now, updatedAt: now };
}
export async function updateThread(id: string, userId: string, fields: { title?: string; updatedAt?: number; agentId?: string | null; projectId?: string | null }) {
  const cur = await getThread(id, userId); if (!cur) return;
  const n = { ...cur, ...fields, updatedAt: Date.now() };
  await q(`UPDATE threads SET title=$1,"agentId"=$2,"projectId"=$3,"updatedAt"=$4 WHERE id=$5 AND "userId"=$6`,
    [n.title, n.agentId, n.projectId, n.updatedAt, id, userId]);
}
export async function deleteThread(id: string, userId: string) {
  await q(`DELETE FROM threads WHERE id=$1 AND "userId"=$2`, [id, userId]);
}

// MESSAGES
export async function listMessages(threadId: string): Promise<Message[]> {
  const rows = await q<any>(`SELECT * FROM messages WHERE "threadId"=$1 ORDER BY "createdAt"`, [threadId]);
  return rows.map(r => ({
    ...r,
    toolCalls: r.toolCalls ? JSON.parse(r.toolCalls) : undefined,
    artifactIds: r.artifactIds ? JSON.parse(r.artifactIds) : undefined,
  }));
}
export async function createMessage(m: Omit<Message,"id"|"createdAt">): Promise<Message> {
  const id = uid("m"); const createdAt = Date.now();
  await q(`INSERT INTO messages (id,"threadId",role,content,"toolCalls","artifactIds",model,"costCredits","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, m.threadId, m.role, m.content,
     m.toolCalls ? JSON.stringify(m.toolCalls) : null,
     m.artifactIds ? JSON.stringify(m.artifactIds) : null,
     m.model || null, m.costCredits ?? null, createdAt]);
  return { ...m, id, createdAt };
}
export async function updateMessage(id: string, fields: Partial<Pick<Message,"content"|"toolCalls"|"artifactIds"|"costCredits">>) {
  const cur = await qOne<any>(`SELECT * FROM messages WHERE id=$1`, [id]);
  if (!cur) return;
  const content = fields.content !== undefined ? fields.content : cur.content;
  const toolCalls = fields.toolCalls !== undefined ? JSON.stringify(fields.toolCalls) : cur.toolCalls;
  const artifactIds = fields.artifactIds !== undefined ? JSON.stringify(fields.artifactIds) : cur.artifactIds;
  const costCredits = fields.costCredits !== undefined ? fields.costCredits : cur.costCredits;
  await q(`UPDATE messages SET content=$1,"toolCalls"=$2,"artifactIds"=$3,"costCredits"=$4 WHERE id=$5`,
    [content, toolCalls, artifactIds, costCredits, id]);
}

// ARTIFACTS
export async function createArtifact(a: Omit<Artifact,"id"|"createdAt">): Promise<Artifact> {
  const id = uid("art"); const createdAt = Date.now();
  await q(`INSERT INTO artifacts (id,"threadId","messageId",type,title,body,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, a.threadId, a.messageId, a.type, a.title, a.body, createdAt]);
  return { ...a, id, createdAt };
}
export async function getArtifact(id: string): Promise<Artifact | null> {
  return qOne(`SELECT * FROM artifacts WHERE id=$1`, [id]);
}
export async function listArtifactsForUser(userId: string): Promise<Artifact[]> {
  return q(`SELECT a.* FROM artifacts a JOIN threads t ON t.id=a."threadId" WHERE t."userId"=$1 ORDER BY a."createdAt" DESC`, [userId]);
}

// AGENTS
export async function listAgents(userId: string): Promise<Agent[]> {
  const rows = await q<any>(`SELECT * FROM agents WHERE "userId"=$1 ORDER BY "createdAt"`, [userId]);
  return rows.map(r => ({ ...r, tools: JSON.parse(r.tools), connectorIds: JSON.parse(r.connectorIds || "[]") }));
}
export async function getAgent(id: string, userId: string): Promise<Agent | null> {
  const row = await qOne<any>(`SELECT * FROM agents WHERE id=$1 AND "userId"=$2`, [id, userId]);
  if (!row) return null;
  return { ...row, tools: JSON.parse(row.tools), connectorIds: JSON.parse(row.connectorIds || "[]") };
}
export async function createAgent(a: Omit<Agent,"id"|"createdAt"> & { projectId?: string | null; connectorIds?: string[]; routerHint?: string }): Promise<Agent> {
  const id = uid("a"); const createdAt = Date.now();
  const projectId = a.projectId ?? null;
  const connectorIds = a.connectorIds ?? [];
  const routerHint = a.routerHint ?? "";
  await q(`INSERT INTO agents (id,"userId","projectId",name,icon,color,description,"systemPrompt",tools,"connectorIds","routerHint","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, a.userId, projectId, a.name, a.icon, a.color, a.description, a.systemPrompt,
     JSON.stringify(a.tools), JSON.stringify(connectorIds), routerHint, createdAt]);
  return { ...a, id, projectId, connectorIds, routerHint, createdAt } as Agent;
}
export async function updateAgent(id: string, userId: string, fields: Partial<Omit<Agent,"id"|"userId"|"createdAt">>) {
  const cur = await getAgent(id, userId); if (!cur) return;
  const n = { ...cur, ...fields };
  await q(`UPDATE agents SET "projectId"=$1,name=$2,icon=$3,color=$4,description=$5,"systemPrompt"=$6,tools=$7,"connectorIds"=$8,"routerHint"=$9 WHERE id=$10 AND "userId"=$11`,
    [n.projectId, n.name, n.icon, n.color, n.description, n.systemPrompt,
     JSON.stringify(n.tools), JSON.stringify(n.connectorIds), n.routerHint, id, userId]);
}
export async function deleteAgent(id: string, userId: string) {
  await q(`DELETE FROM agents WHERE id=$1 AND "userId"=$2`, [id, userId]);
}

// MEMORIES
export async function listMemories(userId: string, opts: { agentId?: string | null; projectId?: string | null } = {}): Promise<Memory[]> {
  const conds: string[] = ['"userId"=$1']; const vals: any[] = [userId];
  if (opts.agentId !== undefined) { vals.push(opts.agentId); conds.push(`("agentId" IS NOT DISTINCT FROM $${vals.length} OR "agentId" IS NULL)`); }
  if (opts.projectId !== undefined) { vals.push(opts.projectId); conds.push(`("projectId" IS NOT DISTINCT FROM $${vals.length} OR "projectId" IS NULL)`); }
  return q(`SELECT * FROM memories WHERE ${conds.join(" AND ")} ORDER BY importance DESC, "createdAt" DESC`, vals);
}
export async function createMemory(m: Omit<Memory,"id"|"createdAt">): Promise<Memory> {
  const id = uid("mem"); const createdAt = Date.now();
  await q(`INSERT INTO memories (id,"userId","agentId","projectId",content,importance,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, m.userId, m.agentId, m.projectId, m.content, m.importance, createdAt]);
  return { ...m, id, createdAt };
}
export async function deleteMemory(id: string, userId: string) {
  await q(`DELETE FROM memories WHERE id=$1 AND "userId"=$2`, [id, userId]);
}

// CONNECTOR CREDENTIALS
export async function listConnectorCredentials(userId: string): Promise<ConnectorCredential[]> {
  const rows = await q<any>(`SELECT * FROM connector_credentials WHERE "userId"=$1`, [userId]);
  return rows.map(r => ({ ...r, credentials: JSON.parse(r.credentials) }));
}
export async function getConnectorCredentialsForId(userId: string, connectorId: string): Promise<ConnectorCredential | null> {
  const row = await qOne<any>(`SELECT * FROM connector_credentials WHERE "userId"=$1 AND "connectorId"=$2 LIMIT 1`, [userId, connectorId]);
  if (!row) return null;
  return { ...row, credentials: JSON.parse(row.credentials) };
}
export async function upsertConnectorCredentials(userId: string, connectorId: string, label: string, credentials: Record<string,string>): Promise<ConnectorCredential> {
  const existing = await getConnectorCredentialsForId(userId, connectorId);
  if (existing) {
    await q(`UPDATE connector_credentials SET label=$1,credentials=$2 WHERE id=$3`, [label, JSON.stringify(credentials), existing.id]);
    return { ...existing, label, credentials };
  }
  const id = uid("cc"); const createdAt = Date.now();
  await q(`INSERT INTO connector_credentials (id,"userId","connectorId",label,credentials,"createdAt") VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, userId, connectorId, label, JSON.stringify(credentials), createdAt]);
  return { id, userId, connectorId, label, credentials, createdAt };
}
export async function deleteConnectorCredentials(userId: string, connectorId: string) {
  await q(`DELETE FROM connector_credentials WHERE "userId"=$1 AND "connectorId"=$2`, [userId, connectorId]);
}

// SKILLS
export async function listSkillTemplates(): Promise<Skill[]> {
  const rows = await q<any>(`SELECT * FROM skills WHERE "isTemplate"=1 ORDER BY category, name`);
  return rows.map(r => ({ ...r, toolHints: JSON.parse(r.toolHints) }));
}
export async function listUserSkills(userId: string): Promise<Skill[]> {
  const rows = await q<any>(`SELECT * FROM skills WHERE "userId"=$1 ORDER BY "createdAt" DESC`, [userId]);
  return rows.map(r => ({ ...r, toolHints: JSON.parse(r.toolHints) }));
}
export async function getSkill(id: string): Promise<Skill | null> {
  const row = await qOne<any>(`SELECT * FROM skills WHERE id=$1`, [id]);
  if (!row) return null;
  return { ...row, toolHints: JSON.parse(row.toolHints) };
}
export async function installSkillFromTemplate(userId: string, templateId: string): Promise<Skill | null> {
  const tpl = await getSkill(templateId);
  if (!tpl || !tpl.isTemplate) return null;
  const id = uid("sk"); const createdAt = Date.now();
  await q(`INSERT INTO skills (id,"userId",name,description,category,"systemPromptAddition","toolHints","isTemplate","installedFromTemplate","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, userId, tpl.name, tpl.description, tpl.category, tpl.systemPromptAddition,
     JSON.stringify(tpl.toolHints), 0, templateId, createdAt]);
  return { ...tpl, id, userId, isTemplate: 0, installedFromTemplate: templateId, createdAt };
}
export async function createSkill(s: Omit<Skill,"id"|"createdAt">): Promise<Skill> {
  const id = uid("sk"); const createdAt = Date.now();
  await q(`INSERT INTO skills (id,"userId",name,description,category,"systemPromptAddition","toolHints","isTemplate","installedFromTemplate","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, s.userId, s.name, s.description, s.category, s.systemPromptAddition,
     JSON.stringify(s.toolHints), s.isTemplate, s.installedFromTemplate, createdAt]);
  return { ...s, id, createdAt };
}
export async function deleteSkill(id: string, userId: string) {
  await q(`DELETE FROM skills WHERE id=$1 AND "userId"=$2`, [id, userId]);
}

// CREDITS
export async function getCreditBalance(userId: string): Promise<number> {
  const r = await qOne<any>(`SELECT COALESCE(SUM(amount),0)::int as bal FROM credit_transactions WHERE "userId"=$1`, [userId]);
  return r?.bal || 0;
}
export async function listCreditTransactions(userId: string, limit = 50): Promise<CreditTransaction[]> {
  return q(`SELECT * FROM credit_transactions WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT $2`, [userId, limit]);
}
export async function addCredits(userId: string, amount: number, reason: string, ref: string | null = null) {
  await q(`INSERT INTO credit_transactions (id,"userId",amount,reason,ref,"createdAt") VALUES ($1,$2,$3,$4,$5,$6)`,
    [uid("ct"), userId, amount, reason, ref, Date.now()]);
}

// SCHEDULES
export async function listSchedules(userId: string): Promise<Schedule[]> {
  return q(`SELECT * FROM schedules WHERE "userId"=$1 ORDER BY "createdAt" DESC`, [userId]);
}
export async function listAllActiveSchedules(): Promise<Schedule[]> {
  return q(`SELECT * FROM schedules WHERE active=1`);
}
export async function getSchedule(id: string): Promise<Schedule | null> {
  return qOne(`SELECT * FROM schedules WHERE id=$1`, [id]);
}
export async function createSchedule(s: Omit<Schedule,"id"|"createdAt"|"lastRunAt">): Promise<Schedule> {
  const id = uid("sch"); const createdAt = Date.now();
  await q(`INSERT INTO schedules (id,"userId","agentId",name,prompt,"intervalMinutes",active,"lastRunAt","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, s.userId, s.agentId, s.name, s.prompt, s.intervalMinutes, s.active, null, createdAt]);
  return { ...s, id, createdAt, lastRunAt: null };
}
export async function updateSchedule(id: string, fields: Partial<Schedule>) {
  if (fields.active !== undefined) await q(`UPDATE schedules SET active=$1 WHERE id=$2`, [fields.active, id]);
  if (fields.lastRunAt !== undefined) await q(`UPDATE schedules SET "lastRunAt"=$1 WHERE id=$2`, [fields.lastRunAt, id]);
}
export async function deleteSchedule(id: string, userId: string) {
  await q(`DELETE FROM schedules WHERE id=$1 AND "userId"=$2`, [id, userId]);
}

// RUNS
export async function createRun(r: Omit<Run,"id">): Promise<Run> {
  const id = uid("run");
  await q(`INSERT INTO runs (id,"scheduleId","threadId",status,output,"startedAt","endedAt") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, r.scheduleId, r.threadId, r.status, r.output, r.startedAt, r.endedAt]);
  return { ...r, id };
}
export async function updateRun(id: string, fields: Partial<Run>) {
  const sets: string[] = []; const vals: any[] = [];
  for (const [k,v] of Object.entries(fields)) { vals.push(v); sets.push(`"${k}"=$${vals.length}`); }
  if (!sets.length) return;
  vals.push(id);
  await q(`UPDATE runs SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
}
export async function listRuns(userId: string, limit = 50): Promise<Run[]> {
  return q(`SELECT r.* FROM runs r JOIN schedules s ON s.id=r."scheduleId" WHERE s."userId"=$1 ORDER BY r."startedAt" DESC LIMIT $2`, [userId, limit]);
}
