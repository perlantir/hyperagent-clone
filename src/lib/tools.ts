// Tool registry. Three layers:
//   1. Built-in tools that always work (web_search, generate_artifact)
//   2. Browser/computer-use tools backed by Hyperbrowser (real cloud Chromium)
//   3. Composio-managed tools (currently stubbed)

import * as browser from "./browser";
import * as media from "./media";
import { getComposioTools, executeComposioTool, listConnectedAccounts } from "./composio";

export interface ToolDef {
  name: string;
  description: string;
  input_schema: any;
  execute: (args: any, ctx: ToolCtx) => Promise<string>;
}

export interface ToolCtx {
  userId: string;
  threadId: string;
  messageId: string;
  artifactsCreated: { id: string; type: string; title: string }[];
}

async function ddgSearch(query: string): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    });
    const html = await res.text();
    const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const links: { title: string; url: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html))) {
      const decoded = m[1].startsWith("//duckduckgo.com/l/?uddg=")
        ? decodeURIComponent(m[1].split("uddg=")[1].split("&")[0])
        : m[1];
      links.push({ url: decoded, title: stripTags(m[2]) });
    }
    const snips: string[] = [];
    while ((m = snipRe.exec(html))) snips.push(stripTags(m[1]));
    const out: string[] = [];
    for (let i = 0; i < Math.min(links.length, 6); i++) {
      out.push(`${i+1}. ${links[i].title}\n   ${links[i].url}\n   ${snips[i] || ""}`);
    }
    return out.length ? out.join("\n\n") : "No results.";
  } catch (e: any) {
    return `Search failed: ${e.message}`;
  }
}

function stripTags(s: string) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
}

