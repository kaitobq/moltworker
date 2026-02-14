import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH } from '../config';
import { shellEscapeArg } from './cli';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';

export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
}

const CONFIG_CHECK_TIMEOUT_MS = 5000;
const RSYNC_CHECK_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 200;
const MAX_LOG_CHARS = 2000;
const OPENCLAW_CONFIG_PATH = '/root/.openclaw/openclaw.json';
const CLAWDBOT_CONFIG_PATH = '/root/.clawdbot/clawdbot.json';

interface CommandResult {
  command: string;
  status: string;
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  durationMs: number;
  didComplete: boolean;
}

interface ConfigCheckResult extends CommandResult {
  path: string;
  exists: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateOutput(value: string): string {
  if (value.length <= MAX_LOG_CHARS) return value;
  return `${value.slice(0, MAX_LOG_CHARS)}\n...[truncated]`;
}

function formatCommandResult(result: CommandResult): Record<string, unknown> {
  return {
    command: result.command,
    status: result.status,
    exitCode: result.exitCode ?? null,
    didComplete: result.didComplete,
    durationMs: result.durationMs,
    stdout: truncateOutput(result.stdout),
    stderr: truncateOutput(result.stderr),
  };
}

function buildConfigCheckDetails(
  checks: ConfigCheckResult[],
  fsContext: { result?: CommandResult; error?: string },
): string {
  return JSON.stringify(
    {
      triedPaths: checks.map((check) => check.path),
      checks: checks.map((check) => ({
        path: check.path,
        exists: check.exists,
        ...formatCommandResult(check),
      })),
      fsContext: fsContext.result ? formatCommandResult(fsContext.result) : undefined,
      fsContextError: fsContext.error,
    },
    null,
    2,
  );
}

function buildRsyncCheckDetails(result: CommandResult): string {
  return JSON.stringify(
    {
      check: formatCommandResult(result),
    },
    null,
    2,
  );
}

async function runCommandWithDetails(
  sandbox: Sandbox,
  command: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const startedAt = Date.now();
  const proc = await sandbox.startProcess(command);

  await waitForProcess(proc, timeoutMs, POLL_INTERVAL_MS);

  const deadline = startedAt + timeoutMs;
  while ((proc.status === 'running' || proc.status === 'starting') && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- intentional sequential polling
    await sleep(POLL_INTERVAL_MS);
  }

  const logs = await proc.getLogs();
  const didComplete =
    proc.status !== 'running' && proc.status !== 'starting' && typeof proc.exitCode === 'number';

  return {
    command,
    status: proc.status,
    exitCode: proc.exitCode,
    stdout: logs.stdout ?? '',
    stderr: logs.stderr ?? '',
    durationMs: Date.now() - startedAt,
    didComplete,
  };
}

async function checkConfigPath(sandbox: Sandbox, path: string): Promise<ConfigCheckResult> {
  const command = `sh -lc "stat -c '%F %s %n' ${shellEscapeArg(path)}"`;
  const result = await runCommandWithDetails(sandbox, command, CONFIG_CHECK_TIMEOUT_MS);
  const exists = result.didComplete && result.exitCode === 0 && result.stdout.includes(path);

  return {
    ...result,
    path,
    exists,
  };
}

async function collectFilesystemContext(
  sandbox: Sandbox,
): Promise<{ result?: CommandResult; error?: string }> {
  const command =
    `sh -lc "pwd; id; ` +
    `echo '--- /root/.openclaw ---'; ls -la /root/.openclaw 2>&1 || true; ` +
    `echo '--- /root/.clawdbot ---'; ls -la /root/.clawdbot 2>&1 || true"`;

  try {
    const result = await runCommandWithDetails(sandbox, command, CONFIG_CHECK_TIMEOUT_MS);
    return { result };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Sync OpenClaw config and workspace from container to R2 for persistence.
 *
 * This function:
 * 1. Mounts R2 if not already mounted
 * 2. Verifies source has critical files (prevents overwriting good backup with empty data)
 * 3. Runs rsync to copy config, workspace, and skills to R2
 * 4. Writes a timestamp file for tracking
 *
 * Sync targets:
 * - Config: /root/.openclaw/ (or /root/.clawdbot/) -> R2:/openclaw/
 * - Workspace: /root/clawd/ -> R2:/workspace/ (primary), R2:/clawd/ (legacy compatibility)
 * - Skills: /root/clawd/skills/ -> R2:/skills/
 */
export async function syncToR2(sandbox: Sandbox, env: MoltbotEnv): Promise<SyncResult> {
  // Check if R2 is configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    return { success: false, error: 'R2 storage is not configured' };
  }

  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'Failed to mount R2 storage' };
  }

