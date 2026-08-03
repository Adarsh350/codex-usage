const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractSnapshotFromText,
  findLatestSnapshot,
  formatCountdown,
  formatStatusText,
} = require('../out/rateLimits');

function event(timestamp, primaryUsed, primaryReset, secondaryUsed, secondaryReset) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: {
          used_percent: primaryUsed,
          window_minutes: 300,
          resets_at: primaryReset,
        },
        secondary: {
          used_percent: secondaryUsed,
          window_minutes: 10080,
          resets_at: secondaryReset,
        },
        plan_type: 'plus',
      },
    },
  });
}

test('extracts the newest valid rate-limit snapshot from JSONL text', () => {
  const text = [
    '{"type":"message"}',
    event('2026-06-19T12:00:00.000Z', 10, 1000, 20, 2000),
    '{malformed',
    event('2026-06-19T12:05:00.000Z', 12, 1100, 21, 2100),
  ].join('\n');

  const snapshot = extractSnapshotFromText(text);

  assert.equal(snapshot.capturedAt, Date.parse('2026-06-19T12:05:00.000Z'));
  assert.equal(snapshot.primary.usedPercent, 12);
  assert.equal(snapshot.primary.windowMinutes, 300);
  assert.equal(snapshot.secondary.usedPercent, 21);
  assert.equal(snapshot.secondary.windowMinutes, 10080);
});

test('selects the newest snapshot across candidate files', async () => {
  const older = event('2026-06-19T10:00:00.000Z', 5, 1000, 10, 2000);
  const newer = event('2026-06-19T11:00:00.000Z', 6, 1100, 11, 2100);

  const snapshot = await findLatestSnapshot(
    ['older.jsonl', 'newer.jsonl'],
    async (file) => file === 'older.jsonl' ? older : newer,
  );

  assert.equal(snapshot.primary.usedPercent, 6);
  assert.equal(snapshot.secondary.usedPercent, 11);
});

test('formats reset countdowns without negative values', () => {
  const now = Date.parse('2026-06-19T12:00:00.000Z');

  assert.equal(formatCountdown(now + (2 * 60 + 7) * 60_000, now), '2h 7m');
  assert.equal(formatCountdown(now + (5 * 24 + 3) * 3_600_000, now), '5d 3h');
  assert.equal(formatCountdown(now - 1, now), 'now');
});

test('formats the compact status-bar text', () => {
  const now = Date.parse('2026-06-19T12:00:00.000Z');
  const snapshot = {
    capturedAt: now,
    planType: 'plus',
    primary: {
      usedPercent: 6,
      windowMinutes: 300,
      resetsAt: Math.floor((now + 2 * 3_600_000) / 1000),
    },
    secondary: {
      usedPercent: 18,
      windowMinutes: 10080,
      resetsAt: Math.floor((now + 5 * 24 * 3_600_000) / 1000),
    },
  };

  assert.equal(
    formatStatusText(snapshot, now),
    '$(zap) 6% 5h (2h 0m)  18% 7d (5d 0h)',
  );
});

test('derives window labels from Codex instead of assuming Claude windows', () => {
  const now = Date.parse('2026-06-19T12:00:00.000Z');
  const snapshot = {
    capturedAt: now,
    planType: 'plus',
    primary: {
      usedPercent: 9,
      windowMinutes: 60,
      resetsAt: Math.floor((now + 30 * 60_000) / 1000),
    },
    secondary: {
      usedPercent: 22,
      windowMinutes: 1440,
      resetsAt: Math.floor((now + 12 * 3_600_000) / 1000),
    },
  };

  assert.equal(
    formatStatusText(snapshot, now),
    '$(zap) 9% 1h (30m)  22% 1d (12h 0m)',
  );
});
