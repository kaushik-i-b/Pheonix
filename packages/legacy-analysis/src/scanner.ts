/**
 * A minimal C-family source scanner.
 *
 * Phoenix has to reason about code it did not write, in languages whose full grammars are far too
 * large to parse here. Instead of pretending to be a compiler front end, the analysis works on a
 * *masked* copy of the source in which comments and string-literal contents are blanked out while
 * every offset and newline is preserved. Structural regular expressions then cannot match inside a
 * comment or a string, and line numbers stay exact — while the literals themselves are collected
 * separately, because in a legacy system the interesting business logic very often lives inside
 * the SQL strings.
 *
 * This is heuristic. Anything derived from it that is not literally present in the source is
 * reported as INFERRED, never as OBSERVED.
 */

export interface SourceLiteral {
  /** Decoded text between the quotes (escapes resolved where trivially possible). */
  value: string;
  /** Raw source text including quotes. */
  raw: string;
  start: number;
  end: number;
  line: number;
  kind: 'string' | 'char';
}

export interface SourceComment {
  text: string;
  start: number;
  end: number;
  line: number;
  kind: 'line' | 'block';
}

export interface MaskedSource {
  readonly source: string;
  /** Same length as `source`; comment bodies and literal contents replaced with spaces. */
  readonly masked: string;
  readonly literals: readonly SourceLiteral[];
  readonly comments: readonly SourceComment[];
  readonly lineStarts: readonly number[];
}

export function maskSource(source: string): MaskedSource {
  // Split by UTF-16 code unit, not by code point, so every offset used below (which comes from
  // `source[i]` indexing) addresses the same position in the masked copy.
  const masked = source.split('');
  const literals: SourceLiteral[] = [];
  const comments: SourceComment[] = [];
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') lineStarts.push(index + 1);
  }

  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (masked[index] !== '\n') masked[index] = ' ';
    }
  };

  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === '/' && next === '/') {
      let end = index + 2;
      while (end < source.length && source[end] !== '\n') end += 1;
      comments.push({ text: source.slice(index, end), start: index, end, line: lineAt(lineStarts, index), kind: 'line' });
      blank(index, end);
      index = end;
      continue;
    }

    if (character === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      const end = close === -1 ? source.length : close + 2;
      comments.push({ text: source.slice(index, end), start: index, end, line: lineAt(lineStarts, index), kind: 'block' });
      blank(index, end);
      index = end;
      continue;
    }

    if (character === '"' || character === "'") {
      const quote = character;
      let end = index + 1;
      let value = '';
      while (end < source.length) {
        const current = source[end];
        if (current === '\\') {
          value += source[end + 1] ?? '';
          end += 2;
          continue;
        }
        if (current === quote) {
          end += 1;
          break;
        }
        if (current === '\n') break; // unterminated literal: stop rather than swallow the file
        value += current;
        end += 1;
      }
      literals.push({
        value,
        raw: source.slice(index, end),
        start: index,
        end,
        line: lineAt(lineStarts, index),
        kind: quote === '"' ? 'string' : 'char',
      });
      blank(index + 1, Math.max(index + 1, end - 1));
      index = end;
      continue;
    }

    index += 1;
  }

  return { source, masked: masked.join(''), literals, comments, lineStarts };
}

export function lineAt(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const start = lineStarts[middle];
    if (start === undefined) break;
    if (start <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

export function lineOf(scanned: MaskedSource, offset: number): number {
  return lineAt(scanned.lineStarts, offset);
}

export function lineText(source: string, lineStarts: readonly number[], line: number): string {
  const start = lineStarts[line - 1];
  if (start === undefined) return '';
  const end = lineStarts[line] ?? source.length;
  return source.slice(start, end).replace(/\r?\n$/, '');
}

/**
 * Offset of the brace matching the `{` at `openBrace`, or -1 when unbalanced. Works on masked
 * source so braces inside strings and comments cannot throw the count off.
 */
export function matchingBrace(masked: string, openBrace: number): number {
  if (masked[openBrace] !== '{') return -1;
  let depth = 0;
  for (let index = openBrace; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Offset of the `)` matching the `(` at `openParen`, or -1 when unbalanced. */
export function matchingParen(masked: string, openParen: number): number {
  if (masked[openParen] !== '(') return -1;
  let depth = 0;
  for (let index = openParen; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
