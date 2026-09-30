// Configuration
// Customizable via ~/.casty/config.json (falls back to defaults)

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Safely load and parse a JSON file (returns fallback on parse error or missing file)
export function loadJsonFile(filePath, fallback) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

const configPath = join(homedir(), '.casty', 'config.json');

// Detect system locale (e.g. "en-US", "ja", "zh-CN")
function detectLocale() {
  // Environment variables first (Intl may lack ICU data and return en-US)
  const env = process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || '';
  const m = env.match(/^([a-z]{2})(?:[_-]([A-Z]{2}))?/);
  if (m) return m[2] ? `${m[1]}-${m[2]}` : m[1];
  // Fallback to Intl API
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale) return locale;
  } catch {}
  return 'en-US';
}

const DEFAULTS = {
  headlessShellPath: '', // Explicit external headless shell; empty uses the managed download
  homeUrl: 'https://github.com/sanohiro/casty',
  searchUrl: 'https://www.google.com/search?q=',
  transport: 'auto', // 'auto' | 'file' | 'inline'
  format: 'auto',    // 'auto' | 'png' | 'jpeg'
  media: false,      // Enable camera/mic via ffmpeg for WebRTC (requires ffmpeg)
  language: detectLocale(), // System locale (override: "en-US", "ja", etc.)
};

let _cache = null;

export function loadConfig() {
  if (_cache) return _cache;
  _cache = { ...DEFAULTS, ...loadJsonFile(configPath, {}) };
  return _cache;
}
