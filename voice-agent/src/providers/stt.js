// Speech-to-text via Groq's Whisper endpoint (OpenAI-compatible transcription API).
// Verify at implementation/update time: current model id and accepted audio formats
// (browser MediaRecorder typically produces webm/opus, which Groq's endpoint accepts).
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

// A transcript this short after trimming is almost always noise/silence misdetected
// as speech by the client-side VAD, not a real utterance.
const MIN_MEANINGFUL_CHARS = 2;

export async function transcribe(audioBuffer, { mimeType = 'audio/webm' } = {}) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set');
  const start = Date.now();

  const form = new FormData();
  const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('wav') ? 'wav' : 'ogg';
  form.append('file', new Blob([audioBuffer], { type: mimeType }), `turn.${ext}`);
  form.append('model', GROQ_STT_MODEL);
  form.append('response_format', 'json');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });
  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Groq transcription failed (${res.status}): ${errText}`);
  }
  const data = await res.json();
  const text = (data.text || '').trim();
  return {
    text,
    isMeaningful: text.length >= MIN_MEANINGFUL_CHARS,
    latencyMs,
  };
}
