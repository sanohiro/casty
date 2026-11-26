#!/usr/bin/env node
// casty - TTY web browser using raw CDP and Kitty graphics protocol

// Handle stdout/stderr write errors (SSH disconnect, terminal close, etc.)
process.stdout.on('error', (err) => {
  if (err.code === 'EIO' || err.code === 'EPIPE') process.exit(0);
});
process.stderr.on('error', () => {});

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs } from '../lib/cli.js';
import { findChrome } from '../lib/chrome.js';
import { toURL } from '../lib/urlbar.js';

let options;
try { options = parseArgs(process.argv.slice(2)); }
catch (err) { console.error(`casty: ${err.message}`); process.exit(1); }

// --version / -v
if (options.version) {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  console.log(`casty ${pkg.version}`);
  process.exit(0);
}

// --help / -h
if (options.help) {
  console.log(`casty - A real Chrome browser in your terminal

Usage: casty [url] [options]

Options:
  --help, -h       Show this help
  --version, -v    Show version
  --headless-shell PATH  Use an external headless shell (overrides config)

Key bindings:
  Alt+L            Address bar
  Alt+F            Hint mode (Vimium-style link navigation)
  Alt+C            Copy selected text
  Ctrl+V           Paste from clipboard
  Alt+Left/Right   Back / Forward
  Alt+Home         Home page
  Ctrl+T / Ctrl+W  Open / close tab
  Alt+Up/Down      Previous / next tab
  Ctrl+Q           Quit

Address bar:
  Type a URL or search query, then Enter
  /b [query]       Search bookmarks

Config: ~/.casty/config.json
Keys:   ~/.casty/keys.json

https://github.com/sanohiro/casty`);
  process.exit(0);
}

const config = loadConfig();
const headlessShellPath = options.headlessShellPath ?? config.headlessShellPath;
try {
  if (headlessShellPath !== '') findChrome(headlessShellPath);
} catch (err) { console.error(`casty: ${err.message}`); process.exit(1); }

// Explicit external shells do not need the managed installer or updater.
if (!headlessShellPath && !process.env.CASTY_ENSURE_CHROME) {
  const __bin = dirname(fileURLToPath(import.meta.url));
  try {
    execFileSync('bash', [join(__bin, 'casty')], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, CASTY_ENSURE_CHROME: '1' },
    });
  } catch (err) {
    console.error(`casty: headless shell installation failed: ${err.message}`);
    process.exit(err.status || 1);
  }
}

import { startBrowser, setupPage, startScreencast, stopScreencast } from '../lib/browser.js';
import { CDPClient } from '../lib/cdp.js';
import { sendFrame, resetFrameCache, clearScreen, hideCursor, showCursor, cleanup as cleanupTmp, transport, selectCaptureFormat, setDisplaySize, disableDedup } from '../lib/kitty.js';
import { enableMouse, disableMouse, mouseMode, mouseFormat, startInputHandling } from '../lib/input.js';
import { loadKeyBindings } from '../lib/keys.js';
import { loadConfig } from '../lib/config.js';
import { startMedia } from '../lib/media.js';
import { mouseTraceFile, traceMouse } from '../lib/trace.js';

const bindings = loadKeyBindings();
const url = toURL(options.url || config.homeUrl) || config.homeUrl;

const TERM_QUERY_TIMEOUT = 1000;
const TERM_PIXEL_FALLBACK_DELAY = 100;

// Delayed capture timings after page navigation (ms)
const DELAYED_CAPTURE_MS = [0, 300, 1000];
const TOOLBAR_ROWS = 2;

// Reference cell size (96 DPI, standard terminal font)
// Larger cells → zoom in, smaller cells → zoom out
const REF_CELL_WIDTH = 8;

// Auto-calculate zoom from cell size
function calcZoom(cellWidth) {
  return cellWidth / REF_CELL_WIDTH;
}

