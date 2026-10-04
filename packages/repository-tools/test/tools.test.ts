import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { permissionsForRole } from '@phoenix/config';
import { ExecutionSandbox } from '@phoenix/execution-sandbox';
import {
  canonicalizePath,
  newRunId,
  newTaskId,
  rolePermissionsSchema,
  type AgentRole,
  type RolePermissions,
  type RunId,
  type ToolInvocation,
  type ToolName,
} from '@phoenix/shared';
import { DatabaseGateway, ToolExecutor, toolSpecsFor, type ToolContext, type ToolPaths } from '../src/index.js';

interface Harness {
  paths: ToolPaths;
  runId: RunId;
  executorFor(role: AgentRole, overrides?: Partial<RolePermissions>): {
    executor: ToolExecutor;
    invocations: ToolInvocation[];
    sandbox: ExecutionSandbox;
  };
  contextFor(role: AgentRole, overrides?: Partial<RolePermissions>): ToolContext;
}

const directories: string[] = [];
function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function harness(): Harness {
  // Tools report canonical absolute paths (macOS tmpdir is a symlink: /var -> /private/var),
  // so the harness compares against canonical roots too.
  const base = canonicalizePath(tempDirectory('phoenix-tools-'));
  const runId = newRunId();
  const paths: ToolPaths = {
    legacyRoot: join(base, 'legacy'),
    modernRoot: join(base, 'modern'),
    artifactRoot: join(base, 'artifacts', runId),
    workspaceRoot: join(base, 'workspace', runId),
  };
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true });
  mkdirSync(join(paths.legacyRoot, 'src', 'main', 'java'), { recursive: true });
  writeFileSync(
    join(paths.legacyRoot, 'src', 'main', 'java', 'FeeCalc.java'),
    'public class FeeCalc {\n  static final int WAIVER = 10000;\n}\n',
    'utf8',
  );
  writeFileSync(join(paths.legacyRoot, 'pom.xml'), '<project/>\n', 'utf8');
  writeFileSync(join(paths.modernRoot, 'seed.ts'), 'export const fee = 1;\n', 'utf8');

  const databases = new DatabaseGateway({ legacy: 'postgres://phoenix:phoenix@127.0.0.1:1/legacy_never_up' });

  return {
    paths,
    runId,
    executorFor(role, overrides) {
      const invocations: ToolInvocation[] = [];
      const profile = permissionsForRole(role, paths);
      const permissions =
        overrides === undefined ? profile : rolePermissionsSchema.parse({ ...profile, ...overrides });
      const sandbox = new ExecutionSandbox({
        commandPatterns: permissions.commandPatterns,
        allowedCwdRoots: [...permissions.readRoots, ...permissions.writeRoots],
        defaultTimeoutMs: 20_000,
      });
      const executor = new ToolExecutor({
        sandbox,
        databases,
        onInvocation: (invocation) => invocations.push(invocation),
        fetchImpl: (async (url: string) =>
          new Response(JSON.stringify({ ok: true, url }), { status: 200 })) as typeof fetch,
      });
      return { executor, invocations, sandbox };
    },
    contextFor(role, overrides) {
      const profile = permissionsForRole(role, paths);
      return {
        runId,
        taskId: newTaskId(),
        role,
        permissions:
          overrides === undefined ? profile : rolePermissionsSchema.parse({ ...profile, ...overrides }),
        paths,
      };
    },
  };
}

function call(id: string, name: ToolName, args: Record<string, unknown>) {
  return { id, name, arguments: args };
}

