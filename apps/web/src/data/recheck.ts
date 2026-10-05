import { readLegacySource, splitLines } from './legacy-source.js';
import type { Workspace } from './repo-root.js';

export type RecheckResult =
  | { state: 'matched' }
  | { state: 'drifted'; firstDiffLine: number | null }
  | { state: 'relocated'; foundStart: number; foundEnd: number }
  | { state: 'file-missing' }
  | { state: 'out-of-range'; lineCount: number };

interface LineRange {
  foundStart: number;
  foundEnd: number;
}

function findAlignedRange(
  lines: string[],
  recorded: string,
  start: number,
  end: number,
): LineRange | null {
  if (recorded.length === 0) return null;
  const text = lines.join('\n');
  let index = text.indexOf(recorded);
  while (index !== -1) {
    const beforeOk = index === 0 || text[index - 1] === '\n';
    const afterIndex = index + recorded.length;
    const afterOk = afterIndex === text.length || text[afterIndex] === '\n';
    if (beforeOk && afterOk) {
      const foundStart = text.slice(0, index).split('\n').length;
      const foundEnd = foundStart + splitLines(recorded).length - 1;
      if (foundStart < start || foundEnd > end) return { foundStart, foundEnd };
    }
    index = text.indexOf(recorded, index + 1);
  }
  return null;
}

function firstDifferingLine(recorded: string, rangeLines: string[], start: number): number | null {
  const recordedLines = splitLines(recorded);
  const count = Math.max(recordedLines.length, rangeLines.length);
  for (let offset = 0; offset < count; offset += 1) {
    if (recordedLines[offset] !== rangeLines[offset]) return start + offset;
  }
  return null;
}

export function recheckEvidence(
  ws: Workspace,
  location: { path: string; startLine: number; endLine?: number },
  quote: string,
): RecheckResult {
  const source = readLegacySource(ws, location.path);
  if (!source.ok) return { state: 'file-missing' };
  const lines = splitLines(source.content);
  const start = location.startLine;
  const end = location.endLine ?? start;
  if (start < 1 || end < start || end > lines.length) {
    return { state: 'out-of-range', lineCount: lines.length };
  }
  const recorded = quote.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rangeLines = lines.slice(start - 1, end);
  if (rangeLines.join('\n') === recorded) return { state: 'matched' };
  const relocated = findAlignedRange(lines, recorded, start, end);
  if (relocated !== null) {
    return { state: 'relocated', foundStart: relocated.foundStart, foundEnd: relocated.foundEnd };
  }
  return { state: 'drifted', firstDiffLine: firstDifferingLine(recorded, rangeLines, start) };
}
