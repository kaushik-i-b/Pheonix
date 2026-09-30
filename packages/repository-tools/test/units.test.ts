import { describe, expect, it } from 'vitest';
import { PhoenixError } from '@phoenix/shared';
import { assertReadOnlySql, limitStatement, stripSqlLiterals } from '../src/database.js';
import { assertHttpTargetAllowed, performHttpRequest, redactHeaders } from '../src/http.js';
import { applyPatchOperations, countOccurrences, replaceLiteral } from '../src/patch.js';
import { isInsideRoot, resolveScopedPath } from '../src/paths.js';
import { globToRegExp, searchFiles } from '../src/search.js';

describe('read-only SQL guard', () => {
  it('permits reads', () => {
    for (const sql of [
      'SELECT * FROM accounts',
      'select id from ledger where amount > 10',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'SHOW search_path',
      'EXPLAIN SELECT 1',
      'VALUES (1), (2)',
      'SELECT 1;',
    ]) {
      expect(() => assertReadOnlySql(sql)).not.toThrow();
    }
  });

  it('rejects writes and schema changes', () => {
    for (const sql of [
      'UPDATE accounts SET balance = 0',
      'DELETE FROM ledger',
      'INSERT INTO ledger VALUES (1)',
      'DROP TABLE accounts',
      'TRUNCATE ledger',
      'CREATE TABLE x (id int)',
      'ALTER TABLE accounts ADD COLUMN y int',
      'GRANT ALL ON accounts TO public',
      "SET app.correction_channel = 'phoenix'",
      'CALL settle()',
      'BEGIN',
    ]) {
      expect(() => assertReadOnlySql(sql), sql).toThrowError(PhoenixError);
    }
  });

  it('rejects a write smuggled in as a second statement', () => {
    expect(() => assertReadOnlySql('SELECT 1; DELETE FROM ledger')).toThrowError(/multiple statements/);
  });

  it('does not mistake data for statements', () => {
    expect(() => assertReadOnlySql("SELECT * FROM notes WHERE text = 'delete everything; drop table x'")).not.toThrow();
    expect(() => assertReadOnlySql('SELECT created_at, updated_by FROM accounts')).not.toThrow();
    expect(() => assertReadOnlySql('SELECT * FROM t -- delete this later\nWHERE id = 1')).not.toThrow();
  });

  it('strips literals and comments so keyword checks see statement shape', () => {
    expect(stripSqlLiterals("SELECT 'a;b' -- note\nFROM t")).toBe("SELECT '' \nFROM t");
    expect(stripSqlLiterals('SELECT "col", $$dollar$$ FROM t')).toBe('SELECT "", $$dollar$$ FROM t');
  });

  it('caps rows only for statements that can be wrapped', () => {
    expect(limitStatement('SELECT * FROM t;', 10)).toBe('SELECT * FROM (SELECT * FROM t) AS phoenix_limited LIMIT 11');
    expect(limitStatement('SHOW search_path', 10)).toBe('SHOW search_path');
  });
});

