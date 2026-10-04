import { lineAt, maskSource } from './scanner.js';
import { sqlSignals, sqlVerbOf, tablesOf, type SqlVerb } from './sql-text.js';

/**
 * SQL file analysis: statement splitting and DDL object extraction.
 *
 * Splitting has to respect single quotes, `--` comments and Postgres dollar-quoted bodies
 * (`$$ ... $$`), otherwise a function containing a semicolon — or a comment containing one — is
 * chopped into nonsense. Quotes and `//` comments are already blanked by `maskSource`; SQL line
 * comments are handled here, because `--` means something entirely different in Java.
 */

export interface SqlStatementInfo {
  index: number;
  kind: SqlVerb;
  /** The chunk as written, commentary included: what a human should be shown. */
  raw: string;
  /** The statement proper: what was classified. */
  body: string;
  /** Line the statement itself begins on. */
  line: number;
  endLine: number;
  tables: string[];
  writes: boolean;
  signals: ReturnType<typeof sqlSignals>;
}

export interface DatabaseColumnInfo {
  name: string;
  type: string;
  nullable: boolean | undefined;
  precision: string | undefined;
}

export interface DatabaseObjectInfo {
  name: string;
  kind: 'table' | 'view' | 'index' | 'sequence' | 'function' | 'trigger' | 'constraint';
  line: number;
  columns: DatabaseColumnInfo[];
  behavior: string | undefined;
  /** Table a trigger/index/constraint belongs to, when the DDL states it. */
  onTable: string | undefined;
}

export interface SqlFileAnalysis {
  relativePath: string;
  statements: SqlStatementInfo[];
  objects: DatabaseObjectInfo[];
  /** True when the file installs behaviour inside the database (triggers, functions, rules). */
  appliesDatabaseBehavior: boolean;
}

export interface SqlStatement {
  /** The chunk as written, including any commentary that preceded the statement. */
  raw: string;
  /** The statement proper, from its first keyword to its terminator. Classify this, not `raw`. */
  body: string;
  /** Line the statement itself begins on — the line a citation should point at. */
  line: number;
  endLine: number;
}

export function splitStatements(source: string): SqlStatement[] {
  const scanned = maskSource(source);
  const masked = scanned.masked;
  const statements: SqlStatement[] = [];
  if (source.length === 0) return statements;
  let start = 0;
  let index = 0;

  /**
   * A chunk begins right after the previous semicolon, so it carries whatever comments and blank
   * lines preceded the statement. Both the cited line and the classified text have to come from the
   * statement proper: pointing a citation at the commentary above a `CREATE`, or asking what verb a
   * comment starts with, sends every downstream consumer to the wrong place.
   */
  const statement = (end: number, endLine: number): SqlStatement | undefined => {
    if (start >= end) return undefined;
    const bodyStart = skipSqlTrivia(source, start, end);
    const body = source.slice(bodyStart, end).trim();
    if (body.length === 0) return undefined;
    return {
      raw: source.slice(start, end).trim(),
      body,
      line: lineAt(scanned.lineStarts, bodyStart),
      endLine,
    };
  };

  while (index < masked.length) {
    // Dollar-quoted bodies hide their own semicolons from the splitter.
    const dollar = masked.startsWith('$', index) ? dollarTagEnd(masked, index) : -1;
    if (dollar !== -1) {
      const tag = masked.slice(index, dollar);
      const close = masked.indexOf(tag, dollar);
      index = close === -1 ? masked.length : close + tag.length;
      continue;
    }
    // So does a `--` comment: legacy migrations are full of prose that happens to contain a
    // semicolon, and splitting there produces statements that begin in the middle of a sentence.
    if (masked[index] === '-' && masked[index + 1] === '-') {
      const newline = masked.indexOf('\n', index);
      index = newline === -1 ? masked.length : newline + 1;
      continue;
    }
    if (masked[index] === ';') {
      const parsed = statement(index + 1, lineAt(scanned.lineStarts, index));
      if (parsed !== undefined) statements.push(parsed);
      index += 1;
      start = index;
      continue;
    }
    index += 1;
  }
  const parsed = statement(source.length, lineAt(scanned.lineStarts, source.length - 1));
  if (parsed !== undefined) statements.push(parsed);
  return statements;
}

/**
 * Offset of the first character of a statement, stepping over whitespace, `--` and block comments,
 * but never past `to`: a chunk that is nothing but commentary has no statement to point at.
 */
function skipSqlTrivia(source: string, from: number, to: number): number {
  let index = from;
  while (index < to) {
    const character = source[index];
    if (character === undefined) break;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '-' && source[index + 1] === '-') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? to : Math.min(end + 1, to);
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close === -1 ? to : Math.min(close + 2, to);
      continue;
    }
    break;
  }
  // Past the end is a legitimate answer: a chunk that is nothing but commentary has no statement
  // in it, and clamping to the last character would invent one.
  return Math.min(index, source.length);
}

/** When `index` starts a dollar-quote tag, returns the offset just past the closing `$`. */
function dollarTagEnd(masked: string, index: number): number {
  const match = /^\$[A-Za-z_]*\$/.exec(masked.slice(index, index + 64));
  return match === null ? -1 : index + match[0].length;
}

