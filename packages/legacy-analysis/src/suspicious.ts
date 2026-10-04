import type { DuplicationCluster, SuspiciousBehavior } from '@phoenix/shared';
import { lineAt, matchingBrace } from './scanner.js';
import { evidenceId } from './evidence.js';
import type { JavaFile, JavaMethod } from './java.js';
import type { SqlFileAnalysis } from './sql.js';

/**
 * Deterministic suspicious-behaviour detection.
 *
 * These are *observations about text*, not conclusions about intent: each one records the category,
 * the exact location and a recommended next action (probe it at runtime, characterize it, or record
 * it as a risk). The Archaeologist decides which of them matter and must say why.
 */

export interface SuspiciousInput {
  javaFiles: readonly JavaFile[];
  sqlFiles: readonly SqlFileAnalysis[];
  duplicationClusters: readonly DuplicationCluster[];
}

const TIME_DEPENDENCE = [
  /\bnew\s+(?:java\.util\.)?Date\s*\(/,
  /\bSystem\s*\.\s*currentTimeMillis\s*\(/,
  /\bLocal(?:Date|DateTime|Time)\s*\.\s*now\s*\(/,
  /\bCalendar\s*\.\s*getInstance\s*\(/,
  /\bInstant\s*\.\s*now\s*\(/,
  /\bnew\s+Random\s*\(/,
  /\bMath\s*\.\s*random\s*\(/,
  /\bUUID\s*\.\s*randomUUID\s*\(/,
];

const SQL_TIME_DEPENDENCE = /\b(?:NOW\s*\(\s*\)|CURRENT_DATE|CURRENT_TIMESTAMP|LOCALTIMESTAMP|clock_timestamp\s*\(\s*\)\b)/i;

const MISLEADING_COMMENT =
  /\b(?:TODO|FIXME|HACK|XXX|WORKAROUND|temporar|for now|do not (?:remove|delete|touch)|nobody knows|don'?t ask)\b/i;

const MANUAL_TRANSACTION = /\bsetAutoCommit\s*\(|\.commit\s*\(\s*\)|\.rollback\s*\(\s*\)/;

const WRITE_CALL =
  /\.(?:insert|update|delete|save|persist|executeUpdate|execute|send|post|create)\w*\s*\(|\b(?:INSERT|UPDATE|DELETE)\s+/i;

const IDEMPOTENCY_HINT = /idempoten|dedup|duplicate[-_ ]?key|already[-_ ]?processed/i;

const ROUTE_ANNOTATIONS = ['GetMapping', 'PostMapping', 'PutMapping', 'PatchMapping', 'DeleteMapping', 'RequestMapping', 'Path'];
const GUARD_ANNOTATIONS = ['PreAuthorize', 'PostAuthorize', 'Secured', 'RolesAllowed'];

/** Numeric literals that are idiomatic rather than encoded thresholds. */
const TRIVIAL_NUMBERS = new Set(['0', '1', '2', '-1', '10', '0.0', '1.0']);

export function detectSuspicious(input: SuspiciousInput): SuspiciousBehavior[] {
  const behaviors: SuspiciousBehavior[] = [];

  const push = (
    category: SuspiciousBehavior['category'],
    description: string,
    location: SuspiciousBehavior['location'],
    recommendedAction: SuspiciousBehavior['recommendedAction'] = 'runtime-probe',
    epistemicStatus: SuspiciousBehavior['epistemicStatus'] = 'OBSERVED',
  ): void => {
    behaviors.push({
      id: evidenceId(`sb-${category}`, location.path, location.startLine, description.slice(0, 60)),
      category,
      description: description.slice(0, 2000),
      location,
      epistemicStatus,
      recommendedAction,
    });
  };

  for (const file of input.javaFiles) {
    const masked = file.scanned.masked;

    for (const match of masked.matchAll(/\bcatch[ \t]*\(([^)]*)\)[ \t]*\{/g)) {
      const openBrace = (match.index ?? 0) + match[0].length - 1;
      const close = matchingBrace(masked, openBrace);
      if (close === -1) continue;
      const body = masked.slice(openBrace + 1, close).trim();
      const line = lineAt(file.scanned.lineStarts, openBrace);
      const statements = body.split(';').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      const caught = match[1]?.trim() ?? 'exception';
      if (statements.length === 0) {
        push('swallowed-exception', `empty catch block for ${caught} — the failure leaves no trace`, { path: file.relativePath, startLine: line }, 'characterize');
      } else if (statements.every((statement) => /\b(?:log(?:ger)?|LOG|System\.err|System\.out)\b/.test(statement))) {
        push('swallowed-exception', `catch block for ${caught} only logs and continues`, { path: file.relativePath, startLine: line }, 'runtime-probe');
      }
    }

    for (const field of file.fields) {
      if (field.modifiers.includes('static') && !field.modifiers.includes('final')) {
        push(
          'static-mutable-state',
          `mutable static field ${field.name} of type ${field.type} is shared across requests`,
          { path: file.relativePath, startLine: field.line, symbol: field.name },
        );
      }
    }

    for (const method of file.methods) {
      const location = { path: file.relativePath, startLine: method.line, endLine: method.endLine, symbol: method.name };

      const timeHit = TIME_DEPENDENCE.find((pattern) => pattern.test(method.body));
      if (timeHit !== undefined) {
        // The matching line is evidence, not orientation: it goes in the snippet the artifact keeps,
        // never in prose that the discovery digest would hand to a model as though it had read it.
        push(
          'time-dependence',
          `${method.name} depends on the current time or randomness`,
          { ...location, snippet: firstMatchLine(method.body, timeHit) },
          'differential-scenario',
        );
      }

      if (MANUAL_TRANSACTION.test(method.body)) {
        push('transaction-boundary-anomaly', `${method.name} manages a transaction manually instead of declaratively`, location);
      }

      const transactional = method.annotations.find((annotation) => annotation.name === 'Transactional');
      if (transactional !== undefined && method.modifiers.includes('private')) {
        push('transaction-boundary-anomaly', `@Transactional on private method ${method.name} has no effect through a Spring proxy`, location, 'record-risk');
      }
      if (transactional !== undefined && /REQUIRES_NEW/.test(transactional.arguments)) {
        push(
          'transaction-boundary-anomaly',
          `${method.name} runs in REQUIRES_NEW: it commits independently of its caller and survives a caller rollback`,
          location,
          'differential-scenario',
        );
      }

      const retries = /retry|retries|attempt|maxAttempts/i.test(method.body) || /retry/i.test(method.name);
      if (retries && WRITE_CALL.test(method.body) && !IDEMPOTENCY_HINT.test(method.body) && !IDEMPOTENCY_HINT.test(method.parameters)) {
        push('retry-without-idempotency', `${method.name} retries a write with no visible idempotency guard`, location, 'differential-scenario');
      }

      if (method.annotations.some((annotation) => /unchecked/.test(annotation.arguments))) {
        push('unchecked-cast', `${method.name} suppresses unchecked-cast warnings`, location, 'record-risk');
      }

      const magics = magicNumbersIn(method.body);
      if (magics.length > 0) {
        // One entry per method, literals in the snippet: the count orients a reader, the values are
        // something the reader has to go and look at in the file itself.
        push(
          'magic-number',
          `${method.name} uses ${magics.length} bare numeric literal(s); the threshold(s) they encode have no name`,
          { path: file.relativePath, startLine: method.line, symbol: method.name, snippet: magics.join(', ') },
          'characterize',
        );
      }
    }

    for (const comment of file.scanned.comments) {
      if (!MISLEADING_COMMENT.test(comment.text)) continue;
      push(
        'misleading-comment',
        'comment carries a warning or unfinished-work marker',
        {
          path: file.relativePath,
          startLine: comment.line,
          snippet: comment.text.replace(/\s+/g, ' ').trim().slice(0, 2000),
        },
        'record-risk',
      );
    }

    const clockHit = file.signals.hasSql ? SQL_TIME_DEPENDENCE.exec(file.scanned.source) : null;
    if (clockHit !== null) {
      push(
        'time-dependence',
        `${file.relativePath} embeds SQL that reads the database clock`,
        { path: file.relativePath, startLine: lineAt(file.scanned.lineStarts, clockHit.index), snippet: clockHit[0] },
        'differential-scenario',
      );
    }
  }

  for (const sqlFile of input.sqlFiles) {
    if (!sqlFile.appliesDatabaseBehavior) continue;
    for (const object of sqlFile.objects) {
      if (object.kind !== 'trigger' && object.kind !== 'function') continue;
      push(
        'db-side-behavior',
        `${object.kind} ${object.name} executes inside the database${object.onTable === undefined ? '' : ` on ${object.onTable}`}; a rewrite that only replaces application code loses it`,
        { path: sqlFile.relativePath, startLine: object.line, symbol: object.name },
      );
    }
  }

  for (const behavior of detectAuthorizationGaps(input.javaFiles)) behaviors.push(behavior);
  for (const behavior of detectDeadCode(input.javaFiles)) behaviors.push(behavior);

  for (const cluster of input.duplicationClusters) {
    const first = cluster.members[0];
    if (first === undefined) continue;
    push(
      'duplicated-calculation',
      cluster.description,
      { path: first.path, startLine: first.startLine, symbol: first.symbol },
      // A drifted clone is two answers to the same question: only a differential run can say which
      // one production actually depends on.
      cluster.drifted ? 'differential-scenario' : 'characterize',
    );
  }

  return behaviors;
}

/** Reports an inconsistency only: some handlers declare an authorization rule, others do not. */
function detectAuthorizationGaps(javaFiles: readonly JavaFile[]): SuspiciousBehavior[] {
  let guardedCount = 0;
  const unguarded: { file: JavaFile; method: JavaMethod }[] = [];
  for (const file of javaFiles) {
    for (const method of file.methods) {
      if (!method.annotations.some((annotation) => ROUTE_ANNOTATIONS.includes(annotation.name))) continue;
      const type = file.types.find((entry) => entry.name === method.declaringType);
      const isGuarded =
        method.annotations.some((annotation) => GUARD_ANNOTATIONS.includes(annotation.name)) ||
        (type?.annotations.some((annotation) => GUARD_ANNOTATIONS.includes(annotation.name)) ?? false);
      if (isGuarded) guardedCount += 1;
      else unguarded.push({ file, method });
    }
  }
  if (guardedCount === 0) return [];
  return unguarded.map(({ file, method }) => ({
    id: evidenceId('sb-authorization-gap', file.relativePath, method.line),
    category: 'authorization-gap' as const,
    description: `${method.name} has no authorization annotation while ${guardedCount} other handler(s) in this repository do`,
    location: { path: file.relativePath, startLine: method.line, endLine: method.endLine, symbol: method.name },
    epistemicStatus: 'OBSERVED' as const,
    recommendedAction: 'record-risk' as const,
  }));
}

/** A private method no other analyzed source mentions is unreachable from anywhere Phoenix can see. */
function detectDeadCode(javaFiles: readonly JavaFile[]): SuspiciousBehavior[] {
  const corpus = javaFiles.map((file) => file.scanned.masked).join('\n');
  const results: SuspiciousBehavior[] = [];
  for (const file of javaFiles) {
    for (const method of file.methods) {
      if (!method.modifiers.includes('private')) continue;
      if (method.annotations.some((annotation) => annotation.name === 'Scheduled' || annotation.name === 'PostConstruct')) continue;
      const references = corpus.match(new RegExp(`\\b${escapeRegExp(method.name)}\\s*\\(`, 'g'))?.length ?? 0;
      if (references > 1) continue; // one occurrence is the declaration itself
      results.push({
        id: evidenceId('sb-dead-code', file.relativePath, method.line),
        category: 'dead-code',
        description: `private method ${method.name} is never called from any analyzed source`,
        location: { path: file.relativePath, startLine: method.line, endLine: method.endLine, symbol: method.name },
        epistemicStatus: 'INFERRED',
        recommendedAction: 'record-risk',
      });
    }
  }
  return results;
}

/**
 * Near-duplicate method bodies.
 *
 * Bodies are reduced to a bigram signature with literals erased, so two copies of the same
 * calculation that differ only in their *constants or rounding mode* land in one cluster and are
 * reported as drifted. That is the case that silently breaks during a migration: byte-identical
 * copies are a maintenance smell, drifted copies are a behavioural fork.
 *
 * Candidates come from an inverted index over bigrams rather than an all-pairs comparison, and
 * bigrams that appear in a large fraction of methods are dropped from the index because they carry
 * no discriminating signal.
 */
export function detectDuplication(javaFiles: readonly JavaFile[], collectedAt: string): DuplicationCluster[] {
  const members: DuplicateMember[] = [];
  for (const file of javaFiles) {
    for (const method of file.methods) {
      if (method.kind === 'constructor') continue;
      const normalized = normalizeBody(method.body);
      const signature = tokenBigrams(normalized);
      if (signature.size < MIN_SIGNATURE_BIGRAMS) continue;
      members.push({ file, method, normalized, signature });
    }
  }

  const postings = new Map<string, number[]>();
  members.forEach((member, index) => {
    for (const bigram of member.signature) {
      const list = postings.get(bigram) ?? [];
      list.push(index);
      postings.set(bigram, list);
    }
  });
  const maxPostings = Math.max(8, Math.floor(members.length * 0.05));

  const neighbours = members.map(() => new Set<number>());
  members.forEach((member, index) => {
    const candidates = new Set<number>();
    for (const bigram of member.signature) {
      const list = postings.get(bigram);
      if (list === undefined || list.length > maxPostings) continue;
      for (const other of list) if (other > index) candidates.add(other);
    }
    for (const other of candidates) {
      const counterpart = members[other];
      if (counterpart === undefined) continue;
      if (sizeRatio(member.signature, counterpart.signature) < DUPLICATION_SIZE_RATIO) continue;
      if (containment(member.signature, counterpart.signature) < DUPLICATION_CONTAINMENT) continue;
      neighbours[index]?.add(other);
      neighbours[other]?.add(index);
    }
  });

  const clusters: DuplicationCluster[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < members.length; index += 1) {
    if (seen.has(index)) continue;
    const component = connectedComponent(index, neighbours, seen);
    if (component.length < 2) continue;
    const group = component
      .map((position) => members[position])
      .filter((entry): entry is DuplicateMember => entry !== undefined)
      .sort((a, b) => a.file.relativePath.localeCompare(b.file.relativePath) || a.method.line - b.method.line);
    if (group.length < 2) continue;
    const drifted = new Set(group.map((entry) => entry.normalized)).size > 1;
    const similarity = averageSimilarity(group);
    clusters.push({
      id: evidenceId('dup', group[0]?.file.relativePath ?? '', group[0]?.method.line ?? 0),
      description: drifted
        ? `${group.length} methods share the same shape with different literals or operators: ${group
            .map((entry) => symbolOf(entry.method))
            .join(', ')}`
        : `${group.length} byte-equivalent method bodies: ${group.map((entry) => symbolOf(entry.method)).join(', ')}`,
      members: group.map((entry) => ({
        path: entry.file.relativePath,
        startLine: entry.method.line,
        endLine: entry.method.endLine,
        symbol: symbolOf(entry.method),
      })),
      drifted,
      driftEvidence: drifted
        ? group.slice(0, 4).map((entry) => ({
            id: evidenceId('dup-ev', entry.file.relativePath, entry.method.line),
            kind: 'source-code' as const,
            collectedAt,
            collectedBy: '@phoenix/legacy-analysis/detectDuplication',
            location: {
              path: entry.file.relativePath,
              startLine: entry.method.line,
              endLine: entry.method.endLine,
              symbol: entry.method.name,
            },
            quote: entry.normalized.slice(0, 1200),
          }))
        : [],
      ...(similarity !== undefined ? { similarity } : {}),
    });
  }
  return clusters.sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id));
}

function containment(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const bigram of left) if (right.has(bigram)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

function averageSimilarity(group: readonly DuplicateMember[]): number | undefined {
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      const left = group[i]?.signature;
      const right = group[j]?.signature;
      if (left === undefined || right === undefined) continue;
      total += containment(left, right);
      pairs += 1;
    }
  }
  if (pairs === 0) return undefined;
  return Math.min(1, Math.round((total / pairs) * 1000) / 1000);
}

interface DuplicateMember {
  file: JavaFile;
  method: JavaMethod;
  normalized: string;
  signature: Set<string>;
}

const MIN_SIGNATURE_BIGRAMS = 10;
const DUPLICATION_CONTAINMENT = 0.75;
/**
 * Containment alone would call a three-line helper a duplicate of any large method that happens to
 * contain it, so the two signatures also have to be of comparable size.
 */
const DUPLICATION_SIZE_RATIO = 0.6;

function sizeRatio(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  return Math.min(left.size, right.size) / Math.max(left.size, right.size);
}

function connectedComponent(start: number, neighbours: readonly Set<number>[], seen: Set<number>): number[] {
  const component: number[] = [];
  const queue = [start];
  seen.add(start);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    component.push(current);
    for (const next of neighbours[current] ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return component.sort((a, b) => a - b);
}

function tokenBigrams(normalized: string): Set<string> {
  const tokens =
    normalized
      .replace(/"(?:[^"\\\n]|\\.)*"/g, ' STR ')
      .replace(/\b\d+(?:\.\d+)?\b/g, ' NUM ')
      .match(/[A-Za-z_$][\w$]*|[^\sA-Za-z_$]/g) ?? [];
  const bigrams = new Set<string>();
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const left = tokens[index];
    const right = tokens[index + 1];
    if (left === undefined || right === undefined) continue;
    bigrams.add(`${left}\u0000${right}`);
  }
  return bigrams;
}

export function symbolOf(method: JavaMethod): string {
  return `${method.declaringType ?? ''}#${method.name}`.replace(/^#/, '');
}

function normalizeBody(body: string): string {
  return body.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
}

function magicNumbersIn(body: string): string[] {
  const found = new Set<string>();
  // Digits inside string literals are format specifiers and messages, not encoded thresholds.
  const code = body.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  for (const match of code.matchAll(/(?:[<>=!]=?|\+|-|\*|\/|%|return)[ \t]*(-?\d+(?:\.\d+)?)/g)) {
    const value = match[1];
    if (value === undefined || TRIVIAL_NUMBERS.has(value)) continue;
    found.add(value);
  }
  return [...found].slice(0, 5);
}

function firstMatchLine(body: string, pattern: RegExp): string {
  const match = pattern.exec(body);
  if (match === null) return pattern.source;
  const start = body.lastIndexOf('\n', match.index) + 1;
  const end = body.indexOf('\n', match.index);
  return body.slice(start, end === -1 ? body.length : end).trim().slice(0, 160);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
