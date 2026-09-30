import type { CompletionRequest, CompletionResult } from '@phoenix/shared';

/**
 * The provider boundary. Phoenix only ever talks to an `LlmProvider`, so hosted Qwen, vLLM,
 * Ollama, llama.cpp or any other OpenAI-compatible endpoint is a configuration change — never a
 * code change. Nothing outside this package may know which vendor is in use.
 */
export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  complete(request: CompletionRequest, options?: CompletionOptions): Promise<CompletionResult>;
}

export interface CompletionOptions {
  signal?: AbortSignal;
  /** Called for recoverable problems (retries, unsupported parameters) so they are not silent. */
  onWarn?: (message: string, details?: Record<string, unknown>) => void;
}

export interface LlmProviderFactory {
  readonly id: string;
  create(options: Record<string, unknown>): LlmProvider;
}
