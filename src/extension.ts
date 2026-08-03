import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  buildAppServerLaunch,
  fetchRateLimitsFromAppServer,
} from './appServer';
import {
  formatStatusText,
  formatWindowLabel,
  RateLimitSnapshot,
  readLatestCodexRateLimits,
} from './rateLimits';

const REFRESH_INTERVAL_MS = 30_000;

function getAppServerLaunch() {
  const openAiExtension = vscode.extensions.getExtension('openai.chatgpt');
  if (!openAiExtension) {
    return {
      command: 'codex',
      args: ['app-server'],
      codexHome: path.join(os.homedir(), '.codex'),
    };
  }

  const useWsl = process.platform === 'win32'
    && vscode.workspace.getConfiguration('chatgpt')
      .get<boolean>('runCodexInWindowsSubsystemForLinux', false);

  return buildAppServerLaunch({
    platform: process.platform,
    architecture: process.arch,
    useWsl,
    extensionPath: openAiExtension.extensionPath,
    homeDirectory: os.homedir(),
  });
}

function formatExactReset(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

function buildTooltip(snapshot: RateLimitSnapshot): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown('**Codex usage limits**\n\n');
  tooltip.appendMarkdown(
    `- ${formatWindowLabel(snapshot.primary.windowMinutes)} window: `
    + `**${snapshot.primary.usedPercent}% used** — resets ${formatExactReset(snapshot.primary.resetsAt)}\n`,
  );
  tooltip.appendMarkdown(
    `- ${formatWindowLabel(snapshot.secondary.windowMinutes)} window: `
    + `**${snapshot.secondary.usedPercent}% used** — resets ${formatExactReset(snapshot.secondary.resetsAt)}\n\n`,
  );
  tooltip.appendMarkdown(`Last Codex update: ${new Date(snapshot.capturedAt).toLocaleString()}`);
  if (snapshot.planType) {
    tooltip.appendMarkdown(`\n\nPlan: ${snapshot.planType}`);
  }
  tooltip.appendMarkdown('\n\nClick to refresh.');
  return tooltip;
}

export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(
    'codex-usage.status',
    vscode.StatusBarAlignment.Left,
    -10_000,
  );
  status.name = 'Codex Usage';
  status.command = 'codex-usage.refresh';
  status.text = '$(zap) Codex usage…';
  status.tooltip = 'Reading Codex usage limits…';
  status.show();

  const sessionsDirectory = path.join(os.homedir(), '.codex', 'sessions');
  const appServerLaunch = getAppServerLaunch();
  let refreshing = false;

  const refresh = async (): Promise<void> => {
    if (refreshing) {
      return;
    }
    refreshing = true;

    try {
      let snapshot: RateLimitSnapshot | null = null;
      let liveError: Error | null = null;

      try {
        snapshot = await fetchRateLimitsFromAppServer(appServerLaunch);
      } catch (error) {
        liveError = error instanceof Error ? error : new Error(String(error));
        const cached = await readLatestCodexRateLimits(sessionsDirectory);
        if (cached && cached.primary.resetsAt * 1000 > Date.now()) {
          snapshot = cached;
        }
      }

      if (!snapshot) {
        status.text = '$(zap) Codex usage unavailable';
        status.tooltip = liveError?.message
          ?? `No current rate-limit snapshot found in ${sessionsDirectory}`;
        status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        return;
      }

      status.text = formatStatusText(snapshot);
      status.tooltip = buildTooltip(snapshot);
      status.backgroundColor = undefined;
    } catch (error) {
      status.text = '$(zap) Codex usage error';
      status.tooltip = error instanceof Error ? error.message : String(error);
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } finally {
      refreshing = false;
    }
  };

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand('codex-usage.refresh', refresh),
  );

  const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  void refresh();
}

export function deactivate(): void {}
