import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  PhoenixError,
  canonicalizePath,
  newStepId,
  nowIso,
  pathIsInsideAny,
  sha256Hex,
  toolCallResultSchema,
  toolInvocationSchema,
  type AgentRole,
  type JsonSchemaSpec,
  type LlmToolSpec,
  type RolePermissions,
  type RunId,
  type TaskId,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolInvocation,
  type ToolName,
} from '@phoenix/shared';
import { ExecutionSandbox, type CommandResult } from '@phoenix/execution-sandbox';
import type { DatabaseGateway} from './database.js';
import { type QueryResult } from './database.js';
import { performHttpRequest, type HttpExchange } from './http.js';
import { applyPatchOperations, type PatchOperation } from './patch.js';
import { resolveScopedPath } from './paths.js';
import { listDirectory, searchFiles } from './search.js';

/**
 * The controlled tool layer.
 *
 * Permission enforcement lives here, in code, not in a prompt. A role that has not been granted
 * `write_file` cannot write, whatever the model was told or decided; a path outside the role's roots
 * cannot be read; a command outside the role's patterns cannot run; a database target it was not
 * given cannot be queried. Every call — successful, failed or denied — becomes a `ToolInvocation`
 * record, which is what the brief means by logging tool, arguments, timestamp, exit code, duration
 * and output summary.
 */

export interface ToolPaths {
  legacyRoot: string;
  modernRoot: string;
  artifactRoot: string;
  workspaceRoot: string;
}

export interface ToolContext {
  runId: RunId;
  taskId: TaskId;
  role: AgentRole;
  permissions: RolePermissions;
  paths: ToolPaths;
}

export interface ToolDependencies {
  sandbox: ExecutionSandbox;
  databases?: DatabaseGateway;
  fetchImpl?: typeof fetch;
  onInvocation?: (invocation: ToolInvocation) => void;
  /** Cap on how much file content a single `read_file` returns to the model. */
  maxReadBytes?: number;
}

export interface ToolOutcome {
  result: ToolCallResult;
  invocation: ToolInvocation;
}

/** A result before defaults are applied; `toolCallResultSchema.parse` fills in the rest. */
type ToolResultDraft = Pick<ToolCallResult, 'ok' | 'content'> & Partial<Omit<ToolCallResult, 'id' | 'name'>>;

interface HandlerOutcome {
  outcome: ToolInvocation['outcome'];
  result: ToolResultDraft;
  extra?: Partial<ToolInvocation>;
}

const DEFAULT_MAX_READ_BYTES = 200_000;
const SUMMARY_LIMIT = 4000;

const readFileArgs = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(4_000_000).optional(),
});

const listFilesArgs = z.object({
  path: z.string().min(1).optional(),
  recursive: z.boolean().optional(),
  limit: z.number().int().positive().max(5000).optional(),
});

const searchArgs = z.object({
  pattern: z.string().min(1).max(2000),
  path: z.string().min(1).optional(),
  filePattern: z.string().min(1).max(200).optional(),
  caseInsensitive: z.boolean().optional(),
  maxResults: z.number().int().positive().max(2000).optional(),
});

const writeFileArgs = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const applyPatchArgs = z.object({
  path: z.string().min(1),
  operations: z
    .array(
      z.object({
        find: z.string().min(1),
        replace: z.string(),
        replaceAll: z.boolean().optional(),
        expectedCount: z.number().int().positive().optional(),
      }),
    )
    .min(1)
    .max(50),
});

const runCommandArgs = z.object({
  program: z.string().min(1).max(400),
  args: z.array(z.string().max(4000)).max(100).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
});

const queryDatabaseArgs = z.object({
  target: z.string().min(1).max(120).optional(),
  sql: z.string().min(1).max(20_000),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(100).optional(),
  maxRows: z.number().int().positive().max(5000).optional(),
});

const gitDiffArgs = z.object({
  cwd: z.string().min(1).optional(),
  ref: z.string().min(1).max(200).optional(),
  staged: z.boolean().optional(),
  path: z.string().min(1).optional(),
  stat: z.boolean().optional(),
});

const httpRequestArgs = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional(),
  url: z.string().min(1).max(2000),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().max(1_000_000).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