describe('http target allowlist', () => {
  const targets = ['http://localhost:8080/', 'http://127.0.0.1:8090/'];

  it('permits allowlisted targets', () => {
    expect(() => assertHttpTargetAllowed('http://localhost:8080/api/accounts', targets)).not.toThrow();
  });

  it('refuses anything else, including lookalikes', () => {
    for (const url of [
      'http://localhost:9999/api',
      'http://evil.example.com/',
      'http://localhost:8080.evil.example.com/',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(() => assertHttpTargetAllowed(url, targets), url).toThrowError(/not permitted|not a valid URL/);
    }
  });

  it('refuses when a role has no http targets at all', () => {
    expect(() => assertHttpTargetAllowed('http://localhost:8080/api', [])).toThrowError(/not permitted/);
  });

  it('reports a network failure as an exchange result, not a thrown error', async () => {
    const exchange = await performHttpRequest(
      { url: 'http://localhost:8080/api/health' },
      {
        allowedTargets: targets,
        fetchImpl: (async () => {
          throw new Error('connect ECONNREFUSED');
        }) as typeof fetch,
      },
    );
    expect(exchange.error?.code).toBe('network');
    expect(exchange.error?.message).toContain('ECONNREFUSED');
    expect(exchange.status).toBeUndefined();
  });

  it('treats a 500 as a result with a body', async () => {
    const exchange = await performHttpRequest(
      { method: 'POST', url: 'http://localhost:8080/api/transfers', body: '{"amount":10}' },
      {
        allowedTargets: targets,
        fetchImpl: (async () =>
          new Response('{"error":"nsf"}', { status: 400, headers: { 'content-type': 'application/json' } })) as typeof fetch,
      },
    );
    expect(exchange.status).toBe(400);
    expect(exchange.json).toEqual({ error: 'nsf' });
    expect(exchange.error).toBeUndefined();
  });

  it('redacts credentials before anything is persisted', () => {
    expect(redactHeaders({ Authorization: 'Bearer sk-1', Cookie: 'a=b', 'X-Trace': 'keep' })).toEqual({
      Authorization: '[redacted]',
      Cookie: '[redacted]',
      'X-Trace': 'keep',
    });
  });
});

describe('patch operations', () => {
  it('applies an exact single replacement', () => {
    const patched = applyPatchOperations('const a = 1;\n', [{ find: 'a = 1', replace: 'a = 2' }]);
    expect(patched.content).toBe('const a = 2;\n');
    expect(patched.replacements).toBe(1);
  });

  it('refuses to guess when the occurrence count is wrong', () => {
    const content = 'fee(); fee();';
    expect(() => applyPatchOperations(content, [{ find: 'fee()', replace: 'chargeFee()' }])).toThrowError(
      /matched 2 occurrence\(s\) but expected 1/,
    );
    expect(
      applyPatchOperations(content, [{ find: 'fee()', replace: 'chargeFee()', expectedCount: 2 }]).content,
    ).toBe('chargeFee(); chargeFee();');
  });

  it('replaces every occurrence when asked', () => {
    const patched = applyPatchOperations('x x x', [{ find: 'x', replace: 'y', replaceAll: true }]);
    expect(patched.content).toBe('y y y');
    expect(patched.replacements).toBe(3);
  });

  it('fails when a replaceAll finds nothing, i.e. the file moved on', () => {
    expect(() =>
      applyPatchOperations('current content', [{ find: 'old content', replace: 'new', replaceAll: true }]),
    ).toThrowError(/matched nothing/);
  });

  it('applies operations in order and aborts the whole patch on the first failure', () => {
    expect(() =>
      applyPatchOperations('abc', [
        { find: 'a', replace: 'A' },
        { find: 'zzz', replace: 'Z' },
      ]),
    ).toThrowError(/refusing to guess/);
  });

  it('treats replacement text literally, not as a regex template', () => {
    expect(replaceLiteral('price: X', 'X', '$&$1')).toBe('price: $&$1');
    expect(countOccurrences('aaa', 'aa')).toBe(1);
    expect(countOccurrences('aaa', '')).toBe(0);
  });
});

describe('path scoping', () => {
  it('detects containment', () => {
    expect(isInsideRoot('/repo/src/Main.java', '/repo')).toBe(true);
    expect(isInsideRoot('/repo', '/repo')).toBe(true);
    expect(isInsideRoot('/repo-other/x', '/repo')).toBe(false);
    expect(isInsideRoot('/etc/passwd', '/repo')).toBe(false);
  });

  it('rejects traversal outside the roots', () => {
    try {
      resolveScopedPath('../../etc/passwd', { roots: ['/repo'], defaultRoot: '/repo/legacy' });
      throw new Error('resolveScopedPath should have thrown');
    } catch (error) {
      expect((error as PhoenixError).code).toBe('TOOL_PATH_OUT_OF_SCOPE');
    }
  });

  it('rejects an empty path', () => {
    expect(() => resolveScopedPath('  ', { roots: ['/repo'] })).toThrowError(/must not be empty/);
  });
});

describe('glob matching', () => {
  it('translates the common shapes', () => {
    expect(globToRegExp('**/*.java').test('src/main/java/App.java')).toBe(true);
    expect(globToRegExp('**/*.java').test('App.java')).toBe(true);
    expect(globToRegExp('**/*.java').test('src/App.kt')).toBe(false);
    expect(globToRegExp('*.{sql,xml}').test('V1__schema.sql')).toBe(true);
    expect(globToRegExp('*.{sql,xml}').test('nested/V1.sql')).toBe(false);
    expect(globToRegExp('src/?ain.java').test('src/main.java')).toBe(true);
  });
});

describe('searchFiles', () => {
  it('reports matches with line numbers and skips build output', () => {
    const root = new URL('./fixtures/repository', import.meta.url).pathname;
    const result = searchFiles({ root, pattern: 'FEE_WAIVER_THRESHOLD' });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.path).toBe('src/main/java/Fee.java');
    expect(result.matches[0]?.line).toBe(4);
    expect(result.matches[0]?.text).toContain('FEE_WAIVER_THRESHOLD');
    expect(result.filesScanned).toBe(2);
  });

  it('honours a file pattern', () => {
    const root = new URL('./fixtures/repository', import.meta.url).pathname;
    const result = searchFiles({ root, pattern: '.', filePattern: '**/*.sql' });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(new Set(result.matches.map((match) => match.path))).toEqual(new Set(['db/migration/V1.sql']));
    expect(result.filesScanned).toBe(1);
  });

  it('stops at maxResults and says it truncated', () => {
    const root = new URL('./fixtures/repository', import.meta.url).pathname;
    const result = searchFiles({ root, pattern: 'a', caseInsensitive: true, maxResults: 2 });
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('rejects an invalid pattern instead of returning nothing', () => {
    const root = new URL('./fixtures/repository', import.meta.url).pathname;
    expect(() => searchFiles({ root, pattern: '([unclosed' })).toThrowError(/not a valid regex/);
  });
});
