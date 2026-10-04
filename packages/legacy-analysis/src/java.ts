import {
  lineOf,
  maskSource,
  matchingBrace,
  matchingParen,
  type MaskedSource,
  type SourceLiteral,
} from './scanner.js';
import { looksLikeSql } from './sql-text.js';

/**
 * Structural extraction for Java sources.
 *
 * The legacy bank Phoenix must handle is Java 8 / Spring Boot, and the same extraction generalises
 * to most C-family JVM code. It is a heuristic scanner, not a parser: every declaration it reports
 * carries a line number and the exact source text it was derived from, so a reader can check it.
 * What it cannot establish is left out rather than guessed.
 */

export interface JavaAnnotation {
  name: string;
  line: number;
  arguments: string;
}

export interface JavaTypeDeclaration {
  name: string;
  kind: 'class' | 'interface' | 'enum' | 'annotation';
  line: number;
  endLine: number;
  modifiers: string[];
  annotations: JavaAnnotation[];
  superclass: string | undefined;
  interfaces: string[];
}

export interface JavaMethod {
  name: string;
  kind: 'method' | 'constructor';
  line: number;
  endLine: number;
  modifiers: string[];
  annotations: JavaAnnotation[];
  returnType: string;
  parameters: string;
  throwsTypes: string[];
  /** Masked-safe body text as it appears in the source. */
  body: string;
  declaringType: string | undefined;
}

export interface JavaField {
  name: string;
  line: number;
  modifiers: string[];
  type: string;
  initializer: string | undefined;
  constant: boolean;
}

export interface JavaFileSignals {
  hasSql: boolean;
  hasHttpAnnotation: boolean;
  hasScheduleAnnotation: boolean;
  hasTransactionAnnotation: boolean;
  hasCatchSwallow: boolean;
  hasStaticMutableState: boolean;
  hasRoundingCall: boolean;
  hasMagicNumbers: boolean;
  cyclomaticEstimate: number;
}

export interface JavaFile {
  relativePath: string;
  packageName: string | undefined;
  imports: string[];
  staticImports: string[];
  types: JavaTypeDeclaration[];
  methods: JavaMethod[];
  fields: JavaField[];
  literals: readonly SourceLiteral[];
  comments: string[];
  signals: JavaFileSignals;
  scanned: MaskedSource;
}

const HTTP_ANNOTATIONS = new Set([
  'RestController',
  'Controller',
  'RequestMapping',
  'GetMapping',
  'PostMapping',
  'PutMapping',
  'PatchMapping',
  'DeleteMapping',
  'PathVariable',
  'RequestParam',
  'RequestBody',
  'ResponseStatus',
  'WebServlet',
  'Path',
  'GET',
  'POST',
  'PUT',
  'DELETE',
]);

const SCHEDULE_ANNOTATIONS = new Set(['Scheduled', 'Schedules', 'Cron', 'RepeatInterval']);
const TRANSACTION_ANNOTATIONS = new Set(['Transactional', 'TransactionAttribute', 'TransactionalEventListener']);

const MODIFIER_PATTERN =
  /(?:public|protected|private|static|final|synchronized|abstract|native|default|strictfp|volatile|transient)/;

/**
 * Annotations written on the declaration's own line (`@Autowired private AcctSvc acctSvc;`) are as
 * common in legacy Spring code as annotations on the line above, so the declaration patterns accept
 * a leading run of them. Their argument text is recovered from the unmasked source.
 */
const ANNOTATION_RUN = '(?:@[A-Za-z_$][\\w$.]*(?:\\([^)]*\\))?[ \\t]*)*';
const ANNOTATION_RUN_LINE = /^([ \t]*(?:@[A-Za-z_$][\w$.]*(?:\([^)]*\))?[ \t]*)+)/;

const METHOD_PATTERN = new RegExp(
  [
    '(?:^|\\n)[ \\t]*',
    ANNOTATION_RUN,
    '((?:(?:public|protected|private|static|final|synchronized|abstract|native|default|strictfp)[ \\t]+)*)',
    '(?:<[^<>{};]*>[ \\t]+)?',
    '([A-Za-z_$][\\w$.]*(?:[ \\t]*<[^;{}()]*?>)?(?:[ \\t]*\\[[ \\t]*\\])*)',
    '[ \\t]+([A-Za-z_$][\\w$]*)[ \\t]*\\(',
  ].join(''),
  'g',
);

