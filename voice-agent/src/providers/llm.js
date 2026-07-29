// The "brain": OpenAI GPT-4o-mini, chosen for reliable tool selection over raw speed
// (see README Decisions & tradeoffs). Two call shapes:
//   1. decide() — non-streaming, tools available, resolves whether/which tool(s) to
//      call. Tool call args must be fully assembled before we can execute them, so
//      this step isn't streamed.
//   2. streamFinalAnswer() — streaming, no tools, produces the grounded spoken
//      answer after any tool results are in the conversation. Sentence-chunked so
//      the caller (ws/session.js) can start TTS on sentence 1 before the model has
//      finished generating sentence 2.
import OpenAI from 'openai';
import { toOpenAiTools } from '../tools/definitions.js';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Lazily constructed so importing this module (e.g. from scripts that don't touch
// the LLM) never crashes just because OPENAI_API_KEY isn't set yet.
let _client = null;
function client() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

function safeParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

export async function decide(messages) {
  const start = Date.now();
  const completion = await client().chat.completions.create({
    model: MODEL,
    messages,
    tools: toOpenAiTools(),
    tool_choice: 'auto',
  });
  const latencyMs = Date.now() - start;
  const msg = completion.choices[0].message;

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    return {
      type: 'tool_calls',
      assistantMessage: msg,
      toolCalls: msg.tool_calls.map((tc) => ({ id: tc.id, name: tc.function.name, args: safeParseJson(tc.function.arguments) })),
      latencyMs,
    };
  }
  return { type: 'text', text: msg.content || '', latencyMs };
}

// Splits on sentence-ending punctuation followed by whitespace. Good enough for
// spoken support answers (short, plain sentences) without pulling in an NLP library.
export function splitSentences(text) {
  const sentences = [];
  let buffer = text;
  const ender = /([.!?])\s+/;
  let match;
  while ((match = buffer.match(ender))) {
    const endIdx = match.index + match[0].length;
    const sentence = buffer.slice(0, endIdx).trim();
    buffer = buffer.slice(endIdx);
    if (sentence) sentences.push(sentence);
  }
  if (buffer.trim()) sentences.push(buffer.trim());
  return sentences;
}

export async function streamFinalAnswer(messages, onSentence) {
  const start = Date.now();
  const stream = await client().chat.completions.create({ model: MODEL, messages, stream: true });
  let buffer = '';
  let fullText = '';
  let firstTokenAt = null;
  const ender = /([.!?])\s+/;

  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content || '';
    if (!delta) continue;
    if (firstTokenAt === null) firstTokenAt = Date.now();
    buffer += delta;
    fullText += delta;
    let match;
    while ((match = buffer.match(ender))) {
      const endIdx = match.index + match[0].length;
      const sentence = buffer.slice(0, endIdx).trim();
      buffer = buffer.slice(endIdx);
      if (sentence) await onSentence(sentence);
    }
  }
  if (buffer.trim()) await onSentence(buffer.trim());

  return { fullText, latencyMs: Date.now() - start, firstTokenMs: firstTokenAt ? firstTokenAt - start : null };
}
