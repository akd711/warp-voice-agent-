// Append-only JSONL event log. One line per event: session lifecycle, transcript
// turns, and tool calls with their timing. Answers "how many calls this week, what
// did people ask for" via stats.js. Defensively strips anything key/token-shaped
// before it ever touches disk, even though nothing upstream should be passing one in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const logDir = path.join(root, 'logs');
const logFile = path.join(logDir, 'events.jsonl');

if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const SECRET_KEY_PATTERN = /key|token|secret|authorization|bearer/i;

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(k)) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

export function logEvent(event) {
  const line = JSON.stringify(scrub({ ts: new Date().toISOString(), ...event }));
  fs.appendFile(logFile, line + '\n', () => {});
}

export function logFilePath() {
  return logFile;
}
