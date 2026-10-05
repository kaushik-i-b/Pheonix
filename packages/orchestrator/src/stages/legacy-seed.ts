import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Business tables the legacy bank migrates. `settlement_marker` is keyed by `marker_key`, so it is
 * truncated with the rest but has no `id` sequence to rewind.
 */
const TABLES = [
  'accounts',
  'ledger_entries',
  'transfers',
  'request_log',
  'settlement_header',
  'settlement_marker',
  'recon_report',
  'audit_log',
] as const;

const SERIAL_TABLES = TABLES.filter((table) => table !== 'settlement_marker');

/**
 * Snapshot the live legacy rows once, then restore those exact bytes before each capture execution.
 *
 * Re-running the seed SQL would call `now()` again and move every timestamp. Restoring this dump
 * keeps both executions on the same book, including clocks, so a mutating scenario can still agree
 * with itself. The dump stays in a temp directory for the life of the process.
 */
export async function snapshotLegacySeed(databaseUrl: string): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-legacy-seed-'));
  const dump = join(dir, 'seed.sql');
  await exec(
    'pg_dump',
    [
      '--data-only',
      '--column-inserts',
      '--no-owner',
      '--no-privileges',
      ...TABLES.flatMap((table) => ['--table', table]),
      '--file',
      dump,
      databaseUrl,
    ],
    { timeout: 30_000 },
  );

  const truncate = `TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`;
  const sequences = SERIAL_TABLES.map(
    (table) =>
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${table}), 1), 1), (SELECT COUNT(*) FROM ${table}) > 0)`,
  ).join('; ');

  return async () => {
    await exec('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', truncate], { timeout: 30_000 });
    await exec('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', dump], { timeout: 30_000 });
    await exec('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', sequences], { timeout: 30_000 });
  };
}
