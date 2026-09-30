// Kitty graphics protocol output
//
// Protocol parameters:
//   a=T  : transmit and display
//   a=d  : delete image(s)
//   f=100: PNG format
//   t=f  : file transfer (send file path as base64)
//   t=d  : inline transfer (send image data as base64)
//   q=2  : suppress response (no OK/ERR from terminal)
//   C=1  : no cursor movement (keep cursor position after display)
//   i=N  : image ID (replace existing image with same ID)
//   m=0/1: chunk continuation (1=more chunks follow, 0=final chunk)
//   d=A  : delete all images (used with a=d)
//
// Two transfer modes:
//   File transfer (t=f): fast, sends only the path (bcon, etc.)
//   Inline (t=d): sends base64 data directly in 4096B chunks (Ghostty, others)
//
// ~/.casty/config.json transport setting:
//   "auto"   → file transfer for bcon/kitty, inline for others
//   "file"   → force file transfer
//   "inline" → force inline

import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from './config.js';
import { traceMouse } from './trace.js';

const tmpFile = join(tmpdir(), `casty-frame-${process.pid}.png`);
const tmpPathB64 = Buffer.from(tmpFile).toString('base64');

// Display size in cells (set by caller, used for c=/r= parameters)
let _cols = 0;
let _rows = 0;

// Set display size (cols = terminal columns, rows = display rows excluding URL bar)
export function setDisplaySize(cols, rows) {
  _cols = cols;
  _rows = rows;
}

// Detect transfer mode
function detectTransport() {
  const config = loadConfig();
  const setting = config.transport || 'auto';

  if (setting === 'file') return 'file';
  if (setting === 'inline') return 'inline';

  // auto: file transfer (t=f) for terminals that support it
  const termProg = process.env.TERM_PROGRAM || '';
  if (/bcon/i.test(termProg)) return 'file';
  if (/kitty/i.test(termProg)) return 'file';
  return 'inline';
}

export const transport = detectTransport();

export function selectCaptureFormat(requested = 'auto', mode = transport, terminal = process.env.TERM_PROGRAM || '') {
  // JPEG file decoding is a bcon extension. Standard Kitty transfers require PNG.
  return requested !== 'png' && mode === 'file' && /bcon/i.test(terminal) ? 'jpeg' : 'png';
}

// Retransmitting an image ID removes its existing image and placements.
// Keep the current frame visible while the next frame loads under another ID.
let displayedImage = 0;
let waitingForDrain = false;
let pendingFrame = null;

function flushPendingFrame() {
  waitingForDrain = false;
  const frame = pendingFrame;
  pendingFrame = null;
  if (frame !== null) sendFrame(frame);
}

function discardPendingFrame() {
  pendingFrame = null;
  waitingForDrain = false;
  process.stdout.removeListener('drain', flushPendingFrame);
}

function nextImageId() {
  return displayedImage === 1 ? 2 : 1;
}

function writeFrame(seq, id) {
  const removeOld = displayedImage
    ? `\x1b_Ga=d,d=I,i=${displayedImage},q=2;\x1b\\` : '';
  if (!process.stdout.write(`${CURSOR_HOME}${wrapKitty(seq + removeOld)}`)) {
    waitingForDrain = true;
    process.stdout.once('drain', flushPendingFrame);
  }
  displayedImage = id;
}

// Cursor to line 2 (line 1 is reserved for URL bar)
const CURSOR_HOME = '\x1b[2;1H';
export function cursorHome() {
  process.stdout.write(CURSOR_HOME);
}

// tmux only forwards kitty graphics if they are wrapped in a DCS passthrough
// envelope. Regular cursor/control sequences must stay outside that wrapper.
function wrapKitty(seq) {
  if (!process.env.TMUX) return seq;
  return `\x1bPtmux;${seq.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`;
}

// Clear screen (also delete all Kitty images)
export function clearScreen() {
  discardPendingFrame();
  process.stdout.write(`${wrapKitty('\x1b_Ga=d,d=A,q=2;\x1b\\')}\x1b[2J\x1b[H`);
  displayedImage = 0;
  resetFrameCache();
}

