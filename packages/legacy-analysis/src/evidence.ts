import { evidenceRefSchema, type EvidenceRef, type SourceLocation } from '@phoenix/shared';

/**
 * Evidence construction for deterministic analysis.
 *
 * Every structural claim the analyzer makes is paired with the file and line it came from, so a
 * reader (or the differential verifier) can check it without trusting the analyzer. Building these
 * through one helper keeps the `collectedBy` attribution and validation consistent.
 */

export const ANALYSIS_GENERATOR = '@phoenix/legacy-analysis/analyzeRepository';

export interface EvidenceInput {
  id: string;
  kind: EvidenceRef['kind'];
  collectedAt: string;
  collectedBy?: string;
  location?: SourceLocation;
  quote?: string;
  observation?: string;
  note?: string;
}

export function evidenceFor(input: EvidenceInput): EvidenceRef {
  return evidenceRefSchema.parse({
    id: input.id,
    kind: input.kind,
    collectedAt: input.collectedAt,
    collectedBy: input.collectedBy ?? ANALYSIS_GENERATOR,
    ...(input.location !== undefined ? { location: input.location } : {}),
    ...(input.quote !== undefined ? { quote: input.quote.slice(0, 8000) } : {}),
    ...(input.observation !== undefined ? { observation: input.observation.slice(0, 8000) } : {}),
    ...(input.note !== undefined ? { note: input.note.slice(0, 2000) } : {}),
  });
}

export function sourceEvidence(
  id: string,
  path: string,
  options: { line?: number; endLine?: number; symbol?: string; quote?: string; collectedAt: string; collectedBy?: string },
): EvidenceRef {
  return evidenceFor({
    id,
    kind: 'source-code',
    collectedAt: options.collectedAt,
    collectedBy: options.collectedBy,
    location: {
      path,
      ...(options.line !== undefined ? { startLine: options.line } : {}),
      ...(options.endLine !== undefined ? { endLine: options.endLine } : {}),
      ...(options.symbol !== undefined ? { symbol: options.symbol } : {}),
    },
    ...(options.quote !== undefined ? { quote: options.quote } : {}),
  });
}

/** Deterministic, collision-resistant evidence ids: same input → same id across runs. */
export function evidenceId(prefix: string, ...parts: (string | number | undefined)[]): string {
  const joined = parts
    .map((part) => String(part ?? ''))
    .filter((part) => part.length > 0)
    .join('|');
  return `${prefix}-${stableSlug(joined)}`;
}

function stableSlug(value: string): string {
  // FNV-1a over the identifying parts: short, stable and good enough to keep ids unique per file.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}-${value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-60)}`;
}
