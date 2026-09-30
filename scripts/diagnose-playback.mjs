// Inspect playback in an already-running casty session without changing the page.
// Run as the same user: node scripts/diagnose-playback.mjs [debugging-port]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CDPClient } from '../lib/cdp.js';

const exec = promisify(execFile);
const output = fileURLToPath(new URL(`../.local-logs/playback-${process.platform}-${Date.now()}.json`, import.meta.url));
const report = { date: new Date().toISOString(), platform: process.platform, arch: process.arch, audio: {}, media: [], samples: [] };
const client = new CDPClient();
// URLs in decoder messages can contain signed media credentials.
const redact = value => JSON.parse(JSON.stringify(value).replace(/https?:[^\s"\\]+/g, '[URL]'));
async function command(file, args) {
  try {
    const { stdout, stderr } = await exec(file, args, { timeout: 2500, maxBuffer: 128 * 1024 });
    return { stdout: stdout.replace(/^Cookie:.*\n?/gm, '').trim(), stderr: stderr.trim() };
  } catch (error) {
    return { error: error.code, stdout: error.stdout?.trim(), stderr: error.stderr?.trim() || error.message };
  }
}
async function evaluate(expression) {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', { expression, returnByValue: true }, 3000);
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return result?.value;
}

try {
  let port = process.argv[2];
  if (!port) {
    const active = await readFile(join(homedir(), '.casty', 'profile', 'DevToolsActivePort'), 'utf8');
    port = active.split('\n')[0];
  }
  if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) throw new Error('Invalid debugging port');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`Cannot list browser pages: HTTP ${response.status}`);
  const pages = (await response.json()).filter(page => page.type === 'page');
  const page = pages.find(page => /^https:\/\/(?:www\.|m\.)?youtube\.com\//.test(page.url)) || pages[0];
  if (!page) throw new Error('No browser page found; keep casty open on the stalled video');
  client.on('error', error => { report.connectionError = error.message; });
  await client.connect(page.webSocketDebuggerUrl);
  report.browser = await client.send('Browser.getVersion');
  for (const event of ['playerErrorsRaised', 'playerMessagesLogged', 'playerEventsAdded']) {
    client.on(`Media.${event}`, data => {
      if (report.media.length < 500) report.media.push({ event, ...redact(data) });
    });
  }
  client.on('Media.playerPropertiesChanged', ({ playerId, properties }) => {
    const selected = properties.filter(p => /audio|video|decoder|pipeline|error|renderer|resolution|dimension|codec/i.test(p.name) && !/url/i.test(p.name));
    if (selected.length && report.media.length < 500) report.media.push({ event: 'properties', playerId, properties: redact(selected) });
  });
  await client.send('Media.enable').catch(error => { report.mediaError = error.message; });
  report.codecs = await evaluate(`(() => {
    const video = document.createElement('video');
    return Object.fromEntries([
      'video/mp4; codecs="avc1.42E01E"', 'audio/mp4; codecs="mp4a.40.2"',
      'video/webm; codecs="vp9"', 'video/webm; codecs="vp8"', 'audio/webm; codecs="opus"',
      'video/mp4; codecs="av01.0.04M.08"'
    ].map(type => [type, {canPlay: video.canPlayType(type), mediaSource: typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type)}]));
  })()`);
  if (process.platform === 'linux') {
    const results = await Promise.all([
      command('pactl', ['info']), command('pactl', ['list', 'short', 'sinks']),
      command('aplay', ['-l']),
      readFile('/proc/asound/cards', 'utf8').catch(error => error.message),
    ]);
    [report.audio.server, report.audio.sinks, report.audio.alsaDevices, report.audio.cards] = results;
  }
  console.log('Collecting playback state for 10 seconds. Keep casty open on the video.');
  for (let second = 0; second < 10; second++) {
    report.samples.push({ second, ...await evaluate(`({
      host: location.hostname,
      videos: [...document.querySelectorAll('video,audio')].map(v => ({
        tag: v.tagName, currentTime: v.currentTime, duration: v.duration,
        paused: v.paused, ended: v.ended, readyState: v.readyState, networkState: v.networkState,
        muted: v.muted, volume: v.volume, width: v.videoWidth, height: v.videoHeight,
        error: v.error && { code: v.error.code, message: v.error.message },
        buffered: Array.from({length:v.buffered.length}, (_,i) => [v.buffered.start(i), v.buffered.end(i)]),
        quality: v.getVideoPlaybackQuality && (() => {const q=v.getVideoPlaybackQuality(); return {total:q.totalVideoFrames, dropped:q.droppedVideoFrames};})()
      }))
    })`) });
    await delay(1000);
  }
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  client.close();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`Playback diagnostics: ${output}`);
  if (report.error) console.error(report.error);
}
