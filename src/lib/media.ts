// Multi-provider media generation.
// Image: Gemini Nano Banana | OpenAI gpt-image-1 | Grok grok-2-image
// Speech: Gemini TTS | OpenAI tts-1 (Grok doesn't have TTS)
// Video: Gemini Veo | OpenAI Sora (Grok doesn't have video)
//
// Provider is chosen per-call via opts, defaulting to user preferences.

export type ImageProvider = "gemini" | "openai" | "grok";
export type SpeechProvider = "gemini" | "openai";
export type VideoProvider = "gemini" | "openai";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_BASE = "https://api.openai.com/v1";
const XAI_BASE = "https://api.x.ai/v1";

function geminiKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY not set. Get one at aistudio.google.com");
  return k;
}
function openaiKey() {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error("OPENAI_API_KEY not set. Get one at platform.openai.com");
  return k;
}
function xaiKey() {
  const k = process.env.XAI_API_KEY;
  if (!k) throw new Error("XAI_API_KEY not set. Get one at x.ai/api");
  return k;
}

// =================== IMAGE ===================

export async function generateImage(
  prompt: string,
  opts: { provider?: ImageProvider; aspectRatio?: string } = {},
): Promise<string> {
  const provider = opts.provider || "gemini";
  if (provider === "gemini") return await geminiImage(prompt);
  if (provider === "openai") return await openaiImage(prompt, opts.aspectRatio);
  if (provider === "grok")   return await grokImage(prompt);
  throw new Error(`Unknown image provider: ${provider}`);
}

async function geminiImage(prompt: string): Promise<string> {
  const r = await fetch(
    `${GEMINI_BASE}/models/gemini-2.5-flash-image:generateContent?key=${geminiKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "image/png", responseModalities: ["IMAGE"] },
      }),
    },
  );
  if (!r.ok) throw new Error(`Gemini image error: ${r.status} ${await r.text()}`);
  const j = await r.json();
  const part = j?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  return part?.inlineData?.data || "";
}

async function openaiImage(prompt: string, aspectRatio?: string): Promise<string> {
  const sizeMap: Record<string, string> = { "1:1": "1024x1024", "16:9": "1792x1024", "9:16": "1024x1792" };
  const size = sizeMap[aspectRatio || "1:1"] || "1024x1024";
  const r = await fetch(`${OPENAI_BASE}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openaiKey()}` },
    body: JSON.stringify({ model: "gpt-image-1", prompt, n: 1, size, response_format: "b64_json" }),
  });
  if (!r.ok) throw new Error(`OpenAI image error: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j?.data?.[0]?.b64_json || "";
}

async function grokImage(prompt: string): Promise<string> {
  const r = await fetch(`${XAI_BASE}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${xaiKey()}` },
    body: JSON.stringify({ model: "grok-2-image", prompt, n: 1, response_format: "b64_json" }),
  });
  if (!r.ok) throw new Error(`Grok image error: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j?.data?.[0]?.b64_json || "";
}

// =================== SPEECH ===================

export async function generateSpeech(
  text: string,
  opts: { provider?: SpeechProvider; voice?: string } = {},
): Promise<{ base64: string; mimeType: string }> {
  const provider = opts.provider || "gemini";
  if (provider === "gemini") return { base64: await geminiSpeech(text, opts.voice), mimeType: "audio/wav" };
  if (provider === "openai") return { base64: await openaiSpeech(text, opts.voice), mimeType: "audio/mpeg" };
  throw new Error(`Unknown speech provider: ${provider}`);
}

async function geminiSpeech(text: string, voice = "Kore"): Promise<string> {
  const r = await fetch(
    `${GEMINI_BASE}/models/gemini-2.5-flash-preview-tts:generateContent?key=${geminiKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    },
  );
  if (!r.ok) throw new Error(`Gemini TTS error: ${r.status} ${await r.text()}`);
  const j = await r.json();
  const part = j?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  return part?.inlineData?.data || "";
}

async function openaiSpeech(text: string, voice = "alloy"): Promise<string> {
  const r = await fetch(`${OPENAI_BASE}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openaiKey()}` },
    body: JSON.stringify({ model: "tts-1", input: text, voice, response_format: "mp3" }),
  });
  if (!r.ok) throw new Error(`OpenAI TTS error: ${r.status} ${await r.text()}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.toString("base64");
}

// =================== TRANSCRIPTION ===================

export async function transcribeAudio(
  audioBase64: string,
  mimeType = "audio/mpeg",
): Promise<string> {
  // Use OpenAI Whisper if available, fallback to Gemini.
  if (process.env.OPENAI_API_KEY) {
    try {
      const buf = Buffer.from(audioBase64, "base64");
      const fd = new FormData();
      fd.append("file", new Blob([buf], { type: mimeType }), "audio");
      fd.append("model", "whisper-1");
      const r = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${openaiKey()}` },
        body: fd as any,
      });
      if (r.ok) { const j = await r.json(); return j.text || ""; }
    } catch {}
  }
  // Fallback: Gemini multimodal
  const r = await fetch(
    `${GEMINI_BASE}/models/gemini-2.5-flash:generateContent?key=${geminiKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: "Transcribe this audio. Output only the transcript, no preamble." },
          { inlineData: { mimeType, data: audioBase64 } },
        ] }],
      }),
    },
  );
  if (!r.ok) throw new Error(`Transcribe error: ${r.status}`);
  const j = await r.json();
  return j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// =================== VIDEO ===================

export async function generateVideo(
  prompt: string,
  opts: { provider?: VideoProvider } = {},
): Promise<{ operationName: string; provider: VideoProvider }> {
  const provider = opts.provider || "gemini";
  if (provider === "gemini") return { operationName: await geminiVideo(prompt), provider };
  if (provider === "openai") return { operationName: await openaiVideo(prompt), provider };
  throw new Error(`Unknown video provider: ${provider}`);
}

async function geminiVideo(prompt: string): Promise<string> {
  const r = await fetch(
    `${GEMINI_BASE}/models/veo-2.0-generate-001:predictLongRunning?key=${geminiKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: "16:9", durationSeconds: 6 },
      }),
    },
  );
  if (!r.ok) throw new Error(`Veo error: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.name || "";
}

async function openaiVideo(prompt: string): Promise<string> {
  // OpenAI Sora video API. Async — returns a job that we poll.
  const r = await fetch(`${OPENAI_BASE}/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openaiKey()}` },
    body: JSON.stringify({ model: "sora-2", prompt, seconds: "8", size: "1280x720" }),
  });
  if (!r.ok) throw new Error(`Sora error: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.id || "";
}
