# Warp Freight — Voice Support Agent

A browser voice agent for Warp freight support. You talk, it talks back — grounded in
the local mock freight API, never in made-up data. It's read-only: it can look up a
shipment's status, get a shipping rate, check an invoice, or pull a document link, but
it never books anything.

## What it does

- Live spoken conversation in the browser — mic in, voice out, no typing.
- Answers are always backed by a real call to the Warp API (the local mock this
  round): shipment tracking and history, recent shipments, freight quotes, invoices,
  and documents (BOL/POD).
- Handles the messy parts out loud: an unknown tracking/order number gets an honest
  "I couldn't find that," a slow or failed rate lookup gets a spoken heads-up instead
  of silence, and a misheard number gets read back for confirmation.
- Every turn is logged (transcript, tool calls, latencies) to `logs/events.jsonl`.

## Pipeline, in short

```
Your voice
   → browser records the turn, auto-stops when you stop talking
   → sent to the backend over a WebSocket
   → Groq transcribes it to text                      (speech-to-text)
   → GPT-4o-mini decides what you're asking for        (the "brain")
   → if it needs real data, it calls the Warp API       (tracking/quote/invoice/etc.)
   → GPT-4o-mini turns the result into a spoken answer
   → ElevenLabs turns that answer into audio, sentence by sentence
   → played back to you in the browser
```

Every step above is timed and logged, and the one slow step (getting a shipping
quote) gets a spoken "let me check that" the instant it starts, so there's no silent
waiting.

## Tech stack

- **Frontend** — plain HTML/CSS/JavaScript, no framework or build step. Uses the
  browser's `MediaRecorder` and Web Audio API (for client-side voice-activity
  detection) to capture a turn, and a WebSocket to talk to the backend.
- **Backend** — Node.js, Express (serves the frontend + static files), `ws`
  (WebSocket server that drives the whole conversation loop).
- **Speech-to-text** — Groq's Whisper API.
- **Reasoning / tool-calling** — OpenAI GPT-4o-mini.
- **Text-to-speech** — ElevenLabs.
- **Data source** — the local Warp mock API (`mock/server.js`, from the repo root).
- **Logging** — a dependency-free append-only JSONL file; no database.

## Running it locally

**Prerequisites:** Node.js 20+, and your own API keys for Groq, OpenAI, and
ElevenLabs (all have free/trial tiers).

```bash
# 1. From the repo root, start the Warp mock API
node mock/server.js

# 2. In a new terminal, install and configure the voice agent
cd voice-agent
npm install
cp .env.example .env
# then open .env and fill in GROQ_API_KEY, OPENAI_API_KEY, ELEVENLABS_API_KEY

# 3. Start the server
npm start
```

Open **http://localhost:8787**, click the mic button, allow microphone access, and
start talking. Try things like *"Where's my shipment S-1001-IN?"*, *"What would it
cost to ship two pallets from 90001 to 60601?"*, *"What do I owe on order O-1001?"*,
or *"Can you send me the documents for O-1002?"*

Extra scripts:
- `npm run smoke` — exercises all 6 Warp tool handlers directly against the mock, no
  voice involved. Good for quickly checking the API integration is healthy.
- `npm run stats` — summarizes `logs/events.jsonl`: call counts per tool, error
  rates, and latency percentiles per pipeline stage.
- `npm run transcripts` — prints exactly what every caller said and how the agent
  answered, conversation by conversation. This (plus the raw `logs/events.jsonl`
  file) is where to see the actual data of what people have asked.

## Decisions & tradeoffs

**What I chose**

- **A roll-your-own pipeline (Groq → GPT-4o-mini → ElevenLabs), not a single-vendor
  realtime API.** Each stage was picked for what it's actually responsible for, not
  just speed: Groq for the fastest speech-to-text available (it's on the critical
  path of every turn), GPT-4o-mini for tool-calling because a wrong tool call or a
  guessed answer is a hard failure — accuracy of that decision mattered more than
  shaving off latency there — and ElevenLabs because voice quality is literally what
  the caller judges the whole experience by.
- **Because that choice makes this a turn-based pipeline, not a full-duplex socket,
  "feels natural" had to be engineered deliberately**: one persistent WebSocket per
  conversation (not a REST call per turn) streaming typed events as they happen,
  sentence-by-sentence TTS so playback starts before the full answer is ready, and
  pre-cached, zero-latency filler lines (a greeting, "let me check that" before the
  slow quote call, "didn't catch that," and a goodbye) so nothing ever sits in
  silence.
- **Auto-stop-on-silence** for turn-taking (client-side voice detection), over an
  explicit click-to-stop or push-to-talk — closer to a real phone call, at the cost
  of occasionally needing a moment of real speech before it starts the silence timer.
- **A deterministic voice hangup** ("stop," "goodbye," "hang up," etc. end the call
  immediately, without going through the LLM at all) — a caller shouldn't be at the
  mercy of whether the model happens to end the conversation instead of just replying
  "okay!" and looping.
- **No automatic retry on a failed quote.** The mock's failure gate is only
  discoverable after its full 4–16s delay, so a silent retry could cost 30+ seconds
  inside one turn. Instead it fails honestly right away and only retries if the
  caller asks it to.
- **Strict grounding, enforced structurally, not just by prompt.** All 6 tools are
  read-only and return a consistent `{ok, code, message}` shape so "not found" is
  handled the same way everywhere; there is no `book`/`booking` tool defined
  anywhere in the code, so the guardrail can't be prompted around.
- **Every key stays server-side.** The browser only ever exchanges audio bytes and
  JSON events with this app's own WebSocket — it never holds a Groq, OpenAI,
  ElevenLabs, or Warp key.
- **Dependency-free logging.** Every turn is appended to `logs/events.jsonl`
  (transcript, tool calls, per-stage latency), with `npm run stats` and
  `npm run transcripts` on top — enough to answer "how many calls this week, what did
  people ask" without standing up a database for a take-home.

**What I cut**

- **Barge-in / interrupting the agent mid-sentence.** Listed as optional stretch in
  the brief; in a turn-based architecture it requires real extra engineering
  (detecting speech while the agent's own audio is playing, cutting playback,
  restarting capture) for less payoff than the streaming/filler-line work above.
- **A phone number (Twilio).** A full second telephony surface — not a reasonable
  scope addition for a half-day build.
- **Deployment.** Not required for submission, and this app currently has no
  auth or rate limiting — a public URL would expose paid API keys to anyone who
  found it. Kept local rather than rush that safely.

**What I'd do next with more time**

- Add barge-in, closing the remaining gap with a full-duplex realtime pipeline.
- Before any public deploy: a shared password gate, per-IP rate limiting, and an
  OpenAI spend limit — all straightforward, just not done yet.
- Move tool execution/session state off in-memory-per-connection and onto something
  resumable, so a dropped connection mid-call doesn't strand a caller.
- Real telemetry instead of a JSONL file once call volume actually justifies it.
- Tighter ID confirmation — spell back an ambiguous-sounding ID before calling a
  tool, not just when its shape is obviously wrong (a normalization pass already
  repairs the common speech-to-text mangling of dashes/spacing, found and fixed
  during testing).
- Re-validate the retry/timeout budgets against a real Warp API once a key is
  available — they're currently tuned to the mock's documented 4–16s/~15% behavior.
