import {
  PhoenixError,
  addUsage,
  completionRequestSchema,
  completionResultSchema,
  estimateCost,
  findPricing,
  isRetryableCode,
  llmToolCallSchema,
  tokenUsageSchema,
  type CompletionRequest,
  type CompletionResult,
  type LlmPricingTable,
  type LlmToolSpec,
} from '@phoenix/shared';
import { hashPromptContent } from './json.js';
import type { CompletionOptions, LlmProvider } from './provider.js';

/**
 * OpenAI-compatible chat completions client.
 *
 * This single implementation covers hosted Qwen (DashScope compatible mode), vLLM, Ollama,
 * llama.cpp server and OpenAI itself. It is intentionally hand-written on `fetch` rather than
 * pulling in a vendor SDK: Phoenix needs retries, timeouts, usage accounting and tool-call
 * parsing, and nothing else.
 */

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Base delay for exponential backoff between retries; capped at 30s. */
  retryBaseDelayMs?: number;
  pricing?: LlmPricingTable;
  fetchImpl?: typeof fetch;
  /** Extra headers some gateways require (e.g. tenant or workspace identifiers). */
  headers?: Record<string, string>;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
}

interface ChatTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface ChatResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: {
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
  error?: { message?: string; type?: string };
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

type SendOutcome =
  | { kind: 'ok'; completion: CompletionResult; warnings: string[] }
  | { kind: 'drop-response-format' };

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;
  private readonly options: OpenAiCompatibleOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.options = options;
    this.id = 'openai-compatible';
    this.model = options.model;
    const injected = options.fetchImpl;
    if (injected !== undefined) {
      this.fetchImpl = injected;
    } else {
      const globalFetch = globalThis.fetch;
      if (globalFetch === undefined) {
        throw new PhoenixError('LLM_REQUEST_FAILED', 'no fetch implementation available', {});
      }
      this.fetchImpl = globalFetch.bind(globalThis);
    }
  }

  private get endpoint(): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  async complete(request: CompletionRequest, options: CompletionOptions = {}): Promise<CompletionResult> {
    const parsed = completionRequestSchema.parse(request);
    const maxRetries = this.options.maxRetries ?? 3;
    const timeoutMs = parsed.timeoutMs ?? this.options.timeoutMs ?? 180_000;
    const promptHash = hashPromptContent(parsed.messages, {
      purpose: parsed.purpose,
      model: parsed.model ?? this.model,
      responseFormat: parsed.responseFormat,
    });

    let attempt = 0;
    let useResponseFormat = parsed.responseFormat === 'json';
    let lastError: unknown;

    while (attempt <= maxRetries) {
      attempt += 1;
      const body = this.buildBody(parsed, useResponseFormat);
      try {
        const sent = await this.send(body, timeoutMs, options.signal, promptHash, attempt);
        if (sent.kind === 'drop-response-format') {
          // The endpoint rejected `response_format`; retry once without it rather than failing.
          useResponseFormat = false;
          options.onWarn?.('endpoint rejected response_format=json_object; retrying without it', {
            attempt,
          });
          continue;
        }
        if (options.onWarn !== undefined) {
          for (const warning of sent.warnings) options.onWarn(warning, { attempt });
        }
        return sent.completion;
      } catch (error) {
        lastError = error;
        const phoenixError =
          error instanceof PhoenixError
            ? error
            : new PhoenixError('LLM_REQUEST_FAILED', String(error), {}, error);
        const retryable = isRetryableCode(phoenixError.code) && isRetryableStatus(phoenixError.details.status);
        if (!retryable || attempt > maxRetries) throw phoenixError;
        const backoff = Math.min(30_000, (this.options.retryBaseDelayMs ?? 500) * 2 ** (attempt - 1));
        options.onWarn?.(`retrying LLM call after ${phoenixError.code}`, {
          attempt,
          backoffMs: backoff,
          message: phoenixError.message,
        });
        await sleep(backoff, options.signal);
      }
    }

    throw lastError instanceof PhoenixError
      ? lastError
      : new PhoenixError('LLM_REQUEST_FAILED', 'LLM call failed after retries', { attempts: attempt }, lastError);
  }

  private buildBody(request: CompletionRequest, useResponseFormat: boolean): Record<string, unknown> {
    const messages: ChatMessage[] = request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.name !== undefined ? { name: message.name } : {}),
      ...(message.toolCallId !== undefined ? { tool_call_id: message.toolCallId } : {}),
      ...(message.toolCalls.length > 0 ? { tool_calls: toWireToolCalls(message.toolCalls) } : {}),
    }));
    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      messages,
      temperature: request.temperature ?? this.options.temperature ?? 0.1,
      max_tokens: request.maxTokens ?? this.options.maxTokens ?? 4096,
      stream: false,
    };
    if (request.seed !== undefined) body.seed = request.seed;
    if (request.stop !== undefined) body.stop = request.stop;
    if (useResponseFormat) body.response_format = { type: 'json_object' };
    if (request.tools.length > 0) {
      body.tools = request.tools.map(toWireTool);
      body.tool_choice = request.toolChoice ?? 'auto';
    }
    return body;
  }

  private async send(
    body: Record<string, unknown>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    promptHash: string,
    attempts: number,
  ): Promise<SendOutcome> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      ...this.options.headers,
    };
    if (this.options.apiKey !== undefined && this.options.apiKey.length > 0) {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    const startedAt = Date.now();
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      if (timeoutSignal.aborted && (signal === undefined || !signal.aborted)) {
        throw new PhoenixError('LLM_TIMEOUT', `LLM request timed out after ${timeoutMs}ms`, { timeoutMs }, error);
      }
      throw new PhoenixError('LLM_REQUEST_FAILED', `LLM request failed: ${describe(error)}`, {}, error);
    }
    const latencyMs = Date.now() - startedAt;

    const rawText = await response.text();
    if (!response.ok) {
      const dropResponseFormat =
        response.status === 400 &&
        body.response_format !== undefined &&
        /response_format|json_object/i.test(rawText);
      if (dropResponseFormat) return { kind: 'drop-response-format' };
      const code = response.status === 429 ? 'LLM_RATE_LIMITED' : 'LLM_REQUEST_FAILED';
      throw new PhoenixError(
        code,
        `LLM endpoint returned ${response.status}: ${rawText.slice(0, 500)}`,
        { status: response.status, endpoint: this.endpoint, retryAfter: response.headers.get('retry-after') ?? undefined },
      );
    }

    let payload: ChatResponse;
    try {
      payload = JSON.parse(rawText) as ChatResponse;
    } catch (error) {
      throw new PhoenixError(
        'LLM_INVALID_RESPONSE',
        `LLM endpoint returned non-JSON body: ${rawText.slice(0, 300)}`,
        {},
        error,
      );
    }
    if (payload.error?.message !== undefined) {
      throw new PhoenixError('LLM_REQUEST_FAILED', `LLM endpoint error: ${payload.error.message}`, {
        type: payload.error.type,
      });
    }

    const choice = payload.choices?.[0];
    const message = choice?.message;
    if (message === undefined) {
      throw new PhoenixError('LLM_INVALID_RESPONSE', 'LLM response contained no choices', {
        rawPrefix: rawText.slice(0, 300),
      });
    }

    const warnings: string[] = [];
    const usage = payload.usage;
    if (usage === undefined) {
      warnings.push('provider did not report token usage; recorded as zero rather than estimated');
    }
    const parsedUsage = tokenUsageSchema.parse({
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
    });

    const toolCalls = (message.tool_calls ?? [])
      .map((call, index) => {
        const name = call.function?.name;
        if (name === undefined) return undefined;
        const rawArguments = call.function?.arguments ?? '{}';
        return llmToolCallSchema.safeParse({
          id: call.id ?? `call_${index}`,
          name,
          arguments: parseToolArguments(rawArguments, name, warnings),
          rawArguments,
        });
      })
      .filter((entry) => entry !== undefined)
      .map((entry) => {
        if (entry.success) return entry.data;
        warnings.push(`dropped malformed tool call: ${entry.error.message}`);
        return undefined;
      })
      .filter((entry) => entry !== undefined);

    const completion = completionResultSchema.parse({
      providerId: this.id,
      model: payload.model ?? (body.model as string),
      text: message.content ?? '',
      toolCalls,
      usage: parsedUsage,
      ...(choice?.finish_reason !== undefined ? { finishReason: choice.finish_reason } : {}),
      latencyMs,
      promptHash,
      attempts,
      ...(this.options.pricing !== undefined
        ? {
            cost: estimateCost(
              parsedUsage,
              findPricing(this.options.pricing, payload.model ?? (body.model as string)),
            ),
          }
        : {}),
    });
    return { kind: 'ok', completion, warnings };
  }
}

function toWireTool(tool: LlmToolSpec): ChatTool {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

function toWireToolCalls(
  calls: { id: string; name: string; arguments: Record<string, unknown> }[],
): ChatMessage['tool_calls'] {
  return calls.map((call) => ({
    id: call.id,
    type: 'function' as const,
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
}

function parseToolArguments(
  raw: string,
  toolName: string,
  warnings: string[],
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    warnings.push(`tool ${toolName} returned non-object arguments`);
    return { raw };
  } catch {
    warnings.push(`tool ${toolName} arguments were not valid JSON`);
    return { raw };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Absent status (network error, timeout) is retryable; a known client error is not. */
function isRetryableStatus(status: unknown): boolean {
  return typeof status !== 'number' || RETRYABLE_STATUS.has(status);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectPromise(new PhoenixError('LLM_TIMEOUT', 'aborted while waiting to retry', {}));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function sumUsage(results: readonly CompletionResult[]): CompletionResult['usage'] {
  return results.reduce(
    (acc, result) => addUsage(acc, result.usage),
    tokenUsageSchema.parse({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
  );
}
