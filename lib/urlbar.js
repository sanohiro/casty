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

function strWidth(str) {
  let w = 0;
  for (const ch of str) w += charWidth(ch.codePointAt(0));
  return w;
}

// Truncate by display width (keep rightmost maxW columns)
function sliceByWidth(str, maxW) {
  const chars = [...str];
  let w = 0;
  let start = chars.length;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charWidth(chars[i].codePointAt(0));
    if (w + cw > maxW) break;
    w += cw;
    start = i;
  }
  return { text: chars.slice(start).join(''), width: w };
}

// padEnd by display width
function padEndByWidth(str, totalW) {
  const w = strWidth(str);
  return w >= totalW ? str : str + ' '.repeat(totalW - w);
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class UrlBar {
  constructor() {
    this.currentUrl = '';
    this.editing = false;
    this.loading = false;
    this._spinIdx = 0;
    this._status = null;
    this.text = '';
    this.cursor = 0;
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
    const line = this.editing ? this._editLine(cols) : this._displayLine(cols);
    process.stdout.write(`\x1b[1;1H${line}\x1b[0m`);
    if (this.editing) {
      const prefix = ' > ';
      const textBeforeCursor = [...this.text].slice(0, this.cursor).join('');
      const cursorCol = prefix.length + strWidth(textBeforeCursor) + 1;
      process.stdout.write(`\x1b[1;${cursorCol}H`);
    }
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

  _editLine(cols) {
    const prefix = ' > ';
    const maxW = cols - prefix.length;
    const tw = strWidth(this.text);
    const display = tw > maxW ? sliceByWidth(this.text, maxW).text : this.text;
    const dw = strWidth(display);
    const pad = Math.max(0, maxW - dw);
    if (this.selectAll) {
      return `\x1b[48;5;24m\x1b[97m${prefix}\x1b[7m${display}\x1b[27m${' '.repeat(pad)}`;
    }
    return `\x1b[97m\x1b[48;5;24m${prefix}${display}${' '.repeat(pad)}`;
  }

  // Start editing mode (returns URL via Promise)
  startEditing() {
    this.editing = true;
    this.selectAll = true;
    this.text = this.currentUrl;
    this.cursor = [...this.text].length;
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
    if (str === '\x1b[D') {
      if (this.selectAll) { this.cursor = 0; this._deselect(); }
      else if (this.cursor > 0) this.cursor--;
      this.render();
      return true;
    }

    // Right arrow → deselect and move to end
    if (str === '\x1b[C') {
      if (this.selectAll) { this._deselect(); }
      else if (this.cursor < [...this.text].length) this.cursor++;
      this.render();
      return true;
    }

    // Home
    if (str === '\x1b[H') {
      this._deselect();
      this.cursor = 0;
      this.render();
      return true;
    }

    // End
    if (str === '\x1b[F') {
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
