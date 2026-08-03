import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface RateLimitWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
}

export interface RateLimitSnapshot {
  capturedAt: number;
  planType: string | null;
  primary: RateLimitWindow;
  secondary: RateLimitWindow;
}

interface RawWindow {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

interface RawRateLimits {
  plan_type?: unknown;
  primary?: RawWindow;
  secondary?: RawWindow;
}

const MAX_FILE_BYTES = 1024 * 1024;

function parseWindow(value: RawWindow | undefined): RateLimitWindow | null {
  if (
    typeof value?.used_percent !== 'number'
    || typeof value.window_minutes !== 'number'
    || typeof value.resets_at !== 'number'
  ) {
    return null;
  }

  return {
    usedPercent: value.used_percent,
    windowMinutes: value.window_minutes,
    resetsAt: value.resets_at,
  };
}

export function extractSnapshotFromText(text: string): RateLimitSnapshot | null {
  const lines = text.split(/\r?\n/);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line || !line.includes('"rate_limits"')) {
      continue;
    }

    try {
      const event = JSON.parse(line);
      const limits = event?.payload?.type === 'token_count'
        ? event.payload.rate_limits as RawRateLimits | undefined
        : undefined;
      const primary = parseWindow(limits?.primary);
      const secondary = parseWindow(limits?.secondary);
      const capturedAt = Date.parse(event?.timestamp);

      if (!primary || !secondary || !Number.isFinite(capturedAt)) {
        continue;
      }

      return {
        capturedAt,
        planType: typeof limits?.plan_type === 'string' ? limits.plan_type : null,
        primary,
        secondary,
      };
    } catch {
      // Ignore incomplete or malformed JSONL records.
    }
  }

  return null;
}

export async function findLatestSnapshot(
  files: string[],
  readText: (file: string) => Promise<string>,
): Promise<RateLimitSnapshot | null> {
  let latest: RateLimitSnapshot | null = null;

  for (const file of files) {
    try {
      const snapshot = extractSnapshotFromText(await readText(file));
      if (snapshot && (!latest || snapshot.capturedAt > latest.capturedAt)) {
        latest = snapshot;
      }
    } catch {
      // A session may be deleted or locked while it is being inspected.
    }
  }

  return latest;
}

async function listJsonlFiles(directory: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(entryPath);
      }
    }));
  }

  await visit(directory);
  return files;
}

async function readTail(file: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, MAX_FILE_BYTES);
    const start = Math.max(0, stats.size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function readLatestCodexRateLimits(
  sessionsDirectory: string,
): Promise<RateLimitSnapshot | null> {
  const files = await listJsonlFiles(sessionsDirectory);
  return findLatestSnapshot(files, readTail);
}

export function formatCountdown(resetAtMs: number, nowMs = Date.now()): string {
  const remainingMs = Math.max(0, resetAtMs - nowMs);
  const totalMinutes = Math.ceil(remainingMs / 60_000);

  if (totalMinutes <= 0) {
    return 'now';
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (totalHours >= 24) {
    const days = Math.floor(totalHours / 24);
    return `${days}d ${totalHours % 24}h`;
  }

  if (totalHours > 0) {
    return `${totalHours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

export function formatWindowLabel(windowMinutes: number): string {
  if (windowMinutes % 1440 === 0) {
    return `${windowMinutes / 1440}d`;
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h`;
  }
  return `${windowMinutes}m`;
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatStatusText(
  snapshot: RateLimitSnapshot,
  nowMs = Date.now(),
): string {
  const primaryReset = formatCountdown(snapshot.primary.resetsAt * 1000, nowMs);
  const secondaryReset = formatCountdown(snapshot.secondary.resetsAt * 1000, nowMs);

  return [
    `$(zap) ${formatPercent(snapshot.primary.usedPercent)}% ${formatWindowLabel(snapshot.primary.windowMinutes)} (${primaryReset})`,
    `${formatPercent(snapshot.secondary.usedPercent)}% ${formatWindowLabel(snapshot.secondary.windowMinutes)} (${secondaryReset})`,
  ].join('  ');
}
