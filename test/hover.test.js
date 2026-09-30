// Use the managed shell, or override with CASTY_TEST_HEADLESS_SHELL=/path/to/shell.
// CDP uses a pipe so this test does not need a listening network socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { CDPClient } from '../lib/cdp.js';
import { findChrome } from '../lib/chrome.js';
import { startScreencast, stopScreencast } from '../lib/browser.js';
import { enableMouse, startInputHandling } from '../lib/input.js';
import { sendFrame, setDisplaySize, clearScreen, resetFrameCache, cleanup as cleanupFrames } from '../lib/kitty.js';

function pngPixels(base64) {
  const png = Buffer.from(base64, 'base64');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(png[24], 8);
  const channels = png[25] === 2 ? 3 : png[25] === 6 ? 4 : 0;
  assert.ok(channels, `Unsupported PNG color type: ${png[25]}`);
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= channels ? pixels[at - channels] : 0;
      const up = y ? pixels[at - stride] : 0;
      const corner = y && x >= channels ? pixels[at - stride - channels] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      else if (filter === 2) prediction = up;
      else if (filter === 3) prediction = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - corner;
        const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
        prediction = a <= b && a <= c ? left : b <= c ? up : corner;
      } else assert.equal(filter, 0);
      pixels[at] = raw[y * (stride + 1) + 1 + x] + prediction;
    }
  }
  return {
    width, height,
    color(x, y) {
      const at = (Math.floor(y) * width + Math.floor(x)) * channels;
      return [...pixels.subarray(at, at + 3)];
    },
  };
}

