// Chrome process launch and binary detection

import { spawn } from 'node:child_process';
import { readdirSync, existsSync, rmSync, statSync, accessSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const BROWSERS_DIR = join(homedir(), '.casty', 'browsers');
const IS_ARM_LINUX = process.platform === 'linux' && process.arch === 'arm64';

// Recursively search for headless shell binary in a Playwright-style directory
// Binary name varies by version: chrome-headless-shell or headless_shell
const HEADLESS_BINS = ['chrome-headless-shell', 'headless_shell'];
function findBinInDir(base) {
  try {
    for (const name of HEADLESS_BINS) {
      // Check directly under base
      const direct = join(base, name);
      if (existsSync(direct) && statSync(direct).isFile()) return direct;
    }
    // Search subdirectories
    for (const sub of readdirSync(base)) {
      for (const name of HEADLESS_BINS) {
        const bin = join(base, sub, name);
        if (existsSync(bin) && statSync(bin).isFile()) return bin;
      }
    }
  } catch {}
  return null;
}

// Use an explicitly selected headless shell or a casty-managed download.
export function findChrome(headlessShellPath = '') {
  if (typeof headlessShellPath !== 'string') throw new Error('headlessShellPath must be a string');
  if (headlessShellPath) {
    const bin = resolve(headlessShellPath.startsWith('~/')
      ? join(homedir(), headlessShellPath.slice(2)) : headlessShellPath);
    try {
      if (!statSync(bin).isFile()) throw new Error('Not a file');
      accessSync(bin, constants.X_OK);
    } catch {
      throw new Error(`Headless shell is not executable: ${bin}`);
    }
    return { bin, headless: false };
  }
  if (existsSync(BROWSERS_DIR)) {
    const entries = readdirSync(BROWSERS_DIR).sort().reverse();

    // 1. Chrome for Testing headless-shell (x86_64 only, skip ARM64 Linux)
    if (!IS_ARM_LINUX) {
      for (const dir of entries) {
        if (!dir.startsWith('chrome-headless-shell-')) continue;
        const bin = join(BROWSERS_DIR, dir, 'chrome-headless-shell');
        if (existsSync(bin)) return { bin, headless: false };
      }
    }

    // 2. Playwright format (all platforms)
    for (const dir of entries) {
      if (!dir.startsWith('chromium_headless_shell-')) continue;
      const bin = findBinInDir(join(BROWSERS_DIR, dir));
      if (bin) return { bin, headless: false };
    }
  }

  return null;
}

// Prevent profile bloat (delete caches/DBs except cookies/localStorage)
// Chrome processes these on startup, so accumulation slows launch dramatically
function cleanProfile(userDataDir) {
  const def = join(userDataDir, 'Default');
  if (!existsSync(def)) return;
  const KEEP = new Set([
    'Cookies', 'Cookies-journal',
    'Local Storage',
    'Preferences', 'Secure Preferences',
  ]);
  try {
    for (const entry of readdirSync(def)) {
      if (KEEP.has(entry)) continue;
      rmSync(join(def, entry), { recursive: true, force: true });
    }
  } catch {}
}

// Launch Chrome, return DevTools WebSocket URL
export function launchChrome({ userDataDir, windowSize, args = [], headlessShellPath = '' } = {}) {
  const chrome = findChrome(headlessShellPath);
  if (!chrome) throw new Error('Headless shell not found. Run casty to install it, or specify --headless-shell /path/to/chromium-headless-shell.');
  cleanProfile(userDataDir);

  const chromeArgs = [
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--auto-grant-permissions',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    // Media playback (autoplay without user gesture in headless)
    '--autoplay-policy=no-user-gesture-required',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
    // Reduce startup overhead
    '--disable-breakpad',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    `--user-data-dir=${userDataDir}`,
  ];
  // Linux often lacks sandbox support (VMs, containers, etc.)
  if (process.platform === 'linux') {
    chromeArgs.push('--no-sandbox', '--disable-dev-shm-usage');
  }
  if (windowSize) {
    chromeArgs.push(`--window-size=${windowSize.width},${windowSize.height}`);
  }
  chromeArgs.push(...args);

  const proc = spawn(chrome.bin, chromeArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Extract DevTools URL from stderr
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  let stderr = '';
  const timeout = setTimeout(() => reject(new Error('Chrome startup timeout')), 15000);

  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) {
      clearTimeout(timeout);
      const wsUrl = m[1];
      const portMatch = wsUrl.match(/:(\d+)\//);
      const port = portMatch ? parseInt(portMatch[1]) : 0;
      resolve({ proc, wsUrl, port });
    }
  });

  proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
  proc.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Chrome exited with code ${code}\n${stderr}`)); });

  return promise;
}
