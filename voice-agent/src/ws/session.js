// Per-connection orchestration: audio in -> Groq STT -> GPT-4o-mini (tools) -> Warp
// mock -> ElevenLabs TTS, streamed back over the socket as typed events. See the
// plan's "Per-turn flow" for the full sequencing rationale.
import { randomUUID } from 'node:crypto';
import { buildSystemPrompt } from '../prompt/instructions.js';
import { runTool } from '../tools/definitions.js';
import * as stt from '../providers/stt.js';
import * as llm from '../providers/llm.js';
import * as tts from '../providers/tts.js';
import { logEvent } from '../logging/logger.js';

const MAX_HISTORY_MESSAGES = 40; // system + ~19 turns worth; keeps token cost bounded

// A hangup is handled deterministically here, not left to the model to decide —
// same reasoning as the quote filler line: the caller shouldn't be at the mercy of
// whether the LLM happens to end the call versus just replying "okay!" and looping.
const END_CALL_PHRASES = new Set([
  'stop', 'stop now', "that's all", 'that is all', "that'll be all", 'that will be all',
  'goodbye', 'good bye', 'bye', 'bye bye', 'end call', 'hang up', 'hangup',
  "i'm done", 'im done', "we're done", 'we are done', 'no more questions', 'nothing else',
  'you can stop', 'you can stop now', "that's it", 'that is it',
]);

