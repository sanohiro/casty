import test from 'node:test';
import assert from 'node:assert/strict';
import { UrlBar } from '../lib/urlbar.js';

const LONG_URL = 'https://example.com/abcdefghijklmnopqrstuvwxyz0123456789';

function withBar(cols, url, run) {
  const originalWrite = process.stdout.write;
  const originalColumns = process.stdout.columns;
  const bar = new UrlBar();
  let output = '';
  process.stdout.columns = cols;
  process.stdout.write = chunk => { output += chunk; return true; };
  const draw = action => {
    output = '';
    action();
    const positions = [...output.matchAll(/\x1b\[1;(\d+)H/g)];
    return {
      text: output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''),
      col: Number(positions.at(-1)?.[1]),
    };
  };
  try {
    bar.currentUrl = url;
    const initial = draw(() => bar.startEditing());
    run({ bar, draw, initial });
  } finally {
    bar.cancelEditing();
    process.stdout.write = originalWrite;
    if (originalColumns === undefined) delete process.stdout.columns;
    else process.stdout.columns = originalColumns;
  }
}

test('long URLs scroll with the cursor and edits retain the entire URL', () => {
  withBar(20, LONG_URL, ({ bar, draw, initial }) => {
    assert.deepEqual(initial, { text: ' > ' + LONG_URL.slice(-16) + ' ', col: 20 });
    const home = draw(() => bar.handleInput('\x1b[H'));
    assert.deepEqual(home, { text: ' > ' + LONG_URL.slice(0, 17), col: 4 });
    assert.equal(bar.cursor, 0);
    draw(() => bar.handleInput('X'));
    assert.equal(bar.text, 'X' + LONG_URL);
    draw(() => bar.handleInput('\x7f'));
    assert.equal(bar.text, LONG_URL);
    assert.deepEqual(draw(() => bar.handleInput('\x1b[F')), initial);
    draw(() => bar.handleInput('\x7f'));
    assert.equal(bar.text, LONG_URL.slice(0, -1));
    assert.equal(bar.cursor, LONG_URL.length - 1);
  });
});

test('Home and End work in normal, application, VT220, and rxvt modes', () => {
  withBar(24, LONG_URL, ({ bar, draw }) => {
    const homes = ['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~'];
    const ends = ['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~'];
    for (let i = 0; i < homes.length; i++) {
      const home = draw(() => bar.handleInput(homes[i]));
      assert.equal(bar.cursor, 0);
      assert.equal(bar.selectAll, false);
      assert.equal(home.col, 4);
      assert.ok(home.text.startsWith(' > https://example.com/'));
      const end = draw(() => bar.handleInput(ends[i]));
      assert.equal(bar.cursor, LONG_URL.length);
      assert.equal(end.col, 24);
      assert.ok(end.text.endsWith('0123456789 '));
    }
  });
});

test('arrows keep the visible slice stable until the cursor crosses an edge', () => {
  withBar(20, LONG_URL, ({ bar, draw }) => {
    const home = draw(() => bar.handleInput('\x1bOD'));
    assert.equal(bar.cursor, 0);
    assert.equal(home.col, 4);
    for (let i = 1; i <= 16; i++) {
      const frame = draw(() => bar.handleInput(i % 2 ? '\x1bOC' : '\x1b[C'));
      assert.equal(bar.cursor, i);
      assert.equal(frame.text, home.text);
      assert.equal(frame.col, i + 4);
    }
    const scrolled = draw(() => bar.handleInput('\x1b[C'));
    assert.equal(scrolled.text, ' > ' + LONG_URL.slice(1, 18));
    assert.equal(scrolled.col, 20);
    for (let i = 0; i < 17; i++) draw(() => bar.handleInput('\x1b[D'));
    assert.deepEqual(draw(() => bar.render()), home);
  });
});

