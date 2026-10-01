// Address bar / search bar (always visible)
// Line 1 of the terminal always shows the current URL
// Alt+L to enter edit mode → Enter to navigate, Escape to cancel

import { showCursor, hideCursor } from './kitty.js';
import { loadConfig } from './config.js';
import { searchBookmarks } from './bookmarks.js';

function isLocalAddress(str) {
  return /^(?:localhost|127(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]|$)/i.test(str)
    || /^\[::1\](?::\d+)?(?:[/?#]|$)/i.test(str);
}

export function toURL(input) {
  if (isLocalAddress(input)) return 'http://' + input;
  // Check host:port before schemes: a dotted hostname is also a valid scheme token.
  if (/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}(?::\d+)?(?:[/?#]|$)/.test(input)) return 'https://' + input;
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return input;

  // /b [query] → bookmark search
  const bm = input.match(/^\/b(?:\s+(.+))?$/);
  if (bm) {
    const results = searchBookmarks(bm[1] || '');
    if (results.length > 0) return results[0].url;
    return null; // No match
  }

  const config = loadConfig();
  return config.searchUrl + encodeURIComponent(input);
}

// East Asian Width (UAX #11) full-width detection
// Character display width (full-width=2, half-width=1)
function charWidth(cp) {
  if (
    (cp >= 0x1100 && cp <= 0x115F) ||  // Hangul Jamo
    (cp >= 0x2E80 && cp <= 0x303E) ||  // CJK Radicals Supplement, Symbols
    (cp >= 0x3040 && cp <= 0x33BF) ||  // Hiragana, Katakana, CJK Compatibility
    (cp >= 0x3400 && cp <= 0x4DBF) ||  // CJK Unified Ideographs Extension A
    (cp >= 0x4E00 && cp <= 0xA4CF) ||  // CJK Unified Ideographs, Yi Syllables
    (cp >= 0xAC00 && cp <= 0xD7FF) ||  // Hangul Syllables
    (cp >= 0xF900 && cp <= 0xFAFF) ||  // CJK Compatibility Ideographs
    (cp >= 0xFE30 && cp <= 0xFE6F) ||  // CJK Compatibility Forms, Small Forms
    (cp >= 0xFF01 && cp <= 0xFF60) ||  // Fullwidth Latin, Symbols
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||  // Fullwidth Currency, Symbols
    (cp >= 0x20000 && cp <= 0x2FA1F)   // CJK Extensions B-F, Compatibility Supplement
  ) return 2;
  return 1;
}

// Truncate and pad by display width without splitting wide characters.
function padEndByWidth(str, totalW) {
  let text = '', width = 0;
  for (const ch of str) {
    const cw = charWidth(ch.codePointAt(0));
    if (width + cw > totalW) break;
    text += ch;
    width += cw;
  }
  return text + ' '.repeat(Math.max(0, totalW - width));
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const HOME_KEYS = new Set(['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~']);
const END_KEYS = new Set(['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~']);

export class UrlBar {
  constructor() {
    this.currentUrl = '';
    this.editing = false;
    this.loading = false;
    this._spinIdx = 0;
    this._status = null;
    this.text = '';
    this.cursor = 0;
    this._scrollStart = 0; // Code-point index of the first visible character
    this.selectAll = false; // Select-all state
    this._resolve = null;
    this._dirty = true;     // Needs re-render
    this._spinTimer = null; // Spinner update interval
  }

  // Update current URL and re-render (if not editing)
  setUrl(url) {
    this.currentUrl = url;
    this._dirty = true;
    if (!this.editing) this.render();
  }

  // Status message (downloads, etc.)
  setStatus(msg) { this._status = msg; this._dirty = true; }
  clearStatus() { this._status = null; this._dirty = true; }

  // Render only if content changed (for frame callback)
  renderIfDirty() {
    if (!this._dirty) return;
    this.render();
  }

  // Render on line 1
  render() {
    this._dirty = false;
    this._updateSpinTimer();
    const cols = process.stdout.columns || 80;
    if (!this.editing) {
      process.stdout.write(`\x1b[1;1H${this._displayLine(cols)}\x1b[0m`);
      return;
    }
    const view = this._editView(cols);
    process.stdout.write(`\x1b[1;1H${this._editLine(cols, view)}\x1b[0m\x1b[1;${view.cursorCol}H`);
  }

  // Start/stop spinner timer (100ms interval instead of every frame)
  _updateSpinTimer() {
    if (this.loading && !this._spinTimer) {
      this._spinTimer = setInterval(() => { this._dirty = true; }, 100);
    } else if (!this.loading && this._spinTimer) {
      clearInterval(this._spinTimer);
      this._spinTimer = null;
    }
  }

  _displayLine(cols) {
    let prefix;
    if (this.loading) {
      prefix = ' ' + SPINNER[this._spinIdx++ % SPINNER.length] + ' ';
    } else {
      prefix = '   ';
    }
    const content = this._status || this.currentUrl;
    const full = prefix + content;
    return `\x1b[38;5;250m\x1b[48;5;236m${padEndByWidth(full, cols)}`;
  }

  // Keep scrolling on character boundaries and share geometry with mouse input.
  _editView(cols) {
    const prefix = ' > '.slice(0, Math.max(0, cols - 1));
    const maxW = cols - prefix.length;
    const chars = [...this.text];
    const offsets = [0];
    for (const ch of chars) offsets.push(offsets.at(-1) + charWidth(ch.codePointAt(0)));

    let start = Math.min(this._scrollStart, this.cursor);
    // Reveal more text after deletion or enlargement, leaving room for the cursor.
    while (start > 0 && offsets.at(-1) - offsets[start - 1] < maxW) start--;
    const cursorWidth = this.cursor < chars.length ? offsets[this.cursor + 1] - offsets[this.cursor] : 1;
    while (start < this.cursor && offsets[this.cursor] - offsets[start] > Math.max(0, maxW - cursorWidth)) start++;
    this._scrollStart = start;

    let end = start;
    while (end < chars.length && offsets[end + 1] - offsets[start] <= maxW) end++;
    return {
      prefix, start, display: chars.slice(start, end).join(''),
      width: offsets[end] - offsets[start],
      cursorCol: prefix.length + offsets[this.cursor] - offsets[start] + 1,
    };
  }

  _editLine(cols, { prefix, display, width } = this._editView(cols)) {
    const pad = ' '.repeat(cols - prefix.length - width);
    if (this.selectAll) {
      return `\x1b[48;5;24m\x1b[97m${prefix}\x1b[7m${display}\x1b[27m${pad}`;
    }
    return `\x1b[97m\x1b[48;5;24m${prefix}${display}${pad}`;
  }

  // col is a 1-based terminal column; either half of a wide character selects it.
  handleClick(col) {
    if (!this.editing) return;
    const cols = process.stdout.columns || 80;
    const { prefix, start, display } = this._editView(cols);
    const target = Math.max(0, Math.min(cols, col) - prefix.length - 1);
    this.cursor = start;
    let width = 0;
    for (const ch of display) {
      const cw = charWidth(ch.codePointAt(0));
      if (width + cw > target) break;
      width += cw;
      this.cursor++;
    }
    this._deselect();
    this.render();
  }

  // Start editing mode (returns URL via Promise)
  startEditing() {
    this.editing = true;
    this.selectAll = true;
    this.text = this.currentUrl;
    this.cursor = [...this.text].length;
    this._scrollStart = 0;
    showCursor();
    this.render();
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    this._resolve = resolve;
    return promise;
  }

  cancelEditing() {
    if (this.editing) this._finishEditing(null);
  }

  // End editing mode
  _finishEditing(result) {
    this.editing = false;
    hideCursor();

    let url = null;
    if (result) {
      url = toURL(result);
      if (url === null) {
        // Bookmark not found
        this.setStatus('Bookmark not found');
        setTimeout(() => this.clearStatus(), 2000);
      }
    }

    this.render();
    if (this._resolve) {
      this._resolve(url);
      this._resolve = null;
    }
  }

  // Clear selection
  _deselect() { this.selectAll = false; }

  // If selected, replace all on input/delete
  _clearIfSelected() {
    if (this.selectAll) {
      this.text = '';
      this.cursor = 0;
      this.selectAll = false;
    }
  }

  // Insert text (for paste)
  insertText(str) {
    if (!this.editing) return;
    this._clearIfSelected();
    const chars = [...this.text];
    const input = [...str];
    this.text = chars.slice(0, this.cursor).join('') + str + chars.slice(this.cursor).join('');
    this.cursor += input.length;
    this.render();
  }

  // Handle key input during editing (returns true if consumed)
  handleInput(str) {
    if (!this.editing) return false;

    // Enter → confirm
    if (str === '\r' || str === '\n') {
      this._finishEditing(this.text.trim() || null);
      return true;
    }

    // Escape → cancel
    if (str === '\x1b') {
      this._finishEditing(null);
      return true;
    }

    // Ctrl+C → cancel
    if (str === '\x03') {
      this._finishEditing(null);
      return true;
    }

    // Ctrl+U → clear all
    if (str === '\x15') {
      this.text = '';
      this.cursor = 0;
      this._deselect();
      this.render();
      return true;
    }

    // Ctrl+A → select all
    if (str === '\x01') {
      this.selectAll = true;
      this.cursor = [...this.text].length;
      this.render();
      return true;
    }

    // Ctrl+E → move to end
    if (str === '\x05') {
      this._deselect();
      this.cursor = [...this.text].length;
      this.render();
      return true;
    }

    // Ctrl+W → delete word
    if (str === '\x17') {
      this._clearIfSelected();
      const chars = [...this.text];
      const before = chars.slice(0, this.cursor).join('');
      const after = chars.slice(this.cursor).join('');
      const trimmed = before.replace(/\S+\s*$/, '');
      this.text = trimmed + after;
      this.cursor = [...trimmed].length;
      this.render();
      return true;
    }

    // Backspace
    if (str === '\x7f' || str === '\x08') {
      if (this.selectAll) {
        this._clearIfSelected();
      } else if (this.cursor > 0) {
        const chars = [...this.text];
        chars.splice(this.cursor - 1, 1);
        this.text = chars.join('');
        this.cursor--;
      }
      this.render();
      return true;
    }

    // Delete
    if (str === '\x1b[3~') {
      if (this.selectAll) {
        this._clearIfSelected();
      } else if (this.cursor < [...this.text].length) {
        const chars = [...this.text];
        chars.splice(this.cursor, 1);
        this.text = chars.join('');
      }
      this.render();
      return true;
    }

    // Left arrow → deselect and move to start
    if (str === '\x1b[D' || str === '\x1bOD') {
      if (this.selectAll) { this.cursor = 0; this._deselect(); }
      else if (this.cursor > 0) this.cursor--;
      this.render();
      return true;
    }

    // Right arrow → deselect and move to end
    if (str === '\x1b[C' || str === '\x1bOC') {
      if (this.selectAll) { this._deselect(); }
      else if (this.cursor < [...this.text].length) this.cursor++;
      this.render();
      return true;
    }

    // Home
    if (HOME_KEYS.has(str)) {
      this._deselect();
      this.cursor = 0;
      this.render();
      return true;
    }

    // End
    if (END_KEYS.has(str)) {
      this._deselect();
      this.cursor = [...this.text].length;
      this.render();
      return true;
    }

    // Normal character input → replace all if selected
    if (!str.startsWith('\x1b') && str.charCodeAt(0) >= 32) {
      this._clearIfSelected();
      const chars = [...this.text];
      const input = [...str];
      this.text = chars.slice(0, this.cursor).join('') + str + chars.slice(this.cursor).join('');
      this.cursor += input.length;
      this.render();
      return true;
    }

    return true; // Consume all input while editing
  }
}
