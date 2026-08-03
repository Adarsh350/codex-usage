const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAppServerLaunch,
  snapshotFromAppServerResult,
} = require('../out/appServer');

test('launches the bundled Linux Codex binary through WSL when Codex uses WSL', () => {
  assert.deepEqual(buildAppServerLaunch({
    platform: 'win32',
    architecture: 'arm64',
    useWsl: true,
    extensionPath: 'C:\\Users\\dev\\.vscode\\extensions\\openai.chatgpt-test',
    homeDirectory: 'C:\\Users\\dev',
  }), {
    command: 'wsl.exe',
    args: [
      '-e',
      '/mnt/c/Users/dev/.vscode/extensions/openai.chatgpt-test/bin/linux-aarch64/codex',
      'app-server',
    ],
    codexHome: undefined,
  });
});

test('launches the bundled native Codex binary outside WSL', () => {
  assert.deepEqual(buildAppServerLaunch({
    platform: 'win32',
    architecture: 'arm64',
    useWsl: false,
    extensionPath: 'C:\\Users\\dev\\.vscode\\extensions\\openai.chatgpt-test',
    homeDirectory: 'C:\\Users\\dev',
  }), {
    command: 'C:\\Users\\dev\\.vscode\\extensions\\openai.chatgpt-test\\bin\\windows-aarch64\\codex.exe',
    args: ['app-server'],
    codexHome: 'C:\\Users\\dev\\.codex',
  });
});

test('maps the official Codex app-server rate-limit response', () => {
  const snapshot = snapshotFromAppServerResult({
    rateLimits: {
      limitId: 'codex',
      planType: 'plus',
      primary: {
        usedPercent: 14,
        windowDurationMins: 300,
        resetsAt: 1781880000,
      },
      secondary: {
        usedPercent: 27,
        windowDurationMins: 10080,
        resetsAt: 1782400000,
      },
    },
  }, 1781870000000);

  assert.deepEqual(snapshot, {
    capturedAt: 1781870000000,
    planType: 'plus',
    primary: {
      usedPercent: 14,
      windowMinutes: 300,
      resetsAt: 1781880000,
    },
    secondary: {
      usedPercent: 27,
      windowMinutes: 10080,
      resetsAt: 1782400000,
    },
  });
});

test('prefers the codex bucket from the multi-limit response', () => {
  const snapshot = snapshotFromAppServerResult({
    rateLimits: null,
    rateLimitsByLimitId: {
      codex_other: {
        limitId: 'codex_other',
        primary: {
          usedPercent: 90,
          windowDurationMins: 60,
          resetsAt: 1781880000,
        },
      },
      codex: {
        limitId: 'codex',
        primary: {
          usedPercent: 4,
          windowDurationMins: 300,
          resetsAt: 1781880000,
        },
        secondary: {
          usedPercent: 8,
          windowDurationMins: 10080,
          resetsAt: 1782400000,
        },
      },
    },
  }, 1781870000000);

  assert.equal(snapshot.primary.usedPercent, 4);
  assert.equal(snapshot.secondary.usedPercent, 8);
});

test('rejects a response without both active Codex windows', () => {
  assert.equal(snapshotFromAppServerResult({
    rateLimits: {
      limitId: 'codex',
      primary: {
        usedPercent: 4,
        windowDurationMins: 300,
        resetsAt: 1781880000,
      },
      secondary: null,
    },
  }), null);
});
