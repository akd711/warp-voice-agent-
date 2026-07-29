// Turn-based voice client: records a turn, auto-stops on silence (client-side VAD),
// sends it over a persistent WebSocket, and plays back sentence-by-sentence audio as
// it streams in from the server. No vendor keys ever touch this file.

const SPEECH_RMS_THRESHOLD = 0.035; // tune if the mic is very quiet/loud in practice
const SILENCE_MS = 1200; // auto-stop a turn after this much quiet, once speech began
const MAX_TURN_MS = 20000; // hard cap once speech has started, so one turn can't run forever

const callButton = document.getElementById('callButton');
const statusText = document.getElementById('statusText');
const transcriptEl = document.getElementById('transcript');
const waveformCanvas = document.getElementById('waveform');
const waveformCtx = waveformCanvas.getContext('2d');

const TOOL_LABELS = {
  track_shipment: 'shipment status',
  get_shipment_events: 'shipment history',
  list_shipments: 'your shipments',
  get_shipping_quote: 'a shipping rate',
  get_invoice: 'the invoice',
  get_documents: 'the documents',
};

let ws = null;
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let audioCtx = null;
let analyser = null;
let vadTimer = null;
let mimeType = '';
let sessionActive = false;

let playQueue = [];
let isPlaying = false;
let turnCompletePending = false;
let endingSession = false;
let waveformRAF = null;

function setButtonState(state) {
  callButton.classList.remove('listening', 'thinking', 'speaking');
  if (state !== 'listening') callButton.classList.remove('user-speaking');
  if (state === 'listening') {
    callButton.classList.add('listening');
    statusText.textContent = 'Listening…';
  } else if (state === 'thinking') {
    callButton.classList.add('thinking');
    statusText.textContent = 'Thinking…';
  } else if (state === 'speaking') {
    callButton.classList.add('speaking');
    statusText.textContent = 'Speaking…';
  } else if (state === 'connecting') {
    statusText.textContent = 'Connecting…';
  } else {
    statusText.textContent = sessionActive ? 'Ready' : 'Click to start a conversation';
  }
}

function appendBubble(kind, text) {
  const el = document.createElement('div');
  el.className = `bubble ${kind}`;
  el.textContent = text;
  transcriptEl.appendChild(el);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return el;
}

function appendLinksBubble(title, documents) {
  const el = document.createElement('div');
  el.className = 'bubble tool';
  const label = document.createElement('div');
  label.textContent = title;
  el.appendChild(label);
  for (const doc of documents) {
    const a = document.createElement('a');
    a.href = doc.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = doc.type;
    a.style.display = 'block';
    el.appendChild(a);
  }
  transcriptEl.appendChild(el);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function pickSupportedMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

async function startSession() {
  setButtonState('connecting');
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    statusText.textContent = 'Microphone permission denied.';
    return;
  }

  mimeType = pickSupportedMimeType();
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  startWaveform();

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'init', mimeType }));
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerEvent(msg);
  };

  ws.onclose = () => {
    if (sessionActive) endSession();
  };

  ws.onerror = () => {
    statusText.textContent = 'Connection error.';
  };

  sessionActive = true;
  callButton.title = 'End conversation';
}

function handleServerEvent(msg) {
  switch (msg.type) {
    case 'connected':
      // Don't start recording yet — wait for the greeting to play first (its
      // audio event + the turn_complete that follows drive startRecordingTurn()).
      statusText.textContent = 'Connected…';
      break;
    case 'transcript':
      appendBubble('user', msg.text);
      break;
    case 'tool_call':
      appendBubble('tool', `Checking ${TOOL_LABELS[msg.name] || msg.name}…`);
      break;
    case 'tool_result':
      if (msg.name === 'get_documents' && msg.result.ok && msg.result.documents?.length) {
        appendLinksBubble('Found these documents:', msg.result.documents);
      }
      break;
    case 'audio':
      enqueueAudio(msg);
      break;
    case 'turn_complete':
      turnCompletePending = true;
      maybeResumeListening();
      break;
    case 'session_ending':
      endingSession = true;
      maybeResumeListening();
      break;
    case 'error':
      appendBubble('error', msg.message);
      break;
  }
}

function enqueueAudio(msg) {
  if (msg.text) appendBubble('agent', msg.text);
  playQueue.push(msg);
  if (!isPlaying) playNext();
}

function playNext() {
  if (playQueue.length === 0) {
    isPlaying = false;
    maybeResumeListening();
    return;
  }
  isPlaying = true;
  setButtonState('speaking');
  const msg = playQueue.shift();
  const audioEl = new Audio(`data:${msg.mimeType};base64,${msg.dataBase64}`);
  audioEl.onended = playNext;
  audioEl.onerror = playNext;
  audioEl.play().catch(playNext);
}

