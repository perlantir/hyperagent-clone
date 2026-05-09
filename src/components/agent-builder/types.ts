// P36 — shared types for the agent-builder tabs.

export interface AgentLike {
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
  modelId?: string | null;
  subagentModelId?: string | null;
  extendedThinking?: boolean;
  maxRunBudgetCredits?: number | null;
  avatar?: string | null;
  createdAt: number;
}

export type TabKey =
  | "config" | "invocations" | "integrations" | "tools"
  | "skills" | "knowledge" | "memory" | "rubrics"
  | "library" | "security";

export interface TabDef {
  key: TabKey;
  label: string;
  icon: string;
  badge?: number | string;
}

// Native tool catalog mirroring the tools.ts registry, with categorization
// for a richer Tools-tab UI. The Hyperagent reference shows tools grouped
// by capability (Search, Computation, Web, Media, etc.) — this matches.
export interface NativeToolMeta {
  name: string;             // matches the key in tools.ts BUILTIN_TOOLS
  label: string;
  description: string;
  category: ToolCategory;
}
export type ToolCategory =
  | "Research" | "Computation" | "Browser" | "Computer"
  | "Media" | "Memory" | "Workflow" | "Files";

export const NATIVE_TOOL_CATALOG: NativeToolMeta[] = [
  { name: "web_search",        label: "Search",            description: "Search the public web with retries + budget tracking. DuckDuckGo backed.", category: "Research" },
  { name: "exa_search",        label: "Exa",               description: "Neural search via Exa.ai — semantic ranking + optional inline page contents. Bring your own Exa key.", category: "Research" },
  { name: "thread_search",     label: "Thread search",     description: "Search across the user's other threads. Returns thread title + matching message snippet.", category: "Research" },
  { name: "search_knowledge",  label: "Knowledge search",  description: "Search the user's memories and skill library from inside a turn.", category: "Research" },
  { name: "code_interpreter",  label: "Full VM",           description: "Run Python in an isolated cloud sandbox with pandas, numpy, requests preinstalled.", category: "Computation" },
  { name: "run_shell",         label: "Run shell",         description: "Execute bash in an isolated Ubuntu sandbox with curl, jq, ffmpeg.", category: "Computation" },
  { name: "browser_navigate",  label: "Browser",           description: "Drive a real Chromium session — navigate, click, type, scroll.", category: "Browser" },
  { name: "browser_screenshot",label: "Browser screenshot",description: "Capture a screenshot of the current browser page.", category: "Browser" },
  { name: "browser_click",     label: "Browser click",     description: "Click an element on the current browser page via CSS selector.", category: "Browser" },
  { name: "browser_type",      label: "Browser type",      description: "Type text into a form field with realistic delay.", category: "Browser" },
  { name: "browser_press_key", label: "Browser press key", description: "Press a keyboard key (Enter, Tab, Escape, …).", category: "Browser" },
  { name: "browser_get_text",  label: "Browser get text",  description: "Read up to 8KB of plain text from the page.", category: "Browser" },
  { name: "browser_extract",   label: "Browser extract",   description: "AI-powered structured extraction from the current page.", category: "Browser" },
  { name: "browser_scroll",    label: "Browser scroll",    description: "Scroll the browser viewport.", category: "Browser" },
  { name: "browser_close",     label: "Browser close",     description: "Tear down the active browser session.", category: "Browser" },
  { name: "computer_screenshot", label: "Computer screenshot", description: "Capture the desktop screen.", category: "Computer" },
  { name: "computer_click",    label: "Computer click",    description: "Click at coordinates on the desktop.", category: "Computer" },
  { name: "computer_move",     label: "Computer move",     description: "Move the mouse to coordinates.", category: "Computer" },
  { name: "computer_type",     label: "Computer type",     description: "Type text on the desktop.", category: "Computer" },
  { name: "computer_key",      label: "Computer key",      description: "Press a keyboard key on the desktop.", category: "Computer" },
  { name: "generate_artifact", label: "Webpages & docs",   description: "Create a persistent artifact (webpage, document, table, image) attached to the thread.", category: "Media" },
  { name: "generate_slides",   label: "Slides",            description: "Generate a reveal.js slide deck as a webpage artifact with arrow navigation + fullscreen.", category: "Media" },
  { name: "generate_table",    label: "Tables",            description: "Create a structured table artifact from columns + rows — sortable HTML output.", category: "Media" },
  { name: "generate_image",    label: "Images",            description: "Generate images via Gemini Nano Banana / OpenAI / Grok.", category: "Media" },
  { name: "generate_video",    label: "Video",             description: "Generate short videos via Gemini Veo / OpenAI Sora.", category: "Media" },
  { name: "generate_speech",   label: "Audio",             description: "Generate speech via Gemini TTS / OpenAI TTS.", category: "Media" },
  { name: "transcribe_audio",  label: "Transcribe",        description: "Transcribe audio to text via Whisper (Gemini multimodal as fallback).", category: "Media" },
  { name: "avatar_video",      label: "Avatar",            description: "Generate a talking-head avatar video via HeyGen — spokesperson clips, narration, briefings.", category: "Media" },
  { name: "maps",              label: "Maps",              description: "Geocoding, places, directions, distance matrix via Google Maps. Bring your own key.", category: "Research" },
  { name: "save_memory",       label: "Save memory",       description: "Persist a fact/preference for future turns.", category: "Memory" },
  { name: "update_working_memory", label: "Working memory", description: "Update the per-thread working doc (Plan Tasks, Findings, Decisions, Notes).", category: "Memory" },
  { name: "dispatch_agent",    label: "Dispatch subagent", description: "Hand off a focused subtask to a subagent with budget reservation.", category: "Workflow" },
  { name: "upload_file_to_page", label: "Upload to page",  description: "Upload a file from the thread into the active browser page.", category: "Files" },
  { name: "download_file",     label: "Download file",     description: "Download a file from the active browser page into the thread.", category: "Files" },
];

// Friendly model labels for the Config tab picker. Shown alongside the
// canonical id from models.ts.
export const CLAUDE_MODEL_VARIANTS = [
  { id: "claude-opus-4-5-20250929",   label: "Claude Opus 4.5",   sub: "Most advanced, 1M context, adaptive thinking" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5", sub: "Balanced speed + intelligence" },
  { id: "claude-haiku-4-5-20250929",  label: "Claude Haiku 4.5",  sub: "Fastest, lowest cost" },
];