test('wide characters stay whole at scroll boundaries and mouse clicks use display columns', () => {
  withBar(14, 'あいうえおかきくけ𠮷', ({ bar, draw, initial }) => {
    assert.deepEqual(initial, { text: ' > かきくけ𠮷 ', col: 14 });
    assert.deepEqual(draw(() => bar.handleInput('\x1b[H')), { text: ' > あいうえお ', col: 4 });
    for (let i = 0; i < 5; i++) draw(() => bar.handleInput('\x1b[C'));
    assert.deepEqual(draw(() => bar.render()), { text: ' > いうえおか ', col: 12 });
    draw(() => bar.handleClick(13));
    assert.equal(bar.cursor, 5, 'clicking the second cell of か must target that character');
    draw(() => bar.handleInput('X'));
    assert.equal(bar.text, 'あいうえおXかきくけ𠮷');
    draw(() => bar.handleInput('\x1b[F'));
    draw(() => bar.handleInput('\x1b[D'));
    assert.equal(bar.cursor, 10);
    draw(() => bar.handleInput('\x1b[3~'));
    assert.equal(bar.text, 'あいうえおXかきくけ');
  });
});

test('clicking scrolled text edits the visible character and trailing space targets the end', () => {
  withBar(20, LONG_URL, ({ bar, draw }) => {
    draw(() => bar.handleClick(6));
    assert.equal(bar.cursor, LONG_URL.length - 14);
    assert.equal(bar.selectAll, false);
    draw(() => bar.handleInput('X'));
    assert.equal(bar.text, LONG_URL.slice(0, -14) + 'X' + LONG_URL.slice(-14));
    draw(() => bar.handleInput('\x01'));
    draw(() => bar.insertText('abc'));
    draw(() => bar.handleClick(20));
    assert.equal(bar.cursor, 3);
    assert.deepEqual(draw(() => bar.render()), { text: ' > abc' + ' '.repeat(14), col: 7 });
  });
});

test('replacing, clearing, and shortening text reset scrolling as needed', () => {
  withBar(20, LONG_URL, ({ bar, draw }) => {
    assert.deepEqual(draw(() => bar.insertText('日本語')), { text: ' > 日本語' + ' '.repeat(11), col: 10 });
    assert.equal(bar.text, '日本語');
    draw(() => bar.handleInput('\x01'));
    draw(() => bar.insertText(LONG_URL));
    assert.deepEqual(draw(() => bar.handleInput('\x15')), { text: ' > ' + ' '.repeat(17), col: 4 });
    draw(() => bar.insertText(LONG_URL));
    assert.deepEqual(draw(() => bar.handleInput('\x17')), { text: ' > ' + ' '.repeat(17), col: 4 });
    draw(() => bar.insertText(LONG_URL));
    for (let i = 0; i < LONG_URL.length - 3; i++) draw(() => bar.handleInput('\x7f'));
    assert.deepEqual(draw(() => bar.render()), { text: ' > htt' + ' '.repeat(14), col: 7 });
  });
});

test('resizing keeps text and cursor inside the line, even in a very narrow terminal', () => {
  withBar(20, LONG_URL, ({ bar, draw }) => {
    for (const cols of [10, 4, 3, 2, 1, 80]) {
      process.stdout.columns = cols;
      const frame = draw(() => bar.render());
      assert.equal(frame.text.length, cols);
      assert.ok(frame.col >= 1 && frame.col <= cols, JSON.stringify(frame));
      assert.equal(bar.text, LONG_URL);
    }
    assert.deepEqual(draw(() => bar.render()), {
      text: (' > ' + LONG_URL).padEnd(80), col: LONG_URL.length + 4,
    });
    draw(() => bar.handleInput('\x1b[H'));
    process.stdout.columns = 20;
    assert.deepEqual(draw(() => bar.render()), { text: ' > ' + LONG_URL.slice(0, 17), col: 4 });
  });
});

test('URLs and status messages also stay on one line outside edit mode', () => {
  withBar(12, LONG_URL, ({ bar, draw }) => {
    const frame = draw(() => bar.cancelEditing());
    assert.equal(frame.text, '   https://e');
    bar.setStatus('あいうえおかきくけこ');
    assert.equal(draw(() => bar.render()).text, '   あいうえ ');
  });
});
