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

**Why I built it this way**

Instead of using one all-in-one voice service, I picked three different specialists
and connected them myself: Groq for turning speech into text (it's the fastest one
out there, and speed here matters because it's the very first thing that happens on
every single turn), GPT-4o-mini as the "brain" that figures out what you're actually
asking and decides which lookup to run, and ElevenLabs for the voice itself, because
the way it sounds is genuinely the biggest part of whether this feels like a real
assistant or a robot. I picked GPT-4o-mini over faster alternatives on purpose —
getting the decision right (not guessing, not calling the wrong lookup) mattered more
to me than shaving off a few hundred milliseconds.

The catch with stitching three separate services together myself, instead of using
one service that does everything, is that it naturally works in "turns" — you talk,
then it thinks, then it replies — more like a walkie-talkie than a phone call unless
you're careful. So I put real effort into hiding that: the moment you finish talking,
things start streaming back to you piece by piece instead of making you wait for the
whole answer, and for the one thing that's genuinely slow (getting a shipping rate,
which can take up to 15 seconds because that's how the practice system behaves), it
immediately says "let me check that for you" instead of leaving you in silence.
Little touches like the greeting, the goodbye, and "sorry, I didn't catch that" are
also pre-recorded ahead of time so they play back instantly with zero delay.

A few other choices worth calling out in plain terms:

- **It stops listening when you stop talking**, the same way a person would notice a
  pause in conversation, rather than making you press a button every time. The
  tradeoff is it needs a beat of real speech before it starts that countdown, so it
  doesn't cut you off the moment you start a sentence.
- **Saying "stop" or "goodbye" always ends the call immediately**, no matter what.
  I didn't want to leave that up to the AI's judgment — it's a fixed rule in the
  code, not something the AI decides on the fly, so it can't get confused and just
  keep chatting when you're trying to leave.
- **If a rate lookup fails, it tells you right away instead of quietly retrying.**
  The practice system it's built against is deliberately slow and occasionally
  flaky, and silently trying again could mean 30+ seconds of dead silence. I'd
  rather it be honest and fast ("that didn't work, want me to try again?") than
  quietly stall.
- **It genuinely can't invent an answer, even if it wanted to.** Every fact it says
  out loud — a status, a price, an invoice total — has to come from an actual lookup
  first. And there's no "booking" capability anywhere in the code at all, not even
  a disabled one, so there's no way for it to ever claim to have booked something.
- **None of your API keys ever reach the browser.** Everything that costs money or
  needs a password lives only on the server side; what your browser talks to is
  just this app's own connection, nothing else.
- **Every conversation gets saved.** Not to train anything or spy — just a plain
  text log of what was asked and how it went, so I (or anyone reviewing this) can
  answer "how many people used it, and what did they ask for" honestly.

**What I chose not to build**

A few things from the "nice to have" list I deliberately left out, given the time I
had:

- **Being able to interrupt it mid-sentence.** Genuinely useful, but meaningfully
  more work in this kind of setup, and I judged the streaming/no-dead-air work above
  as the better use of the time available.
- **A real phone number you could call.** That's a whole separate system on its own
  (think of it like building a second app), not something that fits in this scope.
- **Putting it on the internet with a public link.** It works great locally, but as
  built it has no login and no usage limits — if I put a public link out there as-is,
  anyone who found it could rack up charges on my own API accounts. Rather than rush
  that part and get it wrong, I kept it local.

**What I'd do with more time**

- Add the mid-sentence interruption feature mentioned above.
- Before ever making it public: a simple password, a limit on how often one person
  can use it, and a spending cap on my OpenAI account, just as a safety net.
- Make it recover more gracefully if the connection drops mid-conversation, instead
  of just losing that in-progress turn.
- Swap the simple text-file logging for something more like a proper database, once
  there's enough real usage to justify it.
- Get even better at handling misheard words — right now it already fixes common
  speech-to-text mistakes (like "O-1002" coming through as "01002," or a tracking
  number's last two letters getting dropped — both real bugs I found and fixed while
  testing), and I'd keep sanding down edge cases like that.
- Once there's a real Warp API to test against (instead of the practice version),
  double check my timing assumptions still hold — right now they're tuned to exactly
  how the practice version behaves.
