// Local camera/microphone smoke test. Run: node scripts/manual-media.mjs
import { createServer } from 'node:http';

const html = `<!doctype html>
<html lang="en"><meta charset="utf-8">
<title>casty media test</title>
<style>
body { margin: 24px; background: #18212b; color: #edf4fb; font: 18px system-ui; }
button { margin: 4px; padding: 12px 16px; font: inherit; cursor: pointer; }
video { display: block; margin: 16px 0; width: min(640px, 90vw); background: #080d12; }
meter { width: 240px; height: 24px; vertical-align: middle; }
pre { white-space: pre-wrap; font-size: 15px; }
</style>
<h1>casty media test</h1>
<p>Local preview only. No recording or upload. Requires <code>media: true</code> and ffmpeg.</p>
<button id="start">Start camera + mic</button>
<button id="stopAudio">Stop mic track</button>
<button id="stopVideo">Stop camera track</button>
<button id="stop">Stop all</button>
<button id="reload">Reload page</button>
<video id="preview" autoplay muted playsinline></video>
<p>Mic signal: <meter id="level" min="0" max="1" value="0"></meter></p>
<p id="status">Stopped</p>
<pre id="log"></pre>
<script>
let stream, context, analyser, source, frame;
const preview = document.querySelector('#preview');
const status = document.querySelector('#status');
const log = message => {
  document.querySelector('#log').textContent = new Date().toLocaleTimeString() + ' ' + message + String.fromCharCode(10) + document.querySelector('#log').textContent;
};
function updateStatus() {
  status.textContent = stream ? stream.getTracks().map(t => t.kind + ': ' + t.readyState).join(' / ') : 'Stopped';
}
function stopMonitor() {
  cancelAnimationFrame(frame);
  source?.disconnect();
  if (context) context.close().catch(() => {});
  source = context = analyser = null;
  document.querySelector('#level').value = 0;
}
function stopAll() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stopMonitor();
  preview.srcObject = null;
  updateStatus();
}
document.querySelector('#start').onclick = async () => {
  stopAll();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    preview.srcObject = stream;
    await preview.play();
    context = new AudioContext();
    await context.resume();
    analyser = context.createAnalyser();
    source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const meter = document.querySelector('#level');
    function measure() {
      analyser.getFloatTimeDomainData(samples);
      meter.value = Math.min(1, Math.max(...samples.map(Math.abs)) * 5);
      frame = requestAnimationFrame(measure);
    }
    measure();
    updateStatus();
    log('Started. Check moving video and mic signal, then stop both tracks.');
  } catch (error) { stopAll(); log(error.name + ': ' + error.message); }
};
document.querySelector('#stopAudio').onclick = () => {
  stream?.getAudioTracks().forEach(t => t.stop());
  stopMonitor();
  updateStatus();
  log('Mic track stopped. Relay stays active while the video track is live.');
};
document.querySelector('#stopVideo').onclick = () => {
  stream?.getVideoTracks().forEach(t => t.stop());
  updateStatus();
  log('Camera track stopped. Relay stays active while the audio track is live.');
};
document.querySelector('#stop').onclick = () => { stopAll(); log('All tracks stopped. Check that device capture has stopped.'); };
document.querySelector('#reload').onclick = () => location.reload();
window.addEventListener('pagehide', stopAll);
</script></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
});
server.listen(0, '127.0.0.1', () => {
  console.log(`Open in casty: http://127.0.0.1:${server.address().port}/`);
  console.log('Press Ctrl+C to stop the test server.');
});
