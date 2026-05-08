// Multi-provider media generation, scoped to a user so per-user keys work.
//
// Image:  Gemini Nano Banana | OpenAI gpt-image-1 | Grok grok-2-image
// Speech: Gemini TTS | OpenAI tts-1 (Grok doesn't have TTS yet)
// Video:  Gemini Veo | OpenAI Sora (Grok doesn't have video yet)
//
// All entry points take `userId` so resolveSecret() can find that user's
// saved key, falling back to the platform env var if they haven't set one.

import { resolveSecret, type SecretProvider } from "./secrets";

export type ImageProvider = "gemini" | "openai" | "grok";
export type SpeechProvider = "gemini" | "openai";
export type VideoProvider = "gemini" | "openai";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_BASE = "https://api.openai.com/v1";
const XAI_BASE = "https://api.x.ai/v1";

const PROVIDER_TO_SECRET: Record<string, SecretProvider> = {
  gemini: "gemini", openai: "openai", grok: "xai",
};

async function keyFor(userId: string | null | undefined, provider: string): Promise<string> {
  const slug = PROVIDER_TO_SECRET[provider];
  if (!slug) throw new Error(`Unknown provider: ${provider}`);
  const k = await resolveSecret(userId, slug);
  if (!k) throw new Error(`No ${provider} API key. Set one in Settings → API Keys.`);
  return k;
}

// =================== IMAGE ===================

export async function generateImage(
  prompt: string,
  opts: { provider?: ImageProvider; aspectRatio?: string; userId?: string | null } = {},
): Promise<string> {
  const provider = opts.provider || "gemini";
  const userId = opts.userId || null;
  if (provider === "gemini") return await geminiImage(prompt, userId);
  if (provider === "openai") return await openaiImage(prompt, opts.aspectRatio, userId);
  if (provider === "grok")   return await grokImage(prompt, userId);
  throw new Error(`Unknown image provider: ${provider}`);
}

async function geminiImage(prompt: string, userId: string | null): Promise<string> {
  const k = await keyFor(userId, "gemini");
  const r = await fetch(
    `${GEMINI_BASE}/models/gemini-2.5-flash-image:generateContent?key=${k}`,
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

async function openaiImage(prompt: string, aspectRatio: string | undefined, userId: string | null): Promise<string> {
  const k = await keyFor(userId, "openai");
  const sizeMap: Record<string, string> = { "1:1": "1024x1024", "16:9": "1792x1024", "9:16": "1024x1792" };
  const size = sizeMap[aspectRatio || "1:1"] || "1024x1024";
  const r = await fetch(`${OPENAI_BASE}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${k}` },
    body: JSON.stringify({ model: "gpt-image-1", prompt, n: 1, size, response_format: "b64_json" }),
  });
  if (!r.ok) throw new Error(`OpenAI image error: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j?.data?.[0]?.b64_json || "";
}

async function grokImage(prompt: string, userId: string | null): Promise<string> {
  const k = await keyFor(userId, "grok");
  const r = await fetch(`${XAI_BASE}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${k}` },
    body: JSON.stringify({ model: "grok-2-image", prompt, n: 1, response_format: "b64_json" }),
  });
  if (!r.ok) throw new Error(`Grok image error: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j?.data?.[0]?.b64_json || "";
}

// =================== SPEECH ===================

export async function generateSpeech(
  text: string,
  opts: { provider?: SpeechProvider; voice?: string; userId?: string | null } = {},
): Promise<{ base64: string; mimeType: string }> {
  const provider = opts.provider || "gemini";
  const userId = opts.userId || null;
  if (provider === "gemini") return { base64: await geminiSpeech(text, opts.voice, userId), mimeType: "audio/wav" };
  if (provider === "openai") return { base64: await openaiSpeech(text, opts.voice, userId), mimeType: "audio/mpeg" };
  throw new Error(`Unknown speech provider: ${provider}`);
}

async function geminiSpeech(text: string, voice: string | undefined, userId: string | null): Promise<string> {
  const k = await keyFor(userId, "gemini");
  const r = await fetch(
    `${GEMINI_BASE}/models/gemini-2.5-flash-preview-tts:generateContent?key=${k}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || "Kore" } } },
        },
      }),
    },
  );
  if (!r.ok) throw new Error(`Gemini TTS error: ${r.status} ${await r.text()}`);
  const j = await r.json();
  const part = j?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  return part?.inlineData?.data || "";
}

async function openaiSpeech(text: string, voice: string | undefined, userId: string | null): Promise<string> {
  const k = await keyFor(userId, "openai");
  const r = await fetch(`${OPENAI_BASE}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${k}` },
    body: JSON.stringify({ model: "tts-1", input: text, voice: voice || "alloy", response_format: "mp3" }),
  });
  if (!r.ok) throw new Error(`OpenAI TTS error: ${r.status} ${await r.text()}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.toString("base64");
}

// =================== TRANSCRIPTION ===================

export async function transcribeAudio(
  audioBase64: string,
  mimeType = "audio/mpeg",
  userId: string | null = null,
): Promise<string> {
  // Prefer OpenAI Whisper if available, otherwise Gemini multimodal.
  const openaiKey = await resolveSecret(userId, "openai");
  if (openaiKey) {
    try {
      const buf = Buffer.from(audioBase64, "base64");
      const fd = new FormData();
      fd.append("file", new Blob([buf], { type: mimeType }), "audio");
      fd.append("model", "whisper-1");
      const r = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${openaiKey}` },
        body: fd as any,
      });
      if (r.ok) { const j = await r.json(); return j.text || ""; }
    } catch {}
  }
  const k = await keyFor(userId, "gemini");
  const r = await fetch(
    `${GEMINI_BASE}/models/gemini-2.5-flash:generateContent?key=${k}`,
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
  opts: { provider?: VideoProvider; userId?: string | null } = {},
): Promise<{ operationName: string; provider: VideoProvider }> {
  const provider = opts.provider || "gemini";
  const userId = opts.userId || null;
  if (provider === "gemini") return { operationName: await geminiVideo(prompt, userId), provider };
  if (provider === "openai") return { operationName: await openaiVideo(prompt, userId), provider };
  throw new Error(`Unknown video provider: ${provider}`);
}

async function geminiVideo(prompt: string, userId: string | null): Promise<string> {
  const k = await keyFor(userId, "gemini");
  const r = await fetch(
    `${GEMINI_BASE}/models/veo-2.0-generate-001:predictLongRunning?key=${k}`,
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

async function openaiVideo(prompt: string, userId: string | null): Promise<string> {
  const k = await keyFor(userId, "openai");
  const r = await fetch(`${OPENAI_BASE}/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${k}` },
    body: JSON.stringify({ model: "sora-2", prompt, seconds: "8", size: "1280x720" }),
  });
  if (!r.ok) throw new Error(`Sora error: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.id || "";
}