// Hide cursor
export function hideCursor() {
  process.stdout.write('\x1b[?25l');
}

// Show cursor
export function showCursor() {
  process.stdout.write('\x1b[?25h');
}

// Clean up temp file
export function cleanup() {
  discardPendingFrame();
  try { unlinkSync(tmpFile); } catch {}
}

// Frame deduplication — skip identical consecutive frames
let lastFrameData = '';
let _dedupDisabled = false;
let _dedupTimer = null;

// Temporarily disable dedup (e.g. after resize, bcon needs re-send)
export function disableDedup(ms = 3000) {
  _dedupDisabled = true;
  clearTimeout(_dedupTimer);
  _dedupTimer = setTimeout(() => { _dedupDisabled = false; }, ms);
}

// File transfer mode (fast: sends only path)
// Prepends cursor-home to batch into a single write
function sendFrameFile(base64Data) {
  if (!_dedupDisabled && base64Data.length === lastFrameData.length && base64Data === lastFrameData) {
    traceMouse('frame-skipped', { transport: 'file', reason: 'identical' });
    return;
  }
  lastFrameData = base64Data;
  writeFileSync(tmpFile, Buffer.from(base64Data, 'base64'));
  const crFile = _cols && _rows ? `,c=${_cols},r=${_rows}` : '';
  const id = nextImageId();
  const seq = `\x1b_Ga=T,f=100,t=f,q=2,C=1,i=${id}${crFile};${tmpPathB64}\x1b\\`;
  writeFrame(seq, id);
  traceMouse('frame-sent', { transport: 'file', bytes: base64Data.length, queuedBytes: process.stdout.writableLength });
}

// Inline mode (4096B chunked, PNG only)
// Prepends cursor-home and batches all chunks into a single stdout.write
function sendFrameInline(pngBase64) {
  if (!_dedupDisabled && pngBase64.length === lastFrameData.length && pngBase64 === lastFrameData) {
    traceMouse('frame-skipped', { transport: 'inline', reason: 'identical' });
    return;
  }
  lastFrameData = pngBase64;
  const CHUNK = 4096;
  const crInline = _cols && _rows ? `,c=${_cols},r=${_rows}` : '';
  const id = nextImageId();
  if (pngBase64.length <= CHUNK) {
    const seq = `\x1b_Ga=T,f=100,q=2,C=1,i=${id}${crInline};${pngBase64}\x1b\\`;
    writeFrame(seq, id);
    traceMouse('frame-sent', { transport: 'inline', bytes: pngBase64.length, queuedBytes: process.stdout.writableLength });
    return;
  }
  const parts = [];
  let i = 0;
  while (i < pngBase64.length) {
    const chunk = pngBase64.slice(i, i + CHUNK);
    const more = i + CHUNK < pngBase64.length ? 1 : 0;
    if (i === 0) {
      parts.push(`\x1b_Ga=T,f=100,q=2,C=1,i=${id}${crInline},m=${more};${chunk}\x1b\\`);
    } else {
      parts.push(`\x1b_Gm=${more};${chunk}\x1b\\`);
    }
    i += CHUNK;
  }
  writeFrame(parts.join(''), id);
  traceMouse('frame-sent', { transport: 'inline', bytes: pngBase64.length, queuedBytes: process.stdout.writableLength });
}

// Reset dedup state (e.g. after resize)
export function resetFrameCache() {
  pendingFrame = null;
  lastFrameData = '';
}

const transmitFrame = transport === 'file' ? sendFrameFile : sendFrameInline;
export function sendFrame(data) {
  // Slow terminals need only the newest complete frame, not a growing backlog.
  if (waitingForDrain) {
    pendingFrame = data;
    traceMouse('frame-deferred', { queuedBytes: process.stdout.writableLength });
    return;
  }
  transmitFrame(data);
}
