// Key binding configuration
// Customizable via ~/.casty/keys.json
// Only defines actions casty intercepts; everything else passes through to Chrome.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadJsonFile } from './config.js';

const configPath = join(homedir(), '.casty', 'keys.json');

// Default key bindings
// Key names: "ctrl+c", "alt+left", "f5", "ctrl+shift+r", etc.
const DEFAULTS = {
  'ctrl+q':      'quit',
  'alt+left':    'back',
  'alt+right':   'forward',
  'alt+home':    'home',
  'ctrl+t':      'tab_new',
  'ctrl+w':      'tab_close',
  'alt+up':      'tab_previous',
  'alt+down':    'tab_next',
  'alt+l':       'url_bar',
  'alt+c':       'copy',
  'ctrl+v':      'paste',
  'alt+f':       'hints',
};

// Load bindings (falls back to defaults)
export function loadKeyBindings() {
  return { ...DEFAULTS, ...loadJsonFile(configPath, {}) };
}

// Build a human-readable key name from parsed input
// { key: 'ArrowLeft', modifiers: 1 } → "alt+left"
// { key: 'r', modifiers: 2 }        → "ctrl+r"
// { key: 'F5', modifiers: 0 }       → "f5"
export function toKeyName(info) {
  const parts = [];
  if (info.modifiers & 2) parts.push('ctrl');
  if (info.modifiers & 1) parts.push('alt');
  if (info.modifiers & 8) parts.push('shift');
  if (info.modifiers & 4) parts.push('meta');

  // Normalize key name
  const k = info.key;
  const normalized =
    k === 'ArrowUp'    ? 'up' :
    k === 'ArrowDown'  ? 'down' :
    k === 'ArrowLeft'  ? 'left' :
    k === 'ArrowRight' ? 'right' :
    k === ' '          ? 'space' :
    k.toLowerCase();

  parts.push(normalized);
  return parts.join('+');
}
