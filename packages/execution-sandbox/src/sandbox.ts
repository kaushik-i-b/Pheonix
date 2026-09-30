import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { PhoenixError, canonicalizePath, nowIso, pathIsInsideAny, type IsoTimestamp } from '@phoenix/shared';

/**
 * The controlled execution layer.
 *
 * Agents never get a shell. A command is a program plus an argument vector, spawned without
 * `shell: true`, so nothing an LLM writes can be reinterpreted as shell syntax. On top of that the
 * sandbox enforces: a command allowlist, cwd confinement to the run's directories, an environment
 * allowlist (so `LLM_API_KEY` and friends never reach a spawned build), a timeout that actually
 * kills the process, and an output cap. Every execution is recorded whether it succeeded or not.
 *
 * Known limitation, stated plainly: without a container or namespace this process cannot stop a
 * child from opening a network socket. `allowNetwork` is therefore recorded as intent and
 * enforced by the *tool* layer (which refuses `http_request` to unlisted targets), not by the
 * kernel. Running Phoenix under Docker removes the limitation; see docs/security.md.
 */

export interface CommandRequest {
  program: string;
  args?: string[];
  cwd: string;
  /** Extra variables for this command, added on top of the allowlisted environment. */
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Free-form label used in logs, e.g. the tool call id or the stage that asked for it. */
  label?: string;
  signal?: AbortSignal;
}

export interface CommandResult {
  command: string;
  argv: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  startedAt: IsoTimestamp;
  finishedAt: IsoTimestamp;
  durationMs: number;
  timedOut: boolean;
  /** Present only when the process could not be started at all (e.g. program not found). */
  spawnError?: { code: string; message: string };
}

/** The audit record required by the tool-security section of the brief. */
export interface CommandExecutionRecord {
  command: string;
  argv: string[];
  cwd: string;
  label?: string;
  startedAt: IsoTimestamp;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputSummary: string;
  outputBytes: number;
  truncated: boolean;
  denied?: { reason: string; command: string };
}

export interface SandboxOptions {
  /** Anchored regexes; the command line must match one of them. Empty means nothing may run. */
  commandPatterns: readonly string[];
  /** Directories a command may use as its working directory. */
  allowedCwdRoots: readonly string[];
  envAllowlist?: readonly string[];
  env?: Record<string, string>;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  killSignal?: NodeJS.Signals;
  allowNetwork?: boolean;
  onExecution?: (record: CommandExecutionRecord) => void;
  /** Base environment; defaults to `process.env`. Tests inject a fixed one. */
  baseEnv?: NodeJS.ProcessEnv;
}

const DEFAULT_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'JAVA_HOME', 'TMPDIR'];
const SUMMARY_LIMIT = 2000;

export class ExecutionSandbox {
  private readonly patterns: RegExp[];
  private readonly options: SandboxOptions;
  readonly executions: CommandExecutionRecord[] = [];

