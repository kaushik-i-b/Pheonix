export interface QuoteAnchorInput {
  fileText: string;
  quote: string;
  citedStartLine?: number;
}

export type QuoteAnchorKind = 'verbatim' | 'anchored' | 'unresolved';

export interface QuoteAnchorResult {
  kind: QuoteAnchorKind;
  score: number;
  startLine?: number;
  endLine?: number;
  quote?: string;
}

const LINE_STRONG = 0.6;
const WEAK_PULL = 0.2;
const MIN_INFORMATIVE_TOKENS = 2;
const COVERAGE_MIN = 0.5;
const CLUSTER_GAP = 3;
/**
 * Widest contiguous span the anchorer will treat as one located citation.
 *
 * Exported because a citation-rejection message has to state the same limit the anchorer enforces.
 * A message quoting a stale number sends the model back for a repair that cannot succeed.
 */
export const MAX_SPAN_LINES = 12;
const EXTENSION_REACH = 2;
const WINDOW_MIN = 2;
const WINDOW_MAX = 5;
const WINDOW_THRESHOLD = 0.6;
const MAX_EMITTED_CHARS = 2_000;
const FUZZY_MIN_TOKEN_LEN = 4;
const FUZZY_PREFIX_RATIO = 0.8;

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 0);
}

function countTokens(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let n = 0;
  while (n < max && a[n] === b[n]) {
    n += 1;
  }
  return n;
}

function fuzzyOverlap(a: readonly string[], b: readonly string[]): number {
  const total = a.length + b.length;
  if (total === 0) {
    return 0;
  }
  const countsA = countTokens(a);
  const countsB = countTokens(b);
  let intersection = 0;
  const remainingA: string[] = [];
  for (const [token, count] of countsA) {
    const shared = Math.min(count, countsB.get(token) ?? 0);
    intersection += shared;
    for (let i = shared; i < count; i += 1) {
      remainingA.push(token);
    }
  }
  const remainingB: string[] = [];
  for (const [token, count] of countsB) {
    const shared = Math.min(count, countsA.get(token) ?? 0);
    for (let i = shared; i < count; i += 1) {
      remainingB.push(token);
    }
  }
  const used = new Array<boolean>(remainingB.length).fill(false);
  for (const token of remainingA) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < remainingB.length; i += 1) {
      if (used[i] === true) {
        continue;
      }
      const other = remainingB[i];
      if (other === undefined) {
        continue;
      }
      if (token.length < FUZZY_MIN_TOKEN_LEN || other.length < FUZZY_MIN_TOKEN_LEN) {
        continue;
      }
      const prefix = commonPrefixLength(token, other);
      if (prefix < FUZZY_MIN_TOKEN_LEN) {
        continue;
      }
      const score = prefix / Math.max(token.length, other.length);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0 && bestScore >= FUZZY_PREFIX_RATIO) {
      used[bestIndex] = true;
      intersection += bestScore;
    }
  }
  return (2 * intersection) / total;
}

interface LineMatch {
  line: number;
  score: number;
}

function bestLineMatch(
  quoteTokens: readonly string[],
  fileTokenLines: readonly (readonly string[])[],
): LineMatch {
  let best: LineMatch = { line: -1, score: 0 };
  for (let i = 0; i < fileTokenLines.length; i += 1) {
    const score = fuzzyOverlap(quoteTokens, fileTokenLines[i] ?? []);
    if (score > best.score) {
      best = { line: i, score };
    }
  }
  return best;
}

interface StrongCluster {
  lo: number;
  hi: number;
  size: number;
  score: number;
}

// Scattered strong lines are paraphrases, not one contiguous citation; only a
// dense cluster counts as located evidence.
function clusterStrongLines(strongLines: readonly LineMatch[]): StrongCluster[] {
  const sorted = [...strongLines].sort((a, b) => a.line - b.line);
  const clusters: StrongCluster[] = [];
  for (const match of sorted) {
    const last = clusters[clusters.length - 1];
    if (last !== undefined && match.line - last.hi <= CLUSTER_GAP) {
      last.hi = match.line;
      last.size += 1;
      last.score = Math.max(last.score, match.score);
    } else {
      clusters.push({ lo: match.line, hi: match.line, size: 1, score: match.score });
    }
  }
  return clusters;
}

function clusterDistance(cluster: StrongCluster, citedStartLine?: number): number {
  if (citedStartLine === undefined) {
    return 0;
  }
  const center = (cluster.lo + cluster.hi) / 2 + 1;
  return Math.abs(center - citedStartLine);
}

function isBetterCluster(
  candidate: StrongCluster,
  current: StrongCluster,
  citedStartLine?: number,
): boolean {
  if (candidate.size !== current.size) {
    return candidate.size > current.size;
  }
  if (candidate.score !== current.score) {
    return candidate.score > current.score;
  }
  const candidateSpan = candidate.hi - candidate.lo;
  const currentSpan = current.hi - current.lo;
  if (candidateSpan !== currentSpan) {
    return candidateSpan < currentSpan;
  }
  return clusterDistance(candidate, citedStartLine) < clusterDistance(current, citedStartLine);
}

