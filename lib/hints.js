// Vimium-style hint mode
// Alt+F shows labels on clickable/focusable elements, select by typing the label

import { dispatchClick } from './click.js';

const HINT_CHARS = ['a', 's', 'd', 'f', 'j', 'k', 'l'];
const MAX_HINTS = HINT_CHARS.length * HINT_CHARS.length; // 49

// Collect elements + generate labels + inject overlay in a single evaluate call
function makeCollectAndOverlayScript(hintChars, maxHints) {
  return `(() => {
  try {
    const old = document.getElementById('__casty_hints');
    if (old) old.remove();
    for (const el of document.querySelectorAll('[data-casty-hint-id]')) {
      el.removeAttribute('data-casty-hint-id');
    }

    const CLICKABLE = 'a, button, [role="button"], [onclick], summary, [role="link"], [role="tab"], [tabindex]';
    const FOCUSABLE = 'input, textarea, select, [contenteditable]';
    const all = document.querySelectorAll(CLICKABLE + ', ' + FOCUSABLE);

    const elems = [];
    for (const el of all) {
      if (elems.length >= ${maxHints}) break;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden'
          || style.pointerEvents === 'none' || Number(style.opacity) === 0) continue;

      // getClientRects handles wrapped links better than one large bounding
      // box whose centre may be whitespace or belong to another element.
      const rects = [...el.getClientRects()];
      if (!rects.length && el.firstElementChild) rects.push(...el.firstElementChild.getClientRects());
      let point = null;
      for (const rect of rects) {
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(innerWidth, rect.right);
        const bottom = Math.min(innerHeight, rect.bottom);
        if (right <= left || bottom <= top) continue;
        const cx = Math.round((left + right) / 2);
        const cy = Math.round((top + bottom) / 2);
        const hit = document.elementFromPoint(cx, cy);
        if (hit === el || el.contains(hit)) {
          point = { x: Math.round(left), y: Math.round(top), cx, cy };
          break;
        }
      }
      if (!point) continue;

      const isFocusable = el.matches('input, textarea, select, [contenteditable]');
      const id = String(elems.length);
      el.setAttribute('data-casty-hint-id', id);
      elems.push({
        id,
        ...point,
        type: isFocusable ? 'focus' : 'click',
      });
    }

    if (elems.length === 0) return JSON.stringify([]);

    // Generate labels
    const chars = ${JSON.stringify(hintChars)};
    const labels = [];
    if (elems.length <= chars.length) {
      for (let i = 0; i < elems.length; i++) labels.push(chars[i]);
    } else {
      for (const c1 of chars) {
        for (const c2 of chars) {
          labels.push(c1 + c2);
          if (labels.length >= elems.length) break;
        }
        if (labels.length >= elems.length) break;
      }
    }

    // Inject overlay
    const container = document.createElement('div');
    container.id = '__casty_hints';
    container.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    for (let i = 0; i < elems.length; i++) {
      const h = elems[i];
      h.label = labels[i];
      const span = document.createElement('span');
      span.textContent = labels[i].toUpperCase();
      span.dataset.label = labels[i];
      span.style.cssText = 'position:fixed;background:#FFEE00;color:#000;font:bold 12px monospace;border:1px solid #C38A00;border-radius:3px;padding:0 2px;z-index:2147483647;pointer-events:none;line-height:1.4;'
        + 'left:' + h.x + 'px;top:' + h.y + 'px;';
      container.appendChild(span);
    }
    document.documentElement.appendChild(container);

    return JSON.stringify(elems);
  } catch (e) {
    return JSON.stringify([]);
  }
})()`;
}

const COLLECT_OVERLAY_SCRIPT = makeCollectAndOverlayScript(HINT_CHARS, MAX_HINTS);

// Dim non-matching labels
function makeDimScript(buffer) {
  return `(() => {
    const c = document.getElementById('__casty_hints');
    if (!c) return;
    for (const span of c.children) {
      const label = span.dataset.label;
      span.style.opacity = label.startsWith('${buffer}') ? '1' : '0.2';
    }
  })()`;
}

// Remove overlay script
const REMOVE_OVERLAY_SCRIPT = `(() => {
  const el = document.getElementById('__casty_hints');
  if (el) el.remove();
})()`;

const CLEANUP_HINTS_SCRIPT = `(() => {
  const overlay = document.getElementById('__casty_hints');
  if (overlay) overlay.remove();
  for (const el of document.querySelectorAll('[data-casty-hint-id]')) {
    el.removeAttribute('data-casty-hint-id');
  }
})()`;