export function analyzeSqlFile(relativePath: string, source: string): SqlFileAnalysis {
  const statements: SqlStatementInfo[] = [];
  const objects: DatabaseObjectInfo[] = [];
  let appliesDatabaseBehavior = false;

  const parts = splitStatements(source);
  parts.forEach((part, partIndex) => {
    const kind = sqlVerbOf(part.body);
    if (kind === 'trigger' || kind === 'function' || kind === 'procedure') appliesDatabaseBehavior = true;
    if (/\bCREATE\s+(?:OR\s+REPLACE\s+)?RULE\b/i.test(part.body)) appliesDatabaseBehavior = true;
    statements.push({
      index: partIndex,
      kind,
      raw: part.raw,
      body: part.body,
      line: part.line,
      endLine: part.endLine,
      tables: tablesOf(part.body),
      writes: kind === 'insert' || kind === 'update' || kind === 'delete' || kind === 'ddl' || kind === 'trigger' || kind === 'function' || kind === 'procedure',
      signals: sqlSignals(part.body),
    });
    for (const object of objectsIn(part.body, part.line)) {
      if (object.kind === 'trigger' || object.kind === 'function') appliesDatabaseBehavior = true;
      objects.push(object);
    }
  });

  return { relativePath, statements, objects, appliesDatabaseBehavior };
}

const CREATE_TABLE_PATTERN =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_"][\w$."]*)\s*\(([\s\S]*)\)/i;
const CREATE_OBJECT_PATTERN =
  /CREATE\s+(?:OR\s+REPLACE\s+)?(UNIQUE\s+)?(INDEX|MATERIALIZED\s+VIEW|VIEW|SEQUENCE|TRIGGER|FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_"][\w$."]*)/i;
const ALTER_CONSTRAINT_PATTERN =
  /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z_"][\w$."]*)\s+ADD\s+(?:CONSTRAINT\s+)?([A-Za-z_"][\w$."]*)?\s*(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK)/i;
const ON_TABLE_PATTERN = /\bON\s+([A-Za-z_"][\w$."]*)/i;

function objectsIn(statement: string, line: number): DatabaseObjectInfo[] {
  const objects: DatabaseObjectInfo[] = [];

  const table = CREATE_TABLE_PATTERN.exec(statement);
  if (table !== null) {
    objects.push({
      name: cleanIdentifier(table[1] ?? ''),
      kind: 'table',
      line,
      columns: parseColumns(table[2] ?? ''),
      behavior: undefined,
      onTable: undefined,
    });
    return objects;
  }

  const created = CREATE_OBJECT_PATTERN.exec(statement);
  if (created !== null) {
    const rawKind = (created[2] ?? '').toUpperCase().replace(/\s+/g, ' ');
    const kind: DatabaseObjectInfo['kind'] =
      rawKind === 'INDEX'
        ? 'index'
        : rawKind === 'VIEW' || rawKind === 'MATERIALIZED VIEW'
          ? 'view'
          : rawKind === 'SEQUENCE'
            ? 'sequence'
            : rawKind === 'TRIGGER'
              ? 'trigger'
              : 'function';
    const onTable = ON_TABLE_PATTERN.exec(statement);
    objects.push({
      name: cleanIdentifier(created[3] ?? ''),
      kind,
      line,
      columns: [],
      ...(kind === 'trigger' || kind === 'function'
        ? { behavior: summarizeBehavior(statement) }
        : { behavior: undefined }),
      onTable: onTable?.[1] === undefined ? undefined : cleanIdentifier(onTable[1]),
    });
    return objects;
  }

  const constraint = ALTER_CONSTRAINT_PATTERN.exec(statement);
  if (constraint !== null) {
    const name = constraint[2] === undefined ? `${cleanIdentifier(constraint[1] ?? '')}_${(constraint[3] ?? '').toLowerCase().replace(/\s+/g, '_')}` : cleanIdentifier(constraint[2]);
    objects.push({
      name,
      kind: 'constraint',
      line,
      columns: [],
      behavior: statement.replace(/\s+/g, ' ').trim().slice(0, 4000),
      onTable: cleanIdentifier(constraint[1] ?? ''),
    });
  }

  return objects;
}

/** A trigger/function body is behaviour; keep a readable digest rather than the whole DDL. */
function summarizeBehavior(statement: string): string {
  return statement.replace(/\s+/g, ' ').trim().slice(0, 4000);
}

export function parseColumns(body: string): DatabaseColumnInfo[] {
  const columns: DatabaseColumnInfo[] = [];
  for (const entry of splitTopLevel(body)) {
    const text = entry.trim();
    if (text.length === 0) continue;
    // Table-level constraints are not columns.
    if (/^(?:CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE)\b/i.test(text)) continue;
    const match = /^([A-Za-z_"][\w$"]*)\s+([A-Za-z_][\w$]*(?:\s*\([^)]*\))?(?:\s*\[\s*\])?)([\s\S]*)$/.exec(text);
    if (match === null) continue;
    const rest = match[3] ?? '';
    const typeText = (match[2] ?? '').trim();
    const precisionMatch = /\(([^)]*)\)/.exec(typeText);
    columns.push({
      name: cleanIdentifier(match[1] ?? ''),
      type: typeText.replace(/\s*\([^)]*\)/, '').trim(),
      nullable: /\bNOT\s+NULL\b/i.test(rest) ? false : /\bNULL\b/i.test(rest) ? true : undefined,
      precision: precisionMatch?.[1]?.replace(/\s+/g, ''),
    });
  }
  return columns;
}

/** Split on commas that are not nested inside parentheses or quotes. */
export function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let inQuote = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? '';
    if (inQuote) {
      current += character;
      if (character === "'") inQuote = false;
      continue;
    }
    if (character === "'") {
      inQuote = true;
      current += character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') depth = Math.max(0, depth - 1);
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

export function cleanIdentifier(raw: string): string {
  return raw.replace(/["`]/g, '').replace(/\s+/g, ' ').trim();
}
