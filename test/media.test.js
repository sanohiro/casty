import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { startMedia } from '../lib/media.js';
import { launchChrome } from '../lib/chrome.js';
import { setupPage } from '../lib/browser.js';
import { loadConfig } from '../lib/config.js';

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail('Timed out waiting for media state');
}

// Replace every device probe and capture process; never open real camera/mic devices.
async function fixture(t, { ignoreTerm = false, listAudio = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'casty-media-test-'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'capture.log');
  await mkdir(bin);
  await writeFile(log, '');
  await writeFile(join(bin, 'ffmpeg'), `#!${process.execPath}
const { appendFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('-version')) process.exit(0);
if (${listAudio} && args.includes('-list_devices')) {
  console.error('AVFoundation video devices:\\nAVFoundation audio devices:\\n[0] Offline phone\\n[1] Built-in microphone');
  process.exit(1);
}
if (!args.includes('pipe:1')) process.exit(1);
writeFileSync(${JSON.stringify(join(dir, 'capture-args.json'))}, JSON.stringify(args));
const log = ${JSON.stringify(log)};
appendFileSync(log, 'start ' + process.pid + '\\n');
process.on('SIGTERM', () => {
  if (${ignoreTerm}) return;
  appendFileSync(log, 'stop ' + process.pid + '\\n');
  process.exit(0);
});
process.stdout.on('error', () => {});
const pcm = Buffer.alloc(9600);
for (let i = 0; i < 4800; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 16000), i * 2);
setInterval(() => process.stdout.write(pcm), 100);
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + delimiter + oldPath;
  const sockets = [];
  const relays = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await Promise.all(relays.map(media => media.cleanup()));
    await until(async () => {
      const entries = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean);
      return entries.filter(s => s.startsWith('start ')).every(s => !isRunning(Number(s.split(' ')[1])));
    });
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  });
  async function start(config = { audioDevice: 'test-input', videoDevice: { idx: null } }) {
    const media = await startMedia(config);
    relays.push(media);
    return media;
  }
  function connect(media, path) {
    const ws = new WebSocket(`ws://127.0.0.1:${media.port}${path}`, { origin: 'https://unrelated.example' });
    sockets.push(ws);
    return ws;
  }
  async function counts() {
    const entries = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean);
    return {
      starts: entries.filter(s => s.startsWith('start ')).length,
      stops: entries.filter(s => s.startsWith('stop ')).length,
    };
  }
  return { start, connect, counts, dir, log };
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('macOS selects the default audio device instead of the first enumerated microphone', { skip: process.platform !== 'darwin', timeout: 10000 }, async t => {
  const f = await fixture(t, { listAudio: true });
  const media = await f.start({ videoDevice: { idx: null } });
  const ws = f.connect(media, `/${media.token}`);
  await once(ws, 'message');
  const args = JSON.parse(await readFile(join(f.dir, 'capture-args.json'), 'utf8'));
  assert.equal(args[args.indexOf('-i') + 1], ':default');
  ws.close();
});

test('stopping capture terminates an unresponsive device process', { timeout: 10000 }, async t => {
  const f = await fixture(t, { ignoreTerm: true });
  const media = await f.start();
  const ws = f.connect(media, `/${media.token}`);
  await once(ws, 'message');
  const pid = Number((await readFile(f.log, 'utf8')).trim().split(' ')[1]);
  assert.ok(isRunning(pid));
  ws.close();
  await until(() => !isRunning(pid));
});

for (const disconnectFirst of [false, true]) {
  test(`cleanup waits for capture before process exit (disconnected=${disconnectFirst})`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { ignoreTerm: true });
    const source = `
      import { startMedia } from ${JSON.stringify(new URL('../lib/media.js', import.meta.url).href)};
      import WebSocket from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('ws')).href)};
      import { once } from 'node:events';
      const media = await startMedia({ audioDevice: 'test-input', videoDevice: { idx: null } });
      const ws = new WebSocket('ws://127.0.0.1:' + media.port + '/' + media.token);
      await once(ws, 'message');
      if (${disconnectFirst}) {
        ws.close();
        await once(ws, 'close');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await media.cleanup();
      process.exit(0);
    `;
    const parent = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore' });
    const timer = setTimeout(() => parent.kill('SIGKILL'), 5000);
    let pid;
    try {
      const [code] = await once(parent, 'exit');
      clearTimeout(timer);
      assert.equal(code, 0);
      pid = Number((await readFile(f.log, 'utf8')).trim().split(' ')[1]);
      assert.equal(isRunning(pid), false, 'Capture must exit before its parent');
    } finally {
      clearTimeout(timer);
      if (pid && isRunning(pid)) process.kill(pid, 'SIGKILL');
    }
  });
}

