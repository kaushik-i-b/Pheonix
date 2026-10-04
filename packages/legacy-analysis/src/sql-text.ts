/**
 * Text-level SQL recognition.
 *
 * Legacy systems keep a large share of their real behaviour inside SQL strings, so the analysis has
 * to find them. This module only answers "does this text look like SQL, and what kind"; statement
 * structure lives in `sql.ts`.
 */

const SQL_KEYWORDS = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'WITH',
  'MERGE',
  'TRUNCATE',
];

/** A literal has to start with a real statement keyword to count; "select" in prose does not. */
export const SQL_LOOKS_LIKE_PATTERN = new RegExp(
  `^\\s*(?:${SQL_KEYWORDS.join('|')})\\b[\\s\\S]*`,
  'i',
);

const SECOND_KEYWORD_PATTERN =
  /\b(?:FROM|INTO|SET|VALUES|TABLE|INDEX|VIEW|TRIGGER|FUNCTION|PROCEDURE|WHERE|SELECT)\b/i;

export function looksLikeSql(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 12) return false;
  if (!SQL_LOOKS_LIKE_PATTERN.test(trimmed)) return false;
  return SECOND_KEYWORD_PATTERN.test(trimmed);
}

export type SqlVerb = 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'function' | 'trigger' | 'procedure' | 'unknown';

export function sqlVerbOf(statement: string): SqlVerb {
  const head = statement.trim().toUpperCase();
  if (head.startsWith('CREATE')) {
    if (/\bTRIGGER\b/.test(head)) return 'trigger';
    if (/\bFUNCTION\b/.test(head)) return 'function';
    if (/\bPROCEDURE\b/.test(head)) return 'procedure';
    return 'ddl';
  }
  if (head.startsWith('ALTER') || head.startsWith('DROP') || head.startsWith('TRUNCATE')) return 'ddl';
  if (head.startsWith('SELECT') || head.startsWith('WITH')) return 'select';
  if (head.startsWith('INSERT')) return 'insert';
  if (head.startsWith('UPDATE')) return 'update';
  if (head.startsWith('DELETE')) return 'delete';
  if (head.startsWith('MERGE')) return 'update';
  return 'unknown';
}

/** Words that follow FROM/JOIN/INTO/UPDATE/ON but are not tables. */
const SQL_NOISE_TABLES = new Set([
  'SELECT',
  'UNNEST',
  'GENERATE_SERIES',
  'LATERAL',
  'DUAL',
  'ONLY',
  // `BEFORE UPDATE OF balance ON accounts`: OF and SET sit exactly where a table name would be.
  'OF',
  'SET',
  'WHERE',
]);

/** Table names touched by a statement, best effort: `FROM`/`JOIN`/`INTO`/`UPDATE` targets. */
export function tablesOf(statement: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bFROM\s+([A-Za-z_][\w$.]*)/gi,
    /\bJOIN\s+([A-Za-z_][\w$.]*)/gi,
    /\bINTO\s+([A-Za-z_][\w$.]*)/gi,
    /\bUPDATE\s+([A-Za-z_][\w$.]*)/gi,
    /\bTABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([A-Za-z_][\w$.]*)/gi,
    /\bON\s+([A-Za-z_][\w$.]*)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of statement.matchAll(pattern)) {
      const name = match[1];
      if (name === undefined) continue;
      const cleaned = name.replace(/["`[\]]/g, '');
      if (cleaned.length === 0) continue;
      if (SQL_NOISE_TABLES.has(cleaned.toUpperCase())) continue;
      found.add(cleaned);
    }
  }
  return [...found].sort();
}

export function sqlSignals(statement: string): {
  hasRounding: boolean;
  hasOrderBy: boolean;
  hasAggregate: boolean;
  hasStringConcatenation: boolean;
  hasTransactionControl: boolean;
} {
  const upper = statement.toUpperCase();
  return {
    hasRounding: /\bROUND\s*\(|\bTRUNC\s*\(|\bNUMERIC\s*\(|\bCAST\s*\([^)]*\bAS\b[^)]*(?:NUMERIC|DECIMAL)/.test(upper),
    hasOrderBy: /\bORDER\s+BY\b/.test(upper),
    hasAggregate: /\b(?:COUNT|SUM|AVG|MIN|MAX)\s*\(/.test(upper),
    hasStringConcatenation: /\|\||\bCONCAT\s*\(/.test(statement),
    hasTransactionControl: /\b(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|SAVEPOINT)\b/.test(upper),
  };
}
