// Real camera/mic capture via ffmpeg → WebSocket relay
// Two ffmpeg processes (video MJPEG, audio PCM) piped to a local WS server

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

const IS_MAC = process.platform === 'darwin';

// Detect available devices via ffmpeg
function listDevices() {
  const video = detectVideoDevice();
  const audio = detectAudioDevice();
  return { video, audio };
}

function detectVideoDevice() {
  if (IS_MAC) {
    const out = ffmpegProbe(['-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
    // Parse first video device from "AVFoundation video devices:" section (language-independent)
    const videoSection = out.split(/audio devices/i)[0];
    const m = videoSection.match(/\[(\d+)\]/);
    if (!m) return null;
    const idx = m[1];
    // Probe supported framerate by attempting to open with invalid fps
    const probe = ffmpegProbe(['-f', 'avfoundation', '-framerate', '1', '-video_size', '640x480', '-i', idx]);
    const fpsMatch = probe.match(/640x480@\[(\d+)/);
    const fps = fpsMatch ? parseInt(fpsMatch[1]) : 30;
    return { idx, fps };
  }
  return existsSync('/dev/video0') ? '/dev/video0' : null;
}

function detectAudioDevice() {
  if (IS_MAC) {
    const out = ffmpegProbe(['-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
    // Parse first audio device from "AVFoundation audio devices:" section (language-independent)
    const audioSection = out.split(/audio devices/i)[1];
    const m = audioSection && audioSection.match(/\[(\d+)\]/);
    return m ? ':' + m[1] : null;
  }
  // Linux: find first PulseAudio input source (not monitor)
  try {
    const out = execFileSync('pactl', ['list', 'sources', 'short'], { encoding: 'utf8' });
    for (const line of out.trim().split('\n')) {
      const parts = line.split('\t');
      if (parts[1] && !parts[1].includes('.monitor')) return parts[1];
    }
  } catch {}
  return 'default';
}

function ffmpegProbe(args) {
  try {
    execFileSync('ffmpeg', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return (e.stderr || '') + (e.stdout || '');
  }
  return '';
}

// Parse MJPEG stream: extract individual JPEG frames from continuous byte stream
function createMjpegParser(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      // Find SOI marker (0xFF 0xD8)
      const soi = buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (soi < 0) { buf = Buffer.alloc(0); return; }
      if (soi > 0) buf = buf.subarray(soi);
      // Find EOI marker (0xFF 0xD9) after SOI
      const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (eoi < 0) return; // Incomplete frame
      const frame = buf.subarray(0, eoi + 2);
      onFrame(frame);
      buf = buf.subarray(eoi + 2);
    }
  };
}

// Start media capture and WebSocket relay
export async function startMedia(config = {}) {
  // Check ffmpeg availability
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' });
  } catch {
    console.error('casty: ffmpeg is required for media capture.');
    if (IS_MAC) console.error('casty: Install with: brew install ffmpeg');
    else console.error('casty: Install with: sudo apt install ffmpeg');
    return { port: 0, cleanup: () => {} };
  }

  const devices = listDevices();
  const videoRaw = config.videoDevice || devices.video;
  const audioDevice = config.audioDevice || devices.audio;

  // Normalize video device: { idx, fps } on macOS, string on Linux
  const videoDevice = videoRaw && typeof videoRaw === 'object' ? videoRaw.idx : videoRaw;
  const videoFps = videoRaw && typeof videoRaw === 'object' ? videoRaw.fps : 15;

  if (!videoDevice && !audioDevice) {
    console.error('casty: no media devices found');
    return { port: 0, cleanup: () => {} };
  }

  // Start WebSocket server on random port, guarded by a per-session token so
  // arbitrary pages/origins on the machine can't hijack the media stream (CWE-346).
  const token = randomBytes(16).toString('hex');
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: (info) => info.req.url === `/${token}`,
  });
  const port = await new Promise(resolve => {
    wss.on('listening', () => resolve(wss.address().port));
  });

  const clients = new Set();
  const procs = [];
  let capturing = false;

  function broadcast(prefix, data) {
    const msg = Buffer.concat([Buffer.from([prefix]), data]);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  // Start ffmpeg capture on demand (first WebSocket connection = getUserMedia called)
  function startCapture() {
    if (capturing) return;
    capturing = true;
    console.error('casty: media requested, starting capture');

    // Video capture
    if (videoDevice) {
      const vargs = IS_MAC
        ? ['-f', 'avfoundation', '-framerate', String(videoFps), '-video_size', '640x480', '-i', videoDevice]
        : ['-f', 'v4l2', '-framerate', '15', '-video_size', '640x480', '-i', videoDevice];
      vargs.push('-f', 'mjpeg', '-q:v', '5', '-r', '15', 'pipe:1');

      const vproc = spawn('ffmpeg', vargs, { stdio: ['pipe', 'pipe', 'pipe'] });
      const parse = createMjpegParser((frame) => broadcast(0x01, frame));
      vproc.stdout.on('data', parse);
      vproc.stderr.on('data', () => {}); // Suppress
      vproc.on('error', (e) => console.error('casty: video capture error:', e.message));
      procs.push(vproc);
      console.error(`casty: video capture started (${videoDevice})`);
    }

    // Audio capture
    if (audioDevice) {
      const aargs = IS_MAC
        ? ['-f', 'avfoundation', '-i', audioDevice]
        : ['-f', 'pulse', '-i', audioDevice];
      aargs.push('-f', 's16le', '-ar', '48000', '-ac', '1', 'pipe:1');

      const env = { ...process.env };
      if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
      const aproc = spawn('ffmpeg', aargs, { stdio: ['pipe', 'pipe', 'pipe'], env });
      let pcmBuf = Buffer.alloc(0);
      const PCM_CHUNK = 9600;
      aproc.stdout.on('data', (chunk) => {
        pcmBuf = Buffer.concat([pcmBuf, chunk]);
        while (pcmBuf.length >= PCM_CHUNK) {
          broadcast(0x02, pcmBuf.subarray(0, PCM_CHUNK));
          pcmBuf = pcmBuf.subarray(PCM_CHUNK);
        }
      });
      aproc.stderr.on('data', () => {}); // Suppress
      aproc.on('error', (e) => console.error('casty: audio capture error:', e.message));
      procs.push(aproc);
      console.error(`casty: audio capture started (${audioDevice})`);
    }
  }

  function stopCapture() {
    if (!capturing) return;
    for (const p of procs) {
      try { p.kill(); } catch {}
    }
    procs.length = 0;
    capturing = false;
    console.error('casty: media stopped (no active sessions)');
  }

  // Start capture when first client connects, stop when all disconnect
  wss.on('connection', (ws) => {
    clients.add(ws);
    startCapture();
    ws.on('close', () => {
      clients.delete(ws);
      if (clients.size === 0) stopCapture();
    });
  });

  console.error('casty: media ready (capture starts on demand)');

  function cleanup() {
    for (const p of procs) {
      try { p.kill(); } catch {}
    }
    wss.close();
  }

  return { port, token, cleanup };
}
