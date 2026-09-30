import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { CDPClient } from '../lib/cdp.js';

async function connection(t) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connected = once(server, 'connection');
  const client = new CDPClient();
  await client.connect(`ws://127.0.0.1:${server.address().port}`);
  const [socket] = await connected;
  t.after(() => { client.close(); socket.terminate(); server.close(); });
  const commands = [];
  socket.on('message', data => commands.push(JSON.parse(data)));
  return { client, socket, commands };
}

test('pointer input and resizing wait for capture while frame acknowledgments proceed', async t => {
  const { client, socket, commands } = await connection(t);
  const received = once(socket, 'message');
  const capture = client.send('Page.captureScreenshot');
  await received;
  const pointer = client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 20 });
  const resize = client.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600 });
  const ackReceived = once(socket, 'message');
  const ack = client.send('Page.screencastFrameAck', { sessionId: 1 });
  await ackReceived;
  assert.deepEqual(commands.map(c => c.method), ['Page.captureScreenshot', 'Page.screencastFrameAck']);
  socket.send(JSON.stringify({ id: commands[1].id, result: {} }));
  await ack;
  let next = once(socket, 'message');
  socket.send(JSON.stringify({ id: commands[0].id, result: { data: 'frame' } }));
  await capture;
  await next;
  assert.equal(commands[2].method, 'Input.dispatchMouseEvent');
  next = once(socket, 'message');
  socket.send(JSON.stringify({ id: commands[2].id, result: {} }));
  await pointer;
  await next;
  assert.equal(commands[3].method, 'Emulation.setDeviceMetricsOverride');
  socket.send(JSON.stringify({ id: commands[3].id, result: {} }));
  await resize;
});

test('a failed or lost capture response does not permanently block the input queue', async t => {
  const { client, socket, commands } = await connection(t);
  await assert.rejects(client.send('Page.captureScreenshot', {}, 30), /CDP timeout/);
  assert.equal(commands.length, 1);
  const next = once(socket, 'message');
  const pointer = client.send('Input.dispatchMouseEvent', {});
  await next;
  // A late reply for the timed-out screenshot must not consume the input reply.
  socket.send(JSON.stringify({ id: commands[0].id, result: { data: 'late frame' } }));
  socket.send(JSON.stringify({ id: commands[1].id, result: {} }));
  await pointer;
});

test('navigation abandons old screenshots and restores metrics before queued input', async t => {
  const { client, socket, commands } = await connection(t);
  let next = once(socket, 'message');
  const metrics = client.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 2 });
  await next;
  socket.send(JSON.stringify({ id: commands[0].id, result: {} }));
  await metrics;
  next = once(socket, 'message');
  const capture = assert.rejects(client.send('Page.captureScreenshot'), /Navigation interrupted/);
  await next;
  const staleQueuedCapture = assert.rejects(client.send('Page.captureScreenshot'), /Navigation interrupted/);
  const pointer = client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 150 });
  next = once(socket, 'message');
  socket.send(JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { id: 'main', url: 'http://localhost/new' } } }));
  await next;
  await capture;
  assert.equal(commands.length, 3);
  assert.equal(commands[2].method, 'Emulation.setDeviceMetricsOverride');
  assert.deepEqual(commands[2].params, commands[0].params);
  next = once(socket, 'message');
  socket.send(JSON.stringify({ id: commands[2].id, result: {} }));
  await staleQueuedCapture;
  await next;
  assert.equal(commands[3].method, 'Input.dispatchMouseEvent');
  socket.send(JSON.stringify({ id: commands[3].id, result: {} }));
  await pointer;
});
