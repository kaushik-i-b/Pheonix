import type { z } from 'zod';
import {
  PhoenixError,
  addUsage,
  tokenUsageSchema,
  type CompletionRequest,
  type CompletionResult,
} from '@phoenix/shared';
import { extractJson, tryExtractJson } from './json.js';
import type { CompletionOptions, LlmProvider } from './provider.js';

/**
 * Schema-checked completion with bounded repair.
 *
 * A model that returns prose instead of JSON, or JSON that violates the schema, gets its own
 * output plus the concrete validation errors handed back to it. Retries are bounded; when they
 * are exhausted the call fails loudly. Phoenix never fabricates a value to fill a schema hole.
 */

export interface StructuredCompletionOptions<TSchema extends z.ZodTypeAny> {
  provider: LlmProvider;
  schema: TSchema;
  request: CompletionRequest;
  /** Additional repair rounds after the first attempt. */
  maxRepairs?: number;
  onWarn?: CompletionOptions['onWarn'];
  signal?: AbortSignal;
}

export interface StructuredCompletionResult<T> {
  value: T;
  result: CompletionResult;
  validationRepairs: number;
  warnings: string[];
  usage: CompletionResult['usage'];
}

export async function completeStructured<TSchema extends z.ZodTypeAny>(
  options: StructuredCompletionOptions<TSchema>,
): Promise<StructuredCompletionResult<z.infer<TSchema>>> {
  const maxRepairs = options.maxRepairs ?? 2;
  const messages = [...options.request.messages];
  const warnings: string[] = [];
  let usage = tokenUsageSchema.parse({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  let lastResult: CompletionResult | undefined;
  let repairs = 0;

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const result = await options.provider.complete(
      { ...options.request, messages, responseFormat: 'json' },
      { ...(options.signal !== undefined ? { signal: options.signal } : {}), onWarn: options.onWarn },
    );
    lastResult = result;
    usage = addUsage(usage, result.usage);

    const extracted = tryExtractJson(result.text);
    if (extracted === undefined) {
      const problem = `the response contained no parseable JSON value`;
      if (attempt === maxRepairs) {
        throw invalidResponse(options.request.purpose, problem, result.text, attempt + 1);
      }
      repairs += 1;
      pushRepair(messages, result.text, problem, warnings);
      continue;
    }
    if (extracted.leadingText.length > 0 || extracted.trailingText.length > 0) {
      warnings.push('model wrapped JSON in surrounding prose; extracted the JSON value');
    }

    const parsed = options.schema.safeParse(extracted.value);
    if (parsed.success) {
      return {
        value: parsed.data as z.infer<TSchema>,
        result,
        validationRepairs: repairs,
        warnings,
        usage,
      };
    }

    const problem = parsed.error.issues
      .slice(0, 12)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    if (attempt === maxRepairs) {
      throw invalidResponse(options.request.purpose, problem, result.text, attempt + 1, parsed.error.issues);
    }
    repairs += 1;
    pushRepair(messages, result.text, problem, warnings);
  }

  throw invalidResponse(
    options.request.purpose,
    'repair loop exited without producing a valid payload',
    lastResult?.text ?? '',
    repairs + 1,
  );
}

function pushRepair(
  messages: CompletionRequest['messages'],
  rejectedText: string,
  problem: string,
  warnings: string[],
): void {
  warnings.push(`response rejected: ${problem}`);
  messages.push({
    role: 'assistant',
    content: rejectedText.slice(0, 20_000),
    toolCalls: [],
  });
  messages.push({
    role: 'user',
    content: [
      'Your previous reply was rejected.',
      `Problems: ${problem}`,
      'Reply again with ONLY the corrected JSON value. No prose, no code fences, no commentary.',
    ].join('\n'),
    toolCalls: [],
  });
}

function invalidResponse(
  purpose: string,
  problem: string,
  text: string,
  attempts: number,
  issues?: unknown,
): PhoenixError {
  return new PhoenixError(
    'LLM_INVALID_RESPONSE',
    `model did not produce a schema-valid response for "${purpose}" after ${attempts} attempt(s): ${problem}`,
    {
      purpose,
      attempts,
      problem,
      responsePrefix: text.slice(0, 1000),
      ...(issues !== undefined ? { issues } : {}),
    },
  );
}

/** Convenience wrapper for callers that only need the validated value. */
export async function completeForValue<TSchema extends z.ZodTypeAny>(
  options: StructuredCompletionOptions<TSchema>,
): Promise<z.infer<TSchema>> {
  const completed = await completeStructured(options);
  return completed.value;
}

export { extractJson };