const CONSTRUCTOR_PATTERN = new RegExp(
  `(?:^|\\n)[ \\t]*${ANNOTATION_RUN}((?:(?:public|protected|private)[ \\t]+)?)([A-Z][\\w$]*)[ \\t]*\\(`,
  'g',
);

const FIELD_PATTERN = new RegExp(
  [
    '(?:^|\\n)[ \\t]*',
    ANNOTATION_RUN,
    '((?:(?:public|protected|private|static|final|volatile|transient)[ \\t]+)+)',
    '([A-Za-z_$][\\w$.]*(?:[ \\t]*<[^;{}()]*?>)?(?:[ \\t]*\\[[ \\t]*\\])*)',
    '[ \\t]+([A-Za-z_$][\\w$]*)',
    '[ \\t]*(?:=[ \\t]*([^;\\n]+))?',
    ';',
  ].join(''),
  'g',
);

const TYPE_PATTERN = /(?:^|\n)[ \t]*((?:(?:public|protected|private|static|final|abstract|strictfp)[ \t]+)*)\b(class|interface|enum|@interface)[ \t]+([A-Za-z_$][\w$]*)/g;

const ROUNDING_PATTERN =
  /\bsetScale\s*\(|\bMath\s*\.\s*round\s*\(|\bRoundingMode\b|\bROUND_(?:UP|DOWN|CEILING|FLOOR|HALF_UP|HALF_DOWN|HALF_EVEN)\b|\bdiv\s*\([^)]*,\s*\d/;

const MAGIC_NUMBER_PATTERN = /(?:[<>=!+\-*/%][ \t]*|[ \t]return[ \t]+|[ \t]case[ \t]+)-?\d{2,}(?:\.\d+)?/;

/** Tokens that can appear where a type name would, when a statement is mistaken for a declaration. */
const NON_TYPE_TOKENS = new Set(['return', 'throw', 'new', 'else', 'case', 'if', 'while', 'for', 'switch', 'catch', 'do', 'try']);

export function analyzeJavaFile(relativePath: string, source: string): JavaFile {
  const scanned = maskSource(source);
  const masked = scanned.masked;
  const typeNames = new Set<string>();

  const types: JavaTypeDeclaration[] = [];
  for (const match of masked.matchAll(TYPE_PATTERN)) {
    const matchStart = match.index ?? 0;
    const start = declarationStart(masked, matchStart);
    const kindRaw = match[2];
    const name = match[3];
    if (kindRaw === undefined || name === undefined) continue;
    const line = lineOf(scanned, start);
    const headerEnd = masked.indexOf('{', start);
    const header = headerEnd === -1 ? masked.slice(start, start + 400) : masked.slice(start, headerEnd);
    const closeBrace = headerEnd === -1 ? -1 : matchingBrace(masked, headerEnd);
    types.push({
      name,
      kind: kindRaw === '@interface' ? 'annotation' : (kindRaw as 'class' | 'interface' | 'enum'),
      line,
      endLine: closeBrace === -1 ? line : lineOf(scanned, closeBrace),
      modifiers: splitModifiers(match[1]),
      annotations: annotationsBefore(scanned, start),
      superclass: extendsOf(header),
      interfaces: implementsOf(header),
    });
    typeNames.add(name);
  }

  const methods: JavaMethod[] = [];
  const consumed = new Set<number>();
  for (const match of masked.matchAll(METHOD_PATTERN)) {
    const matchStart = match.index ?? 0;
    const start = declarationStart(masked, matchStart);
    const modifiersRaw = match[1] ?? '';
    const returnType = (match[2] ?? '').trim();
    const name = match[3] ?? '';
    if (name.length === 0 || MODIFIER_PATTERN.test(name)) continue;
    // `return foo(...)` and `throw new Foo(...)` look like declarations to a line-anchored pattern.
    if (NON_TYPE_TOKENS.has(returnType.replace(/\s+/g, ''))) continue;
    const openParen = masked.indexOf('(', matchStart + match[0].length - 1);
    const method = readSignature(masked, scanned, start, openParen, modifiersRaw, returnType, name, 'method');
    if (method === undefined) continue;
    consumed.add(method.line);
    methods.push(method);
  }

  for (const match of masked.matchAll(CONSTRUCTOR_PATTERN)) {
    const matchStart = match.index ?? 0;
    const start = declarationStart(masked, matchStart);
    const name = match[2] ?? '';
    if (!typeNames.has(name)) continue;
    const line = lineOf(scanned, start);
    if (consumed.has(line)) continue;
    const openParen = masked.indexOf('(', matchStart + match[0].length - 1);
    const method = readSignature(masked, scanned, start, openParen, match[1] ?? '', name, name, 'constructor');
    if (method === undefined) continue;
    methods.push(method);
  }
  methods.sort((a, b) => a.line - b.line);

  const fields: JavaField[] = [];
  for (const match of masked.matchAll(FIELD_PATTERN)) {
    const matchStart = match.index ?? 0;
    const start = declarationStart(masked, matchStart);
    const modifiersRaw = match[1] ?? '';
    const modifiers = splitModifiers(modifiersRaw);
    const type = (match[2] ?? '').trim();
    const name = match[3] ?? '';
    if (name.length === 0 || !/^[A-Za-z_$]/.test(name)) continue;
    if (type.length === 0 || NON_TYPE_TOKENS.has(type)) continue;
    const initializer = fieldInitializer(source, masked, matchStart, matchStart + match[0].length);
    fields.push({
      name,
      line: lineOf(scanned, start),
      modifiers,
      type,
      initializer,
      constant: modifiers.includes('static') && modifiers.includes('final'),
    });
  }

  const packageName = packageNameOf(masked);
  const imports: string[] = [];
  const staticImports: string[] = [];
  for (const match of masked.matchAll(/(?:^|\n)[ \t]*import[ \t]+(static[ \t]+)?([\w$.]+(?:\.\*)?)[ \t]*;/g)) {
    const target = match[2];
    if (target === undefined) continue;
    if (match[1] !== undefined) staticImports.push(target);
    else imports.push(target);
  }

  return {
    relativePath,
    packageName,
    imports,
    staticImports,
    types,
    methods,
    fields,
    literals: scanned.literals,
    comments: scanned.comments.map((comment) => comment.text),
    signals: computeSignals(masked, scanned, methods, fields),
    scanned,
  };
}

function readSignature(
  masked: string,
  scanned: MaskedSource,
  start: number,
  openParen: number,
  modifiersRaw: string,
  returnType: string,
  name: string,
  kind: JavaMethod['kind'],
): JavaMethod | undefined {
  if (openParen === -1) return undefined;
  const closeParen = matchingParen(masked, openParen);
  if (closeParen === -1) return undefined;
  // Between the parameter list and the body only `throws ...` and annotations are legal.
  let cursor = closeParen + 1;
  while (cursor < masked.length && /\s/.test(masked[cursor] ?? '')) cursor += 1;
  let throwsTypes: string[] = [];
  if (masked.startsWith('throws', cursor)) {
    const braceOrSemicolon = indexOfAny(masked, cursor, ['{', ';']);
    if (braceOrSemicolon === -1) return undefined;
    throwsTypes = masked
      .slice(cursor + 'throws'.length, braceOrSemicolon)
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    cursor = braceOrSemicolon;
  }
  while (cursor < masked.length && /\s/.test(masked[cursor] ?? '')) cursor += 1;
  const terminator = masked[cursor];
  if (terminator !== '{' && terminator !== ';') return undefined;

  const line = lineOf(scanned, start);
  let endLine = line;
  let body = '';
  if (terminator === '{') {
    const close = matchingBrace(masked, cursor);
    if (close === -1) return undefined;
    endLine = lineOf(scanned, close);
    body = scanned.source.slice(cursor + 1, close);
  }
  return {
    name,
    kind,
    line,
    endLine,
    modifiers: splitModifiers(modifiersRaw),
    annotations: annotationsBefore(scanned, start),
    returnType,
    parameters: masked.slice(openParen + 1, closeParen).replace(/\s+/g, ' ').trim(),
    throwsTypes,
    body,
    declaringType: enclosingType(masked, start),
  };
}

function enclosingType(masked: string, offset: number): string | undefined {
  let found: string | undefined;
  for (const match of masked.matchAll(TYPE_PATTERN)) {
    const start = match.index ?? 0;
    if (start >= offset) break;
    found = match[3];
  }
  return found;
}

/**
 * Annotations sit on the lines immediately above a declaration. They are matched on masked text so
 * that a `(` inside a string or comment cannot end the argument list early, but the argument text is
 * then taken from the *real* source at the same offsets — annotation arguments are almost always
 * literals (`@PostMapping("/api/accounts")`), which masking blanks out.
 */
/**
 * Offset of a declaration's first real character.
 *
 * Every declaration pattern is anchored with `(?:^|\n)[ \t]*`, so `match.index` sits on the newline
 * *above* the declaration. Citing that offset puts every method, field and type one line early —
 * usually on a blank line — and a citation that points at nothing is worse than no citation.
 */
function declarationStart(masked: string, matchStart: number): number {
  let index = matchStart;
  while (index < masked.length && /[\s]/.test(masked[index] ?? '')) index += 1;
  return index;
}

function annotationsBefore(scanned: MaskedSource, start: number): JavaAnnotation[] {
  const masked = scanned.masked;
  const annotations: JavaAnnotation[] = [];
  // Walk backwards over the preceding lines while they are annotation lines. `cursor` is the offset
  // of the newline that ends the line above the declaration, which is what the slice below expects;
  // starting from the declaration itself would read its own indentation as the previous line.
  let cursor = Math.max(0, masked.lastIndexOf('\n', Math.max(0, start - 1)));
  for (;;) {
    const lineStart = masked.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1;
    const lineTextValue = masked.slice(lineStart, cursor).trim();
    const match = /^@([A-Za-z_$][\w$.]*)(?:\(([^)]*)\))?$/.exec(lineTextValue);
    if (match === null) break;
    const openParen = masked.indexOf('(', lineStart);
    annotations.unshift({
      name: match[1] ?? '',
      line: lineOf(scanned, lineStart),
      arguments: annotationArguments(scanned, openParen >= cursor ? -1 : openParen).replace(/\s+/g, ' ').trim(),
    });
    if (lineStart === 0) break;
    cursor = lineStart - 1;
    // Skip blank lines between annotations.
    while (cursor > 0 && masked.slice(masked.lastIndexOf('\n', cursor - 1) + 1, cursor).trim() === '') {
      cursor = masked.lastIndexOf('\n', cursor - 1);
    }
  }
  return [...annotations, ...inlineAnnotations(scanned, start)];
}

/** Annotations written on the declaration's own line, in source order. */
function inlineAnnotations(scanned: MaskedSource, start: number): JavaAnnotation[] {
  const masked = scanned.masked;
  const lineStart = masked[start] === '\n' ? start + 1 : start;
  const newline = masked.indexOf('\n', lineStart);
  const lineText = masked.slice(lineStart, newline === -1 ? masked.length : newline);
  const run = ANNOTATION_RUN_LINE.exec(lineText)?.[1];
  if (run === undefined) return [];
  const found: JavaAnnotation[] = [];
  for (const match of run.matchAll(/@([A-Za-z_$][\w$.]*)(\()?/g)) {
    const name = match[1];
    if (name === undefined) continue;
    const openParen = match[2] === undefined ? -1 : lineStart + (match.index ?? 0) + 1 + name.length;
    found.push({
      name,
      line: lineOf(scanned, lineStart),
      arguments: annotationArguments(scanned, openParen).replace(/\s+/g, ' ').trim(),
    });
  }
  return found;
}

function annotationArguments(scanned: MaskedSource, openParen: number): string {
  if (openParen === -1) return '';
  const closeParen = matchingParen(scanned.masked, openParen);
  if (closeParen === -1) return '';
  return scanned.source.slice(openParen + 1, closeParen);
}

function splitModifiers(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => MODIFIER_PATTERN.test(entry) && entry.length > 0);
}

function extendsOf(header: string): string | undefined {
  const match = /\bextends\s+([A-Za-z_$][\w$.<>,\s]*?)(?:\s+implements\b|\s*$)/.exec(header);
  return match?.[1]?.trim();
}

function implementsOf(header: string): string[] {
  const match = /\bimplements\s+([A-Za-z_$][\w$.<>,\s]*)$/.exec(header.trim());
  if (match?.[1] === undefined) return [];
  return match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function packageNameOf(masked: string): string | undefined {
  const match = /(?:^|\n)[ \t]*package[ \t]+([\w$.]+)[ \t]*;/.exec(masked);
  return match?.[1];
}

function indexOfAny(text: string, from: number, needles: readonly string[]): number {
  let best = -1;
  for (const needle of needles) {
    const found = text.indexOf(needle, from);
    if (found !== -1 && (best === -1 || found < best)) best = found;
  }
  return best;
}

/** Field initialisers are blanked in `masked`; recover the real text from the source at that span. */
function fieldInitializer(source: string, masked: string, matchStart: number, matchEnd: number): string | undefined {
  const equals = masked.indexOf('=', matchStart);
  if (equals === -1 || equals >= matchEnd) return undefined;
  // The match ends at the terminating `;`, which was found on masked text and is therefore real.
  const terminator = masked.lastIndexOf(';', matchEnd);
  if (terminator <= equals) return undefined;
  const text = source.slice(equals + 1, terminator).trim();
  return text.length === 0 ? undefined : text;
}

function computeSignals(
  masked: string,
  scanned: MaskedSource,
  methods: readonly JavaMethod[],
  fields: readonly JavaField[],
): JavaFileSignals {
  const annotations = new Set<string>();
  for (const method of methods) {
    for (const annotation of method.annotations) annotations.add(annotation.name.split('.').pop() ?? annotation.name);
  }
  for (const match of masked.matchAll(/@([A-Za-z_$][\w$.]*)/g)) {
    const name = match[1];
    if (name !== undefined) annotations.add(name.split('.').pop() ?? name);
  }

  let cyclomatic = 1;
  for (const method of methods) {
    cyclomatic += cyclomaticOf(method.body);
  }

  return {
    hasSql: scanned.literals.some((literal) => looksLikeSql(literal.value)),
    hasHttpAnnotation: [...annotations].some((name) => HTTP_ANNOTATIONS.has(name)),
    hasScheduleAnnotation: [...annotations].some((name) => SCHEDULE_ANNOTATIONS.has(name)),
    hasTransactionAnnotation: [...annotations].some((name) => TRANSACTION_ANNOTATIONS.has(name)),
    hasCatchSwallow: hasSwallowedCatch(masked),
    hasStaticMutableState: fields.some((field) => field.modifiers.includes('static') && !field.modifiers.includes('final')),
    hasRoundingCall: ROUNDING_PATTERN.test(masked),
    hasMagicNumbers: MAGIC_NUMBER_PATTERN.test(masked),
    cyclomaticEstimate: cyclomatic,
  };
}

export function cyclomaticOf(body: string): number {
  const keywords = body.match(/\b(?:if|for|while|case|catch)\b/g)?.length ?? 0;
  const operators = body.match(/&&|\|\||\?/g)?.length ?? 0;
  return keywords + operators;
}

/** A catch block whose body does nothing but (optionally) comment or log is a swallowed exception. */
function hasSwallowedCatch(masked: string): boolean {
  for (const match of masked.matchAll(/\bcatch[ \t]*\([^)]*\)[ \t]*\{/g)) {
    const openBrace = (match.index ?? 0) + match[0].length - 1;
    const close = matchingBrace(masked, openBrace);
    if (close === -1) continue;
    const body = masked.slice(openBrace + 1, close).trim();
    if (body.length === 0) return true;
    const statements = body.split(';').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    if (statements.length === 0) return true;
    if (statements.every((statement) => /\b(?:log(?:ger)?|LOG|System\.err|System\.out)\b/.test(statement))) return true;
  }
  return false;
}