  constructor(options: SandboxOptions) {
    this.options = options;
    this.patterns = options.commandPatterns.map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch (error) {
        throw new PhoenixError('CONFIG_INVALID', `command pattern is not a valid regex: ${pattern}`, {
          pattern,
        }, error);
      }
    });
  }

  /** Command line as it will appear in logs and permission checks. */
  static commandLine(program: string, args: readonly string[] = []): string {
    return [program, ...args].map(quoteArg).join(' ');
  }

  checkPermission(request: CommandRequest): void {
    const command = ExecutionSandbox.commandLine(request.program, request.args ?? []);
    if (this.patterns.length === 0 || !this.patterns.some((pattern) => pattern.test(command))) {
      this.deny(request, command, `command does not match any allowed pattern for this role`);
    }
    this.assertCwdInScope(request, command);
  }

  private assertCwdInScope(request: CommandRequest, command: string): void {
    const roots = this.options.allowedCwdRoots;
    if (!isAbsolute(request.cwd)) {
      this.deny(request, command, `cwd must be absolute: ${request.cwd}`);
    }
    const cwd = canonicalizePath(resolve(request.cwd));
    const inside = pathIsInsideAny(cwd, roots.map(canonicalizePath));
    if (!inside) {
      this.deny(request, command, `cwd ${cwd} is outside the permitted roots`);
    }
  }

  private deny(request: CommandRequest, command: string, reason: string): never {
    const record: CommandExecutionRecord = {
      command,
      argv: [request.program, ...(request.args ?? [])],
      cwd: request.cwd,
      ...(request.label !== undefined ? { label: request.label } : {}),
      startedAt: nowIso(),
      durationMs: 0,
      exitCode: null,
      signal: null,
      timedOut: false,
      outputSummary: '',
      outputBytes: 0,
      truncated: false,
      denied: { reason, command },
    };
    this.executions.push(record);
    this.options.onExecution?.(record);
    throw new PhoenixError('SANDBOX_COMMAND_DENIED', `refused to run "${command}": ${reason}`, {
      command,
      reason,
      cwd: request.cwd,
      allowedPatterns: this.options.commandPatterns,
    });
  }

  async execute(request: CommandRequest): Promise<CommandResult> {
    this.checkPermission(request);
    const command = ExecutionSandbox.commandLine(request.program, request.args ?? []);
    const argv = [request.program, ...(request.args ?? [])];
    const cwd = canonicalizePath(resolve(request.cwd));
    const timeoutMs = request.timeoutMs ?? this.options.defaultTimeoutMs ?? 120_000;
    const maxOutputBytes = request.maxOutputBytes ?? this.options.maxOutputBytes ?? 1_048_576;
    const killSignal = this.options.killSignal ?? 'SIGTERM';

    const startedAt = nowIso();
    const started = Date.now();
    const stdout = new BoundedBuffer(maxOutputBytes);
    const stderr = new BoundedBuffer(maxOutputBytes);

    const child = spawn(request.program, request.args ?? [], {
      cwd,
      env: this.buildEnv(request.env),
      shell: false,
      windowsHide: true,
    });

    let timedOut = false;
    let spawnError: { code: string; message: string } | undefined;

    const completion = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill(killSignal);
      }, timeoutMs);

      const onAbort = (): void => {
        timedOut = true;
        child.kill(killSignal);
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        resolvePromise({ exitCode, signal });
      };

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      // A program that cannot be spawned emits 'error' and never 'close'; both must settle.
      child.once('error', (error: NodeJS.ErrnoException) => {
        spawnError = { code: error.code ?? 'ERROR', message: error.message };
        finish(null, null);
      });
      child.once('close', (exitCode, signal) => finish(exitCode, signal));
    });

    const { exitCode, signal } = await completion;
    const durationMs = Date.now() - started;
    const finishedAt = nowIso();

    const result: CommandResult = {
      command,
      argv,
      cwd,
      exitCode,
      signal,
      stdout: stdout.text(),
      stderr: stderr.text(),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      startedAt,
      finishedAt,
      durationMs,
      timedOut,
      ...(spawnError !== undefined ? { spawnError } : {}),
    };

    const record: CommandExecutionRecord = {
      command,
      argv,
      cwd,
      ...(request.label !== undefined ? { label: request.label } : {}),
      startedAt,
      durationMs,
      exitCode,
      signal,
      timedOut,
      outputSummary: summarize(result),
      outputBytes: stdout.bytes + stderr.bytes,
      truncated: stdout.truncated || stderr.truncated,
    };
    this.executions.push(record);
    this.options.onExecution?.(record);

    if (timedOut && exitCode === null && spawnError === undefined) {
      // A hung build is a failure the caller must see, not a silent empty result.
      throw new PhoenixError('SANDBOX_TIMEOUT', `command timed out after ${timeoutMs}ms: ${command}`, {
        command,
        timeoutMs,
        cwd,
        stderr: result.stderr.slice(0, SUMMARY_LIMIT),
      });
    }
    return result;
  }

  private buildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const allowlist = this.options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST;
    const base = this.options.baseEnv ?? process.env;
    const env: NodeJS.ProcessEnv = {};
    for (const name of allowlist) {
      const value = base[name];
      if (value !== undefined) env[name] = value;
    }
    for (const [name, value] of Object.entries(this.options.env ?? {})) env[name] = value;
    for (const [name, value] of Object.entries(extra)) env[name] = value;
    return env;
  }
}

class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  bytes = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.truncated) return;
    const remaining = this.limit - this.bytes;
    if (chunk.byteLength <= remaining) {
      this.chunks.push(chunk);
      this.bytes += chunk.byteLength;
      return;
    }
    this.chunks.push(chunk.subarray(0, Math.max(0, remaining)));
    this.bytes += Math.max(0, remaining);
    this.truncated = true;
  }

  text(): string {
    const text = Buffer.concat(this.chunks).toString('utf8');
    return this.truncated ? `${text}\n[output truncated at ${this.limit} bytes]` : text;
  }
}

function summarize(result: CommandResult): string {
  const parts = [
    `exit=${result.exitCode ?? 'null'}`,
    result.timedOut ? 'timed-out' : undefined,
    result.spawnError !== undefined ? `spawn-error=${result.spawnError.code}` : undefined,
  ].filter((part) => part !== undefined);
  const tail = (result.stdout.trim() || result.stderr.trim()).slice(-SUMMARY_LIMIT);
  return [...parts, tail].filter((part) => part.length > 0).join(' | ').slice(0, SUMMARY_LIMIT);
}

/** POSIX single-quote escaping so the logged command line cannot be confused with another one. */
export function quoteArg(arg: string): string {
  if (arg.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}
