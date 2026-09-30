import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cellToPixel, pixelToViewport } from '../lib/input.js';
import { toURL } from '../lib/urlbar.js';

test('terminal cells map to CSS coordinates before and after a font-size change', () => {
  assert.deepEqual(cellToPixel(26, 12, 10, 20, 1.25), { x: 204, y: 168 });
  assert.deepEqual(cellToPixel(26, 12, 16, 32, 2), { x: 204, y: 168 });
  assert.deepEqual(pixelToViewport(403, 354, 30, 2), { x: 201.5, y: 162 });
  assert.deepEqual(pixelToViewport(409, 354, 30, 2), { x: 204.5, y: 162 });
});

test('local addresses use HTTP while host ports and explicit schemes are preserved', () => {
  assert.equal(toURL('localhost:3000/path'), 'http://localhost:3000/path');
  assert.equal(toURL('127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(toURL('[::1]:9000'), 'http://[::1]:9000');
  assert.equal(toURL('example.com:8080/path'), 'https://example.com:8080/path');
  assert.equal(toURL('https://example.com'), 'https://example.com');
  assert.equal(toURL('file:///tmp/page.html'), 'file:///tmp/page.html');
});

test('hover tracking does not depend on terminal identity or tmux', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { enableMouse, mouseMode } from ${JSON.stringify(new URL('../lib/input.js', import.meta.url).href)};
    let output = '';
    process.stdout.write = value => { output += value; return true; };
    enableMouse();
    assert.equal(mouseMode, 1003);
    assert.ok(output.includes('\\x1b[?1003h'));
    assert.ok(output.includes('\\x1b[?1006h'));
    assert.ok(!output.includes('\\x1b[?1000h'));
  `;
  for (const [terminal, tmux] of [['ghostty', ''], ['kitty', ''], ['bcon', ''], ['', ''], ['ghostty', 'test']]) {
    execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      timeout: 5000, stdio: 'pipe', env: { ...process.env, TERM_PROGRAM: terminal, TMUX: tmux },
    });
  }
});

test('input preserves button holds, short drags, event ordering, and address-bar editing', () => {
  // Isolate process.stdin and timer state in a child, feeding real SGR/key chunks.
  const source = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { setImmediate as turn } from 'node:timers/promises';
    import { startInputHandling } from ${JSON.stringify(new URL('../lib/input.js', import.meta.url).href)};
    process.stdout.write = () => true;
    process.stdin.setRawMode = () => {};
    const client = new EventEmitter();
    const events = [], navigations = [];
    let finishPress;
    client.send = async (method, params) => {
      if (method === 'Page.getNavigationHistory') return { entries: [], currentIndex: 0 };
      if (method === 'Page.navigate') navigations.push(params.url);
      if (method === 'Input.dispatchMouseEvent') {
        events.push(params);
        if (params.type === 'mousePressed') await new Promise(r => finishPress = r);
      }
      return {};
    };
    const paused = [];
    const bar = startInputHandling(client, 10, 20, 1.25, {'alt+l':'url_bar'}, p => paused.push(p), () => {});
    const input = str => process.stdin.emit('data', Buffer.from(str));
    input('\\x1b[<0;20;10M');
    await turn();
    assert.deepEqual(events.map(e=>e.type), ['mousePressed']);
    input('\\x1b[<32;21;10M');
    input('\\x1b[<0;21;10m');
    await turn();
    assert.equal(events.length, 1);
    finishPress();
    await turn();
    assert.deepEqual(events.map(e=>e.type), ['mousePressed','mouseMoved','mouseReleased']);
    assert.equal(events[1].x - events[0].x, 8);
    assert.equal(events[1].buttons, 1);
    assert.equal(events[2].buttons, 0);
    assert.equal(events[2].clickCount, 1);
    input('\\x1bl');
    await turn();
    assert.equal(bar.editing, true);
    input('localhost:3000');
    input('\\r');
    await turn();
    assert.equal(bar.editing, false);
    assert.deepEqual(navigations, ['http://localhost:3000']);
    assert.equal(paused.at(-1), false);
    process.exit(0);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', source], { timeout: 5000, stdio: 'pipe' });
});

test('hover capture follows mouse dispatch after a font-size change', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { setTimeout as delay } from 'node:timers/promises';
    import { enableMouse, startInputHandling } from ${JSON.stringify(new URL('../lib/input.js', import.meta.url).href)};
    let output = '';
    process.stdout.write = value => { output += value; return true; };
    process.stdin.setRawMode = () => {};
    enableMouse();
    assert.ok(output.includes('\\x1b[?1003h'));
    assert.ok(output.includes('\\x1b[?1006h'));
    assert.ok(output.includes('\\x1b[?1016h'));
    assert.ok(!output.includes('\\x1b[?1000h'));
    const client = new EventEmitter();
    const events = [];
    let releaseMotion;
    client.send = async (method, params) => {
      if (method === 'Page.getNavigationHistory') return { entries: [], currentIndex: 0 };
      if (method === 'Input.dispatchMouseEvent') {
        events.push(params);
        if (params.type === 'mouseMoved') await new Promise(resolve => { releaseMotion = resolve; });
      }
      return {};
    };
    const bar = startInputHandling(client, 10, 20, 1.25, {}, () => {}, () => events.push({ type: 'capture' }));
    const input = str => process.stdin.emit('data', Buffer.from(str));
    input('\\x1b[<35;250;230M');
    for (let i = 0; i < 100 && events.length === 0; i++) await delay(5);
    assert.deepEqual([events[0].x, events[0].y], [200, 168]);
    bar.updateCellSize(16, 30, 2);
    releaseMotion();
    await delay(100);
    assert.deepEqual(events.map(e => e.type), ['mouseMoved']);
    input('\\x1b[<39;403;354M');
    for (let i = 0; i < 100 && events.length < 2; i++) await delay(5);
    assert.deepEqual(events.map(e => e.type), ['mouseMoved', 'mouseMoved']);
    assert.deepEqual([events[1].x, events[1].y], [201.5, 162]);
    releaseMotion();
    for (let i = 0; i < 100 && events.length < 3; i++) await delay(5);
    assert.deepEqual(events.map(e => e.type), ['mouseMoved', 'mouseMoved', 'capture']);
    input('\\x1b[<0;403;15M');
    for (let i = 0; i < 100 && !bar.editing; i++) await delay(5);
    assert.equal(bar.editing, true);
    process.exit(0);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    timeout: 5000, stdio: 'pipe', env: { ...process.env, TERM_PROGRAM: 'ghostty', TMUX: '' },
  });
});

test('short pixel motion coalesces captures and refreshes the final position', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { setTimeout as delay } from 'node:timers/promises';
    import { startInputHandling } from ${JSON.stringify(new URL('../lib/input.js', import.meta.url).href)};
    process.stdout.write = () => true;
    process.stdin.setRawMode = () => {};
    const client = new EventEmitter();
    const moves = [];
    client.send = async (method, params) => {
      if (method === 'Page.getNavigationHistory') return { entries: [], currentIndex: 0 };
      if (method === 'Input.dispatchMouseEvent') moves.push(params);
      return {};
    };
    let captures = 0;
    startInputHandling(client, 16, 30, 2, {}, () => {}, () => { captures++; });
    for (let x = 400; x < 410; x++) {
      process.stdin.emit('data', Buffer.from('\\x1b[<35;' + x + ';354M'));
      await delay(5);
    }
    await delay(200);
    assert.ok(captures > 0 && captures <= 2);
    assert.equal(moves.at(-1).x, 204.5);
    process.exit(0);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    timeout: 5000, stdio: 'pipe', env: { ...process.env, TERM_PROGRAM: 'ghostty', TMUX: '' },
  });
});

test('continuous pixel motion refreshes hover before the pointer stops', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { setTimeout as delay } from 'node:timers/promises';
    import { startInputHandling } from ${JSON.stringify(new URL('../lib/input.js', import.meta.url).href)};
    process.stdout.write = () => true;
    process.stdin.setRawMode = () => {};
    const client = new EventEmitter();
    let lastPosition;
    client.send = async (method, params) => {
      if (method === 'Page.getNavigationHistory') return { entries: [], currentIndex: 0 };
      if (method === 'Input.dispatchMouseEvent') lastPosition = params.x;
      return {};
    };
    const captures = [];
    startInputHandling(client, 16, 30, 2, {}, () => {}, () => captures.push(lastPosition));
    for (let x = 400; x < 424; x++) {
      process.stdin.emit('data', Buffer.from('\\x1b[<35;' + x + ';354M'));
      await delay(20);
      if (x === 415) assert.ok(captures.length > 0, 'hover must refresh during movement');
    }
    await delay(140);
    assert.equal(captures.at(-1), 211.5);
    assert.ok(captures.length < 12, 'pixel reports must not each request a capture');
    process.exit(0);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    timeout: 5000, stdio: 'pipe', env: { ...process.env, TERM_PROGRAM: 'ghostty', TMUX: '' },
  });
});

test('a split final pixel report still sets the resting hover position', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { setTimeout as delay } from 'node:timers/promises';
    import { startInputHandling } from ${JSON.stringify(new URL('../lib/input.js', import.meta.url).href)};
    process.stdout.write = () => true;
    process.stdin.setRawMode = () => {};
    const client = new EventEmitter();
    const moves = [];
    client.send = async (method, params) => {
      if (method === 'Page.getNavigationHistory') return { entries: [], currentIndex: 0 };
      if (method === 'Input.dispatchMouseEvent') moves.push(params);
      return {};
    };
    let captures = 0;
    startInputHandling(client, 16, 30, 2, {}, () => {}, () => { captures++; });
    process.stdin.emit('data', Buffer.from('\\x1b[<35;400;354M'));
    process.stdin.emit('data', Buffer.from('\\x1b[<35;408;'));
    process.stdin.emit('data', Buffer.from('354M'));
    await delay(200);
    assert.equal(moves.at(-1).x, 204);
    assert.ok(captures > 0 && captures <= 2);
    process.exit(0);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    timeout: 5000, stdio: 'pipe', env: { ...process.env, TERM_PROGRAM: 'ghostty', TMUX: '' },
  });
});

test('native motion reports update hover without inventing button presses', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { setTimeout as delay } from 'node:timers/promises';
    import { startInputHandling } from ${JSON.stringify(new URL('../lib/input.js', import.meta.url).href)};
    process.stdout.write = () => true;
    process.stdin.setRawMode = () => {};
    const client = new EventEmitter();
    const events = [];
    client.send = async (method, params) => {
      if (method === 'Page.getNavigationHistory') return { entries: [], currentIndex: 0 };
      if (method === 'Input.dispatchMouseEvent') events.push(params);
      return {};
    };
    let captures = 0;
    const bar = startInputHandling(client, 19, 42, 2.375, {}, () => {}, () => { captures++; });
    const input = str => process.stdin.emit('data', Buffer.from(str));
    const waitFor = async length => {
      for (let i = 0; i < 100 && events.length < length; i++) await delay(5);
      assert.equal(events.length, length);
    };
    // These are the first two motion reports in the native Ghostty trace.
    input('\\x1b[<34;550;848M\\x1b[<34;546;848M');
    await waitFor(1);
    assert.deepEqual(events[0], { type: 'mouseMoved', x: 546 / 2.375, y: 806 / 2.375, button: 'none', clickCount: 0, buttons: 0 });
    await delay(200);
    assert.ok(captures > 0, 'native motion must refresh without keyboard input');
    for (const code of [32, 33, 35, 38, 42, 50]) {
      const length = events.length + 1;
      input('\\x1b[<' + code + ';310;495M');
      await waitFor(length);
      assert.equal(events.at(-1).button, 'none');
      assert.equal(events.at(-1).buttons, 0);
    }
    for (const [code, button, buttons] of [[0, 'left', 1], [1, 'middle', 4], [2, 'right', 2]]) {
      const start = events.length;
      input('\\x1b[<' + code + ';285;943M');
      input('\\x1b[<' + (code + 32) + ';310;943M');
      input('\\x1b[<' + code + ';310;943m');
      await waitFor(start + 3);
      assert.deepEqual(events.slice(start).map(e => [e.type, e.button, e.buttons]), [
        ['mousePressed', button, buttons], ['mouseMoved', button, buttons], ['mouseReleased', button, 0],
      ]);
      input('\\x1b[<34;310;495M');
      await waitFor(start + 4);
      assert.equal(events.at(-1).button, 'none');
      assert.equal(events.at(-1).buttons, 0);
    }
    bar.updateCellSize(12, 24, 1.5);
    const length = events.length + 1;
    input('\\x1b[<34;300;399M');
    await waitFor(length);
    assert.deepEqual([events.at(-1).x, events.at(-1).y], [200, 250]);
    process.exit(0);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    timeout: 5000, stdio: 'pipe', env: { ...process.env, TERM_PROGRAM: 'ghostty', TMUX: '' },
  });
});