/** Argument contract per tool. `satisfies` keeps the per-key inferred types for the handlers. */
export const TOOL_ARGUMENT_SCHEMAS = {
  read_file: readFileArgs,
  list_files: listFilesArgs,
  search_repository: searchArgs,
  write_file: writeFileArgs,
  apply_patch: applyPatchArgs,
  run_command: runCommandArgs,
  run_tests: runCommandArgs,
  query_database: queryDatabaseArgs,
  inspect_git_diff: gitDiffArgs,
  http_request: httpRequestArgs,
} satisfies Record<ToolName, z.ZodTypeAny>;

export type ToolArgs<K extends ToolName> = z.infer<(typeof TOOL_ARGUMENT_SCHEMAS)[K]>;

const object = (properties: JsonSchemaSpec, required: string[] = []): JsonSchemaSpec => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const stringList = { type: 'array', items: { type: 'string' } };
const stringMap = { type: 'object', additionalProperties: { type: 'string' } };

export const TOOL_SPECIFICATIONS: Record<ToolName, { description: string; parameters: JsonSchemaSpec }> = {
  read_file: {
    description:
      'Read a text file inside a permitted root and return its exact contents. Use this for source files, SQL migrations and configuration.',
    parameters: object(
      {
        path: { type: 'string', description: 'Absolute path, or relative to the legacy repository root.' },
        maxBytes: { type: 'number', description: 'Optional cap on returned bytes (default 200000).' },
      },
      ['path'],
    ),
  },
  list_files: {
    description: 'List files and directories under a path. Build and dependency directories are skipped.',
    parameters: object({
      path: { type: 'string', description: 'Directory to list; defaults to the legacy repository root.' },
      recursive: { type: 'boolean' },
      limit: { type: 'number', description: 'Maximum entries to return (default 500).' },
    }),
  },
  search_repository: {
    description:
      'Regular-expression search over repository text files. Returns matching lines with file path and line number, suitable for citation as evidence.',
    parameters: object(
      {
        pattern: { type: 'string', description: 'Regular expression (no flags).' },
        path: { type: 'string', description: 'Directory to search; defaults to the legacy repository root.' },
        filePattern: { type: 'string', description: 'Glob against the relative path, e.g. "**/*.java".' },
        caseInsensitive: { type: 'boolean' },
        maxResults: { type: 'number' },
      },
      ['pattern'],
    ),
  },
  write_file: {
    description: 'Write a file inside a permitted write root, creating parent directories as needed.',
    parameters: object({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  },
  apply_patch: {
    description:
      'Apply exact find/replace operations to an existing file. Each operation must match the expected number of occurrences or the whole patch is rejected; re-read the file if it does not match.',
    parameters: object(
      {
        path: { type: 'string' },
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string' },
              replace: { type: 'string' },
              replaceAll: { type: 'boolean' },
              expectedCount: { type: 'number' },
            },
            required: ['find', 'replace'],
            additionalProperties: false,
          },
        },
      },
      ['path', 'operations'],
    ),
  },
  run_command: {
    description:
      'Run a program without a shell. The command line must match one of the patterns permitted for this role. Returns exit code, stdout and stderr.',
    parameters: object(
      {
        program: { type: 'string', description: 'Executable, e.g. "mvn".' },
        args: stringList,
        cwd: { type: 'string', description: 'Working directory; defaults to the legacy repository root.' },
        env: stringMap,
        timeoutMs: { type: 'number' },
      },
      ['program'],
    ),
  },
  run_tests: {
    description:
      'Run a test command and report whether it passed (exit code 0). Subject to the same allowlist as run_command.',
    parameters: object(
      { program: { type: 'string' }, args: stringList, cwd: { type: 'string' }, env: stringMap, timeoutMs: { type: 'number' } },
      ['program'],
    ),
  },
  query_database: {
    description:
      'Run SQL against a named database target. Read-only roles may only issue SELECT/WITH/SHOW/EXPLAIN statements.',
    parameters: object(
      {
        target: { type: 'string', description: 'Named target, e.g. "legacy" or "modern".' },
        sql: { type: 'string' },
        params: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } },
        maxRows: { type: 'number' },
      },
      ['sql'],
    ),
  },
  inspect_git_diff: {
    description: 'Inspect uncommitted or committed changes in a repository using read-only git commands.',
    parameters: object({
      cwd: { type: 'string' },
      ref: { type: 'string', description: 'Revision or range, e.g. "HEAD~1" or "main..feature".' },
      staged: { type: 'boolean' },
      path: { type: 'string', description: 'Restrict the diff to a path.' },
      stat: { type: 'boolean', description: 'Return a --stat summary instead of the full diff.' },
    }),
  },
  http_request: {
    description:
      'Call a running system under test over HTTP. Only allowlisted targets may be reached. A 4xx/5xx response is returned as a result, not an error.',
    parameters: object(
      {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
        url: { type: 'string' },
        headers: stringMap,
        body: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      ['url'],
    ),
  },
};