function maybeResumeListening() {
  if (isPlaying || playQueue.length > 0) return;
  if (endingSession) {
    endingSession = false;
    turnCompletePending = false;
    if (sessionActive) endSession();
    return;
  }
  if (turnCompletePending) {
    turnCompletePending = false;
    if (sessionActive) startRecordingTurn();
  }
}

function startRecordingTurn() {
  if (!sessionActive || !mediaStream) return;
  recordedChunks = [];
  mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: mimeType || 'audio/webm' });
    if (ws && ws.readyState === WebSocket.OPEN && blob.size > 0) {
      ws.send(blob);
      setButtonState('thinking');
    } else {
      setButtonState('listening');
      startRecordingTurn();
    }
  };
  mediaRecorder.start(250);
  setButtonState('listening');
  runVad();
}

// Require this many consecutive 100ms samples above the threshold before counting
// it as "you started talking" — filters out a brief click/pop/cough from arming
// the silence timer (and, more importantly, from sending a near-instant blip of
// audio to Whisper, which is exactly the kind of low-signal clip it tends to
// hallucinate text from).
const SUSTAINED_SPEECH_SAMPLES = 2;

function runVad() {
  const data = new Uint8Array(analyser.fftSize);
  let hasSpoken = false;
  let lastVoiceAt = Date.now();
  const turnStartAt = Date.now();
  let aboveThresholdStreak = 0;

  clearInterval(vadTimer);
  vadTimer = setInterval(() => {
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / data.length);
    const now = Date.now();

    const currentlySpeaking = rms > SPEECH_RMS_THRESHOLD;
    callButton.classList.toggle('user-speaking', currentlySpeaking);
    aboveThresholdStreak = currentlySpeaking ? aboveThresholdStreak + 1 : 0;

    if (aboveThresholdStreak >= SUSTAINED_SPEECH_SAMPLES) {
      hasSpoken = true;
      lastVoiceAt = now;
    }

    if (hasSpoken && now - lastVoiceAt > SILENCE_MS) {
      stopRecordingTurn();
    } else if (hasSpoken && now - turnStartAt > MAX_TURN_MS) {
      stopRecordingTurn();
    }
  }, 100);
}

function stopRecordingTurn() {
  clearInterval(vadTimer);
  callButton.classList.remove('user-speaking');
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

// Radial voice-reactive bars around the mic button, driven by the same analyser
// node the VAD already uses — purely decorative, doesn't affect turn-taking logic.
function startWaveform() {
  const barCount = 40;
  const baseRadius = 46;
  const maxBarLength = 34;
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  const cx = waveformCanvas.width / 2;
  const cy = waveformCanvas.height / 2;
  const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6bff6b';

  const draw = () => {
    if (!analyser) return;
    waveformRAF = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);
    waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
    waveformCtx.strokeStyle = accentColor;
    waveformCtx.lineWidth = 2.5;
    waveformCtx.lineCap = 'round';

    for (let i = 0; i < barCount; i++) {
      const angle = (i / barCount) * Math.PI * 2;
      const dataIndex = Math.floor((i / barCount) * (bufferLength * 0.5));
      const value = dataArray[dataIndex] / 255;
      const len = 3 + value * maxBarLength;
      const x1 = cx + Math.cos(angle) * baseRadius;
      const y1 = cy + Math.sin(angle) * baseRadius;
      const x2 = cx + Math.cos(angle) * (baseRadius + len);
      const y2 = cy + Math.sin(angle) * (baseRadius + len);
      waveformCtx.globalAlpha = 0.25 + value * 0.75;
      waveformCtx.beginPath();
      waveformCtx.moveTo(x1, y1);
      waveformCtx.lineTo(x2, y2);
      waveformCtx.stroke();
    }
  };
  draw();
}

function stopWaveform() {
  if (waveformRAF) cancelAnimationFrame(waveformRAF);
  waveformRAF = null;
  waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
}

function endSession() {
  sessionActive = false;
  clearInterval(vadTimer);
  stopWaveform();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  playQueue = [];
  isPlaying = false;
  turnCompletePending = false;
  endingSession = false;
  callButton.classList.remove('listening', 'thinking', 'speaking', 'user-speaking');
  callButton.title = 'Start conversation';
  statusText.textContent = "Ended — click to start a new conversation";
}

callButton.addEventListener('click', () => {
  if (sessionActive) {
    endSession();
  } else {
    startSession();
  }
});