// Re-resolve the selected element after the overlay is gone. Wait for a
// stable, unobscured point so animations and late layout do not leave us
// clicking the coordinates captured when hint mode began.
function makeResolveHintScript(id, focus) {
  return `(async () => {
    const deadline = performance.now() + 2000;
    let previous = null;
    for (;;) {
      const el = document.querySelector('[data-casty-hint-id="${id}"]');
      if (!el) throw new Error('hint target disappeared');
      const style = getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden'
          && style.pointerEvents !== 'none' && Number(style.opacity) !== 0) {
        const rects = [...el.getClientRects()];
        if (!rects.length && el.firstElementChild) rects.push(...el.firstElementChild.getClientRects());
        for (const rect of rects) {
          const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
          const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
          if (right <= left || bottom <= top) continue;
          const x = (left + right) / 2, y = (top + bottom) / 2;
          const hit = document.elementFromPoint(x, y);
          if (hit !== el && !el.contains(hit)) continue;
          const stable = previous && previous.x === x && previous.y === y;
          previous = { x, y };
          if (stable) {
            ${focus ? 'el.focus({ preventScroll: true });' : ''}
            const anchor = el.closest('a[target="_blank"]');
            if (anchor) anchor.target = '_self';
            const form = el.closest('form[target="_blank"]');
            if (form) form.target = '_self';
            return { x, y };
          }
          break;
        }
      }
      if (performance.now() >= deadline) throw new Error('hint target is not actionable');
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  })()`;
}

export class HintMode {
  constructor(forceCapture) {
    this.active = false;
    this.buffer = '';
    this._client = null;
    this._hints = [];
    this._rawForceCapture = forceCapture || (() => {});
  }

  // Ensure frame capture after DOM changes (immediate + delayed retry)
  _forceCapture() {
    this._rawForceCapture();
    setTimeout(() => this._rawForceCapture(), 200);
  }

  // Finish initialization before accepting the next input chunk.
  async start(client) {
    this._client = client;
    this.buffer = '';

    // Single evaluate: collect elements + generate labels + inject overlay
    let hints;
    try {
      const { result } = await client.send('Runtime.evaluate', {
        expression: COLLECT_OVERLAY_SCRIPT,
      });
      hints = JSON.parse(result.value);
    } catch (e) {
      console.error(`casty: hints failed: ${e.message}`);
      return;
    }

    if (!hints || hints.length === 0) {
      console.error('casty: hints: no elements found');
      return;
    }

    console.error(`casty: hints: ${hints.length} elements`);
    this._hints = hints;
    this.active = true;
    this._forceCapture();
  }

  // Handle input (only called while active)
  async handleInput(str) {
    if (!this.active) return false;

    // Escape → cancel
    if (str === '\x1b') {
      await this._cancel();
      return true;
    }

    // Backspace → remove last buffer char
    if (str === '\x7f' || str === '\x08') {
      if (this.buffer.length > 0) {
        this.buffer = this.buffer.slice(0, -1);
        await this._updateDim();
      }
      return true;
    }

    // Ignore non-hint characters
    const ch = str.toLowerCase();
    if (ch.length !== 1 || !HINT_CHARS.includes(ch)) {
      return true;
    }

    this.buffer += ch;

    // Exact match check
    const exact = this._hints.find(h => h.label === this.buffer);
    if (exact) {
      await this._selectHint(exact);
      return true;
    }

    // Prefix match check
    const partial = this._hints.some(h => h.label.startsWith(this.buffer));
    if (!partial) {
      this.buffer = '';
      await this._updateDim();
      return true;
    }

    // Partial match — dim non-matching labels
    await this._updateDim();
    return true;
  }

  async _updateDim() {
    try {
      await this._client.send('Runtime.evaluate', {
        expression: this.buffer ? makeDimScript(this.buffer) : makeDimScript(''),
      });
      this._forceCapture();
    } catch {}
  }

  async _selectHint(hint) {
    await this._removeOverlay();

    try {
      const { result, exceptionDetails } = await this._client.send('Runtime.evaluate', {
        expression: makeResolveHintScript(hint.id, hint.type === 'focus'),
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) {
        throw new Error(exceptionDetails.exception?.description
          || exceptionDetails.text || 'hint target evaluation failed');
      }
      const point = result?.value;
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new Error('hint target returned no clickable point');
      }
      await dispatchClick(this._client, point.x, point.y);
    } catch (error) {
      console.error(`casty: hint click failed: ${error.message}`);
    } finally {
      await this._cleanupHints();
    }

    this._done();
    this._forceCapture();
  }

  async _cancel() {
    await this._cleanupHints();
    this._done();
    this._forceCapture();
  }

  _done() {
    this.active = false;
    this.buffer = '';
    this._hints = [];
  }

  async _removeOverlay() {
    try {
      await this._client.send('Runtime.evaluate', {
        expression: REMOVE_OVERLAY_SCRIPT,
      });
    } catch {}
  }

  async _cleanupHints() {
    try {
      await this._client.send('Runtime.evaluate', {
        expression: CLEANUP_HINTS_SCRIPT,
      });
    } catch {}
  }
}
