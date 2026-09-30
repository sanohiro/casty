Run the test suite with:

```sh
npm test
```

The hover integration tests automatically use an installed casty-managed headless
shell. To select another shell, set `CASTY_TEST_HEADLESS_SHELL`:

```sh
CASTY_TEST_HEADLESS_SHELL=/path/to/chrome-headless-shell node --test test/hover.test.js
```

To include the HTTP/WebSocket navigation and hint regressions, run the full
suite with an explicit shell path:

```sh
CASTY_TEST_HEADLESS_SHELL=/path/to/chrome-headless-shell npm test
```

The same command runs on macOS and Linux. If no managed shell or explicit path
is available, the browser tests are skipped; they do not download a browser.

The hover tests feed synthetic SGR pixel and cell reports into the production
input handler, run the production CDP command queue and capture loop against a
real Chromium process, and inspect the pixels in the emitted Kitty frames.
Both inline and file transfers are exercised. Cases cover enlarged startup,
shrinking and restoring cell sizes, stationary and continuous hover, delayed
hover painting, split mouse reports, clicks, drag selection, and wheel scrolling
in both directions without changing the scroll distance. Screencast
notifications are also suppressed to check that input-driven refreshes work.
The native Ghostty motion code `34` is exercised without a preceding press,
alongside standard code `35`; input tests preserve real button holds and releases.
Stationary hover is checked on rows 2 and 5 of a seven-row list through repeated
captures after enlargement, shrinkage, and reset. Compositor metadata is checked
as well as image pixels: taking a screenshot must not switch the viewport size.
Viewport queue tests also check that input waits for both metrics and visible
size updates, and that navigation restores the complete viewport.

These tests check the input-to-image bridge. Native terminal mouse reporting and
Kitty rendering still require a check in the target terminal on its actual OS.

To diagnose a native hover failure, launch the local build with:

```sh
CASTY_TRACE_MOUSE=1 ./bin/casty https://github.com/sanohiro/casty
```

The startup message shows a temporary `casty-mouse-*.jsonl` file. It records
terminal mouse reports, mapped pointer coordinates, CDP completion, capture
timings, and frame transmission. Keyboard input and page contents are not
recorded. Reproduce the problem, including font-size changes, then quit with
Ctrl+Q before inspecting the log. Tracing is disabled by default.

To save diagnostics in a shared checkout, create a log directory and select it
with `CASTY_TRACE_DIR`:

```sh
mkdir -p .local-logs
CASTY_TRACE_MOUSE=1 CASTY_TRACE_DIR="$PWD/.local-logs" ./bin/casty https://github.com/sanohiro/casty 2>.local-logs/bcon.log
```

The stderr log and `casty-mouse-*.jsonl` trace are both saved in `.local-logs/`,
which is ignored by Git. Standard output remains attached to the terminal.
