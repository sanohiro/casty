import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { CDPClient } from '../lib/cdp.js';

function connection(t) {
  const client = new CDPClient();
  const commands = [];
  client._ws = { send: packet => commands.push(JSON.parse(packet)), close() {} };
  t.after(() => client.close());
  const reply = (command, result = {}) => {
    const pending = client._pending.get(command.id);
    clearTimeout(pending.timer);
    client._pending.delete(command.id);
    pending.resolve(result);
  };
  return { client, commands, reply };
}

test('viewport updates set capture scale and visible size before pointer input', async t => {
  const { client, commands, reply } = connection(t);
  const metrics = client.setViewport({ width: 800, height: 600, zoom: 0.75, nativeScale: 1.25 });
  const cssPointer = { type: 'mouseMoved', x: 200, y: 150, button: 'none', buttons: 0 };
  const pointer = client.send('Input.dispatchMouseEvent', cssPointer);
  const wheel = client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 150, deltaX: 0, deltaY: 100 });
  await turn();
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].params, {
    width: 800, height: 600, deviceScaleFactor: 0.75, mobile: false, scale: 0.6, dontSetVisibleSize: true,
  });
  reply(commands[0]);
  await turn();
  assert.equal(commands.length, 2);
  assert.equal(commands[1].method, 'Emulation.setVisibleSize');
  assert.deepEqual(commands[1].params, { width: 480, height: 360 });
  reply(commands[1]);
  await metrics;
  await turn();
  assert.deepEqual(commands[2].params, { ...cssPointer, x: 120, y: 90 });
  assert.deepEqual([cssPointer.x, cssPointer.y], [200, 150]);
  reply(commands[2]);
  await pointer;
  await turn();
  assert.deepEqual(commands[3].params, { type: 'mouseWheel', x: 120, y: 90, deltaX: 0, deltaY: 100 });
  reply(commands[3]);
  await wheel;
});

test('navigation restores capture scale and visible size before releasing input', async t => {
  const { client, commands, reply } = connection(t);
  const metrics = client.setViewport({ width: 800, height: 600, zoom: 2, nativeScale: 1.25 });
  await turn();
  reply(commands[0]);
  await turn();
  reply(commands[1]);
  await metrics;
  const capture = assert.rejects(client.send('Page.captureScreenshot'), /Navigation interrupted/);
  await turn();
  const stale = assert.rejects(client.send('Page.captureScreenshot'), /Navigation interrupted/);
  const pointer = client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 150 });
  client._interruptCaptures();
  await capture;
  assert.equal(commands[3].method, 'Emulation.setDeviceMetricsOverride');
  assert.deepEqual(commands[3].params, commands[0].params);
  reply(commands[3]);
  await turn();
  assert.equal(commands[4].method, 'Emulation.setVisibleSize');
  assert.deepEqual(commands[4].params, { width: 1280, height: 960 });
  assert.equal(commands.length, 5);
  reply(commands[4]);
  await stale;
  await turn();
  assert.deepEqual(commands[5].params, { type: 'mouseMoved', x: 320, y: 240 });
  reply(commands[5]);
  await pointer;
});

test('navigation without an active screenshot does not overwrite a pending resize', async t => {
  const { client, commands, reply } = connection(t);
  const initial = client.setViewport({ width: 800, height: 600, zoom: 1.25 });
  await turn();
  reply(commands[0]);
  await turn();
  reply(commands[1]);
  await initial;
  const resize = client.setViewport({ width: 500, height: 400, zoom: 2, nativeScale: 1.25 });
  await turn();
  client._interruptCaptures();
  assert.equal(commands.length, 3);
  reply(commands[2]);
  await turn();
  assert.deepEqual(commands[3].params, { width: 800, height: 640 });
  reply(commands[3]);
  await resize;
  const pointer = client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 100 });
  await turn();
  assert.deepEqual(commands[4].params, { type: 'mouseMoved', x: 160, y: 160 });
  reply(commands[4]);
  await pointer;
});
