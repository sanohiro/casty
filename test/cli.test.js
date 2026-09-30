import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseArgs } from '../lib/cli.js';
import { findChrome } from '../lib/chrome.js';

test('external shell path can precede or follow the URL', () => {
  const expected = { url: 'https://example.com', headlessShellPath: '/a path/headless_shell' };
  assert.deepEqual(parseArgs(['--headless-shell', expected.headlessShellPath, expected.url]), expected);
  assert.deepEqual(parseArgs([expected.url, '--headless-shell=' + expected.headlessShellPath]), expected);
  assert.deepEqual(parseArgs(['--headless-shell', expected.headlessShellPath]), { headlessShellPath: expected.headlessShellPath });
});

test('invalid command-line arguments fail rather than selecting a different browser', () => {
  for (const args of [['--headless-shell'], ['--headless-shell='], ['--headless-shell', '--help'], ['--unknown'], ['a', 'b']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('an explicit executable wins over managed downloads; invalid paths fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'casty-shell-test-'));
  try {
    const bin = join(dir, 'custom headless shell');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);
    assert.equal(findChrome(bin).bin, bin);
    chmodSync(bin, 0o644);
    assert.throws(() => findChrome(bin), /not executable/);
    assert.throws(() => findChrome(dir), /not executable/);
    assert.throws(() => findChrome(join(dir, 'missing')), /not executable/);
    assert.throws(() => findChrome(false), /must be a string/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('both entry points handle help before invoking the browser installer', () => {
  for (const [bin, args] of [[process.execPath, ['bin/casty.js']], ['bash', ['bin/casty']]]) {
    const output = execFileSync(bin, [...args, '--help'], { encoding: 'utf8' });
    assert.match(output, /--headless-shell PATH/);
    assert.doesNotMatch(output, /Installing/);
  }
});

test('startup uses config or CLI precedence and skips the managed installer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'casty-startup-test-'));
  try {
    mkdirSync(join(dir, '.casty'));
    const chosen = join(dir, 'chosen.json');
    const configShell = join(dir, 'configured-shell');
    const cliShell = join(dir, 'cli-shell');
    for (const bin of [configShell, cliShell]) {
      writeFileSync(bin, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(chosen)}, JSON.stringify(process.argv));\nprocess.exit(1);\n`);
      chmodSync(bin, 0o755);
    }
    // A mistakenly invoked installer must fail before it can download anything.
    const bash = join(dir, 'bash');
    writeFileSync(bash, '#!/bin/sh\nexit 99\n');
    chmodSync(bash, 0o755);
    writeFileSync(join(dir, '.casty', 'config.json'), JSON.stringify({ headlessShellPath: configShell }));
    for (const [args, expected] of [[[], configShell], [['--headless-shell', cliShell], cliShell]]) {
      rmSync(chosen, { force: true });
      const source = `
        import os from 'node:os';
        import { syncBuiltinESMExports } from 'node:module';
        os.homedir = () => ${JSON.stringify(dir)};
        syncBuiltinESMExports();
        process.argv = [process.execPath, 'casty', ...${JSON.stringify(args)}];
        await import(${JSON.stringify(new URL('../bin/casty.js', import.meta.url).href)});
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: dir, CASTY_ENSURE_CHROME: '' },
      });
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stderr, /installation failed|Installing/);
      const argv = JSON.parse(readFileSync(chosen, 'utf8'));
      assert.equal(argv[1], expected);
      assert.ok(argv.includes('--force-device-scale-factor=1.25'));
      assert.ok(!argv.includes('--headless=new'));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