async function runHoverTrial() {
  const pixelMouse = process.env.CASTY_TEST_MOUSE_FORMAT === 'pixels';
  const nativeScale = 2.375;
  const profile = await mkdtemp(join(tmpdir(), 'casty-hover-test-'));
  const browser = spawn(process.env.CASTY_TEST_HEADLESS_SHELL, [
    '--no-sandbox', '--single-process', '--remote-debugging-pipe', '--disable-gpu',
    `--force-device-scale-factor=${nativeScale}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const client = new CDPClient();
  let sessionId;
  let dropScreencastFrames = false;
  let inspectSizes = false;
  let castSizes = [];
  let pipeBuffer = '';
  client._ws = {
    send(packet) {
      const message = JSON.parse(packet);
      if (sessionId && !/^(Target|Browser)\./.test(message.method)) message.sessionId = sessionId;
      browser.stdio[3].write(JSON.stringify(message) + '\0');
    },
    close() {},
  };
  browser.stdio[3].on('error', () => {});
  browser.stdio[4].setEncoding('utf8');
  browser.stdio[4].on('data', data => {
    pipeBuffer += data;
    let end;
    while ((end = pipeBuffer.indexOf('\0')) >= 0) {
      const packet = pipeBuffer.slice(0, end);
      pipeBuffer = pipeBuffer.slice(end + 1);
      if (!packet) continue;
      const message = JSON.parse(packet);
      if (message.id !== undefined) {
        const pending = client._pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        client._pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result || {});
      } else if (message.sessionId === sessionId) {
        if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) client._interruptCaptures();
        if (inspectSizes && message.method === 'Page.screencastFrame') {
          castSizes.push([message.params.metadata.deviceWidth, message.params.metadata.deviceHeight]);
        }
        if (dropScreencastFrames && message.method === 'Page.screencastFrame') {
          void client.send('Page.screencastFrameAck', { sessionId: message.params.sessionId });
        } else client.emit(message.method, message.params || {});
      }
    }
  });

  let capture;
  const frames = [];
  let imageData = '';
  let geometry;
  let tracking = 0;
  process.stdout.write = value => {
    for (const mode of String(value).matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
      for (const parameter of mode[1].split(';').map(Number)) {
        if (![1000, 1002, 1003].includes(parameter)) continue;
        if (mode[2] === 'h') tracking = parameter;
        else if (tracking === parameter) tracking = 0;
      }
    }
    for (const match of String(value).matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)) {
      if (match[1].includes('a=T')) {
        imageData = match[1].includes('t=f')
          ? readFileSync(Buffer.from(match[2], 'base64').toString()).toString('base64')
          : match[2];
      }
      else if (/\bm=/.test(match[1])) imageData += match[2];
      else continue;
      if (/\bm=1\b/.test(match[1])) continue;
      const png = pngPixels(imageData);
      assert.equal(png.width, Math.round(geometry.width * geometry.zoom));
      assert.equal(png.height, Math.round(geometry.height * geometry.zoom));
      frames.push({
        a: png.color(200 * geometry.zoom, 150 * geometry.zoom).join(','),
        b: png.color(200 * geometry.zoom, 250 * geometry.zoom).join(','),
        rows: Array.from({ length: 7 }, (_, i) => png.color(390 * geometry.zoom, (116 + i * 32) * geometry.zoom).join(',')),
      });
    }
    return true;
  };
  process.stdin.setRawMode = () => {};
  const waitFor = async (condition, label) => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await delay(10);
    }
    assert.ok(await condition(), label);
  };
  const evaluate = async expression => {
    const { result, exceptionDetails } = await client.send('Runtime.evaluate', { expression, returnByValue: true });
    assert.equal(exceptionDetails, undefined);
    return result.value;
  };
  const pointer = (button, x, y, release = false, split = false) => {
    const col = pixelMouse ? Math.round(x * geometry.zoom) : Math.round(x * geometry.zoom / geometry.cellWidth + 0.5);
    const row = pixelMouse ? Math.round(y * geometry.zoom + geometry.cellHeight) : Math.round(y * geometry.zoom / geometry.cellHeight + 1.5);
    const report = `\x1b[<${button};${col};${row}${release ? 'm' : 'M'}`;
    if (split) {
      process.stdin.emit('data', Buffer.from(report.slice(0, -3)));
      process.stdin.emit('data', Buffer.from(report.slice(-3)));
    } else process.stdin.emit('data', Buffer.from(report));
  };
  let motionCode = 35;
  const move = (x, y, split = false) => {
    if (tracking === 1003) pointer(motionCode, x, y, false, split);
  };

  try {
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true }));
    await client.send('Page.enable');
    await client.send('Target.activateTarget', { targetId });
    const loaded = new Promise(resolve => client.once('Page.loadEventFired', resolve));
    const rowsHtml = Array.from({ length: 7 }, (_, i) => `<div class=row id=row-${i + 1}></div>`).join('');
    const html = '<style>body{margin:0}#a,#b{position:absolute;left:190px;width:20px;height:20px;background:red}#a{top:140px}#b{top:240px}#a:hover,#b:hover{background:lime}#text{position:absolute;left:50px;top:270px;font:20px monospace}#rows{position:absolute;left:340px;top:100px;width:100px}.row{height:32px;background:red}.row:hover{background:lime}</style><div id=a></div><div id=b></div><span id=text>drag selection works</span><div id=rows>' + rowsHtml + '</div><script>window.clicks=[];window.moves=[];window.releases=0;window.wheels=[];document.addEventListener("wheel",e=>wheels.push([e.clientX,e.clientY,e.isTrusted]));document.addEventListener("mouseup",()=>releases++);document.addEventListener("click",e=>clicks.push([e.clientX,e.clientY,e.target.id,e.isTrusted]));document.addEventListener("mousemove",e=>moves.push([e.clientX,e.clientY,e.target.id,e.isTrusted]));</script>';
    await client.send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(html) });
    await loaded;
    enableMouse();
    let bar;
    for (const [cellWidth, cellHeight, zoom, cols, rows] of [
      [19, 42, 2.375, 94, 42], [26, 58, 3.25, 69, 30],
      [12, 24, 1.5, 150, 73], [8, 16, 1, 225, 110],
      [6, 12, 0.75, 300, 147], [19, 42, 2.375, 94, 42],
    ]) {
      inspectSizes = false;
      castSizes = [];
      if (capture) await stopScreencast(client, capture.cleanup);
      geometry = { width: cols * 8, height: Math.round((rows - 1) * cellHeight / zoom), cellWidth, cellHeight, zoom };
      setDisplaySize(cols, rows - 1);
      clearScreen();
      resetFrameCache();
      const metrics = client.setViewport({ width: geometry.width, height: geometry.height, zoom, nativeScale });
      bar?.updateCellSize(cellWidth, cellHeight, zoom);
      await metrics;
      capture = await startScreencast(client, { width: geometry.width, height: geometry.height, onFrame: sendFrame });
      if (!bar) bar = startInputHandling(client, cellWidth, cellHeight, zoom, {}, () => {}, () => capture.forceCapture());
      for (const muted of [false, true]) {
        dropScreencastFrames = muted;
        // The native Ghostty trace reported motion code 34 without a press.
        motionCode = muted ? 34 : 35;
        move(300, 150);
        await waitFor(() => frames.at(-1)?.a === '255,0,0' && frames.at(-1)?.b === '255,0,0', 'pointer leaving must remove hover');
        const before = frames.length;
        move(200, 150, true);
        await waitFor(() => frames.length > before && frames.at(-1)?.a === '0,255,0', `stationary hover must be transmitted without a click at zoom ${zoom}, muted=${muted}`);
        await delay(150);
        assert.equal(frames.at(-1).a, '0,255,0');
        inspectSizes = true;
        move(200, 250);
        await waitFor(() => frames.at(-1)?.a === '255,0,0' && frames.at(-1)?.b === '0,255,0', `hover must move to the lower target at zoom ${zoom}`);
        const lastMove = await evaluate('moves.at(-1)');
        assert.deepEqual(lastMove.slice(2), ['b', true]);
        assert.ok(Math.abs(lastMove[0] - 200) <= 8 && Math.abs(lastMove[1] - 250) <= 10);
      }
      dropScreencastFrames = false;
      for (const row of [2, 5]) {
        move(390, 116 + (row - 1) * 32);
        const expected = Array.from({ length: 7 }, (_, i) => i === row - 1 ? '0,255,0' : '255,0,0');
        await waitFor(() => frames.at(-1)?.rows.join(';') === expected.join(';'), `hover must reach row ${row}`);
        for (let i = 0; i < 5; i++) {
          await capture.forceCapture();
          await delay(20);
          assert.equal(await evaluate(`getComputedStyle(document.getElementById('row-${row}')).backgroundColor`), 'rgb(0, 255, 0)', 'stationary hover must survive repeated captures');
          assert.deepEqual(frames.at(-1).rows, expected, `stationary row ${row} must not alternate with another row`);
        }
      }
      assert.ok(castSizes.length > 0, 'capture must produce compositor metadata');
      const scale = zoom / nativeScale;
      const viewWidth = Math.floor(geometry.width * scale), viewHeight = Math.floor(geometry.height * scale);
      assert.ok(castSizes.every(([w, h]) => Math.abs(w - viewWidth) < 1 && Math.abs(h - viewHeight) < 1),
        `screenshots must not resize the compositor at zoom ${zoom}: ${JSON.stringify([...new Set(castSizes.map(s => s.join(',')))])}`);
      inspectSizes = false;
      assert.deepEqual(await evaluate('clicks'), []);
      const previousReleases = await evaluate('releases');
      pointer(0, 200, 150);
      pointer(0, 200, 150, true);
      await waitFor(async () => (await evaluate('clicks.length')) === 1, 'click must reach the page');
      const click = await evaluate('clicks[0]');
      assert.deepEqual(click.slice(2), ['a', true]);
      assert.ok(Math.abs(click[0] - 200) <= 8 && Math.abs(click[1] - 150) <= 10);
      pointer(0, 55, 280);
      pointer(32, 175, 280);
      pointer(0, 175, 280, true);
      await waitFor(async () => (await evaluate('releases')) === previousReleases + 2, 'drag release must reach the page');
      assert.ok((await evaluate('getSelection().toString()')).length > 0, `drag must select text at zoom ${zoom}`);
      await evaluate('getSelection().removeAllRanges();clicks=[]');
      await evaluate('document.body.style.height="3000px";wheels=[];scrollTo(0,0)');
      pointer(65, 400, 400);
      await waitFor(async () => (await evaluate('wheels.length')) > 0, 'wheel must reach the page');
      const wheel = await evaluate('wheels[0]');
      assert.equal(wheel[2], true);
      assert.ok(Math.abs(wheel[0] - 400) <= 8 && Math.abs(wheel[1] - 400) <= 10, 'wheel hit point must use the resized geometry');
      await waitFor(async () => Math.abs((await evaluate('scrollY')) - 100) < 2, `wheel must scroll 100 CSS pixels at zoom ${zoom}`);
      await capture.forceCapture();
      assert.ok(Math.abs((await evaluate('scrollY')) - 100) < 2, 'capture must preserve scroll position');
      pointer(64, 400, 400);
      await waitFor(async () => (await evaluate('wheels.length')) === 2 && (await evaluate('scrollY')) < 2, 'wheel up must return to the original position');
      // Fractional compositor scales must not move a resting scrolled viewport.
      await evaluate('scrollTo(0,1234.5)');
      await delay(200);
      const restingScroll = await evaluate('scrollY');
      for (let repeat = 0; repeat < 8; repeat++) {
        await capture.forceCapture();
        await delay(30);
        assert.ok(Math.abs((await evaluate('scrollY')) - restingScroll) < 0.1, `capture moved resting scroll at zoom ${zoom}`);
      }
      await evaluate('document.body.style.height="";scrollTo(0,0)');
      await capture.forceCapture();
      process.stderr.write(`pointer passed: zoom=${zoom}, hover without clicks, click target, drag selection, wheel scrolling\n`);
    }
    dropScreencastFrames = true;
    move(300, 150);
    await waitFor(() => frames.at(-1)?.a === '255,0,0' && frames.at(-1)?.b === '255,0,0', 'reset hover before continuous motion');
    for (let i = 0; i < 20; i++) {
      move(195 + i % 10, 150);
      await delay(20);
      if (i === 10) assert.equal(frames.at(-1)?.a, '0,255,0', 'hover must be visible while motion continues');
    }
    await delay(150);
    assert.equal(frames.at(-1)?.a, '0,255,0');
    move(300, 150);
    await waitFor(() => frames.at(-1)?.a === '255,0,0', 'clear hover before delayed painting');
    await evaluate("document.head.insertAdjacentHTML('beforeend', '<style>#a{transition:background-color 120ms step-end}</style>')");
    move(200, 150);
    await waitFor(() => frames.at(-1)?.a === '0,255,0', 'delayed hover painting must reach the terminal without a click');
    assert.deepEqual(await evaluate('clicks'), []);
    process.stderr.write(`hover passed: format=${pixelMouse ? 'pixels' : 'cells'}, continuous motion, resting pointer, delayed painting, zero clicks\n`);
  } finally {
    if (capture) await stopScreencast(client, capture.cleanup);
    await client.send('Browser.close').catch(() => {});
    client.close();
    const exited = browser.exitCode === null ? new Promise(resolve => browser.once('exit', resolve)) : Promise.resolve();
    browser.kill();
    await exited;
    cleanupFrames();
    await rm(profile, { recursive: true, force: true });
  }
}

if (process.argv.includes('--run-pipe')) {
  try { await runHoverTrial(); process.exit(0); }
  catch (error) { process.stderr.write(error.stack + '\n'); process.exit(1); }
} else {
  const headlessShellPath = process.env.CASTY_TEST_HEADLESS_SHELL || findChrome()?.bin;
  for (const mouseFormat of ['pixels', 'cells']) {
    test(`real headless ${mouseFormat} hover reaches Kitty frames without clicks across font-size changes`, {
      skip: !headlessShellPath,
    }, () => {
      const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--run-pipe'], {
        timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env, TERM_PROGRAM: mouseFormat === 'pixels' ? 'ghostty' : 'kitty', TMUX: '',
          CASTY_TEST_HEADLESS_SHELL: headlessShellPath,
          CASTY_TEST_MOUSE_FORMAT: mouseFormat,
        },
      });
      assert.equal(output.length, 0);
    });
  }
}