function isEndCallIntent(text) {
  let t = text.trim().toLowerCase().replace(/[.!?]+$/, '');
  t = t.replace(/^(okay|ok|alright|so|um|uh)[,]?\s+/, '');
  t = t.replace(/^please\s+/, '').replace(/\s+please$/, '');
  return END_CALL_PHRASES.has(t);
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function trimHistory(messages) {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  return [messages[0], ...messages.slice(messages.length - (MAX_HISTORY_MESSAGES - 1))];
}

// If the mic can't get a clean read this many times in a row (silence, background
// noise, a hallucinated transcript that slips past stt.js's own filtering), end the
// call instead of letting it loop indefinitely — belt-and-suspenders on top of the
// hallucination detection in stt.js, and a real safety net against a stuck mic
// (e.g. audio feeding back into it) burning API calls on nothing.
const MAX_CONSECUTIVE_MISSES = 3;

export function handleConnection(ws) {
  const sessionId = randomUUID();
  let mimeType = 'audio/webm';
  let messages = [{ role: 'system', content: buildSystemPrompt() }];
  let consecutiveMisses = 0;

  logEvent({ type: 'session_start', sessionId });
  send(ws, { type: 'connected', sessionId });

  // Greet before the caller has to say anything — spoken from the same pre-cached,
  // zero-latency filler pool as the recovery lines, so it plays instantly. Reuses
  // the normal turn_complete signal so the client's existing "wait for playback to
  // finish, then start listening" logic just works without a separate message type.
  (async () => {
    await sendCachedLine('greeting', "Hi, I'm Warp AI. I'm here to help you with your questions. To stop me, say stop or hang up.");
    send(ws, { type: 'turn_complete', timings: {} });
  })();

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'init' && msg.mimeType) mimeType = msg.mimeType;
      return;
    }
    handleTurn(Buffer.from(data)).catch((err) => {
      console.error('[turn error]', err);
      send(ws, { type: 'error', message: "Something went wrong on my end — go ahead and try again." });
      // Always close out the turn even on a hard failure, so the client resumes
      // listening instead of getting stuck in "thinking" forever (no dead air).
      send(ws, { type: 'turn_complete', timings: {}, errored: true });
    });
  });

  ws.on('close', () => {
    logEvent({ type: 'session_end', sessionId });
  });

  async function sendCachedLine(key, text) {
    try {
      const audio = await tts.getCachedAudio(key, text);
      send(ws, { type: 'audio', text, mimeType: audio.mimeType, dataBase64: audio.buffer.toString('base64'), filler: true });
    } catch (err) {
      console.error('[filler tts error]', err.message);
    }
  }

  async function speakSentences(sentences, onFirstChunk) {
    let index = 0;
    for (const sentence of sentences) {
      const audio = await tts.synthesize(sentence);
      if (index === 0 && onFirstChunk) onFirstChunk();
      send(ws, { type: 'audio', text: sentence, mimeType: audio.mimeType, dataBase64: audio.buffer.toString('base64'), index: index++ });
    }
  }

  async function handleTurn(audioBuffer) {
    const turnStart = Date.now();
    const { text, isMeaningful, latencyMs: sttMs } = await stt.transcribe(audioBuffer, { mimeType });

    if (!isMeaningful) {
      consecutiveMisses += 1;
      if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
        await sendCachedLine('trouble_hearing', "I'm having trouble hearing you clearly, so I'll end the call here — feel free to start a new one anytime.");
        send(ws, { type: 'session_ending' });
        logEvent({
          type: 'turn',
          sessionId,
          transcript: text,
          assistantText: '(ended after repeated unclear audio)',
          toolCalls: [],
          timings: { sttMs, totalMs: Date.now() - turnStart },
        });
        return;
      }
      await sendCachedLine('didnt_catch', "Sorry, I didn't catch that — go ahead.");
      send(ws, { type: 'turn_complete', timings: { sttMs, totalMs: Date.now() - turnStart }, skipped: true });
      return;
    }
    consecutiveMisses = 0;

    send(ws, { type: 'transcript', text });

    if (isEndCallIntent(text)) {
      await sendCachedLine('goodbye', 'Alright, take care — bye for now!');
      send(ws, { type: 'session_ending' });
      logEvent({
        type: 'turn',
        sessionId,
        transcript: text,
        assistantText: '(caller ended the call)',
        toolCalls: [],
        timings: { sttMs, totalMs: Date.now() - turnStart },
      });
      return;
    }

    messages.push({ role: 'user', content: text });

    const decision = await llm.decide(messages);
    const llmDecideMs = decision.latencyMs;
    const toolCallLogs = [];

    if (decision.type === 'tool_calls') {
      messages.push(decision.assistantMessage);

      const hasQuoteCall = decision.toolCalls.some((tc) => tc.name === 'get_shipping_quote');
      const fillerPromise = hasQuoteCall
        ? sendCachedLine('quote_filler', 'Let me check rates on that lane — one moment.')
        : null;

      for (const tc of decision.toolCalls) {
        send(ws, { type: 'tool_call', name: tc.name, args: tc.args });
        const toolStart = Date.now();
        const result = await runTool(tc.name, tc.args);
        const toolMs = Date.now() - toolStart;
        send(ws, { type: 'tool_result', name: tc.name, result });
        toolCallLogs.push({ name: tc.name, args: tc.args, ok: result.ok, code: result.code, latencyMs: toolMs });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      if (fillerPromise) await fillerPromise;
    }

    let ttsFirstChunkMs = null;
    const speakStart = Date.now();
    const markFirstChunk = () => {
      if (ttsFirstChunkMs === null) ttsFirstChunkMs = Date.now() - speakStart;
    };

    let assistantFullText;
    if (decision.type === 'text' && toolCallLogs.length === 0) {
      assistantFullText = decision.text;
      messages.push({ role: 'assistant', content: assistantFullText });
      await speakSentences(llm.splitSentences(assistantFullText), markFirstChunk);
    } else {
      const streamResult = await llm.streamFinalAnswer(messages, async (sentence) => {
        const audio = await tts.synthesize(sentence);
        markFirstChunk();
        send(ws, { type: 'audio', text: sentence, mimeType: audio.mimeType, dataBase64: audio.buffer.toString('base64') });
      });
      assistantFullText = streamResult.fullText;
      messages.push({ role: 'assistant', content: assistantFullText });
    }

    messages = trimHistory(messages);

    const timings = { sttMs, llmDecideMs, ttsFirstChunkMs, totalMs: Date.now() - turnStart };
    send(ws, { type: 'turn_complete', timings });
    logEvent({ type: 'turn', sessionId, transcript: text, assistantText: assistantFullText, toolCalls: toolCallLogs, timings });
  }
}
