import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PhoenixError } from '@phoenix/shared';
import {
  ExecutionSandbox,
  quoteArg,
  type CommandExecutionRecord,
  type CommandRequest,
  type SandboxOptions,
} from '../src/index.js';

const directories: string[] = [];
function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-sandbox-'));
  directories.push(directory);
  return directory;
}
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const NODE = process.execPath;

function sandbox(cwd: string, overrides: Partial<SandboxOptions> = {}): { sandbox: ExecutionSandbox; records: CommandExecutionRecord[] } {
  const records: CommandExecutionRecord[] = [];
  return {
    sandbox: new ExecutionSandbox({
      commandPatterns: [`^${quoteArg(NODE)} `],
      allowedCwdRoots: [cwd],
      envAllowlist: ['PATH'],
      defaultTimeoutMs: 10_000,
      onExecution: (record) => records.push(record),
      ...overrides,
    }),
    records,
  };
}

function nodeEval(cwd: string, script: string, extra: Partial<CommandRequest> = {}): CommandRequest {
  return { program: NODE, args: ['-e', script], cwd, ...extra };
}

describe('ExecutionSandbox', () => {
  it('runs an allowed command and reports exit code, output and duration', async () => {
    const cwd = workspace();
    const { sandbox: box, records } = sandbox(cwd);
    const result = await box.execute(
      nodeEval(cwd, 'process.stdout.write("hello\\n"); process.exit(0);'),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello\n');
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.command).toBe(`${quoteArg(NODE)} -e 'process.stdout.write(\"hello\\n\"); process.exit(0);'`);
    expect(records).toHaveLength(1);
    expect(records[0]?.outputSummary).toContain('exit=0');
    expect(records[0]?.outputSummary).toContain('hello');
  });

  it('returns a non-zero exit code as data instead of throwing', async () => {
    const cwd = workspace();
    const { sandbox: box } = sandbox(cwd);
    const result = await box.execute(nodeEval(cwd, 'process.stderr.write("boom\\n"); process.exit(3);'));
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('boom\n');
  });

  it('denies a command that matches no allowed pattern and records the denial', async () => {
    const cwd = workspace();
    const { sandbox: box, records } = sandbox(cwd, { commandPatterns: ['^mvn -DskipTests package$'] });
    try {
      await box.execute({ program: 'rm', args: ['-rf', cwd], cwd });
      throw new Error('execute should have thrown');
    } catch (error) {
      expect((error as PhoenixError).code).toBe('SANDBOX_COMMAND_DENIED');
      expect((error as PhoenixError).details.command).toBe(`rm -rf ${cwd}`);
    }
    expect(records).toHaveLength(1);
    expect(records[0]?.denied?.reason).toContain('does not match any allowed pattern');
  });

  it('denies everything when a role has no command patterns at all', async () => {
    const cwd = workspace();
    const { sandbox: box } = sandbox(cwd, { commandPatterns: [] });
    await expect(box.execute(nodeEval(cwd, 'process.exit(0)'))).rejects.toMatchObject({
      code: 'SANDBOX_COMMAND_DENIED',
    });
  });

  it('cannot be smuggled past an anchored pattern through an argument', () => {
    // No shell is involved, and the logged command line quotes the argument, so the injection is
    // both inert at execution time and visible to the pattern check.
    const line = ExecutionSandbox.commandLine('bash', ['./run.sh; rm -rf /']);
    expect(line).toBe(`bash './run.sh; rm -rf /'`);
    expect(/^(bash|sh) \.\/run\.sh$/.test(line)).toBe(false);
  });

  it('confines the working directory to the run roots', async () => {
    const cwd = workspace();
    const { sandbox: box } = sandbox(cwd);
    await expect(box.execute(nodeEval('/', 'process.exit(0)'))).rejects.toMatchObject({
      code: 'SANDBOX_COMMAND_DENIED',
    });
    await expect(box.execute({ program: NODE, args: ['-e', 'process.exit(0)'], cwd: 'relative' })).rejects.toThrow(
      /cwd must be absolute/,
    );
  });

  it('scrubs the environment down to the allowlist', async () => {
    const cwd = workspace();
    const { sandbox: box } = sandbox(cwd, {
      envAllowlist: ['PATH'],
      env: { MAVEN_OPTS: '-Xmx512m' },
      baseEnv: { PATH: '/usr/bin', LLM_API_KEY: 'sk-super-secret', HOME: '/home/dev' },
    });
    const result = await box.execute(
      nodeEval(cwd, 'process.stdout.write(JSON.stringify(process.env));', {
        env: { EXTRA: 'kept' },
      }),
    );
    const env = JSON.parse(result.stdout) as Record<string, string>;
    expect(env.PATH).toBe('/usr/bin');
    expect(env.MAVEN_OPTS).toBe('-Xmx512m');
    expect(env.EXTRA).toBe('kept');
    expect(env.LLM_API_KEY).toBeUndefined();
    expect(env.HOME).toBeUndefined();
  });

  it('kills a hung command and reports a timeout instead of hanging', async () => {
    const cwd = workspace();
    const { sandbox: box, records } = sandbox(cwd, { defaultTimeoutMs: 100 });
    const started = Date.now();
    await expect(box.execute(nodeEval(cwd, 'setTimeout(() => {}, 30000);'))).rejects.toMatchObject({
      code: 'SANDBOX_TIMEOUT',
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(records).toHaveLength(1);
    expect(records[0]?.timedOut).toBe(true);
  });

  it('honours an abort signal', async () => {
    const cwd = workspace();
    const { sandbox: box } = sandbox(cwd, { defaultTimeoutMs: 30_000 });
    const controller = new AbortController();
    const pending = box.execute(
      nodeEval(cwd, 'setTimeout(() => {}, 30000);', { signal: controller.signal }),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'SANDBOX_TIMEOUT' });
  });

  it('caps captured output and says so', async () => {
    const cwd = workspace();
    const { sandbox: box } = sandbox(cwd);
    const result = await box.execute(
      nodeEval(cwd, 'process.stdout.write("x".repeat(5000));', { maxOutputBytes: 100 }),
    );
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.startsWith('x'.repeat(100))).toBe(true);
    expect(result.stdout).toContain('[output truncated at 100 bytes]');
  });

  it('reports a program that cannot be spawned rather than hanging', async () => {
    const cwd = workspace();
    const { sandbox: box } = sandbox(cwd, { commandPatterns: ['^phoenix-not-a-real-binary$'] });
    const result = await box.execute({ program: 'phoenix-not-a-real-binary', cwd });
    expect(result.exitCode).toBeNull();
    expect(result.spawnError?.code).toBe('ENOENT');
  });

  it('rejects an invalid command pattern at construction time', () => {
    const cwd = workspace();
    expect(() => sandbox(cwd, { commandPatterns: ['^pnpm ('] })).toThrowError(/not a valid regex/);
  });
});

describe('quoteArg', () => {
  it('leaves safe arguments alone and quotes everything else', () => {
    expect(quoteArg('mvn')).toBe('mvn');
    expect(quoteArg('-DskipTests')).toBe('-DskipTests');
    expect(quoteArg('src/main/java')).toBe('src/main/java');
    expect(quoteArg('')).toBe("''");
    expect(quoteArg('a b')).toBe("'a b'");
    expect(quoteArg("it's")).toBe("'it'\\''s'");
    expect(quoteArg('$(rm -rf /)')).toBe("'$(rm -rf /)'");
  });
});
