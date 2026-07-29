// Speech-to-text via Groq's Whisper endpoint (OpenAI-compatible transcription API).
// Verify at implementation/update time: current model id and accepted audio formats
// (browser MediaRecorder typically produces webm/opus, which Groq's endpoint accepts).
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

// A transcript this short after trimming is almost always noise/silence misdetected
// as speech by the client-side VAD, not a real utterance.
const MIN_MEANINGFUL_CHARS = 2;

// Whisper's own confidence that a segment contained no real speech at all — the
// direct signal for "this was silence/noise," far more reliable than guessing from
// the text alone. Only available via verbose_json.
const NO_SPEECH_PROB_THRESHOLD = 0.5;

// Whisper-family models fed silence/noise sometimes hallucinate a short phrase
// repeated back-to-back (often in a language other than what's actually being
// spoken) rather than returning empty text. A transcript made of the same
// sentence repeated 2+ times is a strong, cheap signal that it's not real speech.
function looksHallucinated(text) {
  const sentences = text
    .split(/[。.!?！？\n]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (sentences.length < 2) return false;
  const counts = new Map();
  for (const s of sentences) counts.set(s, (counts.get(s) || 0) + 1);
  return [...counts.values()].some((c) => c >= 2);
}

export async function transcribe(audioBuffer, { mimeType = 'audio/webm' } = {}) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set');
  const start = Date.now();

  const form = new FormData();
  const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('wav') ? 'wav' : 'ogg';
  form.append('file', new Blob([audioBuffer], { type: mimeType }), `turn.${ext}`);
  form.append('model', GROQ_STT_MODEL);
  form.append('response_format', 'verbose_json');
  // This is an English-language support demo — constraining the language cuts
  // down on Whisper hallucinating text in a random other language from silence.
  form.append('language', 'en');

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

  const segments = data.segments || [];
  const noSpeechProb = segments.length
    ? segments.reduce((sum, s) => sum + (s.no_speech_prob ?? 0), 0) / segments.length
    : undefined;

  const isMeaningful =
    text.length >= MIN_MEANINGFUL_CHARS &&
    !(noSpeechProb !== undefined && noSpeechProb > NO_SPEECH_PROB_THRESHOLD) &&
    !looksHallucinated(text);

  return { text, isMeaningful, latencyMs };
}
