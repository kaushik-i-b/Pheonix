import { PhoenixError } from '@phoenix/shared';
import type { LlmSettings } from '@phoenix/config';
import { OpenAiCompatibleProvider, type OpenAiCompatibleOptions } from './openai-compatible.js';
import { loadPricingTable } from './pricing.js';
import type { LlmProvider } from './provider.js';

export interface CreateProviderOptions {
  settings: LlmSettings;
  onWarn?: (message: string, details?: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

/**
 * Turns configuration into a provider. Hosted Qwen, vLLM, Ollama and llama.cpp all expose
 * OpenAI-compatible chat completions, so switching backend is a `baseUrl` change — there is one
 * client, not one per vendor. An unknown provider id fails loudly rather than silently talking to
 * some other endpoint.
 */
export function createLlmProvider(options: CreateProviderOptions): LlmProvider {
  const { settings } = options;
  if (settings.providerId !== 'openai-compatible') {
    throw new PhoenixError('CONFIG_INVALID', `unsupported LLM provider id "${settings.providerId}"`, {
      providerId: settings.providerId,
      supported: ['openai-compatible'],
    });
  }

  const pricing = loadPricingTable(settings.pricingPath, {
    ...(options.onWarn !== undefined ? { onWarn: options.onWarn } : {}),
  });
  const providerOptions: OpenAiCompatibleOptions = {
    baseUrl: settings.baseUrl,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    timeoutMs: settings.timeoutMs,
    maxRetries: settings.maxRetries,
    ...(settings.apiKey !== undefined ? { apiKey: settings.apiKey } : {}),
    ...(settings.extraBody !== undefined ? { extraBody: settings.extraBody } : {}),
    ...(pricing !== undefined ? { pricing } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  };
  return new OpenAiCompatibleProvider(providerOptions);
}
