# Codex Usage

A VS Code status-bar item showing how much of your Codex rate limit you have
used, in both the short and long window:

```text
⚡ 6% 5h (2h 31m)  18% 7d (5d 14h)
```

Hover for exact reset timestamps and your plan type. Click the item, or run
**Codex Usage: Refresh**, to refresh immediately. It also refreshes itself
every 30 seconds.

## Where the numbers come from

The extension speaks JSON-RPC over stdio to the Codex app server and calls the
official `account/rateLimits/read` method. That is a live read of account
state, not an estimate.

Local Codex session logs under `~/.codex/sessions` are a **fallback only**, and
only when the newest record's primary window has not already expired:

```ts
const cached = await readLatestCodexRateLimits(sessionsDirectory);
if (cached && cached.primary.resetsAt * 1000 > Date.now()) {
  snapshot = cached;
}
```

An earlier version read the session logs first. That was wrong in a way that
looked right: the newest local record is often stale, so both windows rendered
as resetting `now`. Persisted event history describes what happened, not what
is currently true — when a service documents a live read endpoint, use it.

## Window labels are derived, not assumed

Codex reports each window's length, and `formatWindowLabel` computes the label
from that value rather than hardcoding a 5-hour/weekly schedule. If Codex
changes its limit windows, the status bar follows with no code change.
Windows divisible by 1,440 minutes render in days (`7d`), not weeks.

## Finding the right Codex binary

This took the longest to get right, and it is why the launch logic lives in its
own separately tested module.

The extension does not run whatever `codex` is on your `PATH`. It locates the
binary bundled inside the installed `openai.chatgpt` extension, matching your
platform and architecture (`arm64` maps to `aarch64`). If that extension is
absent, it falls back to a bare `codex` on the `PATH`.

The subtle case is WSL. When `chatgpt.runCodexInWindowsSubsystemForLinux` is
enabled, Codex runs in Linux against `/home/<user>/.codex` — while the VS Code
extension host is still Windows. Launching the native Windows binary in that
setup points `CODEX_HOME` at `C:\Users\<user>\.codex`, a **different account
store**, whose token may be invalid. The symptom is "Codex usage unavailable"
while Codex itself works fine a few pixels away in the same window.

So under WSL the extension launches the bundled Linux binary through `wsl.exe`,
translating the Windows extension path to `/mnt/c/...`, and deliberately leaves
`CODEX_HOME` unset so Codex resolves its own:

```ts
{ command: 'wsl.exe',
  args: ['-e', '/mnt/c/Users/dev/.vscode/extensions/openai.chatgpt/bin/linux-aarch64/codex', 'app-server'],
  codexHome: undefined }
```

The general rule: a companion extension should follow the host extension's
runtime and credential store, not infer them from the extension host's OS.

## Failure modes

Each path that can fail degrades to a visible state rather than a silent one:

- Live read fails, cached window still active → cached numbers.
- Live read fails, no unexpired cache → `Codex usage unavailable`, warning
  background, underlying error in the tooltip.
- App server never responds → 10s timeout, then that same warning path.
- Response missing either window → treated as no data, never as zero usage.
- A refresh already in flight → the next tick is skipped, so a slow app server
  cannot stack overlapping child processes.

The child process is killed and the readline interface closed on every exit
path, the timeout included. Malformed JSONL lines are skipped rather than
aborting the scan, and each session file is read from its tail with a 1 MB cap
so a large log costs a bounded read.

## Layout

```
src/rateLimits.ts   session-log parsing, formatting, window labels
src/appServer.ts    binary resolution (incl. WSL) + JSON-RPC client
src/extension.ts    status-bar item, refresh loop, tooltip
test/               node:test unit tests, no extension host required
```

`rateLimits.ts` and `appServer.ts` import nothing from `vscode`. That is what
lets the tests run in plain Node — the `vscode` dependency is confined to
`extension.ts`.

## Build and test

```bash
npm install
npm run build     # tsc -p .
npm test          # builds, then runs node --test against out/
npm run package   # vsce package -> .vsix
```

Install the `.vsix` through **Extensions: Install from VSIX…** in the command
palette.

## Requirements

VS Code 1.96+ and Codex signed in, normally via the `openai.chatgpt` extension.
No API key, no configuration, and no network calls of its own.

## License

MIT
