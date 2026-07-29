#!/usr/bin/env node
// Prints full stored conversations from logs/events.jsonl in readable form —
// the exact raw data behind stats.js's summary. Run via `npm run transcripts`.
import fs from 'node:fs';
import { logFilePath } from './logger.js';

function main() {
  const file = logFilePath();
  if (!fs.existsSync(file)) {
    console.log('No log file yet — run a conversation first.');
    return;
  }
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);

  const sessions = new Map();
  for (const e of events) {
    if (!sessions.has(e.sessionId)) sessions.set(e.sessionId, []);
    sessions.get(e.sessionId).push(e);
  }

  for (const [sessionId, sessionEvents] of sessions) {
    const turns = sessionEvents.filter((e) => e.type === 'turn');
    if (turns.length === 0) continue;
    const start = sessionEvents.find((e) => e.type === 'session_start');
    console.log(`\n=== Session ${sessionId} (${start ? start.ts : 'unknown time'}) ===`);
    for (const t of turns) {
      console.log(`  Caller: ${t.transcript}`);
      console.log(`  Agent:  ${t.assistantText}`);
      if (t.toolCalls && t.toolCalls.length > 0) {
        console.log(`  (tools: ${t.toolCalls.map((c) => `${c.name}${c.ok ? '' : ` [${c.code}]`}`).join(', ')})`);
      }
      console.log('');
    }
  }
}

main();
