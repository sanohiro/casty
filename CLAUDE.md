# casty

TTY web browser using raw CDP and Kitty graphics protocol.

Remote desktop-like architecture: Chrome renders everything, casty bridges screen frames and input events to the terminal.

## Coding Conventions

- **Code comments, commit messages, and release notes must be in English**
- Keep code concise and idiomatic
- Prefer performance and readability

## Architecture

```
Chrome (headless-shell)      casty                Terminal (Ghostty/bcon/kitty)
┌─────────────────┐        ┌─────────────────┐   ┌─────────────────┐
│  Web rendering  │  ────→ │  CDP screencast │ ─→│  Kitty graphics │
│  JS execution   │        │  (change detect)│   │  display        │
│  WebRTC/Audio   │  ←──── │  Input events   │ ←─│  Mouse/Keyboard │
└─────────────────┘        └─────────────────┘   └─────────────────┘
```

Key points:
- Chrome does all rendering, JS execution, and WebRTC
- casty is just a screen + input bridge (~2300 lines)
- Raw CDP via `ws` package (no Playwright runtime dependency)
- `Runtime.enable` must never be sent (breaks Google login)

## Requirements

- **Kitty graphics protocol** — bcon, kitty, Ghostty, etc.
- Node.js >= 18
- `unzip` (for Chrome auto-install)
- chrome-headless-shell (auto-downloaded), or an explicitly selected external headless shell

## Files

```
bin/casty.js         Entry point, terminal setup, main loop
lib/browser.js       CDP browser control, hybrid frame capture, stealth patches
lib/cdp.js           Lightweight CDP WebSocket client
lib/chrome.js        Chrome binary detection and process launch
lib/input.js         Keyboard/mouse input handling, key bindings, clipboard
lib/kitty.js         Kitty graphics protocol output (file/inline transfer)
lib/urlbar.js        Address bar (always visible on line 1)
lib/hints.js         Vimium-style hint mode (Alt+F)
lib/config.js        Config loading (~/.casty/config.json)
lib/keys.js          Key binding config (~/.casty/keys.json)
lib/bookmarks.js     Bookmark search (~/.casty/bookmarks.json)
```

## Key Bindings (default)

| Key       | Action        |
|-----------|---------------|
| Ctrl+Q    | Quit          |
| Alt+Left  | Back          |
| Alt+Right | Forward       |
| Alt+L     | Address bar   |
| Alt+C     | Copy          |
| Ctrl+V    | Paste         |
| Alt+F     | Hint mode     |

Customizable via `~/.casty/keys.json`.

## Technical Notes

### Hybrid Frame Capture

Screencast (1/4 resolution) is used only as a change-detection trigger.
`Page.captureScreenshot` delivers full DPR-aware frames (~12fps).
Screencast ignores DPR, so using it directly produces blurry output.
Chrome's native scale is fixed at launch. Startup and resize use the same
viewport update: emulation scale is current DPR / native DPR, and visible size
is the floored CSS viewport multiplied by that scale. This matches screenshot
capture geometry and prevents hover from shifting during capture. Screenshot
capture, pointer input, and viewport changes are serialized.

### Stealth Patches

Injected via `Page.addScriptToEvaluateOnNewDocument` (no `Runtime.enable`).
Hides headless signals: plugins, mimeTypes, languages, window.chrome,
WebGL renderer, Permissions API, navigator.connection.
UA is unified to macOS Chrome with matching platform string.

### Kitty Graphics

Two transfer modes:
- **File transfer (t=f)**: fast, sends file path only (bcon, kitty)
- **Inline (t=d)**: sends base64 data in 4096B chunks (Ghostty, others)

Adaptive format: JPEG during rapid updates, PNG refinement after idle (file transfer).
PNG always for inline (Kitty protocol has no JPEG format code).

### Input

- SGR 1006 mouse protocol for clicks, drag, scroll
- macOS Option key: Unicode chars mapped back via rawBindings
- Linux: ESC prefix buffering (50ms) for split Alt+Key sequences
- OSC 52 for clipboard read/write

## Usage

```bash
casty https://google.com
```