  // Determine which config file exists (new path first) using stat output and explicit diagnostics.
  let configDir = '/root/.openclaw';
  try {
    const checkNew = await checkConfigPath(sandbox, OPENCLAW_CONFIG_PATH);
    if (checkNew.exists) {
      configDir = '/root/.openclaw';
    } else {
      const checkLegacy = await checkConfigPath(sandbox, CLAWDBOT_CONFIG_PATH);
      if (checkLegacy.exists) {
        configDir = '/root/.clawdbot';
      } else if (!checkNew.didComplete || !checkLegacy.didComplete) {
        const fsContext = await collectFilesystemContext(sandbox);
        return {
          success: false,
          error: 'Sync aborted: config check did not complete',
          details: buildConfigCheckDetails([checkNew, checkLegacy], fsContext),
        };
      } else {
        const fsContext = await collectFilesystemContext(sandbox);
        return {
          success: false,
          error: 'Sync aborted: no config file found',
          details: buildConfigCheckDetails([checkNew, checkLegacy], fsContext),
        };
      }
    }
  } catch (err) {
    return {
      success: false,
      error: 'Failed to verify source files',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  // Verify rsync is available and healthy before starting sync.
  try {
    const rsyncCheck = await runCommandWithDetails(
      sandbox,
      'sh -lc "command -v rsync"',
      RSYNC_CHECK_TIMEOUT_MS,
    );
    if (!rsyncCheck.didComplete) {
      return {
        success: false,
        error: 'Sync aborted: rsync check did not complete',
        details: buildRsyncCheckDetails(rsyncCheck),
      };
    }

    if (rsyncCheck.exitCode !== 0 || rsyncCheck.stdout.trim() === '') {
      return {
        success: false,
        error: 'Sync aborted: rsync is not available',
        details: buildRsyncCheckDetails(rsyncCheck),
      };
    }
  } catch (err) {
    return {
      success: false,
      error: 'Sync aborted: rsync check failed',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  // Use --no-times because s3fs does not support setting timestamps.
  const syncCmd =
    `rsync -r --no-times --delete --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' ${configDir}/ ${R2_MOUNT_PATH}/openclaw/ && ` +
    `if [ -d /root/clawd ]; then rsync -r --no-times --delete --exclude='skills' /root/clawd/ ${R2_MOUNT_PATH}/workspace/; fi && ` +
    `if [ -d /root/clawd ]; then rsync -r --no-times --delete --exclude='skills' /root/clawd/ ${R2_MOUNT_PATH}/clawd/; fi && ` +
    `if [ -d /root/clawd/skills ]; then rsync -r --no-times --delete /root/clawd/skills/ ${R2_MOUNT_PATH}/skills/; fi && ` +
    `date -Iseconds > ${R2_MOUNT_PATH}/.last-sync`;

  try {
    const proc = await sandbox.startProcess(syncCmd);
    await waitForProcess(proc, 30000);

    // Verify success by reading the timestamp marker.
    const timestampProc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/.last-sync`);
    await waitForProcess(timestampProc, 5000);
    const timestampLogs = await timestampProc.getLogs();
    const lastSync = timestampLogs.stdout?.trim();

    if (lastSync && lastSync.match(/^\d{4}-\d{2}-\d{2}/)) {
      return { success: true, lastSync };
    }

    const logs = await proc.getLogs();
    return {
      success: false,
      error: 'Sync failed',
      details: logs.stderr || logs.stdout || 'No timestamp file created',
    };
  } catch (err) {
    return {
      success: false,
      error: 'Sync error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