export const BUILTIN_TOOLS: Record<string, ToolDef> = {
  web_search: {
    name: "web_search",
    description: "Search the public web. Returns up to 6 results with titles, URLs, and snippets.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async execute(args) {
      const q = String(args?.query || "").trim();
      if (!q) return "Empty query.";
      return await ddgSearch(q);
    },
  },
  generate_artifact: {
    name: "generate_artifact",
    description: "Create a persistent artifact (webpage, document, table, image) saved to this thread. Body should be HTML body content.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["webpage","document","table","image"] },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["type","title","body"],
    },
    async execute(args, ctx) {
      const { createArtifact } = await import("./db");
      const a = await createArtifact({
        threadId: ctx.threadId, messageId: ctx.messageId,
        type: args.type, title: args.title, body: args.body,
      });
      ctx.artifactsCreated.push({ id: a.id, type: a.type, title: a.title });
      return `Artifact saved: id=${a.id} title="${a.title}"`;
    },
  },

  // ============ BROWSER AUTOMATION (Hyperbrowser) ============

  browser_navigate: {
    name: "browser_navigate",
    description: "Open a URL in the user's browser session. Creates a session if none exists. Returns the final URL and page title.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async execute(args, ctx) {
      try {
        const r = await browser.navigate(ctx.userId, args.url);
        return `Navigated to ${r.url}\nTitle: ${r.title}`;
      } catch (e: any) { return `browser_navigate error: ${e.message}`; }
    },
  },

  browser_screenshot: {
    name: "browser_screenshot",
    description: "Capture a screenshot of the current page. Saves it as an image artifact and returns the artifact id.",
    input_schema: {
      type: "object",
      properties: { fullPage: { type: "boolean", description: "Capture full scrollable page (default false)" } },
    },
    async execute(args, ctx) {
      try {
        const base64 = await browser.screenshot(ctx.userId, args.fullPage || false);
        if (!base64) return "Screenshot returned empty data.";
        const { createArtifact } = await import("./db");
        const html = `<img src="data:image/png;base64,${base64}" style="max-width:100%;display:block">`;
        const a = await createArtifact({
          threadId: ctx.threadId, messageId: ctx.messageId,
          type: "image", title: `Screenshot ${new Date().toISOString().slice(0,16)}`, body: html,
        });
        ctx.artifactsCreated.push({ id: a.id, type: a.type, title: a.title });
        return `Screenshot saved as artifact id=${a.id}`;
      } catch (e: any) { return `browser_screenshot error: ${e.message}`; }
    },
  },

  browser_click: {
    name: "browser_click",
    description: "Click an element on the current page using a CSS selector. Use #id, .class, [data-attr=value], or button:has-text() patterns.",
    input_schema: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
    async execute(args, ctx) {
      try {
        await browser.click(ctx.userId, args.selector);
        return `Clicked ${args.selector}`;
      } catch (e: any) { return `browser_click error: ${e.message}`; }
    },
  },

  browser_type: {
    name: "browser_type",
    description: "Type text into a form field identified by CSS selector. Use after browser_click on the input first.",
    input_schema: {
      type: "object",
      properties: { selector: { type: "string" }, text: { type: "string" } },
      required: ["selector","text"],
    },
    async execute(args, ctx) {
      try {
        await browser.type(ctx.userId, args.selector, args.text);
        return `Typed ${args.text.length} chars into ${args.selector}`;
      } catch (e: any) { return `browser_type error: ${e.message}`; }
    },
  },

  browser_press_key: {
    name: "browser_press_key",
    description: "Press a keyboard key (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown').",
    input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    async execute(args, ctx) {
      try { await browser.pressKey(ctx.userId, args.key); return `Pressed ${args.key}`; }
      catch (e: any) { return `browser_press_key error: ${e.message}`; }
    },
  },

  browser_get_text: {
    name: "browser_get_text",
    description: "Get text content of the page or a specific element. Pass a CSS selector to scope, omit for full page.",
    input_schema: { type: "object", properties: { selector: { type: "string" } } },
    async execute(args, ctx) {
      try { return await browser.getText(ctx.userId, args.selector); }
      catch (e: any) { return `browser_get_text error: ${e.message}`; }
    },
  },

  browser_extract: {
    name: "browser_extract",
    description: "AI-powered extraction. Pass a natural-language instruction like 'extract all product names and prices' and get structured data back.",
    input_schema: { type: "object", properties: { instruction: { type: "string" } }, required: ["instruction"] },
    async execute(args, ctx) {
      try { return await browser.aiExtract(ctx.userId, args.instruction); }
      catch (e: any) { return `browser_extract error: ${e.message}`; }
    },
  },

  browser_scroll: {
    name: "browser_scroll",
    description: "Scroll the page. Direction is 'up', 'down', 'top', or 'bottom'.",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up","down","top","bottom"] },
        amount: { type: "number", description: "Pixels for up/down (default 600)" },
      },
      required: ["direction"],
    },
    async execute(args, ctx) {
      try { await browser.scroll(ctx.userId, args.direction, args.amount); return `Scrolled ${args.direction}`; }
      catch (e: any) { return `browser_scroll error: ${e.message}`; }
    },
  },

  browser_close: {
    name: "browser_close",
    description: "Close the current browser session. Frees server resources. The next browser_navigate call will start a new session.",
    input_schema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      try { await browser.closeSession(ctx.userId); return "Browser session closed"; }
      catch (e: any) { return `browser_close error: ${e.message}`; }
    },
  },

  // ============ COMPUTER USE (pixel-precise) ============
  // These map the Anthropic computer_use_20241022 action set onto a
  // Hyperbrowser session. Coordinates are pixel offsets in the browser
  // viewport (default 1280×720). For agents that need pixel-precise control.

  computer_screenshot: {
    name: "computer_screenshot",
    description: "Take a screenshot of the virtual desktop (browser viewport). Returns artifact id of the captured PNG.",
    input_schema: { type: "object", properties: {} },
    async execute(_args, ctx) {
      try {
        const base64 = await browser.screenshot(ctx.userId, false);
        const { createArtifact } = await import("./db");
        const html = `<img src="data:image/png;base64,${base64}" style="max-width:100%;display:block">`;
        const a = await createArtifact({
          threadId: ctx.threadId, messageId: ctx.messageId,
          type: "image", title: `Computer screenshot ${new Date().toISOString().slice(11,19)}`, body: html,
        });
        ctx.artifactsCreated.push({ id: a.id, type: a.type, title: a.title });
        return `Screenshot id=${a.id}`;
      } catch (e: any) { return `computer_screenshot error: ${e.message}`; }
    },
  },

  computer_click: {
    name: "computer_click",
    description: "Click at pixel coordinates (x, y) in the virtual desktop.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left","right","middle"] },
        double: { type: "boolean" },
      },
      required: ["x","y"],
    },
    async execute(args, ctx) {
      try {
        if (args.double) await browser.mouseDoubleClick(ctx.userId, args.x, args.y);
        else await browser.mouseClick(ctx.userId, args.x, args.y, args.button || "left");
        return `Clicked (${args.x},${args.y})`;
      } catch (e: any) { return `computer_click error: ${e.message}`; }
    },
  },

  computer_move: {
    name: "computer_move",
    description: "Move the mouse to pixel coordinates without clicking.",
    input_schema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x","y"] },
    async execute(args, ctx) {
      try { await browser.mouseMove(ctx.userId, args.x, args.y); return `Moved to (${args.x},${args.y})`; }
      catch (e: any) { return `computer_move error: ${e.message}`; }
    },
  },

  computer_type: {
    name: "computer_type",
    description: "Type text into the focused element (no selector needed). Use computer_click first to focus.",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(args, ctx) {
      try { await browser.keyboardType(ctx.userId, args.text); return `Typed ${args.text.length} chars`; }
      catch (e: any) { return `computer_type error: ${e.message}`; }
    },
  },

  computer_key: {
    name: "computer_key",
    description: "Press a keyboard key — 'Enter', 'Tab', 'Escape', 'Meta+a', 'Control+c', etc.",
    input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    async execute(args, ctx) {
      try { await browser.pressKey(ctx.userId, args.key); return `Pressed ${args.key}`; }
      catch (e: any) { return `computer_key error: ${e.message}`; }
    },
  },

  // ============ FILE OPERATIONS ============

  upload_file_to_page: {
    name: "upload_file_to_page",
    description: "Upload a file to a file-input on the current page. Pass a publicly accessible URL of the file plus the CSS selector of the <input type=file>.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        fileUrl: { type: "string" },
        filename: { type: "string" },
      },
      required: ["selector","fileUrl","filename"],
    },
    async execute(args, ctx) {
      try {
        await browser.uploadFile(ctx.userId, args.selector, args.fileUrl, args.filename);
        return `Uploaded ${args.filename} to ${args.selector}`;
      } catch (e: any) { return `upload_file_to_page error: ${e.message}`; }
    },
  },

  download_file: {
    name: "download_file",
    description: "Download a file from a URL and capture it. Returns the downloaded URL + filename.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async execute(args, ctx) {
      try {
        const r = await browser.downloadFile(ctx.userId, args.url);
        return `Downloaded ${r.filename} → ${r.url}`;
      } catch (e: any) { return `download_file error: ${e.message}`; }
    },
  },

  // ============ MEDIA GENERATION (P13) ============

  generate_image: {
    name: "generate_image",
    description: "Generate a new image from a text prompt using Gemini Nano Banana. Saves as image artifact.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to draw. Be specific about subject, style, composition." },
        aspectRatio: { type: "string", enum: ["1:1","16:9","9:16","4:3","3:4"], description: "Image aspect ratio" },
      },
      required: ["prompt"],
    },
    async execute(args, ctx) {
      try {
        const base64 = await media.generateImage(args.prompt, { aspectRatio: args.aspectRatio });
        if (!base64) return "Image generation returned empty.";
        const { createArtifact } = await import("./db");
        const a = await createArtifact({
          threadId: ctx.threadId, messageId: ctx.messageId, type: "image",
          title: args.prompt.slice(0, 60),
          body: `<img src="data:image/png;base64,${base64}" style="max-width:100%;display:block">`,
        });
        ctx.artifactsCreated.push({ id: a.id, type: a.type, title: a.title });
        return `Image generated: artifact id=${a.id}`;
      } catch (e: any) { return `generate_image error: ${e.message}`; }
    },
  },

  generate_speech: {
    name: "generate_speech",
    description: "Convert text to speech audio (Gemini TTS). Saves as a document artifact with embedded audio player.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        voice: { type: "string", enum: ["Kore","Charon","Puck","Zephyr","Leda","Aoede"] },
      },
      required: ["text"],
    },
    async execute(args, ctx) {
      try {
        const base64 = await media.generateSpeech(args.text, args.voice || "Kore");
        if (!base64) return "TTS returned empty.";
        const { createArtifact } = await import("./db");
        const a = await createArtifact({
          threadId: ctx.threadId, messageId: ctx.messageId, type: "document",
          title: `Audio: ${args.text.slice(0, 50)}…`,
          body: `<audio controls style="width:100%"><source src="data:audio/wav;base64,${base64}" type="audio/wav"></audio>`,
        });
        ctx.artifactsCreated.push({ id: a.id, type: a.type, title: a.title });
        return `Audio generated: artifact id=${a.id}`;
      } catch (e: any) { return `generate_speech error: ${e.message}`; }
    },
  },

  generate_video: {
    name: "generate_video",
    description: "Generate a short video from a text prompt using Veo. Returns an operation name to poll. Long-running (1-3 min).",
    input_schema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
    async execute(args, _ctx) {
      try {
        const r = await media.generateVideo(args.prompt);
        return `Video generation started. Operation: ${r.operationName}. Poll with check_video_status.`;
      } catch (e: any) { return `generate_video error: ${e.message}`; }
    },
  },
};