// Query exact cell size via CSI 16t, with CSI 14t as a fallback.
// keepAlive: true when called during operation (SIGWINCH) — don't touch stdin state
function queryTermSize({ keepAlive = false } = {}) {
  if (!process.stdin.isTTY) return Promise.resolve(null);

  let resolve;
  const promise = new Promise(r => { resolve = r; });
  const wasRaw = process.stdin.isRaw;
  let fallbackTimer;
  let windowSize = null;
  function finish(size) {
    clearTimeout(timeout);
    clearTimeout(fallbackTimer);
    process.stdin.removeListener('data', onData);
    if (!keepAlive) {
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    }
    resolve(size);
  }
  const timeout = setTimeout(() => finish(windowSize), TERM_QUERY_TIMEOUT);

  if (!keepAlive) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }

  let buf = '';
  const onData = (data) => {
    buf += data.toString();
    const cell = buf.match(/\x1b\[6;(\d+);(\d+)t/);
    if (cell && +cell[1] > 0 && +cell[2] > 0) {
      finish({ cellHeight: +cell[1], cellWidth: +cell[2] });
      return;
    }
    const window = buf.match(/\x1b\[4;(\d+);(\d+)t/);
    if (window && +window[1] > 0 && +window[2] > 0 && !windowSize) {
      windowSize = { height: +window[1], width: +window[2] };
      fallbackTimer = setTimeout(() => finish(windowSize), TERM_PIXEL_FALLBACK_DELAY);
    }
  };
  process.stdin.on('data', onData);

  process.stdout.write('\x1b[16t\x1b[14t');
  return promise;
}

// Get terminal info
// keepAlive: true during operation (SIGWINCH) to avoid killing stdin
async function getTermInfo({ keepAlive = false } = {}) {
  const reportedSize = await queryTermSize({ keepAlive });
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  if (reportedSize) {
    // The window can contain padding; only CSI 16t reports the true cell size.
    const cellWidth = reportedSize.cellWidth || Math.floor(reportedSize.width / cols);
    const cellHeight = reportedSize.cellHeight || Math.floor(reportedSize.height / rows);
    const width = cellWidth * cols;
    const height = cellHeight * rows;
    const zoom = calcZoom(cellWidth);
    const sizeSource = reportedSize.cellWidth ? 'cell' : 'window';
    return { cols, rows, width, height, cellWidth, cellHeight, zoom, sizeSource };
  }

  const cellWidth = parseInt(process.env.CASTY_CELL_WIDTH) || 10;
  const cellHeight = parseInt(process.env.CASTY_CELL_HEIGHT) || 20;
  const zoom = calcZoom(cellWidth);
  return {
    cols, rows,
    width: cols * cellWidth,
    height: rows * cellHeight,
    cellWidth, cellHeight, zoom, sizeSource: 'fallback',
  };
}

async function main() {
  // Phase 1: Read the initial zoom before launching Chrome; media starts in parallel.
  // getTermInfo() must complete fully before input handling starts.
  const mediaP = config.media ? startMedia(config) : null;
  const term = await getTermInfo();
  const browser = await startBrowser(term.zoom, headlessShellPath);
  const media = mediaP ? await mediaP : null;

  // Reserve one row each for tabs and navigation.
  let currentTerm = term;
  const pageRows = t => Math.max(1, t.rows - TOOLBAR_ROWS);
  setDisplaySize(term.cols, pageRows(term), TOOLBAR_ROWS);

  // Phase 2: CDP connection + page setup
  const preparePage = (t, targetId) => setupPage(browser, {
    ...t, height: pageRows(t) * t.cellHeight, nativeScale: term.zoom, targetId,
    mediaPort: media?.port || 0, mediaToken: media?.token || '',
  });
  const first = await preparePage(term);
  const { cssWidth, cssHeight } = first;
  let client = first.client;
  let activeId = first.targetId;
  const tabs = new Map([[activeId, { id: activeId, client, url: 'about:blank' }]]);
  const navigation = new EventEmitter();
  const browserClient = new CDPClient();
  browserClient.on('error', err => console.error('casty: browser CDP error:', err.message));
  await browserClient.connect(browser.wsUrl);

  let renderPaused = false;
  const pauseRender = (p = true) => {
    renderPaused = p;
    if (p) resetFrameCache();
  };

  // input.js converts terminal device pixels to viewport CSS pixels.
  const cssCellW = term.cellWidth;
  const cssCellH = term.cellHeight;
  // Standard Kitty output uses PNG; bcon also supports adaptive JPEG files.
  const screenshotFormat = selectCaptureFormat(config.format);

  console.error(`casty: ${term.width}x${term.height} cell=${term.cellWidth.toFixed(0)}x${term.cellHeight.toFixed(0)} size=${term.sizeSource} zoom=${term.zoom.toFixed(2)} mouse=${mouseFormat} tracking=${mouseMode} transport=${transport} format=${screenshotFormat}${screenshotFormat === 'jpeg' ? ' (adaptive)' : ''}`);
  if (mouseTraceFile) console.error(`casty: mouse trace ${mouseTraceFile}`);
  traceMouse('mouse-geometry', { cellWidth: term.cellWidth, cellHeight: term.cellHeight, zoom: term.zoom });
  traceMouse('viewport', { width: cssWidth, height: cssHeight, zoom: term.zoom, cols: term.cols, rows: term.rows, sizeSource: term.sizeSource });

  hideCursor();
  clearScreen();
  enableMouse();

  // Frame callback for screencast / captureScreenshot
  // sendFrame includes cursor positioning (single write)
  let urlBar = null;
  function onFrame(data) {
    if (renderPaused) { traceMouse('frame-paused'); return; }
    sendFrame(data);
    if (urlBar) urlBar.renderIfDirty();
  }

  // Phase 3: Start screencast
  let { forceCapture, cleanup: screencastCleanup } = await startScreencast(client, {
    width: cssWidth,
    height: cssHeight,
    format: screenshotFormat,
    onFrame,
  });

  // Force capture on page load events (debounced — multiple events fire close together)
  let delayedTimers = [];
  function delayedCapture() {
    for (const t of delayedTimers) clearTimeout(t);
    delayedTimers = [];
    for (const ms of DELAYED_CAPTURE_MS) {
      if (ms === 0) forceCapture();
      else delayedTimers.push(setTimeout(() => forceCapture(), ms));
    }
  }
  let shuttingDown = false;
  let viewTransition = Promise.resolve();
  function changeView(work) {
    viewTransition = viewTransition.then(() => {
      if (!shuttingDown) return work();
    }).catch(err => console.error('casty: view error:', err.message));
    return viewTransition;
  }

  function publishTabs() {
    navigation.emit('tabsChanged', [...tabs.values()], activeId);
  }

  async function readTabTitle(tab) {
    const url = tab.url;
    try {
      const { result } = await tab.client.send('Runtime.evaluate', {
        expression: 'document.title', returnByValue: true,
      }, 1500);
      if (tabs.has(tab.id) && tab.url === url && result.value && tab.title !== result.value) {
        tab.title = result.value;
        publishTabs();
      }
    } catch {}
  }

  function watchPage(tab) {
    tab.client.on('error', err => console.error('casty: page CDP error:', err.message));
    tab.client.on('Page.loadEventFired', () => void readTabTitle(tab));
    for (const event of ['Page.domContentEventFired', 'Page.loadEventFired', 'Page.frameNavigated',
      'Page.navigatedWithinDocument', 'Browser.downloadWillBegin', 'Browser.downloadProgress']) {
      tab.client.on(event, data => {
        if (tab.id === activeId) navigation.emit(event, data);
      });
    }
  }

  async function selectTab(id) {
    const tab = tabs.get(id);
    if (!tab || id === activeId) return;
    const t = currentTerm;
    const width = Math.round(t.width / t.zoom);
    const height = Math.round(pageRows(t) * t.cellHeight / t.zoom);
    if (!tab.client) {
      const prepared = await preparePage(t, id);
      if (!tabs.has(id) || shuttingDown) { prepared.client.close(); return; }
      tab.client = prepared.client;
      watchPage(tab);
    } else {
      await tab.client.setViewport({ width, height, zoom: t.zoom, nativeScale: term.zoom });
    }
    await browserClient.send('Target.activateTarget', { targetId: id });
    if (!tabs.has(id) || shuttingDown) return;
    for (const timer of delayedTimers) clearTimeout(timer);
    delayedTimers = [];
    const previous = tabs.get(activeId);
    client = tab.client;
    activeId = id;
    if (previous) await stopScreencast(previous.client, screencastCleanup);
    else screencastCleanup();
    if (!tabs.has(id) || shuttingDown) return;
    clearScreen();
    const info = await client.send('Page.getFrameTree', {}, 1500).catch(() => null);
    navigation.emit('tabSelected', info?.frameTree?.frame || { id, url: tab.url || 'about:blank' });
    publishTabs();
    ({ forceCapture, cleanup: screencastCleanup } = await startScreencast(client, {
      width, height, format: screenshotFormat, onFrame,
    }));
    forceCapture();
    void readTabTitle(tab);
  }

  const select = id => changeView(() => selectTab(id));
  const tabActions = {
    client: () => client,
    select,
    cycle: delta => changeView(() => {
      const ids = [...tabs.keys()];
      const index = ids.indexOf(activeId);
      return selectTab(ids[(index + delta + ids.length) % ids.length]);
    }),
    open: () => changeView(async () => {
      const { targetId } = await browserClient.send('Target.createTarget', { url: 'about:blank' });
      tabs.set(targetId, { id: targetId, url: 'about:blank' });
      await selectTab(targetId);
      if (activeId === targetId) {
        const homeUrl = toURL(config.homeUrl) || config.homeUrl;
        await client.send('Page.navigate', { url: homeUrl });
      }
    }),
    close: () => changeView(async () => {
      if (tabs.size === 1) return shutdown();
      const previous = activeId;
      const ids = [...tabs.keys()];
      const index = ids.indexOf(previous);
      await selectTab(ids[index + 1] || ids[index - 1]);
      if (tabs.has(previous)) await browserClient.send('Target.closeTarget', { targetId: previous });
    }),
  };

  urlBar = startInputHandling(navigation, cssCellW, cssCellH, term.zoom, bindings, pauseRender, () => forceCapture(), tabActions);
  watchPage(tabs.get(activeId));
  publishTabs();
  navigation.on('Page.domContentEventFired', delayedCapture);
  navigation.on('Page.loadEventFired', delayedCapture);
  navigation.on('Page.frameNavigated', ({ frame }) => {
    if (!frame.parentId) delayedCapture();
  });
  navigation.on('Page.navigatedWithinDocument', delayedCapture);

  browserClient.on('Target.targetCreated', ({ targetInfo }) => {
    const { targetId: id, title, url, openerId } = targetInfo;
    if (!tabs.has(openerId) || tabs.has(id)) return;
    tabs.set(id, { id, title, url });
    publishTabs();
    void select(id);
  });
  browserClient.on('Target.targetInfoChanged', ({ targetInfo }) => {
    const { targetId: id, title, url } = targetInfo;
    const tab = tabs.get(id);
    if (!tab) return;
    const nextTitle = url === tab.url && title === url ? tab.title : title;
    if (tab.title === nextTitle && tab.url === url) return;
    Object.assign(tab, { title: nextTitle, url });
    publishTabs();
  });
  browserClient.on('Target.targetDestroyed', ({ targetId }) => {
    const tab = tabs.get(targetId);
    if (!tab) return;
    tabs.delete(targetId);
    tab.client?.close();
    if (shuttingDown) return;
    publishTabs();
    if (targetId === activeId) {
      if (tabs.size) void select(tabs.keys().next().value);
      else void shutdown();
    }
  });
  await browserClient.send('Target.setDiscoverTargets', { discover: true, filter: [{ type: 'page' }] });

  // Fast local pages can finish loading before capture and input listeners exist.
  client.send('Page.navigate', { url }).catch(e => console.error('casty: navigate error:', e.message));

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error('casty: shutting down...');
    renderPaused = true;           // Stop rendering first
    for (const timer of delayedTimers) clearTimeout(timer);
    try {
      await stopScreencast(client, screencastCleanup);  // Stop screencast (disables pending captures)
      await browserClient.send('Browser.close').catch(() => {});
    } catch {}
    for (const tab of tabs.values()) tab.client?.close();
    browserClient.close();
    browser.proc.kill();
    await media?.cleanup();
    disableMouse();
    showCursor();
    try { process.stdin.setRawMode(false); } catch {}
    clearScreen();                 // Clear after everything is stopped — no re-render risk
    cleanupTmp();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);

  // SIGWINCH: Follow resize + font size changes
  // Debounce bursts and serialize resizing with tab changes.
  let resizeTimer = null;
  process.on('SIGWINCH', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => changeView(handleResize), 150);
  });
  // Direct screenshot — bypasses screencast's capturing flag
  const screenshotOpts = { format: screenshotFormat, optimizeForSpeed: true, captureBeyondViewport: false };
  if (screenshotFormat === 'jpeg') screenshotOpts.quality = 85;
  async function directCapture() {
    try {
      const { data } = await client.send('Page.captureScreenshot', screenshotOpts);
      if (data) onFrame(data);
    } catch {}
  }

  async function handleResize() {
    try {
      // Stop old screencast FIRST to prevent stale frames
      await stopScreencast(client, screencastCleanup);

      const t = await getTermInfo({ keepAlive: true });
      currentTerm = t;
      const vh = pageRows(t) * t.cellHeight;
      const cw = Math.round(t.width / t.zoom);
      const ch = Math.round(vh / t.zoom);
      setDisplaySize(t.cols, pageRows(t), TOOLBAR_ROWS);
      console.error(`casty: resize ${cw}x${ch} (dev:${t.width}x${vh}) cell:${t.cellWidth}x${t.cellHeight} size:${t.sizeSource} zoom:${t.zoom.toFixed(2)}`);

      clearScreen();
      resetFrameCache();
      disableDedup(3000); // Force re-send for 3s (bcon may not display first frame)

      const metricsUpdate = client.setViewport({ width: cw, height: ch, zoom: t.zoom, nativeScale: term.zoom });
      // Input after this point must use the new geometry and queue behind the metrics update.
      urlBar.updateCellSize(t.cellWidth, t.cellHeight, t.zoom);
      await metricsUpdate;
      traceMouse('viewport', { width: cw, height: ch, zoom: t.zoom, cols: t.cols, rows: t.rows, sizeSource: t.sizeSource });

      // Wait for Chrome to finish re-rendering by watching for a screencast frame
      await new Promise(resolve => {
        const onFirstFrame = ({ sessionId }) => {
          client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
          client.removeListener('Page.screencastFrame', onFirstFrame);
          resolve();
        };
        client.on('Page.screencastFrame', onFirstFrame);
        client.send('Page.startScreencast', {
          format: 'jpeg', quality: 10,
          maxWidth: Math.round(cw / 4), maxHeight: Math.round(ch / 4),
          everyNthFrame: 1,
        }).catch(() => resolve());
        setTimeout(() => {
          client.removeListener('Page.screencastFrame', onFirstFrame);
          resolve();
        }, 2000);
      });
      await client.send('Page.stopScreencast').catch(() => {});

      // Capture hi-res frame (Chrome has finished rendering)
      await directCapture();
      urlBar.render();

      // Restart screencast for ongoing change detection
      ({ forceCapture, cleanup: screencastCleanup } = await startScreencast(client, {
        width: cw,
        height: ch,
        format: screenshotFormat,
        onFrame,
      }));
    } catch (err) {
      console.error('casty: resize error:', err.message);
    }
  }
}

try {
  await main();
} catch (err) {
  // Restore stdin from raw mode (prevent CSI 14t response leak)
  try { process.stdin.setRawMode(false); process.stdin.pause(); } catch {}
  console.error('casty: error:', err.message);
  disableMouse();
  showCursor();
  cleanupTmp();
  process.exit(1);
}