describe('tool permission enforcement', () => {
  let rig: Harness;
  beforeEach(() => {
    rig = harness();
  });

  it('lets the Archaeologist read the legacy repository', async () => {
    const { executor } = rig.executorFor('archaeologist');
    const context = rig.contextFor('archaeologist');
    const { result, invocation } = await executor.invoke(
      call('c1', 'read_file', { path: join(rig.paths.legacyRoot, 'src/main/java/FeeCalc.java') }),
      context,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('WAIVER = 10000');
    expect(invocation.outcome).toBe('ok');
    expect(invocation.tool).toBe('read_file');
    expect(invocation.role).toBe('archaeologist');
    expect(invocation.outputBytes).toBeGreaterThan(0);
  });

  it('lets the Archaeologist read relative to the legacy root', async () => {
    const { executor } = rig.executorFor('archaeologist');
    const { result } = await executor.invoke(call('c1', 'read_file', { path: 'pom.xml' }), rig.contextFor('archaeologist'));
    expect(result.ok).toBe(true);
    expect(result.content).toBe('<project/>\n');
  });

  it('refuses to let the Archaeologist read outside its roots', async () => {
    const { executor } = rig.executorFor('archaeologist');
    const { result, invocation } = await executor.invoke(
      call('c1', 'read_file', { path: join(rig.paths.modernRoot, 'seed.ts') }),
      rig.contextFor('archaeologist'),
    );
    expect(result.ok).toBe(false);
    expect(result.denied).toBe(true);
    expect(result.meta.code).toBe('TOOL_PATH_OUT_OF_SCOPE');
    expect(invocation.outcome).toBe('denied');
  });

  it('refuses to follow a symlink out of the repository', async () => {
    const outside = join(tempDirectory('phoenix-outside-'), 'secrets.env');
    writeFileSync(outside, 'LLM_API_KEY=sk-live\n', 'utf8');
    symlinkSync(outside, join(rig.paths.legacyRoot, 'innocent.env'));
    const { executor } = rig.executorFor('archaeologist');
    const { result } = await executor.invoke(
      call('c1', 'read_file', { path: join(rig.paths.legacyRoot, 'innocent.env') }),
      rig.contextFor('archaeologist'),
    );
    expect(result.denied).toBe(true);
    expect(result.meta.code).toBe('TOOL_PATH_OUT_OF_SCOPE');
  });

  it('gives the Archaeologist no write tool at all, whatever the prompt says', async () => {
    const { executor } = rig.executorFor('archaeologist');
    for (const tool of ['write_file', 'apply_patch', 'run_command', 'http_request'] as ToolName[]) {
      const { result, invocation } = await executor.invoke(
        call('c1', tool, { path: join(rig.paths.legacyRoot, 'x'), content: 'x', program: 'rm', url: 'http://x/' }),
        rig.contextFor('archaeologist'),
      );
      expect(result.denied, tool).toBe(true);
      expect(result.denialReason).toContain('not permitted');
      expect(invocation.outcome).toBe('denied');
    }
  });

  it('lets the Modernizer write the replacement but never the legacy system', async () => {
    const { executor } = rig.executorFor('modernizer');
    const target = join(rig.paths.modernRoot, 'src', 'fees.ts');
    const written = await executor.invoke(
      call('c1', 'write_file', { path: target, content: 'export const fee = 2;\n' }),
      rig.contextFor('modernizer'),
    );
    expect(written.result.ok).toBe(true);
    expect(written.result.meta.path).toBe(target);

    const intoLegacy = await executor.invoke(
      call('c2', 'write_file', { path: join(rig.paths.legacyRoot, 'patched.java'), content: 'x' }),
      rig.contextFor('modernizer'),
    );
    expect(intoLegacy.result.denied).toBe(true);
    expect(intoLegacy.result.meta.code).toBe('TOOL_PATH_OUT_OF_SCOPE');

    const intoDesign = await executor.invoke(
      call('c3', 'write_file', { path: join(rig.paths.artifactRoot, 'design', 'architecture.md'), content: 'x' }),
      rig.contextFor('modernizer'),
    );
    expect(intoDesign.result.denied).toBe(true);
  });

  it('applies an exact patch and refuses a stale one', async () => {
    const { executor } = rig.executorFor('modernizer');
    const context = rig.contextFor('modernizer');
    const target = join(rig.paths.modernRoot, 'seed.ts');

    const patched = await executor.invoke(
      call('c1', 'apply_patch', { path: target, operations: [{ find: 'fee = 1', replace: 'fee = 2' }] }),
      context,
    );
    expect(patched.result.ok).toBe(true);
    expect(patched.result.meta.replacements).toBe(1);

    const stale = await executor.invoke(
      call('c2', 'apply_patch', { path: target, operations: [{ find: 'fee = 1', replace: 'fee = 3' }] }),
      context,
    );
    expect(stale.result.ok).toBe(false);
    expect(stale.invocation.outcome).toBe('error');
    expect(stale.result.content).toContain('matched 0 occurrence(s)');
  });

  it('lets the Release Guardian run tests but not write application code', async () => {
    const { executor } = rig.executorFor('release-guardian');
    const context = rig.contextFor('release-guardian');

    const tests = await executor.invoke(
      call(
        'c1',
        'run_tests',
        { program: 'node', args: ['-e', 'process.exit(0)'], cwd: rig.paths.workspaceRoot },
      ),
      context,
    );
    expect(tests.result.ok).toBe(true);
    expect(tests.result.meta.passed).toBe(true);
    expect(tests.invocation.exitCode).toBe(0);

    const write = await executor.invoke(
      call('c2', 'write_file', { path: join(rig.paths.modernRoot, 'sneaky.ts'), content: 'x' }),
      context,
    );
    expect(write.result.denied).toBe(true);
    expect(write.result.denialReason).toContain('not permitted');

    const destructive = await executor.invoke(
      call('c3', 'run_command', { program: 'rm', args: ['-rf', rig.paths.modernRoot], cwd: rig.paths.workspaceRoot }),
      context,
    );
    expect(destructive.result.denied).toBe(true);
    expect(destructive.result.meta.code).toBe('SANDBOX_COMMAND_DENIED');
    expect(destructive.invocation.outcome).toBe('denied');
  });

  it('reports a failing test run as a result with a non-zero exit code, not an exception', async () => {
    const { executor } = rig.executorFor('release-guardian');
    const { result, invocation } = await executor.invoke(
      call(
        'c1',
        'run_tests',
        { program: 'node', args: ['-e', 'process.stderr.write("3 failed\\n"); process.exit(1)'], cwd: rig.paths.workspaceRoot },
      ),
      rig.contextFor('release-guardian'),
    );
    expect(result.ok).toBe(false);
    expect(result.meta.passed).toBe(false);
    expect(invocation.exitCode).toBe(1);
    expect(invocation.outcome).toBe('ok');
    expect(invocation.outputSummary).toContain('3 failed');
  });

  it('confines http_request to the allowlisted targets of the system under test', async () => {
    const { executor } = rig.executorFor('differential-verifier');
    const context = rig.contextFor('differential-verifier');

    const allowed = await executor.invoke(
      call('c1', 'http_request', { url: 'http://localhost:8080/api/accounts/1' }),
      context,
    );
    expect(allowed.result.ok).toBe(true);
    expect(allowed.result.meta.status).toBe(200);

    const refused = await executor.invoke(
      call('c2', 'http_request', { url: 'http://169.254.169.254/latest/meta-data/' }),
      context,
    );
    expect(refused.result.denied).toBe(true);
    expect(refused.result.meta.code).toBe('TOOL_TARGET_NOT_ALLOWED');
  });

  it('enforces read-only SQL for roles that may only look at the database', async () => {
    const { executor } = rig.executorFor('archaeologist');
    const { result, invocation } = await executor.invoke(
      call('c1', 'query_database', { target: 'legacy', sql: 'DELETE FROM ledger' }),
      rig.contextFor('archaeologist'),
    );
    expect(result.ok).toBe(false);
    expect(result.meta.code).toBe('DATABASE_QUERY_FAILED');
    expect(invocation.outcome).toBe('error');
  });

  it('refuses a database target the role was not given', async () => {
    const { executor } = rig.executorFor('archaeologist');
    const { result } = await executor.invoke(
      call('c1', 'query_database', { target: 'modern', sql: 'SELECT 1' }),
      rig.contextFor('archaeologist'),
    );
    expect(result.denied).toBe(true);
    expect(result.meta.code).toBe('TOOL_TARGET_NOT_ALLOWED');
  });

  it('refuses a database call when the role has no database targets', async () => {
    const { executor } = rig.executorFor('archaeologist');
    const { result } = await executor.invoke(
      call('c1', 'query_database', { sql: 'SELECT 1' }),
      rig.contextFor('archaeologist', { databaseTargets: [] }),
    );
    expect(result.denied).toBe(true);
  });

  it('stops a task that exhausts its tool budget', async () => {
    const { executor } = rig.executorFor('archaeologist');
    const context = rig.contextFor('archaeologist', { maxToolCalls: 2 });
    await executor.invoke(call('c1', 'list_files', {}), context);
    await executor.invoke(call('c2', 'list_files', {}), context);
    const third = await executor.invoke(call('c3', 'list_files', {}), context);
    expect(third.result.denied).toBe(true);
    expect(third.result.denialReason).toContain('tool budget exhausted');
    expect(executor.invocationsFor(context.taskId)).toHaveLength(3);
  });

  it('rejects malformed arguments with the field that was wrong', async () => {
    const { executor } = rig.executorFor('archaeologist');
    const { result, invocation } = await executor.invoke(call('c1', 'read_file', {}), rig.contextFor('archaeologist'));
    expect(result.ok).toBe(false);
    expect(result.content).toContain('path: Required');
    expect(result.meta.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(invocation.outcome).toBe('error');
  });

  it('records every invocation, including denials, as audit evidence', async () => {
    const { executor, invocations } = rig.executorFor('archaeologist');
    const context = rig.contextFor('archaeologist');
    await executor.invoke(call('c1', 'list_files', { recursive: true }), context);
    await executor.invoke(call('c2', 'write_file', { path: 'x', content: 'y' }), context);

    expect(invocations).toHaveLength(2);
    expect(invocations.map((entry) => entry.outcome)).toEqual(['ok', 'denied']);
    for (const invocation of invocations) {
      expect(invocation.runId).toBe(rig.runId);
      expect(invocation.taskId).toBe(context.taskId);
      expect(invocation.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(invocation.durationMs).toBeGreaterThanOrEqual(0);
      expect(invocation.argumentsSummary.length).toBeGreaterThan(0);
    }
    expect(invocations[0]?.outputSummary).toContain('FeeCalc.java');
  });

  it('clips a long output to the audit limit instead of failing the call', async () => {
    // Any source file longer than the summary cap is ordinary, so a summary that overshoots the cap
    // by one character would turn a successful read into an INTERNAL error the agent cannot act on.
    const path = join(rig.paths.legacyRoot, 'src/main/java/Ledger.java');
    writeFileSync(path, 'public class Ledger {\n'.padEnd(5_000, ' '), 'utf8');
    const { executor, invocations } = rig.executorFor('archaeologist');

    const { result } = await executor.invoke(call('c1', 'read_file', { path }), rig.contextFor('archaeologist'));

    expect(result.ok).toBe(true);
    expect(result.content.startsWith('public class Ledger {')).toBe(true);
    expect(invocations[0]?.outcome).toBe('ok');
    expect(invocations[0]?.outputSummary.length).toBeLessThanOrEqual(4_000);
    expect(invocations[0]?.outputSummary.startsWith('public class Ledger {')).toBe(true);
  });

  it('lists files recursively while skipping build output', async () => {
    mkdirSync(join(rig.paths.legacyRoot, 'target', 'classes'), { recursive: true });
    writeFileSync(join(rig.paths.legacyRoot, 'target', 'classes', 'FeeCalc.class'), 'binary', 'utf8');
    const { executor } = rig.executorFor('archaeologist');
    const { result } = await executor.invoke(
      call('c1', 'list_files', { recursive: true }),
      rig.contextFor('archaeologist'),
    );
    expect(result.content).toContain('src/main/java/FeeCalc.java');
    expect(result.content).not.toContain('target');
  });

  it('finds evidence with line numbers that can be cited', async () => {
    const { executor } = rig.executorFor('business-rule-analyst');
    const { result } = await executor.invoke(
      call('c1', 'search_repository', { pattern: 'WAIVER', filePattern: '**/*.java' }),
      rig.contextFor('business-rule-analyst'),
    );
    const payload = JSON.parse(result.content) as { matches: { path: string; line: number; text: string }[] };
    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0]?.line).toBe(2);
    expect(payload.matches[0]?.path).toBe(join(rig.paths.legacyRoot, 'src/main/java/FeeCalc.java'));
    expect(result.meta.filesScanned).toBe(1);
  });

  it('inspects a git diff through read-only git verbs only', async () => {
    const repo = tempDirectory('phoenix-git-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'phoenix@example.test'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Phoenix'], { cwd: repo });
    writeFileSync(join(repo, 'fee.ts'), 'export const fee = 1;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    writeFileSync(join(repo, 'fee.ts'), 'export const fee = 2;\n', 'utf8');

    const overrides = { readRoots: [...permissionsForRole('modernizer', rig.paths).readRoots, repo] };
    const { executor } = rig.executorFor('modernizer', overrides);
    const { result } = await executor.invoke(
      call('c1', 'inspect_git_diff', { cwd: repo }),
      rig.contextFor('modernizer', overrides),
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('-export const fee = 1;');
    expect(result.content).toContain('+export const fee = 2;');
  });

  it('exposes only the tools a role is entitled to, as model-facing specs', () => {
    const specs = toolSpecsFor(permissionsForRole('archaeologist', rig.paths));
    expect(specs.map((spec) => spec.name).sort()).toEqual(
      ['inspect_git_diff', 'list_files', 'query_database', 'read_file', 'search_repository'].sort(),
    );
    for (const spec of specs) {
      expect(spec.description.length).toBeGreaterThan(20);
      expect(spec.parameters.type).toBe('object');
    }

    const guardian = toolSpecsFor(permissionsForRole('release-guardian', rig.paths)).map((spec) => spec.name);
    expect(guardian).not.toContain('write_file');
    expect(guardian).not.toContain('apply_patch');
    expect(guardian).toContain('run_tests');

    expect(toolSpecsFor(permissionsForRole('orchestrator', rig.paths))).toEqual([]);
  });

  it('keeps the orchestrator tool-less by construction', async () => {
    const { executor } = rig.executorFor('orchestrator');
    const { result } = await executor.invoke(call('c1', 'read_file', { path: 'pom.xml' }), rig.contextFor('orchestrator'));
    expect(result.denied).toBe(true);
  });
});
