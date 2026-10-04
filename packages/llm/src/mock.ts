import {
  PhoenixError,
  completionResultSchema,
  hashStable,
  tokenUsageSchema,
  type CompletionRequest,
  type CompletionResult,
  type LlmToolCall,
  type TokenUsage,
} from '@phoenix/shared';
import type { CompletionOptions, LlmProvider } from './provider.js';

/**
 * Deterministic, scriptable provider used by tests.
 *
 * Orchestration, permission enforcement, repair loops and release gates must be testable without
 * a network model, so this provider replays canned responses and records every request it saw.
 * It is exported from `@phoenix/llm/testing` and refuses to be constructed outside a test
 * environment: mocks belong in tests, never in production code paths.
 */

export type MockResponse =
  | string
  | {
      text?: string;
      toolCalls?: LlmToolCall[];
      usage?: Partial<TokenUsage>;
      finishReason?: string;
      /** When set, the provider throws this error instead of returning a completion. */
      error?: PhoenixError;
    };

export type MockResponder = (
  request: CompletionRequest,
  callIndex: number,
) => MockResponse | Promise<MockResponse>;

export interface MockLlmProviderOptions {
  model?: string;
  responses?: readonly MockResponse[];
  responder?: MockResponder;
  defaultUsage?: Partial<TokenUsage>;
  latencyMs?: number;
  /** Escape hatch for demos that intentionally run without a real endpoint. */
  allowOutsideTests?: boolean;
}

export class MockLlmProvider implements LlmProvider {
  readonly id = 'mock';
  readonly model: string;
  readonly requests: CompletionRequest[] = [];
  readonly responses: readonly MockResponse[];
  private readonly responder: MockResponder | undefined;
  private readonly defaultUsage: TokenUsage;
  private readonly latencyMs: number;

  constructor(options: MockLlmProviderOptions = {}) {
    const inTestEnvironment = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
    if (!inTestEnvironment && options.allowOutsideTests !== true) {
      throw new PhoenixError(
        'INTERNAL',
        'MockLlmProvider is test-only; refusing to construct outside a test environment',
        { nodeEnv: process.env.NODE_ENV ?? null },
      );
    }
    this.model = options.model ?? 'mock-model';
    this.responses = options.responses ?? [];
    this.responder = options.responder;
    this.latencyMs = options.latencyMs ?? 0;
    this.defaultUsage = tokenUsageSchema.parse({
      promptTokens: options.defaultUsage?.promptTokens ?? 10,
      completionTokens: options.defaultUsage?.completionTokens ?? 20,
      totalTokens: options.defaultUsage?.totalTokens ?? 30,
    });
  }

  get callCount(): number {
    return this.requests.length;
  }

  async complete(request: CompletionRequest, _options: CompletionOptions = {}): Promise<CompletionResult> {
    const index = this.requests.length;
    // A copy of the message list, not the caller's array: the agent loop keeps appending to the same
    // history, so recording the reference would leave every "what did request N contain" assertion
    // reading the final transcript instead of the request that was actually sent.
    this.requests.push({ ...request, messages: [...request.messages] });
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));

    const response = await this.nextResponse(index);
    if (response.error !== undefined) throw response.error;

    const text = response.text ?? '';
    const usage = tokenUsageSchema.parse({
      promptTokens: response.usage?.promptTokens ?? this.defaultUsage.promptTokens,
      completionTokens: response.usage?.completionTokens ?? this.defaultUsage.completionTokens,
      totalTokens:
        response.usage?.totalTokens ??
        (response.usage?.promptTokens ?? this.defaultUsage.promptTokens) +
          (response.usage?.completionTokens ?? this.defaultUsage.completionTokens),
    });

    return completionResultSchema.parse({
      providerId: this.id,
      model: this.model,
      text,
      toolCalls: response.toolCalls ?? [],
      usage,
      ...(response.finishReason !== undefined ? { finishReason: response.finishReason } : {}),
      latencyMs: this.latencyMs,
      promptHash: hashStable({ purpose: request.purpose, messages: request.messages }),
      attempts: 1,
    });
  }

  private async nextResponse(index: number): Promise<Exclude<MockResponse, string> & { text?: string }> {
    if (this.responder !== undefined) return normalize(await this.responder(this.requests[index] as CompletionRequest, index));
    const response = this.responses[index];
    if (response === undefined) {
      throw new PhoenixError(
        'LLM_INVALID_RESPONSE',
        `MockLlmProvider has no scripted response for call #${index} (purpose "${
          this.requests[index]?.purpose ?? 'unknown'
        }")`,
        { index, scripted: this.responses.length, purposes: this.requests.map((entry) => entry.purpose) },
      );
    }
    return normalize(response);
  }

  reset(): void {
    this.requests.length = 0;
  }

  /** Purposes of the calls made so far — assertions about *what* was asked, not just how often. */
  purposes(): string[] {
    return this.requests.map((request) => request.purpose);
  }
}

function normalize(response: MockResponse): { text?: string } & Exclude<MockResponse, string> {
  return typeof response === 'string' ? { text: response } : response;
}

/** Turns plain values into JSON text responses, the common case in tests. */
export function jsonResponse(value: unknown): MockResponse {
  return JSON.stringify(value);
}

export function jsonResponses(values: readonly unknown[]): MockResponse[] {
  return values.map((value) => jsonResponse(value));
}
