// Input event handling
// Receives keyboard/mouse events via stdin raw mode and forwards them to Chrome via CDP

import { toKeyName } from './keys.js';
import { UrlBar } from './urlbar.js';
import { HintMode } from './hints.js';
import { loadConfig } from './config.js';
import { mouseTraceFile, traceMouse } from './trace.js';

// SGR mouse button codes
const MOUSE_BTN_LEFT    = 0;
const MOUSE_BTN_MOTION  = 35;  // Motion without button (mode 1003)
const MOUSE_BUTTONS = [
  { name: 'left', mask: 1 },
  { name: 'middle', mask: 4 },
  { name: 'right', mask: 2 },
];
const MOUSE_SCROLL_UP   = 64;
const MOUSE_SCROLL_DOWN = 65;
const SCROLL_DELTA      = 100; // px

// OSC 52 clipboard response timeout
const CLIPBOARD_TIMEOUT = 1000; // ms

// Status message display duration
const STATUS_DISPLAY_MS = 2000;

// 1003 reports motion without a pressed button, which browser hover requires.
// Override via config.json: "mouseMode": 1002 or 1003
const TERM_PROGRAM = (process.env.TERM_PROGRAM || '').toLowerCase();
const PIXEL_MOUSE = TERM_PROGRAM === 'ghostty' && !process.env.TMUX;

function detectMouseMode() {
  const config = loadConfig();
  return Number(config.mouseMode) === 1002 ? 1002 : 1003;
}

export const mouseMode = detectMouseMode();
export const mouseFormat = PIXEL_MOUSE ? 'pixels' : 'cells';

// Enable mouse events (SGR 1006 format)
export function enableMouse() {
  traceMouse('mouse-mode', { tracking: mouseMode, format: mouseFormat, termProgram: TERM_PROGRAM, tmux: !!process.env.TMUX });
  process.stdout.write(`\x1b[?${mouseMode}h\x1b[?1006h${PIXEL_MOUSE ? '\x1b[?1016h' : ''}`);
}

// Disable mouse events
export function disableMouse() {
  process.stdout.write(`\x1b[?${mouseMode}l\x1b[?1006l${PIXEL_MOUSE ? '\x1b[?1016l' : ''}`);
}

// Aim at the terminal cell centre, expressed in viewport CSS pixels.
// row=2 is the top of the browser area (row=1 is the URL bar)
export function cellToPixel(col, row, cellWidth, cellHeight, zoom = 1) {
  return {
    x: (col - 0.5) * cellWidth / zoom,
    y: (row - 1.5) * cellHeight / zoom,
  };
}

// SGR-pixel coordinates are relative to the terminal grid, including the URL bar.
export function pixelToViewport(x, y, cellHeight, zoom = 1) {
  return { x: x / zoom, y: (y - cellHeight) / zoom };
}

// Send mouse event via CDP
async function dispatchMouse(client, type, x, y, button = 'left', clickCount = 0, buttons = 0) {
  traceMouse('pointer-send', { type, x, y, button, buttons });
  try {
    await client.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount, buttons });
    traceMouse('pointer-done', { type });
  } catch (err) {
    traceMouse('pointer-error', { type, message: err.message });
    throw err;
  }
}

// Send scroll event via CDP
async function dispatchScroll(client, x, y, deltaX, deltaY) {
  traceMouse('pointer-send', { type: 'mouseWheel', x, y, deltaX, deltaY });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
  traceMouse('pointer-done', { type: 'mouseWheel' });
}

