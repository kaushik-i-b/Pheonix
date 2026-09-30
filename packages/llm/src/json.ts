import { PhoenixError, stableStringify, sha256Hex } from '@phoenix/shared';

/**
 * Tolerant JSON extraction.
 *
 * Small and local models routinely wrap JSON in prose or code fences. Extraction is a mechanical
 * problem, so it is solved mechanically: find the first balanced JSON value and parse it. What is
 * *not* done here is inventing missing fields or guessing at malformed syntax — if the model did
 * not produce parseable JSON, that is a failure the caller must surface or repair.
 */

export function stripCodeFences(text: string): string {
  const fenced = /^\s*```(?:json|javascript|js)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  if (fenced?.[1] !== undefined) return fenced[1].trim();
  return text.trim();
}

/** Scans for balanced JSON values, ignoring braces that appear inside string literals. */
function balancedSlice(text: string, start: number): string | undefined {
  const opening = text[start];
  if (opening !== '{' && opening !== '[') return undefined;
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === opening) depth += 1;
    else if (char === closing) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

export interface ExtractJsonResult {
  value: unknown;
  /** Text surrounding the JSON value, kept so callers can log what the model actually said. */
  leadingText: string;
  trailingText: string;
}

export function tryExtractJson(text: string): ExtractJsonResult | undefined {
  const candidate = stripCodeFences(text);
  const searchIn = candidate.length > 0 ? candidate : text;
  for (let index = 0; index < searchIn.length; index += 1) {
    const char = searchIn[index];
    if (char !== '{' && char !== '[') continue;
    const slice = balancedSlice(searchIn, index);
    if (slice === undefined) continue;
    try {
      return {
        value: JSON.parse(slice) as unknown,
        leadingText: searchIn.slice(0, index).trim(),
        trailingText: searchIn.slice(index + slice.length).trim(),
      };
    } catch {
      // Not valid JSON at this offset; keep scanning for the next candidate.
    }
  }
  return undefined;
}

export function extractJson(text: string, purpose = 'llm-response'): unknown {
  const extracted = tryExtractJson(text);
  if (extracted === undefined) {
    throw new PhoenixError(
      'LLM_INVALID_RESPONSE',
      `no parseable JSON value found in model response for "${purpose}"`,
      { purpose, responsePrefix: text.slice(0, 500), responseLength: text.length },
    );
  }
  return extracted.value;
}

/** Canonical hash of a request, used to correlate prompts, events and persisted artifacts. */
export function hashPromptContent(messages: unknown, extras: Record<string, unknown> = {}): string {
  return sha256Hex(stableStringify({ messages, ...extras }));
}
