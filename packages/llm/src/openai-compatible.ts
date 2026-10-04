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
  /**
   * Provider-specific request fields, merged last: Ollama's `options.num_ctx`, vLLM's
   * `guided_decoding`, a gateway's `enable_thinking`. Phoenix has one client for every
   * OpenAI-compatible endpoint, so the knobs that only one backend understands are configuration
   * rather than code. Fields that decide *what was asked* cannot be overridden this way.
   */
  extraBody?: Record<string, unknown>;
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
      /** Ollama's name for the reasoning channel; other gateways call it `reasoning_content`. */
      reasoning?: string | null;
      reasoning_content?: string | null;
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

/** Request fields `extraBody` may not replace: they are the question, not a backend knob. */
const RESERVED_BODY_FIELDS = new Set([
  'model',
  'messages',
  'stream',
  'tools',
  'tool_choice',
  'response_format',
]);

type ResponseFormatMode = 'json_schema' | 'json_object' | 'none';

type SendOutcome =
  | { kind: 'ok'; completion: CompletionResult; warnings: string[] }
  | { kind: 'response-format-rejected' };

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;
  private readonly options: OpenAiCompatibleOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    const reserved = Object.keys(options.extraBody ?? {}).filter((key) =>
      RESERVED_BODY_FIELDS.has(key),
    );
    if (reserved.length > 0) {
      throw new PhoenixError(
        'CONFIG_INVALID',
        `extraBody may not override ${reserved.join(', ')}; those fields describe the request Phoenix is making`,
        { reserved },
      );
    }
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

  async complete(
    request: CompletionRequest,
    options: CompletionOptions = {},
  ): Promise<CompletionResult> {
    const parsed = completionRequestSchema.parse(request);
    const maxRetries = this.options.maxRetries ?? 3;
    const timeoutMs = parsed.timeoutMs ?? this.options.timeoutMs ?? 180_000;
    const promptHash = hashPromptContent(parsed.messages, {
      purpose: parsed.purpose,
      model: parsed.model ?? this.model,
      responseFormat: parsed.responseFormat,
      expectedSchema: parsed.expectedSchema,
    });

    let attempt = 0;
    let retryFailures = 0;
    let responseFormatMode: ResponseFormatMode =
      parsed.responseFormat !== 'json'
        ? 'none'
        : parsed.expectedSchema === undefined
          ? 'json_object'
          : 'json_schema';

    while (true) {
      attempt += 1;
      const body = this.buildBody(parsed, responseFormatMode);
      try {
        const sent = await this.send(body, timeoutMs, options.signal, promptHash, attempt);
        if (sent.kind === 'response-format-rejected') {
          const rejected = responseFormatMode;
          responseFormatMode = rejected === 'json_schema' ? 'json_object' : 'none';
          options.onWarn?.(
            rejected === 'json_schema'
              ? 'endpoint rejected response_format=json_schema; retrying with json_object'
              : 'endpoint rejected response_format=json_object; retrying without response_format',
            { attempt },
          );
          continue;
        }
        if (options.onWarn !== undefined) {
          for (const warning of sent.warnings) options.onWarn(warning, { attempt });
        }
        return sent.completion;
      } catch (error) {
        const phoenixError =
          error instanceof PhoenixError
            ? error
            : new PhoenixError('LLM_REQUEST_FAILED', String(error), {}, error);
        const retryable =
          isRetryableCode(phoenixError.code) && isRetryableStatus(phoenixError.details.status);
        if (!retryable || retryFailures >= maxRetries) throw phoenixError;
        retryFailures += 1;
        const backoff = Math.min(
          30_000,
          (this.options.retryBaseDelayMs ?? 500) * 2 ** (retryFailures - 1),
        );
        options.onWarn?.(`retrying LLM call after ${phoenixError.code}`, {
          attempt,
          backoffMs: backoff,
          message: phoenixError.message,
        });
        await sleep(backoff, options.signal);
      }
    }
  }

  private buildBody(
    request: CompletionRequest,
    responseFormatMode: ResponseFormatMode,
  ): Record<string, unknown> {
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
    if (responseFormatMode === 'json_schema' && request.expectedSchema !== undefined) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: schemaName(request.purpose),
          schema: request.expectedSchema,
        },
      };
    } else if (responseFormatMode === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    if (request.tools.length > 0) {
      body.tools = request.tools.map(toWireTool);
      body.tool_choice = request.toolChoice ?? 'auto';
    }
    for (const [key, value] of Object.entries(this.options.extraBody ?? {})) {
      body[key] = value;
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

    const timeoutController = new AbortController();
    const combined =
      signal !== undefined
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

    const startedAt = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timeoutController.abort();
        reject(
          new PhoenixError('LLM_TIMEOUT', `LLM request timed out after ${timeoutMs}ms`, {
            timeoutMs,
          }),
        );
      }, timeoutMs);
    });

    let response: Response;
    let rawText: string;
    try {
      const exchange = this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: combined,
      }).then(async (received) => ({ response: received, rawText: await received.text() }));
      ({ response, rawText } = await Promise.race([exchange, timeoutFailure]));
    } catch (error) {
      if (error instanceof PhoenixError && error.code === 'LLM_TIMEOUT') throw error;
      throw new PhoenixError(
        'LLM_REQUEST_FAILED',
        `LLM request failed: ${describe(error)}`,
        {},
        error,
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      const responseFormatRejected =
        response.status === 400 &&
        body.response_format !== undefined &&
        /response_format|json_schema|json_object/i.test(rawText);
      if (responseFormatRejected) return { kind: 'response-format-rejected' };
      const code = response.status === 429 ? 'LLM_RATE_LIMITED' : 'LLM_REQUEST_FAILED';
      throw new PhoenixError(
        code,
        `LLM endpoint returned ${response.status}: ${rawText.slice(0, 500)}`,
        {
          status: response.status,
          endpoint: this.endpoint,
          retryAfter: response.headers.get('retry-after') ?? undefined,
        },
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
      totalTokens:
        usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
    });

    let toolCalls = (message.tool_calls ?? [])
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

    let text = message.content ?? '';
    const reasoning = message.reasoning ?? message.reasoning_content ?? '';

    // Some local models — qwen2.5-coder among them — answer a tools request by writing the call as
    // JSON into `content` instead of the `tool_calls` field the endpoint is supposed to return. The
    // decision to call the tool is still the model's; only the envelope differs, so it is translated
    // here rather than dropping every tool call on the floor. Gated on the request carrying tools:
    // with no tools requested, a top-level `{name, arguments}` could only be a final answer.
    if (
      toolCalls.length === 0 &&
      text.trim().length > 0 &&
      Array.isArray(body.tools) &&
      body.tools.length > 0
    ) {
      const extracted = extractContentToolCalls(text, warnings);
      if (extracted !== undefined) {
        text = extracted.text;
        toolCalls = extracted.calls;
      }
    }

    if (text.length === 0 && toolCalls.length === 0) {
      // A reasoning model that exhausts its budget never reaches the answer: every completion token
      // went into thinking, and the reply arrives with an empty content field. Reporting that as
      // "the reply contained no JSON" would send whoever reads it hunting for a prompt bug that does
      // not exist, so the cause is named here. It is not retryable — the identical request with the
      // identical budget fails identically.
      if (choice?.finish_reason === 'length') {
        throw new PhoenixError(
          'LLM_OUTPUT_TRUNCATED',
          `model produced ${reasoning.length} character(s) of reasoning and no answer before exhausting its ${String(body.max_tokens)}-token budget; raise LLM_MAX_TOKENS or ask for a smaller output`,
          {
            finishReason: 'length',
            reasoningChars: reasoning.length,
            maxTokens: body.max_tokens,
            completionTokens: parsedUsage.completionTokens,
          },
        );
      }
      warnings.push('model returned an empty reply with no tool calls');
    }

    const completion = completionResultSchema.parse({
      providerId: this.id,
      model: payload.model ?? (body.model as string),
      text,
      ...(reasoning.length > 0 ? { reasoningText: reasoning } : {}),
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

function schemaName(purpose: string): string {
  const normalized = purpose.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return normalized.length > 0 ? normalized : 'structured_output';
}

function toWireTool(tool: LlmToolSpec): ChatTool {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

const TOOL_CALL_TAG = /<tool_call>([\s\S]*?)<\/tool_call>/g;

interface ContentToolCall {
  id: string;
  name: ReturnType<typeof llmToolCallSchema.parse>['name'];
  arguments: Record<string, unknown>;
  rawArguments?: string | undefined;
}

/**
 * Tool calls a model wrote into `content` instead of the `tool_calls` field. Two spellings occur:
 * the chat template's canonical `<tool_call>{"name":…,"arguments":…}</tool_call>` blocks, and a
 * single bare JSON object as the entire reply. Returns undefined when the content is a tool call
 * under neither spelling, leaving the text untouched for structured-answer handling.
 */
function extractContentToolCalls(
  text: string,
  warnings: string[],
): { text: string; calls: ContentToolCall[] } | undefined {
  const tagged = [...text.matchAll(TOOL_CALL_TAG)];
  if (tagged.length > 0) {
    const calls = tagged
      .map((match, index) => contentToolCallOf(match[1]?.trim() ?? '', index, warnings))
      .filter((call) => call !== undefined);
    return { text: text.replace(TOOL_CALL_TAG, '').trim(), calls };
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  // A final answer for any Phoenix stage never carries a top-level string `name` beside
  // `arguments`; requiring both is what keeps an ordinary JSON answer out of this branch.
  if (typeof record.name !== 'string' || record.name.length === 0 || !('arguments' in record))
    return undefined;
  const call = contentToolCallOf(trimmed, 0, warnings);
  if (call === undefined) return undefined;
  return { text: '', calls: [call] };
}

function contentToolCallOf(
  raw: string,
  index: number,
  warnings: string[],
): ContentToolCall | undefined {
  const preview = raw.slice(0, 120);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push(`ignored a tool call that was not valid JSON: ${preview}`);
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`ignored a tool call whose body was not a JSON object: ${preview}`);
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.name !== 'string' || record.name.length === 0) {
    warnings.push(`ignored a tool call without a function name: ${preview}`);
    return undefined;
  }
  const rawArguments =
    typeof record.arguments === 'string'
      ? record.arguments
      : JSON.stringify(record.arguments ?? {});
  const candidate = llmToolCallSchema.safeParse({
    id: `call_content_${index}`,
    name: record.name,
    arguments: parseToolArguments(rawArguments, record.name, warnings),
    rawArguments,
  });
  if (candidate.success) return candidate.data;
  // An invented tool name fails the schema's enum the same way it would have failed the runtime's
  // permission layer; the call is dropped here with the reason recorded.
  warnings.push(`dropped tool call written in content: ${candidate.error.message}`);
  return undefined;
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