test('media relay authenticates before starting capture and rotates session tokens', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const first = await f.start();
  const second = await f.start();
  assert.match(first.token, /^[0-9a-f]{32}$/);
  assert.notEqual(first.token, second.token);
  for (const path of ['/', '/incorrect', `/${first.token}?extra=1`, `/${first.token}/`, `/${second.token}`]) {
    await assert.rejects(once(f.connect(first, path), 'open'), /Unexpected server response: 401/);
  }
  assert.deepEqual(await f.counts(), { starts: 0, stops: 0 });
  const ws = f.connect(first, `/${first.token}`);
  const [data] = await once(ws, 'message');
  assert.equal(data[0], 2);
  assert.equal(data.length, 9601);
  const other = f.connect(first, `/${first.token}`);
  await once(other, 'message');
  ws.close();
  await once(ws, 'close');
  assert.equal((await f.counts()).stops, 0);
  other.close();
  await until(async () => (await f.counts()).stops === 1);
});

const headlessShellPath = process.env.CASTY_TEST_HEADLESS_SHELL;
test('page media lifecycle releases capture and supports restarting', { skip: !headlessShellPath, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const media = await f.start();
  const server = createServer((req, res) => res.end('<!doctype html><title>Media regression</title>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = loadConfig();
  const previousMedia = config.media;
  config.media = true;
  const profile = await mkdtemp(join(tmpdir(), 'casty-media-profile-'));
  let browser, client;
  t.after(async () => {
    config.media = previousMedia;
    if (browser) {
      const exited = browser.proc.exitCode === null ? once(browser.proc, 'exit') : Promise.resolve();
      if (client) {
        await client.send('Browser.close').catch(() => {});
        client.close();
      }
      browser.proc.kill();
      await exited;
    }
    server.close();
    await rm(profile, { recursive: true, force: true });
  });
  browser = await launchChrome({ userDataDir: profile, headlessShellPath });
  ({ client } = await setupPage(browser, { width: 800, height: 600, mediaPort: media.port, mediaToken: media.token }));
  const evaluate = async expression => {
    const { result, exceptionDetails } = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(exceptionDetails, undefined);
    return result.value;
  };
  async function navigate() {
    const loaded = once(client, 'Page.loadEventFired');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await loaded;
    await evaluate(`
      window.sockets = [];
      window.contexts = [];
      window.packetCount = 0;
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url) {
          super(url);
          sockets.push(this);
          this.addEventListener('message', () => packetCount++);
        }
      };
      const NativeAudioContext = window.AudioContext;
      window.AudioContext = class extends NativeAudioContext {
        constructor(options) { super(options); contexts.push(this); }
      };
    `);
  }
  async function start(constraints = '{ audio: true, video: true }') {
    await evaluate(`(async () => { window.packetCount = 0; window.stream = await navigator.mediaDevices.getUserMedia(${constraints}); })()`);
    await until(async () => await evaluate('packetCount > 0'));
  }
  async function stopped() {
    await until(async () => await evaluate('sockets.every(s => s.readyState === WebSocket.CLOSED)'));
    assert.equal(await evaluate('contexts.every(c => c.state === "closed")'), true);
    await until(async () => {
      const counts = await f.counts();
      return counts.starts === counts.stops;
    });
  }
  await navigate();
  await t.test('received PCM becomes audible samples in the returned audio track', async () => {
    await start('{ audio: true }');
    await evaluate(`
      window.monitor = new AudioContext({ sampleRate: 48000 });
      window.analyser = monitor.createAnalyser();
      window.input = monitor.createMediaStreamSource(stream);
      input.connect(analyser);
    `);
    await until(async () => await evaluate(`(() => {
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return samples.some(s => Math.abs(s) > 0.1);
    })()`));
    await evaluate('input.disconnect(); monitor.close(); stream.getTracks().forEach(t => t.stop())');
    await stopped();
  });
  await t.test('stop() closes the relay and audio resources after the last track', async () => {
    await start();
    await evaluate('stream.getAudioTracks()[0].stop()');
    assert.equal(await evaluate('sockets.at(-1).readyState'), 1);
    await evaluate('stream.getVideoTracks()[0].stop(); stream.getVideoTracks()[0].stop()');
    await stopped();
  });
  await t.test('cloned tracks keep capture alive until they also stop', async () => {
    await start('{ audio: true }');
    await evaluate('window.clone = stream.clone(); stream.getTracks().forEach(t => t.stop())');
    assert.equal(await evaluate('sockets.at(-1).readyState'), 1);
    await evaluate('clone.getTracks().forEach(t => t.stop())');
    await stopped();
  });
  await t.test('clones of rewrapped streams keep receiving audio after originals stop', async () => {
    await start('{ audio: true }');
    await evaluate(`
      window.clone = new MediaStream(stream).clone();
      stream.getTracks().forEach(t => MediaStreamTrack.prototype.stop.call(t));
      window.monitor = new AudioContext({ sampleRate: 48000 });
      window.analyser = monitor.createAnalyser();
      window.input = monitor.createMediaStreamSource(clone);
      input.connect(analyser);
    `);
    assert.equal(await evaluate('sockets.at(-1).readyState'), 1);
    await until(async () => await evaluate(`(() => {
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return samples.some(s => Math.abs(s) > 0.1);
    })()`));
    await evaluate('input.disconnect(); monitor.close(); clone.getTracks().forEach(t => t.stop())');
    await stopped();
  });
  await t.test('cloning tracks from two relays preserves each independent lifetime', async () => {
    await start('{ audio: true }');
    await evaluate('(async () => { window.other = await navigator.mediaDevices.getUserMedia({ audio: true }); })()');
    await until(async () => await evaluate('sockets.at(-1).readyState === WebSocket.OPEN'));
    await evaluate(`
      window.mixed = new MediaStream([...stream.getTracks(), ...other.getTracks()]).clone();
      stream.getTracks().forEach(t => t.stop());
      other.getTracks().forEach(t => t.stop());
    `);
    assert.deepEqual(await evaluate('sockets.slice(-2).map(s => s.readyState)'), [1, 1]);
    await evaluate('mixed.getTracks()[0].stop()');
    await until(async () => await evaluate('sockets.slice(-2).some(s => s.readyState === WebSocket.CLOSED)'));
    assert.equal(await evaluate('sockets.slice(-2).filter(s => s.readyState === WebSocket.OPEN).length'), 1);
    await evaluate('mixed.getTracks()[1].stop()');
    await stopped();
  });
  await t.test('native streams outside the relay retain their clone and stop behavior', async () => {
    assert.deepEqual(await evaluate(`(() => {
      const canvas = document.createElement('canvas');
      const original = canvas.captureStream();
      const clone = original.clone();
      original.getTracks()[0].stop();
      const states = [original.getTracks()[0].readyState, clone.getTracks()[0].readyState];
      clone.getTracks()[0].stop();
      return states;
    })()`), ['ended', 'live']);
  });
  await t.test('removing a live track from the stream does not lose its cleanup', async () => {
    await start();
    await evaluate('window.removed = stream.getVideoTracks()[0]; stream.removeTrack(removed); stream.getTracks().forEach(t => t.stop())');
    assert.equal(await evaluate('sockets.at(-1).readyState'), 1);
    await evaluate('removed.stop()');
    await stopped();
  });
  await t.test('navigation disconnects the old relay and a new page reconnects', async () => {
    await start('{ audio: true }');
    await navigate();
    await until(async () => {
      const counts = await f.counts();
      return counts.starts === counts.stops;
    });
    await start('{ audio: true }');
    await evaluate('stream.getTracks().forEach(t => t.stop())');
    await stopped();
  });
  await t.test('video-only streams stop without audio resources', async () => {
    await start('{ video: true }');
    await evaluate('stream.getTracks().forEach(t => t.stop())');
    await stopped();
  });
  await t.test('a lost relay connection ends tracks and releases audio resources', async () => {
    await start();
    await evaluate('sockets.at(-1).close()');
    await stopped();
    assert.equal(await evaluate('stream.getTracks().every(t => t.readyState === "ended")'), true);
  });
});
