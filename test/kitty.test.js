import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';

const moduleUrl = new URL('../lib/kitty.js', import.meta.url);
const CURSOR_HOME = '\x1b[2;1H';

function tmuxWrap(seq) {
  return `\x1bPtmux;${seq.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`;
}

async function withKitty(env, fn) {
  const saved = {
    TMUX: process.env.TMUX,
    TERM_PROGRAM: process.env.TERM_PROGRAM,
  };

  if (env.TMUX === undefined) delete process.env.TMUX;
  else process.env.TMUX = env.TMUX;

  if (env.TERM_PROGRAM === undefined) delete process.env.TERM_PROGRAM;
  else process.env.TERM_PROGRAM = env.TERM_PROGRAM;

  const mod = await import(`${moduleUrl.href}?test=${Date.now()}-${Math.random()}`);

  try {
    return await fn(mod);
  } finally {
    if (saved.TMUX === undefined) delete process.env.TMUX;
    else process.env.TMUX = saved.TMUX;

    if (saved.TERM_PROGRAM === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = saved.TERM_PROGRAM;
  }
}

function captureStdout(fn) {
  const chunks = [];
  const originalWrite = process.stdout.write;

  process.stdout.write = (chunk, encoding, callback) => {
    const text = typeof chunk === 'string'
      ? chunk
      : chunk.toString(typeof encoding === 'string' ? encoding : undefined);
    chunks.push(text);

    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };

  try {
    fn();
    return chunks.join('');
  } finally {
    process.stdout.write = originalWrite;
  }
}

test('clearScreen keeps raw kitty output outside tmux', async () => {
  await withKitty({}, (kitty) => {
    const output = captureStdout(() => kitty.clearScreen());
    assert.equal(output, '\x1b_Ga=d,d=A,q=2;\x1b\\\x1b[2J\x1b[H');
  });
});

test('clearScreen wraps kitty delete sequence for tmux passthrough', async () => {
  await withKitty({ TMUX: '/tmp/tmux-1/default,1,0' }, (kitty) => {
    const output = captureStdout(() => kitty.clearScreen());
    assert.equal(output, `${tmuxWrap('\x1b_Ga=d,d=A,q=2;\x1b\\')}\x1b[2J\x1b[H`);
  });
});

test('sendFrame emits raw inline kitty graphics outside tmux', async () => {
  await withKitty({}, (kitty) => {
    kitty.setDisplaySize(10, 5);
    const output = captureStdout(() => kitty.sendFrame('abc'));
    assert.equal(output, `${CURSOR_HOME}\x1b_Ga=T,f=100,q=2,C=1,i=1,c=10,r=5;abc\x1b\\`);
  });
});

test('sendFrame wraps chunked inline kitty graphics for tmux', async () => {
  await withKitty({ TMUX: '/tmp/tmux-1/default,1,0' }, (kitty) => {
    kitty.setDisplaySize(10, 5);
    const payload = 'a'.repeat(5000);
    const sequence = [
      `\x1b_Ga=T,f=100,q=2,C=1,i=1,c=10,r=5,m=1;${payload.slice(0, 4096)}\x1b\\`,
      `\x1b_Gm=0;${payload.slice(4096)}\x1b\\`,
    ].join('');

    const output = captureStdout(() => kitty.sendFrame(payload));
    assert.equal(output, `${CURSOR_HOME}${tmuxWrap(sequence)}`);
  });
});

test('sendFrame wraps file transfer mode for tmux', async () => {
  await withKitty({ TMUX: '/tmp/tmux-1/default,1,0', TERM_PROGRAM: 'kitty' }, (kitty) => {
    kitty.setDisplaySize(10, 5);
    const tmpPathB64 = Buffer.from(join(tmpdir(), `casty-frame-${process.pid}.png`)).toString('base64');
    const output = captureStdout(() => kitty.sendFrame('YWJj'));

    assert.equal(
      output,
      `${CURSOR_HOME}${tmuxWrap(`\x1b_Ga=T,f=100,t=f,q=2,C=1,i=1,c=10,r=5;${tmpPathB64}\x1b\\`)}`,
    );

    kitty.cleanup();
  });
});

for (const TERM_PROGRAM of ['ghostty', 'kitty', 'bcon']) {
  for (const TMUX of [undefined, '/tmp/tmux-test']) {
    test(`frame replacement keeps the old image until transfer completes (${TERM_PROGRAM}, tmux=${!!TMUX})`, async () => {
      await withKitty({ TERM_PROGRAM, TMUX }, kitty => {
        try {
          kitty.setDisplaySize(20, 10);
          captureStdout(() => kitty.sendFrame('a'.repeat(9000)));
          const output = captureStdout(() => kitty.sendFrame('b'.repeat(9000)));
          const raw = TMUX ? output.slice(CURSOR_HOME.length + 7, -2).replaceAll('\x1b\x1b', '\x1b') : output.slice(CURSOR_HOME.length);
          assert.match(raw, /^\x1b_Ga=T,[^;]*i=2,c=20,r=10/);
          assert.ok(raw.endsWith('\x1b_Ga=d,d=I,i=1,q=2;\x1b\\'));
          if (kitty.transport === 'inline') {
            assert.ok(raw.indexOf('\x1b_Gm=0;') < raw.indexOf('a=d,d=I'));
          }
          assert.equal(captureStdout(() => kitty.sendFrame('b'.repeat(9000))), '');
          const next = captureStdout(() => kitty.sendFrame('c'.repeat(9000)));
          assert.match(next, /a=T,[^;]*i=1,c=20,r=10/);
          assert.match(next, /a=d,d=I,i=2,q=2/);
          captureStdout(() => kitty.clearScreen());
          const reset = captureStdout(() => kitty.sendFrame('c'.repeat(9000)));
          assert.match(reset, /a=T,[^;]*i=1,c=20,r=10/);
          assert.doesNotMatch(reset, /a=d/);
        } finally { kitty.cleanup(); }
      });
    });
  }
}

function noisePng(seed) {
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(body.length + 8);
    result.writeUInt32BE(data.length);
    body.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(32, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((64 * 3 + 1) * 32);
  for (let i = 0; i < pixels.length; i++) {
    if (i % 193 === 0) continue;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = seed >>> 24;
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

// Runs Kitty's actual parser and graphics state without opening a GUI window.
test('native Kitty retains a displayed image throughout chunked frame replacement', { skip: !process.env.CASTY_TEST_KITTY }, async () => {
  await withKitty({ TERM_PROGRAM: 'ghostty' }, kitty => {
    const frames = [];
    kitty.setDisplaySize(20, 10);
    for (let seed = 1; seed <= 6; seed++) frames.push(captureStdout(() => kitty.sendFrame(noisePng(seed))));
    const script = `
import base64, json, re
from kitty.fast_data_types import Screen, set_options
from kitty.options.types import defaults
set_options(defaults)
# Kitty runs Python with assertions disabled, so use explicit checks.
def check(condition, message='Native Kitty check failed'):
    if not condition:
        raise AssertionError(message)
screen = Screen(None, 24, 80, 100, 10, 20)
def parse(data, screen=screen):
    data = memoryview(data)
    while data:
        target = screen.test_create_write_buffer()
        n = screen.test_commit_write_buffer(data, target)
        data = data[n:]
        screen.test_parse_written_data(None)
displayed = set()
for index, frame in enumerate(json.loads(base64.b64decode('${Buffer.from(JSON.stringify(frames)).toString('base64')}'))):
    parse(b"\\x1b[2;1H")
    for command in re.findall(r'\\x1b_G.*?\\x1b\\\\', frame):
        if 'a=T,' in command:
            image_id = int(re.search(r',i=(\\d+)', command).group(1))
            check(image_id not in displayed, 'Retransmitting an image that is still displayed')
            uploading = image_id
        parse(command.encode())
        if 'a=d,' in command:
            displayed.discard(int(re.search(r',i=(\\d+)', command).group(1)))
        elif 'm=0;' in command:
            displayed.add(uploading)
        layers = screen.grman.update_layers(0, -1, 1, 2/80, 2/24, 80, 24, 10, 20)
        if index:
            check(layers, 'Displayed image vanished during transfer')
            images = [screen.grman.image_for_client_id(image_id) for image_id in displayed]
            check(any(img and img['root_frame_data_loaded'] and img['refs.count'] for img in images), 'No complete image remains during transfer')
        check(screen.grman.image_count <= 2, 'Old images are accumulating')
    check(len(layers) == 1, f'Frame {index}: layers={layers}')
    check(screen.grman.image_count == 1, f'Frame {index}: count={screen.grman.image_count}')
print('Six frames retained an image throughout transfer; no image leak')
`;
    const result = spawnSync(process.env.CASTY_TEST_KITTY, ['+runpy', script], {
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /Six frames retained an image/);
  });
});

for (const terminal of ['ghostty', 'kitty']) {
  test(`slow output retains only the newest frame and clear cancels it (${terminal})`, async () => {
    await withKitty({ TERM_PROGRAM: terminal }, kitty => {
      const originalWrite = process.stdout.write;
      const frames = [];
      const initialListeners = process.stdout.listenerCount('drain');
      process.stdout.write = chunk => { frames.push(chunk); return false; };
      try {
        kitty.sendFrame('first');
        for (let i = 0; i < 1000; i++) kitty.sendFrame('frame-' + i);
        assert.equal(frames.length, 1, 'blocked output must not buffer every frame');
        assert.equal(process.stdout.listenerCount('drain'), initialListeners + 1);
        process.stdout.emit('drain');
        assert.equal(frames.length, 2);
        if (terminal === 'ghostty') assert.ok(frames.at(-1).includes(';frame-999\x1b\\'));
        kitty.sendFrame('paused');
        kitty.resetFrameCache();
        process.stdout.emit('drain');
        assert.equal(frames.length, 2, 'pausing must discard a deferred frame');
        kitty.sendFrame('resumed');
        kitty.sendFrame('stale');
        kitty.clearScreen();
        assert.equal(process.stdout.listenerCount('drain'), initialListeners);
        const count = frames.length;
        process.stdout.emit('drain');
        assert.equal(frames.length, count, 'clear must not be followed by a stale deferred image');
      } finally {
        process.stdout.write = originalWrite;
        kitty.cleanup();
      }
    });
  });
}


test('capture format uses PNG unless the terminal supports JPEG file decoding', async () => {
  await withKitty({}, kitty => {
    for (const terminal of ['kitty', 'ghostty', 'bcon', '']) {
      for (const mode of ['file', 'inline']) {
        for (const requested of ['auto', 'png', 'jpeg']) {
          assert.equal(kitty.selectCaptureFormat(requested, mode, terminal),
            terminal === 'bcon' && mode === 'file' && requested !== 'png' ? 'jpeg' : 'png');
        }
      }
    }
  });
});
