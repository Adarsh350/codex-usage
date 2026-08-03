import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { RateLimitSnapshot, RateLimitWindow } from './rateLimits';

export interface AppServerLaunchOptions {
  platform: NodeJS.Platform;
  architecture: string;
  useWsl: boolean;
  extensionPath: string;
  homeDirectory: string;
}

export interface AppServerLaunch {
  command: string;
  args: string[];
  codexHome?: string;
}

interface AppServerWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface AppServerLimit {
  limitId?: unknown;
  planType?: unknown;
  primary?: AppServerWindow | null;
  secondary?: AppServerWindow | null;
}

interface AppServerResult {
  rateLimits?: AppServerLimit | null;
  rateLimitsByLimitId?: Record<string, AppServerLimit> | null;
}

function architectureDirectory(architecture: string): string {
  return architecture === 'arm64' ? 'aarch64' : 'x86_64';
}

function windowsPathToWsl(value: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  if (!match) {
    return value.replaceAll('\\', '/');
  }

  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

export function buildAppServerLaunch(options: AppServerLaunchOptions): AppServerLaunch {
  const architecture = architectureDirectory(options.architecture);

  if (options.platform === 'win32' && options.useWsl) {
    const linuxCodex = windowsPathToWsl(path.win32.join(
      options.extensionPath,
      'bin',
      `linux-${architecture}`,
      'codex',
    ));

    return {
      command: 'wsl.exe',
      args: ['-e', linuxCodex, 'app-server'],
      codexHome: undefined,
    };
  }

  const platformDirectory = options.platform === 'win32'
    ? `windows-${architecture}`
    : `${options.platform}-${architecture}`;
  const executable = options.platform === 'win32' ? 'codex.exe' : 'codex';
  const join = options.platform === 'win32' ? path.win32.join : path.join;

  return {
    command: join(options.extensionPath, 'bin', platformDirectory, executable),
    args: ['app-server'],
    codexHome: join(options.homeDirectory, '.codex'),
  };
}

function parseWindow(value: AppServerWindow | null | undefined): RateLimitWindow | null {
  if (
    typeof value?.usedPercent !== 'number'
    || typeof value.windowDurationMins !== 'number'
    || typeof value.resetsAt !== 'number'
  ) {
    return null;
  }

  return {
    usedPercent: value.usedPercent,
    windowMinutes: value.windowDurationMins,
    resetsAt: value.resetsAt,
  };
}

export function snapshotFromAppServerResult(
  result: AppServerResult,
  capturedAt = Date.now(),
): RateLimitSnapshot | null {
  const multiBucket = result.rateLimitsByLimitId?.codex;
  const singleBucket = result.rateLimits?.limitId === 'codex' ? result.rateLimits : null;
  const limits = multiBucket ?? singleBucket;
  const primary = parseWindow(limits?.primary);
  const secondary = parseWindow(limits?.secondary);

  if (!primary || !secondary) {
    return null;
  }

  return {
    capturedAt,
    planType: typeof limits?.planType === 'string' ? limits.planType : null,
    primary,
    secondary,
  };
}

export function fetchRateLimitsFromAppServer(
  launch: AppServerLaunch,
  timeoutMs = 10_000,
): Promise<RateLimitSnapshot> {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    if (launch.codexHome) {
      environment.CODEX_HOME = launch.codexHome;
    } else {
      delete environment.CODEX_HOME;
    }

    const child = spawn(launch.command, launch.args, {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const lines = readline.createInterface({ input: child.stdout });
    let stderr = '';
    let finished = false;

    const finish = (error?: Error, snapshot?: RateLimitSnapshot): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      lines.close();
      child.kill();

      if (error) {
        reject(error);
      } else if (snapshot) {
        resolve(snapshot);
      } else {
        reject(new Error('Codex returned no rate-limit data.'));
      }
    };

    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const timer = setTimeout(
      () => finish(new Error('Timed out while reading Codex rate limits.')),
      timeoutMs,
    );

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_000) {
        stderr += chunk.toString();
      }
    });

    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      if (!finished) {
        const detail = stderr.trim();
        finish(new Error(
          detail || `Codex app server exited before responding (code ${code ?? 'unknown'}).`,
        ));
      }
    });

    lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.id === 0 && message.result) {
        send({ method: 'initialized', params: {} });
        send({ method: 'account/rateLimits/read', id: 1 });
        return;
      }

      if (message.id !== 1) {
        return;
      }

      if (message.error) {
        finish(new Error(message.error.message ?? 'Codex rate-limit request failed.'));
        return;
      }

      const snapshot = snapshotFromAppServerResult(message.result ?? {});
      if (!snapshot) {
        finish(new Error('Codex did not return both primary and secondary usage windows.'));
        return;
      }

      finish(undefined, snapshot);
    });

    send({
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: {
          name: 'codex_usage_vscode',
          title: 'Codex Usage',
          version: '1.0.0',
        },
      },
    });
  });
}
