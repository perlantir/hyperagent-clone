// Media generation backend.
//
// Image: Google Gemini 2.5 Flash Image (Nano Banana) — best quality + cheap.
//        Falls back to a stub if GEMINI_API_KEY is not set.
// Audio: Gemini TTS for synthesis, plus transcription.
// Video: Gemini Veo (returns a job id we can poll).
//
// Each function returns base64 (or a URL) which we then save as an artifact.

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

function geminiKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY not set. Get one at aistudio.google.com");
  return k;
}

export async function generateImage(prompt: string, opts: { aspectRatio?: string } = {}): Promise<string> {
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

export async function generateSpeech(text: string, voice = "Kore"): Promise<string> {
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

export async function transcribeAudio(audioBase64: string, mimeType = "audio/mpeg"): Promise<string> {
  const r = await fetch(
    `${GEMINI_BASE}/models/gemini-2.5-flash:generateContent?key=${geminiKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { parts: [
            { text: "Transcribe this audio. Output only the transcript, no preamble." },
            { inlineData: { mimeType, data: audioBase64 } },
          ] },
        ],
      }),
    },
  );
  if (!r.ok) throw new Error(`Gemini transcribe error: ${r.status}`);
  const j = await r.json();
  return j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// Video generation kicks off an async Veo job. Returns operation name.
export async function generateVideo(prompt: string): Promise<{ operationName: string }> {
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
  return { operationName: j.name };
}