export function toolSpecsFor(permissions: RolePermissions): LlmToolSpec[] {
  return permissions.tools.map((tool) => ({
    name: tool,
    description: TOOL_SPECIFICATIONS[tool].description,
    parameters: TOOL_SPECIFICATIONS[tool].parameters,
  }));
}

export class ToolExecutor {
  readonly invocations: ToolInvocation[] = [];

  private readonly handlers: { [K in ToolName]: (args: ToolArgs<K>, context: ToolContext) => HandlerOutcome | Promise<HandlerOutcome> };

  constructor(private readonly deps: ToolDependencies) {
    this.handlers = {
      read_file: (args, context) => this.readFile(args, context),
      list_files: (args, context) => this.listFiles(args, context),
      search_repository: (args, context) => this.searchRepository(args, context),
      write_file: (args, context) => this.writeFile(args, context),
      apply_patch: (args, context) => this.applyPatch(args, context),
      run_command: (args, context) => this.runCommand(args, context, false),
      run_tests: (args, context) => this.runCommand(args, context, true),
      query_database: (args, context) => this.queryDatabase(args, context),
      inspect_git_diff: (args, context) => this.inspectGitDiff(args, context),
      http_request: (args, context) => this.httpRequest(args, context),
    };
  }

  invocationsFor(taskId: TaskId): ToolInvocation[] {
    return this.invocations.filter((invocation) => invocation.taskId === taskId);
  }

