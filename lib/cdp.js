// CDP WebSocket client
// Lightweight CDP client that never sends Runtime.enable

import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { traceMouse } from './trace.js';

const CDP_TIMEOUT = 10000; // ms — reject pending commands after this
const VIEWPORT_COMMANDS = new Set([
  'Page.captureScreenshot', 'Input.dispatchMouseEvent', 'Emulation.setDeviceMetricsOverride',
]);

export class CDPClient extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._id = 0;
    this._pending = new Map();
    this._viewportQueue = Promise.resolve();
    this._viewportReset = Promise.resolve();
    this._deviceMetrics = null;
    this._captureEpoch = 0;
  }

  // Connect via WebSocket
  async connect(wsUrl) {
    this._ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    this._ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); }
      catch { return; } // Ignore non-JSON frames
      if (msg.id !== undefined) {
        // Command response
        const p = this._pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this._pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result || {});
        }
      } else if (msg.method) {
        if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) {
          this._interruptCaptures();
        }
        // CDP event
        this.emit(msg.method, msg.params || {});
      }
    });
    this._ws.on('close', () => this.emit('close'));
    this._ws.on('error', (err) => this.emit('error', err));
    // once() rejects on 'error' if it fires before 'open'
    await once(this._ws, 'open');
  }

  // Send CDP command (with timeout to prevent forever-pending)
  send(method, params = {}, timeoutMs = CDP_TIMEOUT) {
    // Captures, pointer input, and viewport changes share committed geometry.
    if (!VIEWPORT_COMMANDS.has(method)) return this._send(method, params, timeoutMs);
    const epoch = this._captureEpoch;
    const result = this._viewportQueue.then(async () => {
      await this._viewportReset;
      if (method === 'Page.captureScreenshot' && epoch !== this._captureEpoch) {
        throw new Error('Navigation interrupted screenshot');
      }
      return method === 'Emulation.setDeviceMetricsOverride'
        ? this._applyDeviceMetrics(params, timeoutMs)
        : this._send(method, params, timeoutMs);
    });
    this._viewportQueue = result.catch(() => {});
    return result;
  }

  // Keep the view at capture resolution so screenshots do not rescale hover.
  setViewport({ width, height, zoom, nativeScale = zoom }) {
    return this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: zoom, mobile: false,
      scale: zoom / nativeScale, dontSetVisibleSize: true,
    });
  }

  async _applyDeviceMetrics(params, timeoutMs) {
    const result = await this._send('Emulation.setDeviceMetricsOverride', params, timeoutMs);
    if (params.dontSetVisibleSize && params.scale) {
      // Match captureScreenshot's floored widget size. Apply both commands
      // before releasing queued input or captures.
      const width = Math.max(1, Math.floor(params.width * params.scale));
      const height = Math.max(1, Math.floor(params.height * params.scale));
      await this._send('Emulation.setVisibleSize', { width, height }, timeoutMs);
      traceMouse('viewport-scale', { scale: params.scale, width, height });
    }
    this._deviceMetrics = { ...params };
    return result;
  }

  _interruptCaptures() {
    this._captureEpoch++;
    // Chrome can abandon a screenshot callback when navigation replaces its
    // renderer. Restore the viewport before releasing queued pointer input.
    const captures = [...this._pending].filter(([, pending]) => pending.method === 'Page.captureScreenshot');
    if (captures.length && this._deviceMetrics) {
      this._viewportReset = this._applyDeviceMetrics(this._deviceMetrics, CDP_TIMEOUT)
        .catch(() => {});
    }
    for (const [id, pending] of captures) {
      clearTimeout(pending.timer);
      this._pending.delete(id);
      pending.reject(new Error('Navigation interrupted screenshot'));
    }
  }

  _send(method, params, timeoutMs) {
    if (method === 'Input.dispatchMouseEvent' && this._deviceMetrics?.dontSetVisibleSize) {
      // CDP injects widget DIPs; callers use viewport CSS coordinates.
      // Wheel distances stay in CSS pixels; only the hit point scales.
      const scale = this._deviceMetrics.scale || 1;
      params = { ...params, x: params.x * scale, y: params.y * scale };
      traceMouse('pointer-wire', { type: params.type, x: params.x, y: params.y, scale });
    }
    const id = ++this._id;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const timer = setTimeout(() => {
      this._pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, timeoutMs);
    this._pending.set(id, { resolve, reject, timer, method });
    try {
      this._ws.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      // ws.send() can throw synchronously if socket is closed
      clearTimeout(timer);
      this._pending.delete(id);
      reject(err);
    }
    return promise;
  }

  // Disconnect
  close() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection closed'));
    }
    this._pending.clear();
  }
}
