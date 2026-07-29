// Text-to-speech via ElevenLabs. Verify at implementation/update time: current
// endpoint path and default output format (assumed mp3 here).
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // "Sarah" — a premade voice usable on the free tier
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';

function endpoint(voiceId) {
  return `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
}

// Synthesizes one chunk of text (typically a single sentence) to a complete MP3
// buffer. Called once per sentence as the model's answer streams in, so the caller
// can start playback of sentence 1 while sentence 2 is still being generated.
export async function synthesize(text) {
  if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set');
  const start = Date.now();
  const res = await fetch(endpoint(VOICE_ID), {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`ElevenLabs synthesis failed (${res.status}): ${errText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType: 'audio/mpeg', latencyMs: Date.now() - start };
}

// A handful of fixed lines (the quote filler, "didn't catch that", etc) are
// synthesized once and cached in memory, so playing them later costs zero TTS
// latency — critical for the no-dead-air requirement on the slow quote path.
const fillerCache = new Map();

export async function getCachedAudio(key, text) {
  if (fillerCache.has(key)) return fillerCache.get(key);
  const result = await synthesize(text);
  fillerCache.set(key, result);
  return result;
}

// Sequential on purpose: ElevenLabs' free tier caps concurrent requests (currently
// 4), and firing every filler at once at startup can exceed that as more lines get
// added. Startup isn't latency-sensitive, so there's no reason to risk it.
export async function warmFillerCache(fillers) {
  for (const [key, text] of Object.entries(fillers)) {
    try {
      await getCachedAudio(key, text);
    } catch (err) {
      console.warn(`[startup] could not pre-warm filler "${key}" (check ELEVENLABS_API_KEY):`, err.message);
    }
  }
}