  async invoke(request: ToolCallRequest, context: ToolContext): Promise<ToolOutcome> {
    const startedAt = Date.now();
    const requestedAt = nowIso();
    const invocationId = newStepId();

    const finish = (
      outcome: ToolInvocation['outcome'],
      result: ToolResultDraft,
      extra: Partial<ToolInvocation> = {},
    ): ToolOutcome => {
      const invocation = toolInvocationSchema.parse({
        invocationId,
        taskId: context.taskId,
        runId: context.runId,
        role: context.role,
        tool: request.name,
        arguments: request.arguments,
        argumentsSummary: truncate(JSON.stringify(request.arguments) ?? '', 2000),
        requestedAt,
        durationMs: Math.max(0, Date.now() - startedAt),
        outcome,
        ...(result.denialReason !== undefined ? { denialReason: result.denialReason } : {}),
        ...extra,
        outputSummary: truncate(result.content, SUMMARY_LIMIT),
        outputBytes: Buffer.byteLength(result.content, 'utf8'),
        truncated: result.truncated ?? false,
      });
      this.invocations.push(invocation);
      this.deps.onInvocation?.(invocation);
      return {
        result: toolCallResultSchema.parse({ id: request.id, name: request.name, ...result }),
        invocation,
      };
    };

    if (!context.permissions.tools.includes(request.name)) {
      return finish('denied', {
        ok: false,
        content: '',
        denied: true,
        denialReason: `role "${context.role}" is not permitted to use ${request.name}`,
        meta: { allowedTools: context.permissions.tools },
      });
    }

    const budget = context.permissions.maxToolCalls;
    if (budget !== undefined && this.invocationsFor(context.taskId).length >= budget) {
      return finish('denied', {
        ok: false,
        content: '',
        denied: true,
        denialReason: `tool budget exhausted for this task (${budget} calls)`,
        meta: { budget },
      });
    }

    const schema: z.ZodTypeAny = TOOL_ARGUMENT_SCHEMAS[request.name];
    const parsedArgs = schema.safeParse(request.arguments);
    if (!parsedArgs.success) {
      return finish('error', {
        ok: false,
        content: `invalid arguments for ${request.name}: ${parsedArgs.error.issues
          .slice(0, 10)
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
        meta: { code: 'SCHEMA_VALIDATION_FAILED' },
      });
    }

    try {
      // Heterogeneous dispatch: the handler map is checked per tool above, so this is the single
      // place where the argument type has to be erased.
      const handler = this.handlers[request.name] as (args: never, context: ToolContext) => HandlerOutcome | Promise<HandlerOutcome>;
      const outcome = await handler(parsedArgs.data as never, context);
      return finish(outcome.outcome, outcome.result, outcome.extra ?? {});
    } catch (error) {
      const phoenixError =
        error instanceof PhoenixError
          ? error
          : new PhoenixError('INTERNAL', error instanceof Error ? error.message : String(error), {}, error);
      const outcome = classifyFailure(phoenixError.code);
      return finish(outcome, {
        ok: false,
        content: phoenixError.message,
        denied: outcome === 'denied',
        ...(outcome === 'denied' ? { denialReason: phoenixError.message } : {}),
        meta: { code: phoenixError.code, details: phoenixError.details },
      });
    }
  }

  private ok(content: string, meta: Record<string, unknown> = {}, truncated = false): HandlerOutcome {
    return { outcome: 'ok', result: { ok: true, content, truncated, meta } };
  }

  private readFile(args: ToolArgs<'read_file'>, context: ToolContext): HandlerOutcome {
    const path = resolveScopedPath(args.path, {
      roots: context.permissions.readRoots,
      defaultRoot: context.paths.legacyRoot,
      scope: 'read',
    });
    let stats;
    try {
      stats = statSync(path);
    } catch {
      throw new PhoenixError('TOOL_EXECUTION_FAILED', `file not found: ${path}`, { path });
    }
    if (stats.isDirectory()) {
      throw new PhoenixError('TOOL_EXECUTION_FAILED', `path is a directory, use list_files: ${path}`, { path });
    }
    const maxBytes = args.maxBytes ?? this.deps.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    const buffer = readFileSync(path);
    const truncated = buffer.byteLength > maxBytes;
    const text = buffer.subarray(0, Math.min(maxBytes, buffer.byteLength)).toString('utf8');
    return this.ok(
      truncated ? `${text}\n[truncated at ${maxBytes} of ${buffer.byteLength} bytes]` : text,
      { path, bytes: buffer.byteLength, sha256: sha256Hex(buffer), truncated },
      truncated,
    );
  }

  private listFiles(args: ToolArgs<'list_files'>, context: ToolContext): HandlerOutcome {
    const path = resolveScopedPath(args.path ?? context.paths.legacyRoot, {
      roots: context.permissions.readRoots,
      defaultRoot: context.paths.legacyRoot,
      scope: 'read',
    });
    const listing = listDirectory({
      root: path,
      recursive: args.recursive ?? false,
      limit: args.limit ?? 500,
    });
    const content = listing.entries
      .map((entry) => (entry.kind === 'directory' ? entry.path : `${entry.path} (${entry.bytes ?? 0} bytes)`))
      .join('\n');
    return this.ok(
      listing.entries.length === 0 ? '(empty)' : content,
      { path, count: listing.entries.length, truncated: listing.truncated },
      listing.truncated,
    );
  }

  private searchRepository(args: ToolArgs<'search_repository'>, context: ToolContext): HandlerOutcome {
    const root = resolveScopedPath(args.path ?? context.paths.legacyRoot, {
      roots: context.permissions.readRoots,
      defaultRoot: context.paths.legacyRoot,
      scope: 'read',
    });
    const result = searchFiles({
      root,
      pattern: args.pattern,
      ...(args.caseInsensitive !== undefined ? { caseInsensitive: args.caseInsensitive } : {}),
      ...(args.filePattern !== undefined ? { filePattern: args.filePattern } : {}),
      ...(args.maxResults !== undefined ? { maxResults: args.maxResults } : {}),
    });
    const matches = result.matches.map((match) => ({ ...match, path: resolve(root, match.path) }));
    return this.ok(
      JSON.stringify({ root, ...result, matches }, null, 2),
      { root, matchCount: matches.length, filesScanned: result.filesScanned, truncated: result.truncated },
      result.truncated,
    );
  }

  private writeFile(args: ToolArgs<'write_file'>, context: ToolContext): HandlerOutcome {
    const path = resolveScopedPath(args.path, {
      roots: context.permissions.writeRoots,
      defaultRoot: context.paths.modernRoot,
      scope: 'write',
    });
    mkdirSync(dirname(path), { recursive: true });
    const bytes = Buffer.from(args.content, 'utf8');
    writeFileSync(path, bytes);
    return this.ok(`wrote ${bytes.byteLength} bytes to ${path}`, {
      path,
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
  }

  private applyPatch(args: ToolArgs<'apply_patch'>, context: ToolContext): HandlerOutcome {
    const path = resolveScopedPath(args.path, {
      roots: context.permissions.writeRoots,
      defaultRoot: context.paths.modernRoot,
      scope: 'write',
    });
    if (!existsSync(path)) {
      throw new PhoenixError('TOOL_EXECUTION_FAILED', `cannot patch a file that does not exist: ${path}`, { path });
    }
    const before = readFileSync(path, 'utf8');
    const operations: PatchOperation[] = args.operations.map((operation) => ({
      find: operation.find,
      replace: operation.replace,
      ...(operation.replaceAll !== undefined ? { replaceAll: operation.replaceAll } : {}),
      ...(operation.expectedCount !== undefined ? { expectedCount: operation.expectedCount } : {}),
    }));
    const patched = applyPatchOperations(before, operations);
    const bytes = Buffer.from(patched.content, 'utf8');
    writeFileSync(path, bytes);
    return this.ok(
      `applied ${patched.operationsApplied} operation(s), ${patched.replacements} replacement(s) to ${path}`,
      {
        path,
        bytesBefore: Buffer.byteLength(before, 'utf8'),
        bytesAfter: bytes.byteLength,
        sha256Before: sha256Hex(before),
        sha256After: sha256Hex(bytes),
        replacements: patched.replacements,
      },
    );
  }

  private async runCommand(
    args: ToolArgs<'run_command'>,
    context: ToolContext,
    asTestRun: boolean,
  ): Promise<HandlerOutcome> {
    const cwd = this.commandCwd(args.cwd, context);
    const result: CommandResult = await this.deps.sandbox.execute({
      program: args.program,
      args: args.args ?? [],
      cwd,
      ...(args.env !== undefined ? { env: args.env } : {}),
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      label: `${context.role}:${asTestRun ? 'run_tests' : 'run_command'}`,
    });
    const payload = {
      command: result.command,
      cwd: result.cwd,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdout: tail(result.stdout, 20_000),
      stderr: tail(result.stderr, 8_000),
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      ...(asTestRun ? { passed: result.exitCode === 0 } : {}),
      ...(result.spawnError !== undefined ? { spawnError: result.spawnError } : {}),
    };
    return {
      outcome: 'ok',
      result: {
        ok: result.exitCode === 0,
        content: JSON.stringify(payload, null, 2),
        truncated: result.stdoutTruncated || result.stderrTruncated,
        meta: {
          exitCode: result.exitCode ?? null,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          ...(asTestRun ? { passed: result.exitCode === 0 } : {}),
        },
      },
      ...(result.exitCode !== null ? { extra: { exitCode: result.exitCode } } : {}),
    };
  }

  private commandCwd(cwd: string | undefined, context: ToolContext): string {
    const candidate = cwd ?? context.paths.legacyRoot;
    const resolved = canonicalizePath(
      isAbsolute(candidate) ? resolve(candidate) : resolve(context.paths.legacyRoot, candidate),
    );
    const roots = [...context.permissions.readRoots, ...context.permissions.writeRoots];
    if (!pathIsInsideAny(resolved, roots.map(canonicalizePath))) {
      throw new PhoenixError('TOOL_PATH_OUT_OF_SCOPE', `command cwd ${resolved} is outside the permitted roots`, {
        cwd: resolved,
        roots,
      });
    }
    return resolved;
  }

  private async queryDatabase(args: ToolArgs<'query_database'>, context: ToolContext): Promise<HandlerOutcome> {
    const gateway = this.deps.databases;
    if (gateway === undefined) {
      throw new PhoenixError('DATABASE_QUERY_FAILED', 'no database gateway is configured for this run', {});
    }
    const target = args.target ?? context.permissions.databaseTargets[0];
    if (target === undefined) {
      throw new PhoenixError('TOOL_TARGET_NOT_ALLOWED', 'no database target is permitted for this role', {
        configured: gateway.targetNames(),
      });
    }
    const query: QueryResult = await gateway.query(
      {
        target,
        sql: args.sql,
        ...(args.params !== undefined ? { params: args.params } : {}),
        ...(args.maxRows !== undefined ? { maxRows: args.maxRows } : {}),
      },
      { allowedTargets: context.permissions.databaseTargets, readOnly: context.permissions.databaseReadOnly },
    );
    return this.ok(
      JSON.stringify(query, null, 2),
      {
        target: query.target,
        rowCount: query.rowCount,
        truncated: query.truncated,
        durationMs: query.durationMs,
        readOnly: query.readOnly,
      },
      query.truncated,
    );
  }

  private async inspectGitDiff(args: ToolArgs<'inspect_git_diff'>, context: ToolContext): Promise<HandlerOutcome> {
    const cwd = this.commandCwd(args.cwd ?? context.paths.legacyRoot, context);
    const gitArgs: string[] = args.stat === true ? ['--no-pager', 'diff', '--stat'] : ['--no-pager', 'diff'];
    if (args.staged === true) gitArgs.push('--staged');
    if (args.ref !== undefined) gitArgs.push(args.ref);
    gitArgs.push('--', args.path ?? '.');
    // A dedicated sandbox: read-only git verbs, no shell, same root confinement.
    const git = new ExecutionSandbox({
      commandPatterns: ['^git --no-pager diff '],
      allowedCwdRoots: [...context.permissions.readRoots, ...context.permissions.writeRoots],
      defaultTimeoutMs: 60_000,
    });
    const result = await git.execute({ program: 'git', args: gitArgs, cwd, label: `${context.role}:git-diff` });
    if (result.exitCode !== 0) {
      throw new PhoenixError('TOOL_EXECUTION_FAILED', `git diff failed: ${tail(result.stderr, 2000)}`, {
        command: result.command,
        exitCode: result.exitCode,
      });
    }
    const content = result.stdout.trim();
    const truncated = content.length > 100_000;
    return this.ok(
      content.length === 0 ? '(no changes)' : tail(content, 100_000),
      { cwd, command: result.command, bytes: Buffer.byteLength(result.stdout, 'utf8') },
      truncated,
    );
  }

  private async httpRequest(args: ToolArgs<'http_request'>, context: ToolContext): Promise<HandlerOutcome> {
    const exchange: HttpExchange = await performHttpRequest(
      {
        url: args.url,
        ...(args.method !== undefined ? { method: args.method } : {}),
        ...(args.headers !== undefined ? { headers: args.headers } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      },
      {
        allowedTargets: context.permissions.httpTargets,
        ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
      },
    );
    if (exchange.error !== undefined) {
      throw new PhoenixError(
        'SYSTEM_UNREACHABLE',
        `${exchange.request.method} ${exchange.request.url}: ${exchange.error.message}`,
        { url: exchange.request.url, code: exchange.error.code },
      );
    }
    const truncated = exchange.bodyText.length > 100_000;
    return {
      outcome: 'ok',
      result: {
        ok: exchange.status !== undefined && exchange.status >= 200 && exchange.status < 400,
        content: JSON.stringify({ ...exchange, bodyText: tail(exchange.bodyText, 100_000) }, null, 2),
        truncated,
        meta: { status: exchange.status ?? null, durationMs: exchange.durationMs, url: exchange.request.url },
      },
    };
  }
}

const DENIAL_CODES = new Set([
  'TOOL_NOT_ALLOWED',
  'TOOL_PATH_OUT_OF_SCOPE',
  'TOOL_COMMAND_NOT_ALLOWED',
  'TOOL_TARGET_NOT_ALLOWED',
  'TOOL_BUDGET_EXCEEDED',
  'SANDBOX_COMMAND_DENIED',
]);

const TIMEOUT_CODES = new Set(['TOOL_TIMEOUT', 'SANDBOX_TIMEOUT']);

export function classifyFailure(code: PhoenixError['code']): ToolInvocation['outcome'] {
  if (TIMEOUT_CODES.has(code)) return 'timeout';
  if (DENIAL_CODES.has(code)) return 'denied';
  return 'error';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}
