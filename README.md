# cdp-inject

[简体中文](README.zh-CN.md) | **English**

A zero-dependency script injector for Electron apps based on the **Chrome DevTools Protocol (CDP)**. It watches a local `scripts/` folder and injects every `.js` file into **every page** of a target Electron application (including `<webview>` guests), similar to how Tampermonkey works — but without any browser extension.

## Features

- **Zero dependencies** — only requires Node.js >= 22 (native `WebSocket` / `fetch`). No `npm install` needed.
- **Document-start injection** — new pages are paused via `Target.setAutoAttach` + `waitForDebuggerOnStart` until all scripts are registered, so your scripts run *before* any page code or network requests (equivalent to Tampermonkey's `document-start`).
- **No reload needed** — pages that were already open when the injector starts get the scripts executed immediately after registration.
- **Hot reload** — adding / modifying / deleting files in `scripts/` is picked up automatically (polled every second) and synced to all live pages.
- **Syntax pre-check** — a version with syntax errors never takes effect; the last known-good version keeps running until the file is fixed.
- **`@match` support** — optional match patterns declared in a script's header comment block restrict where it runs.
- **Isolated scope** — each script is wrapped in a block scope `{ ... }`, so top-level `let/const/class` never leak into the global scope and re-execution never throws "already declared".

## Requirements

- Node.js **>= 22**
- The target Electron app must expose the remote debugging port on **`127.0.0.1:9222`**

How to launch the target app with debugging enabled (example):

```powershell
your-app.exe --remote-debugging-port=9222
```

Or set the environment variable before launching (works for many Electron apps):

```powershell
$env:ELECTRON_ARGS = "--remote-debugging-port=9222"
```

## Usage

1. Put your scripts into the `scripts/` directory (an `example.js` is included).
2. Start the target Electron application with remote debugging on port 9222.
3. Run the injector — either double-click `start.bat`, or:

```powershell
node inject.js
# custom scripts directory:
node inject.js D:\path\to\my-scripts
```

4. Keep the window open. Close it (or `Ctrl+C`) to stop injecting.

Order matters: you can start the injector **before** the target app — it will connect automatically once the app appears. Pages already open when the injector connects are taken over and injected immediately.

## Writing Scripts

A script is a plain `.js` file. Optionally declare match patterns in the **header comment block** (only comments before the first line of code are parsed; if none are declared, the script applies to all pages):

```js
// @match https://example.com/*
// @match http://localhost:*/admin/*

// runs only on matching pages
console.log('hello from', location.href);
```

Match syntax: glob-like patterns where `*` matches any characters (e.g. `https://*/*`). The pattern is compiled to a regexp and tested against `location.href` at page runtime.

Notes:

- Scripts run in each page's main world (same context as page code).
- Each script body is wrapped in `{ ... }`, so top-level `let/const/class` are scoped and safe for hot reload.
- If a file has a syntax error, the previous valid version stays active and an error is printed to the injector console.
- In DevTools, injected scripts appear under the name `cdp-inject/<filename>` (via `//# sourceURL`).

## How It Works

1. Polls `http://127.0.0.1:9222/json/version` every second until the target app is up, then connects to its browser-level WebSocket endpoint.
2. Calls `Target.setAutoAttach` with `waitForDebuggerOnStart: true` so every new page target (type `page` or `webview`) is created **paused**.
3. On attach, registers all current scripts with `Page.addScriptToEvaluateOnNewDocument`, then calls `Runtime.runIfWaitingForDebugger` to release the page — guaranteeing document-start timing.
4. Every second, rescans the scripts directory. New/changed scripts are registered on all live sessions and removed ones are unregistered, with careful ordering to avoid a window where the old version is gone but the new one isn't registered yet.
5. Non-injectable targets (DevTools windows, workers) are released immediately so they never hang.

It also handles reconnects: if the app closes and relaunches, the injector re-attaches automatically, and uncaught errors are caught to prevent the process from dying while pages are paused waiting for injection.

## Project Structure

```
cdp-inject/
├── inject.js        # the injector (single file, zero dependencies)
├── start.bat        # Windows launcher
└── scripts/         # put your user scripts here
    └── example.js   # sample script
```

## Console Messages

| Prefix | Meaning |
|--------|---------|
| `[i]`  | Info (connected, loaded/removed scripts) |
| `[+]`  | A page was injected |
| `[*]`  | A script was updated |
| `[-]`  | A script was removed |
| `[!]`  | Error / warning |

## Disclaimer

This tool is intended for **debugging and automating your own applications**. Injecting scripts into applications you are not authorized to modify may violate their terms of service or applicable laws. Use responsibly.