function pickCluster(
  clusters: readonly StrongCluster[],
  citedStartLine?: number,
): StrongCluster | undefined {
  let best: StrongCluster | undefined;
  for (const cluster of clusters) {
    if (best === undefined || isBetterCluster(cluster, best, citedStartLine)) {
      best = cluster;
    }
  }
  return best;
}

interface WindowMatch {
  lo: number;
  hi: number;
  score: number;
}

function bestWindow(
  quoteTokens: readonly string[],
  fileTokenLines: readonly (readonly string[])[],
): WindowMatch {
  let best: WindowMatch = { lo: -1, hi: -1, score: 0 };
  for (let start = 0; start < fileTokenLines.length; start += 1) {
    const flattened: string[] = [...(fileTokenLines[start] ?? [])];
    for (
      let end = start + WINDOW_MIN - 1;
      end < fileTokenLines.length && end - start + 1 <= WINDOW_MAX;
      end += 1
    ) {
      flattened.push(...(fileTokenLines[end] ?? []));
      const score = fuzzyOverlap(quoteTokens, flattened);
      if (score > best.score) {
        best = { lo: start, hi: end, score };
      }
    }
  }
  return best;
}

interface Span {
  lo: number;
  hi: number;
}

function isTokenlessNonBlank(line: string, tokens: readonly string[]): boolean {
  return tokens.length === 0 && line.trim().length > 0;
}

function countLeadingTokenless(lines: readonly string[]): number {
  let count = 0;
  for (const line of lines) {
    if (tokenize(line).length === 0) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function countTrailingTokenless(lines: readonly string[]): number {
  let count = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line !== undefined && tokenize(line).length === 0) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function extendSpan(
  span: Span,
  rawQuoteLines: readonly string[],
  fileLines: readonly string[],
  fileTokenLines: readonly (readonly string[])[],
  matches: readonly LineMatch[],
): Span {
  let lo = span.lo;
  let hi = span.hi;
  let changed = true;
  while (changed) {
    changed = false;
    let bestLine = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const match of matches) {
      if (match.line < 0 || match.score < WEAK_PULL) {
        continue;
      }
      if (match.line >= lo && match.line <= hi) {
        continue;
      }
      const distance = match.line < lo ? lo - match.line : match.line - hi;
      if (distance > EXTENSION_REACH) {
        continue;
      }
      if (hi - lo + 1 + distance > MAX_SPAN_LINES) {
        continue;
      }
      if (distance < bestDistance) {
        bestDistance = distance;
        bestLine = match.line;
      }
    }
    if (bestLine >= 0) {
      if (bestLine < lo) {
        lo = bestLine;
      } else {
        hi = bestLine;
      }
      changed = true;
    }
  }

  let trailing = countTrailingTokenless(rawQuoteLines);
  while (trailing > 0 && hi + 1 < fileLines.length && hi - lo + 1 < MAX_SPAN_LINES) {
    const nextLine = fileLines[hi + 1];
    const nextTokens = fileTokenLines[hi + 1];
    if (nextLine === undefined || nextTokens === undefined || !isTokenlessNonBlank(nextLine, nextTokens)) {
      break;
    }
    hi += 1;
    trailing -= 1;
  }

  let leading = countLeadingTokenless(rawQuoteLines);
  while (leading > 0 && lo - 1 >= 0 && hi - lo + 1 < MAX_SPAN_LINES) {
    const prevLine = fileLines[lo - 1];
    const prevTokens = fileTokenLines[lo - 1];
    if (prevLine === undefined || prevTokens === undefined || !isTokenlessNonBlank(prevLine, prevTokens)) {
      break;
    }
    lo -= 1;
    leading -= 1;
  }

  return { lo, hi };
}

interface EmittedSpan {
  text: string;
  startLine: number;
  endLine: number;
}

function emitSpan(fileLines: readonly string[], span: Span, keeper: Span): EmittedSpan {
  let lo = span.lo;
  let hi = span.hi;
  while (lo < hi && lo < keeper.lo && (fileLines[lo] ?? '').trim().length === 0) {
    lo += 1;
  }
  while (hi > lo && hi > keeper.hi && (fileLines[hi] ?? '').trim().length === 0) {
    hi -= 1;
  }
  let text = fileLines.slice(lo, hi + 1).join('\n');
  while (text.length > MAX_EMITTED_CHARS && hi > keeper.hi) {
    hi -= 1;
    text = fileLines.slice(lo, hi + 1).join('\n');
  }
  while (text.length > MAX_EMITTED_CHARS && lo < keeper.lo) {
    lo += 1;
    text = fileLines.slice(lo, hi + 1).join('\n');
  }
  if (text.length > MAX_EMITTED_CHARS) {
    text = text.slice(0, MAX_EMITTED_CHARS);
  }
  return { text, startLine: lo + 1, endLine: hi + 1 };
}

interface NormalizedWithLineMap {
  normalized: string;
  lineByChar: number[];
}

function normalizeWithLineMap(text: string): NormalizedWithLineMap {
  const lines = text.split('\n');
  let normalized = '';
  const lineByChar: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const collapsed = (lines[i] ?? '').replace(/\s+/g, ' ').trim();
    if (collapsed.length === 0) {
      continue;
    }
    if (normalized.length > 0) {
      normalized += ' ';
      lineByChar.push(i);
    }
    normalized += collapsed;
    for (let j = 0; j < collapsed.length; j += 1) {
      lineByChar.push(i);
    }
  }
  return { normalized, lineByChar };
}

