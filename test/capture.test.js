import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { startScreencast } from '../lib/browser.js';

function delayedClient() {
  const client = new EventEmitter();
  const captures = [];
  client.send = async method => {
    if (method !== 'Page.captureScreenshot') return {};
    return new Promise(resolve => captures.push(resolve));
  };
  return { client, captures };
}

test('a forced refresh during capture is coalesced and delivered afterward', async () => {
  const { client, captures } = delayedClient();
  const frames = [];
  const capture = await startScreencast(client, { width: 800, height: 600, onFrame: f => frames.push(f) });
  try {
    await capture.forceCapture();
    await capture.forceCapture();
    assert.equal(captures.length, 1);
    captures[0]({ data: 'old page' });
    await nextTurn();
    assert.equal(captures.length, 2);
    captures[1]({ data: 'new page' });
    await nextTurn();
    assert.deepEqual(frames, ['old page', 'new page']);
  } finally { capture.cleanup(); }
});

test('stopping capture discards in-flight frames and queued refreshes', async () => {
  const { client, captures } = delayedClient();
  const frames = [];
  const capture = await startScreencast(client, { width: 800, height: 600, onFrame: f => frames.push(f) });
  await capture.forceCapture();
  capture.cleanup();
  captures[0]({ data: 'stale frame' });
  await nextTurn();
  await capture.forceCapture();
  assert.deepEqual(frames, []);
  assert.equal(captures.length, 1);
  assert.equal(client.listenerCount('Page.screencastFrame'), 0);
});

test('a page change during capture is displayed after the older frame completes', async () => {
  const { client, captures } = delayedClient();
  const frames = [];
  const capture = await startScreencast(client, { width: 800, height: 600, onFrame: f => frames.push(f) });
  try {
    client.emit('Page.screencastFrame', { data: 'changed page', sessionId: 1 });
    captures[0]({ data: 'old page' });
    await delay(60);
    assert.equal(captures.length, 2);
    captures[1]({ data: 'new page' });
    await nextTurn();
    assert.deepEqual(frames, ['old page', 'new page']);
    client.emit('Page.screencastFrame', { data: 'changed page', sessionId: 2 });
    await delay(60);
    assert.equal(captures.length, 2);
  } finally { capture.cleanup(); }
});

test('unchanged screencast frames do not start redundant screenshots', async () => {
  const client = new EventEmitter();
  let screenshots = 0;
  client.send = async method => {
    if (method === 'Page.captureScreenshot') return { data: String(++screenshots) };
    return {};
  };
  const capture = await startScreencast(client, { width: 800, height: 600, onFrame: () => {} });
  try {
    await nextTurn();
    const initial = screenshots;
    client.emit('Page.screencastFrame', { data: 'same', sessionId: 1 });
    await delay(100);
    assert.equal(screenshots, initial + 1);
    client.emit('Page.screencastFrame', { data: 'same', sessionId: 2 });
    await delay(100);
    assert.equal(screenshots, initial + 1);
    client.emit('Page.screencastFrame', { data: 'changed', sessionId: 3 });
    await delay(100);
    assert.equal(screenshots, initial + 2);
  } finally { capture.cleanup(); }
});
