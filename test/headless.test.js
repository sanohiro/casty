// Run with CASTY_TEST_HEADLESS_SHELL=/path/to/chrome-headless-shell npm test.
// The browser uses a disposable profile and an HTTP server bound to loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { launchChrome } from '../lib/chrome.js';
import { setupPage, startScreencast, stopScreencast } from '../lib/browser.js';
import { dispatchClick } from '../lib/click.js';
import { HintMode } from '../lib/hints.js';

const headlessShellPath = process.env.CASTY_TEST_HEADLESS_SHELL;
test('headless browser regressions', { skip: !headlessShellPath, timeout: 60000 }, async t => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><style>body{margin:0}</style><button id="target" style="position:absolute;left:190px;top:140px;width:20px;height:20px">X</button><a id="next" href="/next" style="position:absolute;left:60px;top:200px;width:100px;height:20px">Next page</a><script>window.clicks=[];document.addEventListener("click",e=>clicks.push({x:e.clientX,y:e.clientY,id:e.target.id,trusted:e.isTrusted}));</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const profile = await mkdtemp(join(tmpdir(), 'casty-headless-test-'));
  let browser;
  let client;
  t.after(async () => {
    if (browser) {
      const exited = browser.proc.exitCode === null ? once(browser.proc, 'exit') : Promise.resolve();
      if (client) {
        await client.send('Browser.close').catch(() => {});
        client.close();
      }
      browser.proc.kill();
      await exited;
    }
    await rm(profile, { recursive: true, force: true });
  });
  browser = await launchChrome({ userDataDir: profile, headlessShellPath, args: ['--force-device-scale-factor=1.25'] });
  ({ client } = await setupPage(browser, { width: 1000, height: 750, zoom: 1.25 }));
  const evaluate = async expression => {
    const { result, exceptionDetails } = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(exceptionDetails, undefined);
    return result?.value;
  };
  const navigate = async () => {
    const loaded = once(client, 'Page.loadEventFired');
    await client.send('Page.navigate', { url });
    await loaded;
  };
  const within = async (promise, ms) => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`No updated frame within ${ms}ms`)), ms);
      })]);
    } finally { clearTimeout(timer); }
  };
  await navigate();

  await t.test('captures retain DPR resolution and clicks hit after zoom changes', async () => {
    for (const zoom of [1.25, 2, 0.75]) {
      await client.setViewport({ width: 800, height: 600, zoom, nativeScale: 1.25 });
      await evaluate('clicks=[]');
      for (let i = 0; i < 10; i++) {
        const [{ data }] = await Promise.all([
          client.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false }),
          dispatchClick(client, 200, 150),
        ]);
        const png = Buffer.from(data, 'base64');
        assert.equal(png.readUInt32BE(16), Math.round(800 * zoom));
        assert.equal(png.readUInt32BE(20), Math.round(600 * zoom));
      }
      const clicks = await evaluate('clicks');
      assert.equal(clicks.length, 10);
      assert.ok(clicks.every(c => c.id === 'target' && c.x === 200 && c.y === 150 && c.trusted), JSON.stringify(clicks));
    }
    await client.setViewport({ width: 800, height: 600, zoom: 1.25 });
  });

  await t.test('screenshot capture keeps hover on the element under the pointer', async () => {
    await navigate();
    await evaluate("document.head.insertAdjacentHTML('beforeend', '<style>#target{background:red}#target:hover{background:lime}</style>')");
    for (const zoom of [1.25, 2, 0.75]) {
      await client.setViewport({ width: 800, height: 600, zoom, nativeScale: 1.25 });
      for (let i = 0; i < 3; i++) {
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 150, button: 'none', buttons: 0 });
        assert.equal(await evaluate("getComputedStyle(document.getElementById('target')).backgroundColor"), 'rgb(0, 255, 0)');
        await client.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false });
        assert.equal(await evaluate("getComputedStyle(document.getElementById('target')).backgroundColor"), 'rgb(0, 255, 0)');
      }
    }
  });

  await t.test('scrolling past the top settles without capture feedback or stuck input', async () => {
    await navigate();
    await evaluate('document.body.style.height="3000px"');
    for (const zoom of [1.25, 2, 0.75]) {
      await client.setViewport({ width: 800, height: 601, zoom, nativeScale: 1.25 });
      let frames = [];
      const capture = await startScreencast(client, {
        width: 800, height: 601, onFrame: data => frames.push(data),
      });
      try {
        await evaluate('scrollTo(0,200)');
        for (let i = 0; i < 12; i++) {
          await within(client.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: -100,
          }), 1000);
          capture.forceCapture();
        }
        await delay(500);
        assert.equal(await evaluate('scrollY'), 0);
        frames = [];
        for (let i = 0; i < 4; i++) {
          await capture.forceCapture();
          await delay(80);
          assert.equal(await evaluate('scrollY'), 0);
        }
        assert.ok(frames.length > 0);
        assert.equal(new Set(frames).size, 1, `resting top frame must not oscillate at zoom ${zoom}`);
        const count = frames.length;
        await delay(250);
        assert.equal(frames.length, count, 'capture must settle after input stops');
        await within(dispatchClick(client, 200, 150), 1000);
        assert.equal((await evaluate('clicks.at(-1)')).id, 'target');
      } finally { await stopScreencast(client, capture.cleanup); }
    }
  });

  await t.test('hints resolve a target that moved after labels were displayed', async () => {
    await navigate();
    const hints = new HintMode();
    await hints.start(client);
    assert.equal(hints.active, true);
    await evaluate("document.getElementById('target').style.left='390px'");
    await hints.handleInput('a');
    const clicks = await evaluate('clicks');
    assert.equal(clicks.length, 1);
    assert.equal(clicks[0].id, 'target');
    assert.equal(clicks[0].x, 400);
    assert.equal(clicks[0].trusted, true);
    assert.equal(hints.active, false);
  });

  await t.test('hints click a visible line when the first line of a wrapped link is covered', async () => {
    await navigate();
    await evaluate(`document.body.innerHTML='<div style="width:170px;font:20px monospace"><a id="wrapped" href="#done">one two three four five six seven eight nine ten</a></div>';
      const r=document.getElementById('wrapped').getClientRects()[0];
      const cover=document.createElement('div');
      cover.style.cssText='position:fixed;background:black;z-index:10;left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px';
      document.body.append(cover); clicks=[];`);
    const hints = new HintMode();
    await hints.start(client);
    assert.equal(hints.active, true);
    await hints.handleInput('a');
    const clicks = await evaluate('clicks');
    assert.equal(clicks.length, 1);
    assert.equal(clicks[0].id, 'wrapped');
    assert.equal(await evaluate("document.querySelectorAll('[data-casty-hint-id]').length"), 0);
  });

  await t.test('fast local navigation delivers a new frame without waiting for an abandoned capture', async () => {
    for (let i = 0; i < 5; i++) {
      let loaded = false, frameReady;
      const frame = new Promise(resolve => { frameReady = resolve; });
      const capture = await startScreencast(client, {
        width: 800, height: 600, onFrame: () => { if (loaded) frameReady(); },
      });
      client.once('Page.loadEventFired', () => { loaded = true; capture.forceCapture(); });
      try {
        await client.send('Page.navigate', { url: `${url}/?${i}` });
        await within(frame, 1000);
      } finally { await stopScreencast(client, capture.cleanup); }
    }
  });

  await t.test('link clicks followed immediately by capture update promptly at changed zoom', async () => {
    await navigate();
    await client.setViewport({ width: 800, height: 600, zoom: 2.5, nativeScale: 1.25 });
    let loaded = false, frameReady;
    const frame = new Promise(resolve => { frameReady = resolve; });
    const capture = await startScreencast(client, {
      width: 800, height: 600, onFrame: () => { if (loaded) frameReady(); },
    });
    client.once('Page.loadEventFired', () => { loaded = true; capture.forceCapture(); });
    try {
      await dispatchClick(client, 100, 210);
      capture.forceCapture();
      await within(frame, 1000);
      assert.equal(await evaluate('location.pathname'), '/next');
      await evaluate('clicks=[]');
      await Promise.all([capture.forceCapture(), dispatchClick(client, 200, 150)]);
      assert.equal((await evaluate('clicks'))[0].id, 'target');
    } finally { await stopScreencast(client, capture.cleanup); }
  });
});
