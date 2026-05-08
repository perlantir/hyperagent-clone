// Browser automation backend.
//
// Uses Hyperbrowser (https://hyperbrowser.ai) for cloud Chromium sessions.
// Each Hyperagent user gets their own browser session, persisted across tool
// calls within a thread. Sessions auto-expire after inactivity.
//
// HYPERBROWSER_API_KEY env var required. Falls back to clear error messages
// when missing rather than crashing.

interface BrowserSession {
  id: string;            // Hyperbrowser session id
  userId: string;
  createdAt: number;
  lastActiveAt: number;
}

// In-memory session map (lambda-local). For production multi-instance deploys
// we'd persist these in Postgres or Redis.
const sessions = new Map<string, BrowserSession>();
const SESSION_TTL_MS = 30 * 60 * 1000;

function apiKey(): string {
  const k = process.env.HYPERBROWSER_API_KEY;
  if (!k) throw new Error("HYPERBROWSER_API_KEY is not set. Sign up at hyperbrowser.ai and add the key in Vercel env vars.");
  return k;
}

const API = "https://app.hyperbrowser.ai/api";

async function hbFetch(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Hyperbrowser ${path} ${r.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function startSession(userId: string): Promise<BrowserSession> {
  const r = await hbFetch("/session", {
    method: "POST",
    body: JSON.stringify({
      useStealth: true,
      solveCaptchas: true,
      adblock: true,
    }),
  });
  const id = r.id || r.sessionId;
  if (!id) throw new Error("Hyperbrowser session create returned no id");
  const session: BrowserSession = {
    id,
    userId,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  sessions.set(userId, session);
  return session;
}

export async function ensureSession(userId: string): Promise<BrowserSession> {
  const existing = sessions.get(userId);
  if (existing && Date.now() - existing.lastActiveAt < SESSION_TTL_MS) {
    existing.lastActiveAt = Date.now();
    return existing;
  }
  return await startSession(userId);
}

export async function closeSession(userId: string): Promise<void> {
  const s = sessions.get(userId);
  if (!s) return;
  try { await hbFetch(`/session/${s.id}/stop`, { method: "PUT" }); } catch {}
  sessions.delete(userId);
}

// Page-level operations. Hyperbrowser's REST API exposes /scrape, /extract,
// /screenshot, /click, /type, /navigate.

export async function navigate(userId: string, url: string): Promise<{ url: string; title: string }> {
  const s = await ensureSession(userId);
  const r = await hbFetch(`/session/${s.id}/navigate`, {
    method: "POST",
    body: JSON.stringify({ url, waitUntil: "domcontentloaded", timeout: 30000 }),
  });
  return { url: r.url || url, title: r.title || "" };
}

export async function screenshot(userId: string, fullPage = false): Promise<string> {
  const s = await ensureSession(userId);
  const r = await hbFetch(`/session/${s.id}/screenshot`, {
    method: "POST",
    body: JSON.stringify({ fullPage, encoding: "base64" }),
  });
  return r.image || r.data || r.base64 || "";
}

export async function click(userId: string, selector: string): Promise<void> {
  const s = await ensureSession(userId);
  await hbFetch(`/session/${s.id}/click`, {
    method: "POST",
    body: JSON.stringify({ selector, timeout: 10000 }),
  });
}

export async function type(userId: string, selector: string, text: string): Promise<void> {
  const s = await ensureSession(userId);
  await hbFetch(`/session/${s.id}/type`, {
    method: "POST",
    body: JSON.stringify({ selector, text, delay: 50 }),
  });
}

export async function pressKey(userId: string, key: string): Promise<void> {
  const s = await ensureSession(userId);
  await hbFetch(`/session/${s.id}/keyboard`, {
    method: "POST",
    body: JSON.stringify({ key }),
  });
}

export async function getText(userId: string, selector?: string): Promise<string> {
  const s = await ensureSession(userId);
  const r = await hbFetch(`/session/${s.id}/text`, {
    method: "POST",
    body: JSON.stringify({ selector: selector || "body" }),
  });
  return (r.text || r.content || "").slice(0, 8000);
}

export async function getHtml(userId: string): Promise<string> {
  const s = await ensureSession(userId);
  const r = await hbFetch(`/session/${s.id}/html`, { method: "GET" });
  return (r.html || r.content || "").slice(0, 16000);
}

export async function aiExtract(userId: string, instruction: string): Promise<string> {
  const s = await ensureSession(userId);
  const r = await hbFetch(`/session/${s.id}/extract`, {
    method: "POST",
    body: JSON.stringify({ instruction }),
  });
  if (typeof r === "string") return r.slice(0, 8000);
  return JSON.stringify(r.data || r).slice(0, 8000);
}

export async function scroll(userId: string, direction: "up"|"down"|"top"|"bottom", amount = 600): Promise<void> {
  const s = await ensureSession(userId);
  await hbFetch(`/session/${s.id}/scroll`, {
    method: "POST",
    body: JSON.stringify({ direction, amount }),
  });
}

export async function uploadFile(userId: string, selector: string, fileUrl: string, filename: string): Promise<void> {
  const s = await ensureSession(userId);
  await hbFetch(`/session/${s.id}/upload`, {
    method: "POST",
    body: JSON.stringify({ selector, fileUrl, filename }),
  });
}

export async function downloadFile(userId: string, url: string): Promise<{ url: string; filename: string }> {
  const s = await ensureSession(userId);
  const r = await hbFetch(`/session/${s.id}/download`, {
    method: "POST",
    body: JSON.stringify({ url }),
  });
  return { url: r.url || url, filename: r.filename || "download" };
}

// Computer-use primitive: pixel-coordinate mouse + keyboard. Maps Anthropic's
// computer_20241022 tool actions to Hyperbrowser's CDP-backed mouse/keyboard.

export async function mouseMove(userId: string, x: number, y: number) {
  const s = await ensureSession(userId);
  await hbFetch(`/session/${s.id}/mouse/move`, { method: "POST", body: JSON.stringify({ x, y }) });
}
export async function mouseClick(userId: string, x: number, y: number, button: "left"|"right"|"middle" = "left") {
  const s = await ensureSession(userId);
  await hbFetch(`/session/${s.id}/mouse/click`, { method: "POST", body: JSON.stringify({ x, y, button }) });
}
export async function mouseDoubleClick(userId: string, x: number, y: number) {
  const s = await ensureSession(userId);
  await hbFetch(`/session/${s.id}/mouse/dblclick`, { method: "POST", body: JSON.stringify({ x, y }) });
}
export async function keyboardType(userId: string, text: string) {
  const s = await ensureSession(userId);
  await hbFetch(`/session/${s.id}/keyboard/type`, { method: "POST", body: JSON.stringify({ text }) });
}