// Anthropic-format tool spec
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: any;
}

// Resolve all tools for a chat turn:
//   - Always includes BUILTIN_TOOLS that match the agent's tool list
//   - Adds Composio tools for any toolkits the user has connected
export async function resolveAllTools(
  userId: string,
  agentToolNames: string[],
): Promise<{ tools: AnthropicTool[]; composioToolNames: Set<string>; builtinTools: ToolDef[] }> {
  const builtinTools: ToolDef[] = [];
  for (const name of agentToolNames) {
    if (BUILTIN_TOOLS[name]) builtinTools.push(BUILTIN_TOOLS[name]);
  }

  const connected = await listConnectedAccounts(userId);
  const connectedToolkits = Array.from(
    new Set(connected.map((c: any) => c.toolkit?.slug || c.appName || c.app_name).filter(Boolean)),
  ) as string[];
  const composioTools = await getComposioTools(userId, connectedToolkits);

  const tools: AnthropicTool[] = [
    ...builtinTools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    ...composioTools.map((t: any) => ({
      name: t.name,
      description: t.description || "",
      input_schema: t.input_schema || t.inputSchema || { type: "object", properties: {} },
    })),
  ];
  const composioToolNames = new Set(composioTools.map((t: any) => t.name));
  return { tools, composioToolNames, builtinTools };
}

export async function executeAnyTool(
  name: string,
  args: any,
  ctx: ToolCtx,
  composioToolNames: Set<string>,
  builtinTools: ToolDef[],
): Promise<string> {
  const builtin = builtinTools.find(t => t.name === name);
  if (builtin) return await builtin.execute(args, ctx);
  if (composioToolNames.has(name)) return await executeComposioTool(ctx.userId, name, args);
  return `Unknown tool: ${name}`;
}

// Default tool list for newly-created agents
export const DEFAULT_AGENT_TOOLS = [
  "web_search",
  "generate_artifact",
  "browser_navigate",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_get_text",
  "browser_extract",
  "browser_scroll",
  "browser_close",
  "computer_screenshot",
  "computer_click",
  "computer_move",
  "computer_type",
  "computer_key",
  "upload_file_to_page",
  "download_file",
  "generate_image",
  "generate_speech",
  "generate_video",
];
