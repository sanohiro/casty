// Opt-in mouse diagnostics; never records keyboard input or page contents.
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const mouseTraceFile = process.env.CASTY_TRACE_MOUSE === '1'
  ? join(process.env.CASTY_TRACE_DIR || tmpdir(), `casty-mouse-${process.pid}-${Date.now()}.jsonl`)
  : null;
const started = Date.now();

export function traceMouse(event, details = {}) {
  if (!mouseTraceFile) return;
  try {
    appendFileSync(mouseTraceFile, JSON.stringify({ ms: Date.now() - started, event, ...details }) + '\n', { mode: 0o600 });
  } catch {}
}