// CDP modifiers bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8
function modifierBits({ alt = false, ctrl = false, meta = false, shift = false } = {}) {
  return (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
}

// Send key event via CDP
async function dispatchKey(client, { key, code, keyCode, text, modifiers = 0 }) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  if (text) {
    await client.send('Input.dispatchKeyEvent', { type: 'char', text, key, code, modifiers });
  }
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// ── Key mapping (terminal escape sequences → CDP key info) ──

const SPECIAL_KEYS = {
  '\x1b[A':  { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
  '\x1b[B':  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
  '\x1b[C':  { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  '\x1b[D':  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
  '\x1b[H':  { key: 'Home',       code: 'Home',       keyCode: 36 },
  '\x1b[F':  { key: 'End',        code: 'End',        keyCode: 35 },
  '\x1b[5~': { key: 'PageUp',     code: 'PageUp',     keyCode: 33 },
  '\x1b[6~': { key: 'PageDown',   code: 'PageDown',   keyCode: 34 },
  '\x1b[3~': { key: 'Delete',     code: 'Delete',     keyCode: 46 },
  '\x7f':    { key: 'Backspace',  code: 'Backspace',  keyCode: 8,  text: '\x08' },
  '\x08':    { key: 'Backspace',  code: 'Backspace',  keyCode: 8,  text: '\x08' },
  '\r':      { key: 'Enter',      code: 'Enter',      keyCode: 13, text: '\r' },
  '\n':      { key: 'Enter',      code: 'Enter',      keyCode: 13, text: '\r' },
  '\t':      { key: 'Tab',        code: 'Tab',        keyCode: 9,  text: '\t' },
  '\x1b':    { key: 'Escape',     code: 'Escape',     keyCode: 27 },
  ' ':       { key: ' ',          code: 'Space',      keyCode: 32, text: ' ' },
  '\x1bOP':   { key: 'F1',  code: 'F1',  keyCode: 112 },
  '\x1bOQ':   { key: 'F2',  code: 'F2',  keyCode: 113 },
  '\x1bOR':   { key: 'F3',  code: 'F3',  keyCode: 114 },
  '\x1bOS':   { key: 'F4',  code: 'F4',  keyCode: 115 },
  '\x1b[15~': { key: 'F5',  code: 'F5',  keyCode: 116 },
  '\x1b[17~': { key: 'F6',  code: 'F6',  keyCode: 117 },
  '\x1b[18~': { key: 'F7',  code: 'F7',  keyCode: 118 },
  '\x1b[19~': { key: 'F8',  code: 'F8',  keyCode: 119 },
  '\x1b[20~': { key: 'F9',  code: 'F9',  keyCode: 120 },
  '\x1b[21~': { key: 'F10', code: 'F10', keyCode: 121 },
  '\x1b[23~': { key: 'F11', code: 'F11', keyCode: 122 },
  '\x1b[24~': { key: 'F12', code: 'F12', keyCode: 123 },
};

// Ctrl+Key (0x01-0x1A) → exclude collisions with Backspace/Tab/Enter
const CTRL_KEYS = {};
const CTRL_EXCLUDE = new Set([2, 7, 8, 12]); // C, H(BS), I(Tab), M(Enter)
for (let i = 0; i < 26; i++) {
  if (CTRL_EXCLUDE.has(i)) continue;
  const char = String.fromCharCode(i + 1);
  const letter = String.fromCharCode(i + 97);
  const upper = letter.toUpperCase();
  CTRL_KEYS[char] = {
    key: letter,
    code: `Key${upper}`,
    keyCode: upper.charCodeAt(0),
    modifiers: modifierBits({ ctrl: true }),
  };
}

// Base key info for modifier+key combinations
const MOD_SUFFIX = {
  'A': { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
  'B': { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
  'C': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  'D': { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
  'H': { key: 'Home',       code: 'Home',       keyCode: 36 },
  'F': { key: 'End',        code: 'End',        keyCode: 35 },
};

const MOD_TILDE = {
  '3':  { key: 'Delete',   code: 'Delete',   keyCode: 46 },
  '5':  { key: 'PageUp',   code: 'PageUp',   keyCode: 33 },
  '6':  { key: 'PageDown', code: 'PageDown',  keyCode: 34 },
  '15': { key: 'F5',  code: 'F5',  keyCode: 116 },
  '17': { key: 'F6',  code: 'F6',  keyCode: 117 },
  '18': { key: 'F7',  code: 'F7',  keyCode: 118 },
  '19': { key: 'F8',  code: 'F8',  keyCode: 119 },
  '20': { key: 'F9',  code: 'F9',  keyCode: 120 },
  '21': { key: 'F10', code: 'F10', keyCode: 121 },
  '23': { key: 'F11', code: 'F11', keyCode: 122 },
  '24': { key: 'F12', code: 'F12', keyCode: 123 },
};

// macOS Option+char → base char map (US keyboard layout)
const MAC_OPTION_MAP = {
  'å': 'a', '∫': 'b', 'ç': 'c', '∂': 'd',
  'ƒ': 'f', '©': 'g', '˙': 'h', '∆': 'j',
  '˚': 'k', '¬': 'l', 'µ': 'm', 'ø': 'o',
  'π': 'p', 'œ': 'q', '®': 'r', 'ß': 's', '†': 't',
  '√': 'v', '∑': 'w', '≈': 'x', '¥': 'y', 'Ω': 'z',
};

function modBitsFromParam(p) {
  const n = p - 1;
  return modifierBits({ shift: !!(n & 1), alt: !!(n & 2), ctrl: !!(n & 4) });
}

// Pre-compiled regexes for parseInput (hot path)
const RE_MOD_ARROW = /^\x1b\[1;(\d+)([A-H])$/;
const RE_MOD_TILDE = /^\x1b\[(\d+);(\d+)~$/;

// Parse escape sequence into key info (with modifiers)
function parseInput(str) {
  // Exact match for special keys
  const special = SPECIAL_KEYS[str];
  if (special) return { ...special, modifiers: 0 };

  // Ctrl+Key (0x01-0x1A)
  if (str.length === 1 && CTRL_KEYS[str]) return CTRL_KEYS[str];

  // Modified arrows: ESC [ 1 ; <mod> <A-H>
  let m = str.match(RE_MOD_ARROW);
  if (m) {
    const info = MOD_SUFFIX[m[2]];
    if (info) return { ...info, modifiers: modBitsFromParam(parseInt(m[1], 10)) };
  }

  // Modified special keys: ESC [ <num> ; <mod> ~
  m = str.match(RE_MOD_TILDE);
  if (m) {
    const info = MOD_TILDE[m[1]];
    if (info) return { ...info, modifiers: modBitsFromParam(parseInt(m[2], 10)) };
  }

  // Alt+char: ESC + single char (not ESC [ or ESC O sequences)
  if (str.length === 2 && str[0] === '\x1b' && str[1] !== '[' && str[1] !== 'O') {
    const ch = str[1];
    return {
      key: ch,
      code: `Key${ch.toUpperCase()}`,
      keyCode: ch.toUpperCase().charCodeAt(0),
      modifiers: modifierBits({ alt: true }),
    };
  }

  // macOS Option+char: arrives as Unicode char → convert to alt+char
  if (str.length === 1 && MAC_OPTION_MAP[str]) {
    const ch = MAC_OPTION_MAP[str];
    return {
      key: ch,
      code: `Key${ch.toUpperCase()}`,
      keyCode: ch.toUpperCase().charCodeAt(0),
      modifiers: modifierBits({ alt: true }),
    };
  }

  // Normal characters
  if (!str.startsWith('\x1b') && str.length >= 1) return 'text';

  return undefined;
}

// ── OSC 52 clipboard ──

// Write to clipboard via OSC 52
function clipboardWrite(text) {
  const b64 = Buffer.from(text).toString('base64');
  process.stdout.write(`\x1b]52;c;${b64}\x07`);
}

// Read from clipboard via OSC 52
function clipboardRead() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  const timeout = setTimeout(() => {
    process.stdin.removeListener('data', onData);
    resolve(null);
  }, CLIPBOARD_TIMEOUT);

  let buf = '';
  const onData = (data) => {
    buf += data.toString();
    // OSC 52 response: ESC ] 52 ; c ; <base64> ESC \ or BEL
    const m = buf.match(/\x1b\]52;c;([A-Za-z0-9+/=]*?)(?:\x1b\\|\x07)/);
    if (m) {
      clearTimeout(timeout);
      process.stdin.removeListener('data', onData);
      resolve(Buffer.from(m[1], 'base64').toString());
    }
  };
  process.stdin.on('data', onData);

  // Request clipboard read
  process.stdout.write('\x1b]52;c;?\x07');
  return promise;
}

// Get selected text via CDP
async function getSelection(client) {
  try {
    const { result } = await client.send('Runtime.evaluate', {
      expression: 'window.getSelection().toString()',
    });
    return result.value || '';
  } catch { return ''; }
}

// ── casty action execution ──

async function getHistoryEntry(client, delta) {
  const { currentIndex, entries } = await client.send('Page.getNavigationHistory');
  const idx = currentIndex + delta;
  if (idx >= 0 && idx < entries.length) return { entryId: entries[idx].id };
  return { entryId: entries[currentIndex].id };
}

// ── Main ──

// Track currentUrl locally (replacement for page.url())
// bindings: { "ctrl+q": "quit", "alt+left": "back", "alt+l": "url_bar", ... }
export function startInputHandling(client, cellWidth, cellHeight, zoom, bindings, pauseRender, forceCapture) {
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // Mutable cell dimensions (updated on resize via updateCellSize)
  let _cellW = cellWidth;
  let _cellH = cellHeight;
  let _zoom = zoom;

  const keyToAction = bindings;
  const urlBar = new UrlBar();
  const hintMode = new HintMode(forceCapture);

  // Capture after user input — immediate + delayed for Chrome rendering lag
  const INPUT_CAPTURE_DELAY = 150; // ms
  let _captureTimer = null;
  let _hoverTimer = null;
  let _hoverSettleTimer = null;
  function captureAfterInput() {
    forceCapture();
    clearTimeout(_captureTimer);
    _captureTimer = setTimeout(forceCapture, INPUT_CAPTURE_DELAY);
  }

  function scheduleHoverCapture() {
    // Refresh during motion, then again after the final pointer update settles.
    clearTimeout(_hoverSettleTimer);
    _hoverSettleTimer = setTimeout(() => {
      _hoverSettleTimer = null;
      traceMouse('hover-capture', { phase: 'settled' });
      forceCapture();
    }, INPUT_CAPTURE_DELAY);
    if (_hoverTimer) return;
    _hoverTimer = setTimeout(() => {
      _hoverTimer = null;
      traceMouse('hover-capture', { phase: 'motion' });
      forceCapture();
    }, 80);
  }

  function cancelHoverCapture() {
    clearTimeout(_hoverTimer);
    clearTimeout(_hoverSettleTimer);
    _hoverTimer = null;
    _hoverSettleTimer = null;
  }

  // Throttled mouse motion (mode 1003 generates events for every pixel)
  let pendingMotion = null;
  let motionInFlight = false;
  let pointerEpoch = 0;
  let pressedButtons = 0;
  let lastClickButton = null;
  let lastClickTime = 0, lastClickX = 0, lastClickY = 0, lastClickCount = 0;
  let _motionTimer = null;
  const MOTION_INTERVAL = 16; // ms (~60fps)
  function flushMotion() {
    if (pendingMotion && !motionInFlight) {
      const { x, y } = pendingMotion;
      const epoch = pointerEpoch;
      pendingMotion = null;
      motionInFlight = true;
      dispatchMouse(client, 'mouseMoved', x, y, 'none')
        .then(() => { if (epoch === pointerEpoch) scheduleHoverCapture(); }, () => {})
        .finally(() => { motionInFlight = false; });
    }
  }
  _motionTimer = setInterval(flushMotion, MOTION_INTERVAL);

  // Track current URL locally
  let currentUrl = '';
  let mainFrameId = null;

  // Build rawBindings for macOS Option key (macOS only)
  // On Linux, ESC+char collides with Alt+char byte sequences
  const rawBindings = {};
  if (process.platform === 'darwin') {
    const MAC_OPTION_ARROWS = { 'alt+left': '\x1bb', 'alt+right': '\x1bf' };
    for (const [keyName, action] of Object.entries(bindings)) {
      const m = keyName.match(/^alt\+([a-z])$/);
      if (m) {
        const optChar = Object.entries(MAC_OPTION_MAP).find(([, v]) => v === m[1]);
        if (optChar) rawBindings[optChar[0]] = action;
      }
      if (MAC_OPTION_ARROWS[keyName]) {
        rawBindings[MAC_OPTION_ARROWS[keyName]] = action;
      }
    }
  }

  // Get initial URL from navigation history
  urlBar.loading = true;
  client.send('Page.getNavigationHistory').then(({ currentIndex, entries }) => {
    if (!currentUrl && entries[currentIndex]) {
      currentUrl = entries[currentIndex].url;
      urlBar.setUrl(currentUrl);
    }
  }).catch(() => {});

  // Update URL bar on page navigation (CDP events)
  client.on('Page.frameNavigated', ({ frame }) => {
    // Frame without parentId = main frame
    if (!frame.parentId) {
      mainFrameId = frame.id;
      currentUrl = frame.url;
      urlBar.setUrl(currentUrl);
      urlBar.loading = true;
    }
  });

  // Loading complete
  client.on('Page.loadEventFired', () => {
    urlBar.loading = false;
  });
  client.on('Page.navigatedWithinDocument', ({ frameId, url }) => {
    if (frameId !== mainFrameId) return;
    currentUrl = url;
    urlBar.setUrl(url);
  });

  // Download handling (CDP events)
  client.on('Browser.downloadWillBegin', ({ suggestedFilename }) => {
    urlBar.setStatus(`Downloading: ${suggestedFilename}`);
  });
  client.on('Browser.downloadProgress', ({ state }) => {
    if (state === 'completed') {
      urlBar.setStatus('Download complete');
      setTimeout(() => urlBar.clearStatus(), 3000);
    } else if (state === 'canceled') {
      urlBar.setStatus('Download canceled');
      setTimeout(() => urlBar.clearStatus(), 3000);
    }
  });

  // Execute action
  async function execAction(action) {
    if (action === 'quit') { process.emit('SIGINT'); return true; }
    if (action === 'url_bar') {
      pointerEpoch++;
      pendingMotion = null;
      cancelHoverCapture();
      pauseRender();
      // Editing must not block the input queue that supplies its keystrokes.
      urlBar.startEditing().then(async (url) => {
        pauseRender(false);
        forceCapture();
        if (url) {
          urlBar.loading = true;
          await client.send('Page.navigate', { url });
        }
      }).catch(e => console.error('casty: navigate error:', e.message));
      return true;
    }
    if (action === 'back') {
      urlBar.loading = true;
      await client.send('Page.navigateToHistoryEntry', await getHistoryEntry(client, -1));
      return true;
    }
    if (action === 'forward') {
      urlBar.loading = true;
      await client.send('Page.navigateToHistoryEntry', await getHistoryEntry(client, +1));
      return true;
    }
    if (action === 'copy') {
      const text = await getSelection(client);
      if (text) {
        clipboardWrite(text);
        urlBar.setStatus(`Copied: ${text.slice(0, 40)}${text.length > 40 ? '...' : ''}`);
        setTimeout(() => urlBar.clearStatus(), STATUS_DISPLAY_MS);
      }
      return true;
    }
    if (action === 'paste') {
      const text = await clipboardRead();
      if (text) {
        await client.send('Input.insertText', { text });
        captureAfterInput();
      }
      return true;
    }
    if (action === 'hints') {
      await hintMode.start(client);
      return true;
    }
    return false;
  }

  // ESC prefix buffer: when ESC arrives alone, wait for subsequent chars.
  // On Linux terminals, Alt+Key arrives as ESC + Key (2 bytes), but async
  // handler delays can split them. 50ms is sufficient even over SSH without
  // noticeable input lag.
  // On macOS, rawBindings handle Option key directly, so this buffer
  // is primarily relevant on Linux.
  let escBuf = '';
  let escTimer = null;
  const ESC_TIMEOUT = 50; // ms
  const inputQueue = [];
  let processingInput = false;
  let quitRequested = false;
  const CONTINUOUS_MAX_AGE = 150; // Discard reports delayed by a busy renderer.

  async function drainInput() {
    if (processingInput) return;
    processingInput = true;
    try {
      while (inputQueue.length) {
        const input = inputQueue.shift();
        if (input.kind === 'wheel' && Date.now() - input.time > CONTINUOUS_MAX_AGE) {
          traceMouse('input-discarded', { kind: input.kind, age: Date.now() - input.time });
          continue;
        }
        try { await handleInput(input.str); }
        catch (e) { console.error('casty: input error:', e.message); }
      }
    } finally { processingInput = false; }
  }

  function queueInput(str) {
    if (quitRequested) return;
    const key = parseInput(str);
    const action = rawBindings[str] || (key && key !== 'text' && keyToAction[toKeyName(key)]);
    // Quitting must work even while Chrome is stalled.
    if (str === '\x03' || action === 'quit') {
      quitRequested = true;
      inputQueue.length = 0;
      pendingMotion = null;
      process.emit('SIGINT');
      return;
    }
    const mouse = str.match(/^\x1b\[<(\d+);-?\d+;-?\d+[Mm]$/);
    const cb = mouse ? +mouse[1] & ~28 : -1;
    const kind = cb === 64 || cb === 65 ? 'wheel' : cb >= 32 && cb <= 35 ? 'motion' : null;
    const input = { str, kind, time: Date.now() };
    // Keep the latest continuous report, including a reversed wheel direction.
    // Presses, releases, and keys remain ordered and are never coalesced.
    if (kind) {
      for (let i = inputQueue.length - 1; i >= 0 && inputQueue[i].kind; i--) {
        if (inputQueue[i].kind === kind) {
          inputQueue.splice(i, 1);
          break;
        }
      }
    }
    inputQueue.push(input);
  }

  function enqueueInput(str) {
    // A single stdin chunk can contain both mouse reports and keyboard input.
    // Tokenize before queueing so a trackpad burst cannot hide a following key.
    const tokens = str.match(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[<\d+;-?\d+;-?\d+[Mm]|\x1b\[[0-?]*[ -/]*[@-~]|\x1bO.|\x1b[^\[O]|[\x00-\x1f\x7f]|[^\x00-\x1f\x7f]+/g) || [];
    for (const token of tokens) queueInput(token);
    void drainInput();
  }

  process.stdin.on('data', (data) => {
    let str = escBuf + data.toString();
    escBuf = '';
    clearTimeout(escTimer);
    escTimer = null;

    // Hold an incomplete escape sequence, including a split SGR mouse report.
    const lastEsc = str.lastIndexOf('\x1b');
    if (lastEsc >= 0 && /^\x1b(?:\[[<\d;\-]*)?$/.test(str.slice(lastEsc))) {
      escBuf = str.slice(lastEsc);
      str = str.slice(0, lastEsc);
      escTimer = setTimeout(() => {
        escTimer = null;
        const buf = escBuf;
        escBuf = '';
        enqueueInput(buf);
      }, ESC_TIMEOUT);
    }

    if (str) enqueueInput(str);
  });

  async function handleInput(str) {
    if (mouseTraceFile) {
      for (const report of str.matchAll(/\x1b\[<(\d+);(-?\d+);(-?\d+)([Mm])/g)) {
        traceMouse('mouse-report', { button: +report[1], x: +report[2], y: +report[3], release: report[4] === 'm', editing: urlBar.editing, hints: hintMode.active });
      }
    }
    // Hint mode active → route all input to hint mode
    if (hintMode.active) {
      await hintMode.handleInput(str);
      return;
    }

    // A page click leaves address editing and continues to the browser.
    // Ghostty can report negative coordinates when the pointer leaves its grid.
    const report = str.match(/^\x1b\[<(\d+);(-?\d+);(-?\d+)([Mm])$/);
    if (urlBar.editing && report && (+report[1] & ~28) === MOUSE_BTN_LEFT
        && report[4] === 'M' && +report[2] > 0
        && (PIXEL_MOUSE ? +report[3] >= _cellH : +report[3] > 1)) {
      urlBar.cancelEditing();
    }

    // URL bar editing → handle copy/paste here, rest goes to URL bar
    if (urlBar.editing) {
      const r = parseInput(str);
      const kn = r && r !== 'text' ? toKeyName(r) : null;
      const act = kn ? keyToAction[kn] : rawBindings[str];
      if (act === 'paste') {
        const text = await clipboardRead();
        if (text) urlBar.insertText(text);
        return;
      }
      if (act === 'copy') {
        if (urlBar.text) {
          clipboardWrite(urlBar.text);
          urlBar.setStatus('Copied');
          setTimeout(() => urlBar.clearStatus(), 1500);
        }
        return;
      }
      urlBar.handleInput(str);
      return;
    }

    // SGR cell/pixel mouse event: ESC [ < Cb ; Cx ; Cy M/m
    //   Cb: 0=left click, 32=drag, 64/65=scroll up/down
    //   M=press, m=release
    const mouseRe = /\x1b\[<(\d+);(-?\d+);(-?\d+)([Mm])/g;
    let match;
    let hadMouse = false;
    let captureMouseInput = false;

    while ((match = mouseRe.exec(str)) !== null) {
      hadMouse = true;
      const cb = parseInt(match[1]) & ~28;
      const col = parseInt(match[2]);
      const row = parseInt(match[3]);
      const release = match[4] === 'm';
      const motion = cb >= 32 && cb <= 35;
      const { x, y } = PIXEL_MOUSE
        ? pixelToViewport(col, row, _cellH, _zoom)
        : cellToPixel(col, row, _cellW, _cellH, _zoom);
      if (!motion) {
        pendingMotion = null;
        cancelHoverCapture();
      }

      // Click on line 1 → open address bar
      if (col > 0 && row > 0 && (PIXEL_MOUSE ? row < _cellH : row === 1)
          && cb === MOUSE_BTN_LEFT && !release) {
        await execAction('url_bar');
        return;
      }

      if (cb === MOUSE_SCROLL_UP) {
        await dispatchScroll(client, x, y, 0, -SCROLL_DELTA);
        captureMouseInput = true;
      } else if (cb === MOUSE_SCROLL_DOWN) {
        await dispatchScroll(client, x, y, 0, SCROLL_DELTA);
        captureMouseInput = true;
      } else if (MOUSE_BUTTONS[cb]) {
        const { name: button, mask } = MOUSE_BUTTONS[cb];
        if (release) {
          pressedButtons &= ~mask;
          await dispatchMouse(client, 'mouseReleased', x, y, button, cb === MOUSE_BTN_LEFT ? lastClickCount : 1, pressedButtons);
        } else {
          // Detect double/triple click by timing and position
          const now = Date.now();
          const MULTI_CLICK_MS = 400;
          const MULTI_CLICK_PX = 5;
          if (cb === MOUSE_BTN_LEFT && cb === lastClickButton && now - lastClickTime < MULTI_CLICK_MS
              && Math.abs(x - lastClickX) < MULTI_CLICK_PX
              && Math.abs(y - lastClickY) < MULTI_CLICK_PX) {
            lastClickCount = Math.min(lastClickCount + 1, 3);
          } else {
            lastClickCount = 1;
          }
          lastClickTime = now;
          lastClickButton = cb;
          lastClickX = x;
          lastClickY = y;
          pressedButtons |= mask;
          await dispatchMouse(client, 'mousePressed', x, y, button, lastClickCount, pressedButtons);
        }
        captureMouseInput = true;
      } else if (motion) {
        if (cb === MOUSE_BTN_MOTION) pressedButtons = 0;
        const held = MOUSE_BUTTONS[cb & 3];
        // Only a press received by casty can start a browser drag. Terminals
        // can report motion with a stale button state after focus changes.
        if (held && (pressedButtons & held.mask)) {
          await dispatchMouse(client, 'mouseMoved', x, y, held.name, 0, pressedButtons);
          captureMouseInput = true;
        } else {
          pendingMotion = { x, y };
        }
      }
    }

    if (hadMouse) {
      if (captureMouseInput) captureAfterInput();
      return;
    }

    // Check raw input bindings directly (macOS Option+char)
    if (rawBindings[str]) {
      await execAction(rawBindings[str]);
      return;
    }

    // Check bindings via parseInput
    const result = parseInput(str);
    if (result && result !== 'text') {
      const keyName = toKeyName(result);
      const action = keyToAction[keyName];
      if (action && await execAction(action)) return;
    }

    // Ctrl+C fallback
    if (str === '\x03') {
      process.emit('SIGINT');
      return;
    }

    // Not a casty action → pass through to Chrome
    if (result === 'text') {
      await client.send('Input.insertText', { text: str });
      captureAfterInput();
    } else if (result) {
      await dispatchKey(client, result);
      captureAfterInput();
    }
  }

  // Allow updating cell dimensions after resize
  urlBar.updateCellSize = (w, h, nextZoom) => {
    traceMouse('mouse-geometry', { cellWidth: w, cellHeight: h, zoom: nextZoom });
    pointerEpoch++;
    for (let i = inputQueue.length - 1; i >= 0; i--) {
      if (inputQueue[i].kind) inputQueue.splice(i, 1);
    }
    pendingMotion = null;
    cancelHoverCapture();
    _cellW = w;
    _cellH = h;
    _zoom = nextZoom;
  };

  return urlBar;
}
