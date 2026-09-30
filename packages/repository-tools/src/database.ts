import pg from 'pg';
import { PhoenixError, nowIso } from '@phoenix/shared';

/**
 * Database inspection.
 *
 * Read-only enforcement is belt and braces: the SQL is rejected before it is sent if it is not a
 * read, *and* the statement is executed inside a `READ ONLY` transaction so PostgreSQL itself
 * refuses a write even if the parser was fooled. Legacy behaviour frequently lives in triggers and
 * functions, so being able to look at the database directly is not optional.
 */

const { Pool } = pg;

export interface QueryRequest {
  target: string;
  sql: string;
  params?: unknown[];
  maxRows?: number;
  timeoutMs?: number;
}

export interface QueryContext {
  allowedTargets: readonly string[];
  readOnly: boolean;
}

export interface QueryResult {
  target: string;
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  executedAt: string;
  readOnly: boolean;
}

const FORBIDDEN_STATEMENTS = [
  'insert',
  'update',
  'delete',
  'drop',
  'alter',
  'create',
  'truncate',
  'grant',
  'revoke',
  'copy',
  'call',
  'do',
  'set',
  'reset',
  'lock',
  'vacuum',
  'reindex',
  'cluster',
  'analyze',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'prepare',
  'execute',
  'deallocate',
  'merge',
  'refresh',
  'listen',
  'notify',
  'discard',
  'import',
] as const;

/** Strips comments and string/identifier literals so keyword checks see the statement shape only. */
export function stripSqlLiterals(sql: string): string {
  let output = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] as string;
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === char) {
          if (sql[index + 1] === char) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      output += `${char}${char}`;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

export function assertReadOnlySql(sql: string): void {
  const normalized = stripSqlLiterals(sql).trim();
  if (normalized.length === 0) {
    throw new PhoenixError('DATABASE_QUERY_FAILED', 'sql is empty', {});
  }
  const withoutTrailing = normalized.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    throw new PhoenixError('DATABASE_QUERY_FAILED', 'multiple statements are not permitted in one call', {
      sql: withoutTrailing.slice(0, 300),
    });
  }
  const lower = withoutTrailing.toLowerCase();
  const firstWord = /^[a-z]+/.exec(lower)?.[0] ?? '';
  if (!['select', 'with', 'show', 'explain', 'values', 'table'].includes(firstWord)) {
    throw new PhoenixError(
      'DATABASE_QUERY_FAILED',
      `only read statements are permitted for this role; got "${firstWord || 'unknown'}"`,
      { sql: withoutTrailing.slice(0, 300), firstWord },
    );
  }
  for (const forbidden of FORBIDDEN_STATEMENTS) {
    const matcher = new RegExp(`\\b${forbidden}\\b`, 'i');
    if (matcher.test(lower)) {
      throw new PhoenixError('DATABASE_QUERY_FAILED', `statement contains the write keyword "${forbidden}"`, {
        sql: withoutTrailing.slice(0, 300),
        keyword: forbidden,
      });
    }
  }
}

export interface DatabaseGatewayOptions {
  maxRows?: number;
  timeoutMs?: number;
  /** Called for background pool failures so nothing is silently discarded. */
  onWarn?: (message: string, details?: Record<string, unknown>) => void;
}

export class DatabaseGateway {
  private readonly pools = new Map<string, pg.Pool>();
  readonly queries: QueryResult[] = [];

  constructor(
    private readonly targets: Readonly<Record<string, string>>,
    private readonly defaults: DatabaseGatewayOptions = {},
  ) {}

  hasTarget(name: string): boolean {
    return Object.hasOwn(this.targets, name);
  }

  targetNames(): string[] {
    return Object.keys(this.targets).sort();
  }

  private poolFor(target: string, context: QueryContext): pg.Pool {
    if (!context.allowedTargets.includes(target)) {
      throw new PhoenixError('TOOL_TARGET_NOT_ALLOWED', `role may not query database target "${target}"`, {
        target,
        allowedTargets: [...context.allowedTargets],
      });
    }
    const url = this.targets[target];
    if (url === undefined) {
      throw new PhoenixError('DATABASE_QUERY_FAILED', `unknown database target "${target}"`, {
        target,
        configured: this.targetNames(),
      });
    }
    const existing = this.pools.get(target);
    if (existing !== undefined) return existing;
    const pool = new Pool({ connectionString: url, max: 2, idleTimeoutMillis: 30_000 });
    pool.on('error', (error: Error) => {
      this.warn(`idle client on database target "${target}" failed: ${error.message}`, { target });
    });
    this.pools.set(target, pool);
    return pool;
  }

  async query(request: QueryRequest, context: QueryContext): Promise<QueryResult> {
    if (context.readOnly) assertReadOnlySql(request.sql);
    const pool = this.poolFor(request.target, context);
    const maxRows = request.maxRows ?? this.defaults.maxRows ?? 500;
    const timeoutMs = request.timeoutMs ?? this.defaults.timeoutMs ?? 30_000;
    const startedAt = nowIso();
    const started = Date.now();

    const client = await pool.connect();
    try {
      if (context.readOnly) {
        await client.query('BEGIN TRANSACTION READ ONLY');
      }
      const issued = limitStatement(request.sql, maxRows);
      const response = await withTimeout(
        client.query(issued, request.params ?? []),
        timeoutMs,
        request.sql,
      );
      const allRows = (response.rows ?? []) as Record<string, unknown>[];
      const truncated = allRows.length > maxRows;
      const rows = truncated ? allRows.slice(0, maxRows) : allRows;
      const result: QueryResult = {
        target: request.target,
        sql: request.sql,
        columns: (response.fields ?? []).map((field) => field.name),
        rows,
        rowCount: rows.length,
        truncated,
        durationMs: Date.now() - started,
        executedAt: startedAt,
        readOnly: context.readOnly,
      };
      this.queries.push(result);
      return result;
    } catch (error) {
      throw new PhoenixError(
        'DATABASE_QUERY_FAILED',
        `query against "${request.target}" failed: ${error instanceof Error ? error.message : String(error)}`,
        { target: request.target, sql: request.sql.slice(0, 1000) },
        error,
      );
    } finally {
      if (context.readOnly) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The client is discarded below; a failed rollback cannot leak a write.
        }
      }
      client.release();
    }
  }

  private warn(message: string, details?: Record<string, unknown>): void {
    if (this.defaults.onWarn !== undefined) {
      this.defaults.onWarn(message, details);
      return;
    }
    process.stderr.write(`[phoenix:database] ${message}\n`);
  }

  async close(): Promise<void> {
    for (const pool of this.pools.values()) await pool.end();
    this.pools.clear();
  }
}

/**
 * Adds a row limit to statements that can be wrapped. `SHOW`, `EXPLAIN` and friends cannot be
 * nested, so they are sent as-is; the row cap is then applied when reading the result.
 */
export function limitStatement(sql: string, maxRows: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  const firstWord = (/^[a-z]+/i.exec(trimmed)?.[0] ?? '').toLowerCase();
  if (!['select', 'with', 'values', 'table'].includes(firstWord)) return sql;
  return `SELECT * FROM (${trimmed}) AS phoenix_limited LIMIT ${maxRows + 1}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, sql: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(
        new PhoenixError('DATABASE_QUERY_FAILED', `query timed out after ${timeoutMs}ms`, {
          timeoutMs,
          sql: sql.slice(0, 300),
        }),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