function locateVerbatimSpan(
  normalized: string,
  lineByChar: readonly number[],
  normalizedQuote: string,
  citedStartLine?: number,
): Span | undefined {
  const occurrences: number[] = [];
  let from = 0;
  for (;;) {
    const at = normalized.indexOf(normalizedQuote, from);
    if (at < 0) {
      break;
    }
    occurrences.push(at);
    from = at + normalizedQuote.length;
  }
  if (occurrences.length === 0) {
    return undefined;
  }
  let chosen = occurrences[0] ?? 0;
  if (citedStartLine !== undefined) {
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const at of occurrences) {
      const line = lineByChar[at];
      if (line === undefined) {
        continue;
      }
      const distance = Math.abs(line + 1 - citedStartLine);
      if (distance < bestDistance) {
        bestDistance = distance;
        chosen = at;
      }
    }
  }
  const startChar = lineByChar[chosen];
  const endChar = lineByChar[chosen + normalizedQuote.length - 1];
  if (startChar === undefined || endChar === undefined) {
    return undefined;
  }
  return { lo: startChar, hi: endChar };
}

export function anchorQuote(input: QuoteAnchorInput): QuoteAnchorResult {
  const fileLines = input.fileText.split('\n');
  const normalizedQuote = normalizeWhitespace(input.quote);
  if (normalizedQuote.length === 0) {
    return { kind: 'unresolved', score: 0 };
  }

  const { normalized, lineByChar } = normalizeWithLineMap(input.fileText);
  const verbatimSpan = locateVerbatimSpan(normalized, lineByChar, normalizedQuote, input.citedStartLine);
  if (verbatimSpan !== undefined) {
    const emitted = emitSpan(fileLines, verbatimSpan, verbatimSpan);
    return {
      kind: 'verbatim',
      score: 1,
      startLine: emitted.startLine,
      endLine: emitted.endLine,
      quote: emitted.text,
    };
  }

  const fileTokenLines = fileLines.map((line) => tokenize(line));
  const rawQuoteLines = input.quote.split('\n').filter((line) => line.trim().length > 0);
  const informativeTokens = rawQuoteLines
    .map((line) => tokenize(line))
    .filter((tokens) => tokens.length >= MIN_INFORMATIVE_TOKENS);
  if (informativeTokens.length === 0) {
    return { kind: 'unresolved', score: 0 };
  }

  const matches = informativeTokens.map((tokens) => bestLineMatch(tokens, fileTokenLines));
  let lineScore = 0;
  for (const match of matches) {
    lineScore = Math.max(lineScore, match.score);
  }

  const quoteTokens = tokenize(input.quote);
  const window = bestWindow(quoteTokens, fileTokenLines);

  const strongLines = matches.filter((match) => match.score >= LINE_STRONG);
  const cluster = pickCluster(clusterStrongLines(strongLines), input.citedStartLine);
  const clusterViable =
    cluster !== undefined &&
    cluster.size / informativeTokens.length >= COVERAGE_MIN &&
    cluster.hi - cluster.lo + 1 <= MAX_SPAN_LINES;

  let chosenSpan: Span | undefined;
  let keeper: Span | undefined;
  let chosenScore = 0;

  if (window.score >= WINDOW_THRESHOLD && (cluster === undefined || !clusterViable || window.score >= cluster.score)) {
    const matchedLines = matches
      .filter((match) => match.line >= window.lo && match.line <= window.hi)
      .map((match) => match.line);
    chosenSpan = { lo: window.lo, hi: window.hi };
    keeper =
      matchedLines.length > 0
        ? { lo: Math.min(...matchedLines), hi: Math.max(...matchedLines) }
        : { lo: window.lo, hi: window.hi };
    chosenScore = window.score;
  } else if (cluster !== undefined && clusterViable) {
    chosenSpan = { lo: cluster.lo, hi: cluster.hi };
    keeper = { lo: cluster.lo, hi: cluster.hi };
    chosenScore = cluster.score;
  }

  if (chosenSpan === undefined || keeper === undefined) {
    return { kind: 'unresolved', score: Math.max(lineScore, window.score) };
  }

  const extended = extendSpan(chosenSpan, rawQuoteLines, fileLines, fileTokenLines, matches);
  const emitted = emitSpan(fileLines, extended, keeper);
  return {
    kind: 'anchored',
    score: chosenScore,
    startLine: emitted.startLine,
    endLine: emitted.endLine,
    quote: emitted.text,
  };
}
