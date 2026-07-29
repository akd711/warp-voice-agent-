import './env.js';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { handleConnection } from './ws/session.js';
import { warmFillerCache } from './providers/tts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', handleConnection);

server.listen(PORT, () => {
  console.log(`voice-agent listening on http://localhost:${PORT}`);
  console.log(`  make sure the Warp mock is running: node mock/server.js`);
});

// Pre-synthesize the fixed recovery/filler lines once at startup so playing them
// during a real conversation costs zero TTS latency (the whole point of caching them).
warmFillerCache({
  greeting: "Hi, I'm Warp AI. I'm here to help you with your questions. To stop me, say stop or hang up.",
  quote_filler: 'Let me check rates on that lane — one moment.',
  didnt_catch: "Sorry, I didn't catch that — go ahead.",
  goodbye: 'Alright, take care — bye for now!',
}).catch((err) => {
  console.warn('[startup] could not pre-warm filler cache (check ELEVENLABS_API_KEY):', err.message);
});
