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
    description: `Search the public web. Returns up to 6 results with titles, URLs, and snippets.

When to use: factual lookups for events post-training-cutoff, finding specific URLs, recent news, current pricing/availability, anything where freshness matters.

When NOT to use: general knowledge already in your training (basic math, well-known facts, code syntax), or when the user gave you a specific URL — just fetch it directly via browser_navigate.

Tip: Build queries with high-signal terms. "Anthropic Claude pricing 2026" beats "what does the latest Claude cost." Quote exact phrases. Add site:domain.com to scope to a specific source.

Pitfalls: Returns search results, not the page contents. If you need to read a specific result, call browser_navigate on the URL. Some sites (Twitter/X, SPAs) won't render usefully from search snippets — go to browser for those.`,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query. Be specific; high-signal terms beat broad ones." } },
      required: ["query"],
    },
    async execute(args) {
      const q = String(args?.query || "").trim();
      if (!q) return "Empty query.";
      return await ddgSearch(q);
    },
  },
  generate_artifact: {
    name: "generate_artifact",
    description: `Create a persistent artifact (webpage, document, table, image) attached to this thread. Renders as an inline embed in the chat.

When to use: polished deliverables — research reports, dashboards, comparison tables, slide decks, generated mini-pages. Anything the user is likely to refer back to or share. Always prefer this over inlining a wall of HTML in the response.

When NOT to use: short answers that fit in 2 paragraphs of markdown. Conversational replies. One-off code snippets (use fenced blocks).

The body should be valid HTML body content (no <html>, <head>, <body> wrappers). For tables, use <table>. For pages with custom design, include inline <style>. CDN links for fonts and libraries are fine.

After calling this, reference the artifact in your reply via [[ARTIFACT_<id>]] on its own line so it renders correctly. Do not paste the body content again in your reply.

Pitfalls: All CSS must be inline or in <style> tags (sandboxed iframe blocks external stylesheets). External <a href> must include target="_blank" rel="noopener noreferrer".`,
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["webpage","document","table","image"], description: "Artifact category — webpage for HTML pages, document for long-form text, table for structured data, image for embedded media" },
        title: { type: "string", description: "Short, descriptive title shown above the artifact" },
        body: { type: "string", description: "HTML body content (no <html><body> wrappers)" },
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
    description: `Open a URL in the user's persistent cloud Chromium session. Reuses an existing session within the same thread; auto-creates one if none exists. Sessions persist for 30 minutes of inactivity then auto-terminate.

When to use: any task requiring real page rendering — JS-heavy SPAs, login-gated content, modern web apps, dashboards, anything where web_search snippets won't suffice. Also: when WebFetch / web_search return 404 or empty content.

When NOT to use: simple factual lookups (web_search is faster), or when you need raw API data (use a direct API call via run_shell + curl).

After navigating, follow up with browser_get_text, browser_extract, or browser_screenshot to actually read the page. Most pages benefit from a 1-2 second wait for JS to render — Hyperbrowser handles that automatically via waitUntil: domcontentloaded.

Pitfalls: 30-second timeout on slow pages. Stealth mode is on by default but some bot-walls still detect headless. CAPTCHAs are auto-solved when possible.`,
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Full URL with protocol (https://...)" } },
      required: ["url"],
    },
    async execute(args, ctx) {
      try {
        const r = await browser.navigate(ctx.userId, args.url);
        return `Navigated to ${r.url}\nTitle: ${r.title}`;
      } catch (e: any) { return `browser_navigate error: ${e.message}`; }
    },
  },

  browser_screenshot: {
    name: "browser_screenshot",
    description: `Capture a screenshot of the current browser page. Saves as an image artifact attached to this thread.

When to use: visual verification of state, sharing what the user is currently seeing, capturing UI for comparison/review, or as evidence in a multi-step automation.

When NOT to use: extracting text content (use browser_get_text) — screenshots are larger and the model can't read text in them as accurately as the underlying DOM.

Set fullPage: true to capture the entire scrollable page (useful for long articles or dashboards). Default is just the visible viewport.`,
    input_schema: {
      type: "object",
      properties: { fullPage: { type: "boolean", description: "Capture full scrollable page (default false — viewport only)" } },
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
    description: `Click an element on the current browser page using a CSS selector.

Selector patterns: #id, .class, [data-attr="value"], button:has-text("Submit"), input[name="email"]. Modern semantic selectors usually beat brittle nth-child paths.

When to use: clicking buttons, links, menu items, form controls — anything that takes a click action.

When NOT to use: typing into fields (use browser_type, which auto-clicks first). Pixel-precise interactions where you need exact coordinates (use computer_click).

Pitfalls: 10-second timeout if the selector doesn't match. If a click triggers navigation, the session URL will change — call browser_get_text to read the new page state. Hidden elements (display:none) won't click; check visibility first via browser_extract.`,
    input_schema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS selector matching exactly one element" } },
      required: ["selector"],
    },
    async execute(args, ctx) {
      try {
        await browser.click(ctx.userId, args.selector);
        return `Clicked ${args.selector}`;
      } catch (e: any) { return `browser_click error: ${e.message}`; }
    },
  },

  browser_type: {
    name: "browser_type",
    description: `Type text into a form field. Auto-focuses the field via click first, then types character-by-character with realistic delay.

When to use: filling out forms — search boxes, email/password fields, text areas, contenteditable divs.

When NOT to use: anything that's not an input. Don't try to type into a button or div.

Pitfalls: doesn't clear existing content first. If the field has a default value, send "" first via Ctrl+A then Delete, or just trust that the new text overwrites if the field auto-clears on focus.`,
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the input" },
        text: { type: "string", description: "Text to type (special chars OK; emoji works)" },
      },
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
    description: `Press a keyboard key in the browser. Use after browser_type or browser_click to submit forms or trigger keyboard shortcuts.

Common keys: Enter (submit), Tab (next field), Escape (close modal), ArrowDown/ArrowUp (autocomplete navigation).

For modifier combinations like Cmd+A or Ctrl+C, use computer_key instead — that supports modifier syntax.`,
    input_schema: {
      type: "object",
      properties: { key: { type: "string", description: "Key name like 'Enter', 'Tab', 'Escape', 'ArrowDown'" } },
      required: ["key"],
    },
    async execute(args, ctx) {
      try { await browser.pressKey(ctx.userId, args.key); return `Pressed ${args.key}`; }
      catch (e: any) { return `browser_press_key error: ${e.message}`; }
    },
  },

  browser_get_text: {
    name: "browser_get_text",
    description: `Get text content from the current page or a specific element. Returns up to 8KB of plain text (HTML stripped).

When to use: reading article content, extracting unstructured text, verifying what's currently displayed.

When NOT to use: structured extraction (use browser_extract for that — it returns JSON-shaped data via AI). Reading raw HTML (use the underlying browser API directly).

Pass a selector to scope to a specific element ('main', '#article-body', 'table.results'). Omit selector to get the whole body.`,
    input_schema: {
      type: "object",
      properties: { selector: { type: "string", description: "Optional CSS selector to scope. Defaults to 'body'." } },
    },
    async execute(args, ctx) {
      try { return await browser.getText(ctx.userId, args.selector); }
      catch (e: any) { return `browser_get_text error: ${e.message}`; }
    },
  },

  browser_extract: {
    name: "browser_extract",
    description: `AI-powered structured extraction from the current page. Pass a natural-language instruction; an LLM reads the page and returns JSON-shaped data.

When to use: pulling structured data — product lists with prices, table rows, contact info, article metadata, anything where you'd otherwise parse HTML by hand.

When NOT to use: free-form reading (browser_get_text is cheaper). Single-element extraction where browser_get_text with a selector works.

Examples: "extract all product names and prices", "get author, title, and publication date", "list every menu item with description and price".

Pitfalls: relies on the LLM understanding page structure — works best on well-marked-up pages. May hallucinate if the data isn't actually on the page.`,
    input_schema: {
      type: "object",
      properties: { instruction: { type: "string", description: "What to extract, in natural language" } },
      required: ["instruction"],
    },
    async execute(args, ctx) {
      try { return await browser.aiExtract(ctx.userId, args.instruction); }
      catch (e: any) { return `browser_extract error: ${e.message}`; }
    },
  },

  browser_scroll: {
    name: "browser_scroll",
    description: `Scroll the browser viewport. Use 'top'/'bottom' to jump, 'up'/'down' with amount for granular control.

When to use: revealing lazy-loaded content (infinite scroll feeds), navigating long pages, triggering scroll-based animations or content loaders.

Tip: scroll then re-read with browser_get_text or browser_extract — content above the fold may differ from below.`,
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up","down","top","bottom"], description: "Direction to scroll" },
        amount: { type: "number", description: "Pixels for up/down (default 600). Ignored for top/bottom." },
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
    description: `Explicitly close the current browser session. Frees server resources immediately. Next browser_navigate call starts a fresh session.

When to use: finished a multi-step browser task and won't need it again. End of a research run. Sessions also auto-terminate after 30 minutes of inactivity, so explicit close is mostly for cost control.

When NOT to use: between steps in the same task — keep the session alive to preserve cookies, navigation history, and rendering state.`,
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
    description: `Take a screenshot of the virtual desktop (browser viewport). Same image as browser_screenshot but returns the artifact id reference for use in subsequent computer_* calls.

When to use: pixel-precise computer-use workflows where you need to see the current state before issuing coordinate-based clicks/types.

When NOT to use: extracting text content (use browser_get_text — cheaper and more accurate). General page navigation (browser_screenshot is sufficient).

Pitfalls: viewport defaults to 1280×720; coordinates in subsequent computer_click/computer_move calls must match this coordinate space.`,
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
    description: `Click at pixel coordinates (x, y) in the virtual desktop. Use for pixel-precise interactions when CSS selectors aren't reliable.

When to use: targeting elements that have no stable selector (canvas-rendered UIs, image maps), pixel-precise drag start positions, complex SPAs where DOM is opaque.

When NOT to use: any element with a stable CSS selector — use browser_click instead. Selectors are more robust to viewport/scroll changes.

Coordinate space: 1280×720 viewport (top-left origin). Take a computer_screenshot first to see what's at each position.

Set double:true for double-clicks; button to "right"/"middle" for context menus or middle-click navigation.`,
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X pixel coordinate (0..1280)" },
        y: { type: "number", description: "Y pixel coordinate (0..720)" },
        button: { type: "string", enum: ["left","right","middle"], description: "Mouse button (default left)" },
        double: { type: "boolean", description: "Double-click instead of single (default false)" },
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
    description: `Move the mouse to pixel coordinates without clicking.

When to use: triggering hover-only UI (tooltips, dropdown menus that open on hover), positioning before a deliberate click.

When NOT to use: standard navigation — browser_navigate is faster than scripted mouse movement.`,
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X pixel coordinate" },
        y: { type: "number", description: "Y pixel coordinate" },
      },
      required: ["x","y"],
    },
    async execute(args, ctx) {
      try { await browser.mouseMove(ctx.userId, args.x, args.y); return `Moved to (${args.x},${args.y})`; }
      catch (e: any) { return `computer_move error: ${e.message}`; }
    },
  },

  computer_type: {
    name: "computer_type",
    description: `Type text into whatever element is currently focused (no selector). Use computer_click first to focus a specific input.

When to use: pixel-precise input flows where you've already focused an element via coordinates.

When NOT to use: forms with stable selectors — browser_type is safer (auto-focuses by selector, less likely to type into the wrong element).

Pitfalls: if focus is lost between focus and type (e.g., a modal opened), text goes to whatever has focus instead. Always verify state with computer_screenshot if uncertain.`,
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to type into the currently-focused element" } },
      required: ["text"],
    },
    async execute(args, ctx) {
      try { await browser.keyboardType(ctx.userId, args.text); return `Typed ${args.text.length} chars`; }
      catch (e: any) { return `computer_type error: ${e.message}`; }
    },
  },

  computer_key: {
    name: "computer_key",
    description: `Press a keyboard key or modifier combination.

When to use: keyboard shortcuts (Cmd+A, Control+C, Meta+Shift+P), accessibility flows where actions are keyboard-only, modal dismissal (Escape).

Modifier syntax: "Meta+a" (Cmd-A on Mac), "Control+c", "Shift+Tab", "Alt+ArrowLeft". Combine with + delimiter.

Single keys: "Enter", "Tab", "Escape", "ArrowUp/Down/Left/Right", "Backspace", "Home", "End".

For literal text input, use computer_type or browser_type. This is for control keys only.`,
    input_schema: {
      type: "object",
      properties: { key: { type: "string", description: "Key name or modifier combo (e.g. 'Enter', 'Meta+a', 'Control+Shift+c')" } },
      required: ["key"],
    },
    async execute(args, ctx) {
      try { await browser.pressKey(ctx.userId, args.key); return `Pressed ${args.key}`; }
      catch (e: any) { return `computer_key error: ${e.message}`; }
    },
  },

  // ============ FILE OPERATIONS ============

  upload_file_to_page: {
    name: "upload_file_to_page",
    description: `Upload a file to an <input type=file> element on the current browser page.

When to use: filling forms that require document/image attachments — application portals, expense report uploaders, image-edit tools.

Inputs: a publicly accessible fileUrl, the CSS selector of the file input, and the desired filename Hyperbrowser will present to the page.

Pitfalls: the file URL must be reachable from Hyperbrowser's egress (signed S3/R2 URLs work; localhost does not). Many sites validate file size/type/MIME — uploads that pass our tool can still be rejected by the page's JS validation. Watch for that in browser_get_text after upload.`,
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of <input type=file>" },
        fileUrl: { type: "string", description: "Publicly reachable file URL" },
        filename: { type: "string", description: "Filename presented to the page" },
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
    description: `Download a file from a URL and capture it for downstream use. Returns the downloaded URL + filename for reference in subsequent tool calls.

When to use: capturing exports, generated reports, files behind a Save button click, screenshots from third-party tools.

When NOT to use: viewing/reading a file inline — for HTML pages or text content use browser_navigate + browser_get_text instead.

Pitfalls: large files may exceed sandbox storage. PDFs/spreadsheets that need parsing should be downloaded then processed via code_interpreter (pandas, pypdf, openpyxl).`,
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Direct file URL" } },
      required: ["url"],
    },
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
    description: `Generate an image from a text prompt. Saved as an inline image artifact in the thread.

When to use: hero images for reports, mood-board concepts, product mock-ups, infographic illustrations, anything where a generated image adds more than describing-in-words would.

When NOT to use: factual photography (real people, real places — use SearchImages on real subjects). Diagrams or charts (use generate_artifact with HTML/SVG instead — vector, editable, accurate).

Provider trade-offs:
- gemini (Nano Banana): fast (~3s), cheap, good photorealism, supports image editing via inputImages
- openai (gpt-image-1): sharpest text rendering, best for posters/UI mock-ups, slower (~15s)
- grok (Aurora): xAI's distinctive style, good for stylized/illustrative outputs

Tip: write specific prompts with subject + style + composition + lighting. "A photorealistic close-up of a vintage typewriter on a wood desk, soft morning light, shallow depth of field" beats "typewriter".

Pitfalls: prompts containing real public figures may be filtered. Brand logos may be rejected. For brand work, use real reference images via inputImages (Gemini path).`,
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image description: subject + style + composition + lighting" },
        aspectRatio: { type: "string", enum: ["1:1","16:9","9:16","4:3","3:4"], description: "Output aspect ratio (default 1:1)" },
        provider: { type: "string", enum: ["gemini","openai","grok"], description: "Override the user's default image provider" },
      },
      required: ["prompt"],
    },
    async execute(args, ctx) {
      try {
        const { getPrefs } = await import("./preferences");
        const prefs = await getPrefs(ctx.userId);
        const provider = (args.provider || prefs.imageProvider || "gemini") as media.ImageProvider;
        const base64 = await media.generateImage(args.prompt, { provider, aspectRatio: args.aspectRatio, userId: ctx.userId });
        if (!base64) return "Image generation returned empty.";
        const { createArtifact } = await import("./db");
        const a = await createArtifact({
          threadId: ctx.threadId, messageId: ctx.messageId, type: "image",
          title: args.prompt.slice(0, 60),
          body: `<img src="data:image/png;base64,${base64}" style="max-width:100%;display:block">`,
        });
        ctx.artifactsCreated.push({ id: a.id, type: a.type, title: a.title });
        return `Image generated via ${provider}: artifact id=${a.id}`;
      } catch (e: any) { return `generate_image error: ${e.message}`; }
    },
  },

  generate_speech: {
    name: "generate_speech",
    description: `Convert text to speech. Saved as an inline audio artifact with a player.

When to use: voice-over scripts, podcast intros, accessibility (read-aloud version of an article), automated phone-system prompts, voicemail templates.

When NOT to use: long-form audio over 5 minutes — split into chunks first. Multi-speaker dialogue without identifying speakers (Gemini supports multi-speaker; pass distinct voices per turn — but the simple text→speech surface here is single-voice).

Provider trade-offs:
- gemini: 30+ voices including non-English, natural prosody, supports multi-speaker dialogue mode
- openai (tts-1): 6 voices (alloy, echo, fable, onyx, nova, shimmer), cleaner-sounding for narration

Voice selection tips: alloy/echo (neutral US), fable (British), onyx (deep male), nova (warm female), shimmer (warm female alt). Gemini's Kore/Charon/Puck have distinct personalities.

Pitfalls: pronunciation of proper nouns can be off. Numbers read as digits ("one two three") not words ("123") unless you spell them out.`,
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to speak. Up to ~5000 chars; split longer." },
        voice: { type: "string", description: "Voice name (provider-specific). Defaults: alloy (openai), Kore (gemini)." },
        provider: { type: "string", enum: ["gemini","openai"] },
      },
      required: ["text"],
    },
    async execute(args, ctx) {
      try {
        const { getPrefs } = await import("./preferences");
        const prefs = await getPrefs(ctx.userId);
        const provider = (args.provider || prefs.speechProvider || "gemini") as media.SpeechProvider;
        const result = await media.generateSpeech(args.text, { provider, voice: args.voice, userId: ctx.userId });
        if (!result.base64) return "TTS returned empty.";
        const { createArtifact } = await import("./db");
        const a = await createArtifact({
          threadId: ctx.threadId, messageId: ctx.messageId, type: "document",
          title: `Audio: ${args.text.slice(0, 50)}…`,
          body: `<audio controls style="width:100%"><source src="data:${result.mimeType};base64,${result.base64}" type="${result.mimeType}"></audio>`,
        });
        ctx.artifactsCreated.push({ id: a.id, type: a.type, title: a.title });
        return `Audio generated via ${provider}: artifact id=${a.id}`;
      } catch (e: any) { return `generate_speech error: ${e.message}`; }
    },
  },

  generate_video: {
    name: "generate_video",
    description: `Generate a short video clip from a text prompt. Async — returns an operation ID immediately; the video appears as an artifact when the provider finishes (1–5 min typical).

When to use: product reveals, ad concepts, animated illustrations, showing motion that a still image can't convey.

When NOT to use: long-form video (>10 sec) — these are clip generators. Lectures or talking-head video (use HeyGen avatar tooling instead, available via SearchIntegrations). Visual diff/comparison (a side-by-side still is clearer).

Provider trade-offs:
- gemini (Veo 3.1): 4–8 sec clips, native audio, good cinematic camera moves, ~1 min generation
- openai (Sora-2): higher fidelity, supports up to 8 sec, slower (~3 min generation)

Prompt structure: [Subject] + [Action] + [Scene] + [Style] + [Camera]. Example: "A red sports car drifting through a rain-soaked city street at night, neon reflections, cinematic dolly shot".

Pitfalls: real people generation is restricted. Branded products may be rejected. Output isn't deterministic — same prompt produces different clips each call.`,
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Video description: subject + action + scene + style + camera" },
        provider: { type: "string", enum: ["gemini","openai"] },
      },
      required: ["prompt"],
    },
    async execute(args, ctx) {
      try {
        const { getPrefs } = await import("./preferences");
        const prefs = await getPrefs(ctx.userId);
        const provider = (args.provider || prefs.videoProvider || "gemini") as media.VideoProvider;
        const r = await media.generateVideo(args.prompt, { provider, userId: ctx.userId });
        return `Video generation started via ${r.provider}. Operation: ${r.operationName}.`;
      } catch (e: any) { return `generate_video error: ${e.message}`; }
    },
  },

  // ============ WORKING MEMORY (P24) ============

  update_working_memory: {
    name: "update_working_memory",
    description: `Update your Thread Context Doc — the persistent working memory for this thread. Use it to record plans, findings, decisions, and to track multi-step progress with checkbox tasks.

When to use:
- BEFORE multi-step work (3+ tool calls or sub-tasks): write a plan in Plan Tasks as checkboxes ("- [ ] task description")
- DURING execution: tick off completed tasks with operation "check_task"
- AFTER discovering important facts: append to Findings (numbers, URLs, entities, dates)
- AFTER making a tradeoff: append to Decisions ("Chose X over Y because Z")
- AFTER user states a constraint: append to Notes ("Budget: $50K", "Must ship by Friday")

When NOT to use:
- Simple one-step Q&A — overhead isn't worth it
- Information that fits in 2 paragraphs of the response
- Sensitive secrets (the doc is visible to the user but logged in trace events)

Operations:
- append: add content to end of section (most common)
- prepend: add content to beginning of section
- replace: overwrite section entirely (rare; use for plan rewrites)
- check_task: tick off a checkbox ("- [ ] X" → "- [x] X"). Pass the exact task text as content.

Default sections: "Plan Overview", "Plan Tasks", "Findings", "Decisions", "Notes". You can use any other section name and it'll be created.

Tip: Plan Tasks should be checkbox lists. The UI renders them as a live progress bar — the user sees you completing work in real-time.`,
    input_schema: {
      type: "object",
      properties: {
        section: { type: "string", description: "Section name. Common: Plan Overview, Plan Tasks, Findings, Decisions, Notes. Custom names auto-create the section." },
        operation: { type: "string", enum: ["append", "prepend", "replace", "check_task"], description: "How to combine with existing content" },
        content: { type: "string", description: "Text to add or, for check_task, the exact task text to tick off" },
      },
      required: ["section", "operation", "content"],
    },
    async execute(args, ctx) {
      try {
        const { updateSection } = await import("./working-memory");
        const r = await updateSection(ctx.threadId, args.section, args.operation, args.content);
        if (!r.ok) return `update_working_memory error: ${r.reason}`;
        return `Updated section "${args.section}" (${args.operation}). New length: ${r.section?.content.length} chars.`;
      } catch (e: any) {
        return `update_working_memory error: ${e.message}`;
      }
    },
  },

  // ============ SUBAGENT DISPATCH (P24) ============

  dispatch_agent: {
    name: "dispatch_agent",
    description: `Spawn a focused subagent in parallel to handle a contained sub-task. The subagent runs in its own isolated context, returns a structured result (summary + artifacts + cost + trace_id), and its budget is reserved from your remaining run budget.

When to use:
- Multi-faceted research where each facet is independent (research A in one subagent, B in another, run in parallel)
- Code review where the reviewer needs different context than the implementer
- Long single-step work that would otherwise blow the parent's context window
- Bounded explorations: "investigate X with these specific tools, return findings"

When NOT to use:
- Sequential dependent work — just continue in this thread, no need for a subagent
- Trivial tasks — overhead of dispatch (budget reservation, prompt compile, separate trace) isn't worth it for a one-shot tool call
- Anything that needs the same conversation history — subagents don't see your thread

Hard guardrails enforced by the platform:
- max_depth: 3 (parent depth 0; one level of children OK; grandchildren OK; great-grandchildren rejected)
- max_parallel per parent: 5 concurrent dispatches
- budget_remaining: subagent reserves credits from your pool; if denied, dispatch fails fast
- allowed_tools: subset of the parent's tools (cannot escalate)
- deadline_ms: default 120000 (2 min), max 300000 (5 min)
- Subagent gets the layered system prompt + its own working memory, but does NOT see this thread

Returned structure:
{
  childRunId: "run_xxx",
  status: "succeeded" | "failed" | "timeout" | "cancelled",
  summary: "...",       // what the subagent ultimately concluded
  artifacts: [...],     // any artifacts the subagent created
  costCredits: number,  // committed cost
  durationMs: number,
  traceUrl: "/api/traces/run_xxx"
}

Tip: write the goal as a self-contained brief. Include all context the subagent needs — it can't ask you clarifying questions mid-run.`,
    input_schema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Self-contained brief: what to accomplish, what context, what output shape. Write as if briefing a stranger." },
        allowed_tools: { type: "array", items: { type: "string" }, description: "Subset of parent's tools the subagent can use. Default: all parent tools except dispatch_agent itself." },
        deadline_ms: { type: "number", description: "Max wall-clock duration in ms (default 120000, max 300000)" },
        budget_credits: { type: "number", description: "Max credits the subagent may spend (default 2000). Reserved from parent's remaining budget." },
      },
      required: ["goal"],
    },
    async execute(args, ctx) {
      try {
        const { dispatchSubagent } = await import("./subagent");
        const result = await dispatchSubagent({
          parentRunId: (ctx as any).runId || null,
          parentDepth: (ctx as any).depth || 0,
          userId: ctx.userId,
          threadId: ctx.threadId,
          goal: args.goal,
          allowedTools: args.allowed_tools,
          deadlineMs: args.deadline_ms,
          budgetCredits: args.budget_credits,
        });
        return JSON.stringify(result);
      } catch (e: any) {
        return `dispatch_agent error: ${e.message}`;
      }
    },
  },

  // ============ SANDBOXED CODE EXECUTION (e2b) ============

  code_interpreter: {
    name: "code_interpreter",
    description: `Execute Python code in a fresh, isolated cloud sandbox. Returns stdout, stderr, and the value of the last expression.

When to use: data analysis, calculations, file processing, API calls, anything that requires actual computation rather than describing what the computation would do. The sandbox has pandas, numpy, requests, beautifulsoup4, matplotlib preinstalled. Network access is enabled.

When NOT to use: code generation for the user to run elsewhere (just write the code as text), simple math (do it in your head), anything that doesn't need to actually execute.

Each call gets a brand-new sandbox — there is NO state carried between calls. If you need multi-step computation, put it all in one code block.

Tip: Use \`print()\` to surface intermediate values to stdout. The last expression in your code is also captured separately as 'result'.

Pitfalls: Sandbox timeout is 60 seconds. Long-running tasks should be split or use timeouts inside the code. Output is truncated to 16KB stdout / 8KB stderr.`,
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Python code to execute. Must be self-contained — no imports persist across calls." },
        timeoutMs: { type: "number", description: "Max execution time in ms (default 60000, max 120000)" },
      },
      required: ["code"],
    },
    async execute(args, ctx) {
      try {
        const { runPython } = await import("./sandbox");
        const r = await runPython(args.code, {
          userId: ctx.userId,
          timeoutMs: Math.min(args.timeoutMs || 60_000, 120_000),
        });
        const parts = [];
        if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
        if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
        if (r.result !== undefined) {
          const resStr = typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2);
          parts.push(`result:\n${resStr}`);
        }
        parts.push(`(exit ${r.exitCode}, ${r.durationMs}ms)`);
        return parts.join("\n\n");
      } catch (e: any) { return `code_interpreter error: ${e.message}`; }
    },
  },

  run_shell: {
    name: "run_shell",
    description: `Run a shell command in a fresh, isolated Ubuntu sandbox. Returns stdout + stderr + exit code.

When to use: file operations, running CLI tools (curl, jq, ffmpeg), shell scripts, things easier in bash than in Python. Network is enabled.

When NOT to use: anything that needs persistent state (each call is fresh), interactive commands (no TTY), or things you'd just write in Python.

Pitfalls: Sandbox timeout 60s. No filesystem state persists between calls. Output truncated to 16KB stdout / 8KB stderr.`,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command (single line; use && or ; to chain)" },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
    },
    async execute(args, ctx) {
      try {
        const { runShell } = await import("./sandbox");
        const r = await runShell(args.command, {
          userId: ctx.userId,
          timeoutMs: Math.min(args.timeoutMs || 60_000, 120_000),
        });
        const parts = [];
        if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
        if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
        parts.push(`(exit ${r.exitCode}, ${r.durationMs}ms)`);
        return parts.join("\n\n");
      } catch (e: any) { return `run_shell error: ${e.message}`; }
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
  "code_interpreter",
  "run_shell",
  "update_working_memory",
  "dispatch_agent",
];
