import { z } from 'zod';
import { artifactIdSchema, costSchema, isoTimestampSchema, sha256HexSchema, tokenUsageSchema } from './primitives.js';
import { agentRoleSchema, toolNameSchema } from './roles.js';

/**
 * LLM contracts. The wire format is OpenAI-compatible chat completions, which is what hosted
 * Qwen, vLLM, Ollama and llama.cpp servers all expose. No Phoenix type may mention a vendor.
 */

export const llmMessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type LlmMessageRole = z.infer<typeof llmMessageRoleSchema>;

export const llmToolCallSchema = z.object({
  id: z.string().min(1),
  name: toolNameSchema,
  arguments: z.record(z.string(), z.unknown()),
  /** Raw argument text as produced by the model, kept for diagnosis of malformed calls. */
  rawArguments: z.string().max(20_000).optional(),
});
export type LlmToolCall = z.infer<typeof llmToolCallSchema>;

export const llmMessageSchema = z.object({
  role: llmMessageRoleSchema,
  content: z.string().default(''),
  name: z.string().max(120).optional(),
  toolCallId: z.string().max(120).optional(),
  toolCalls: z.array(llmToolCallSchema).default([]),
});
export type LlmMessage = z.infer<typeof llmMessageSchema>;

/** JSON Schema subset passed to providers that support native tool calling. */
export const jsonSchemaSpecSchema = z.record(z.string(), z.unknown());
export type JsonSchemaSpec = z.infer<typeof jsonSchemaSpecSchema>;

export const llmToolSpecSchema = z.object({
  name: toolNameSchema,
  description: z.string().min(1).max(2000),
  parameters: jsonSchemaSpecSchema,
});
export type LlmToolSpec = z.infer<typeof llmToolSpecSchema>;

export const responseFormatSchema = z.enum(['text', 'json', 'tool']);
export type ResponseFormat = z.infer<typeof responseFormatSchema>;

export const completionRequestSchema = z.object({
  /** Stable identifier for what this call is for; appears in `llm.completed` events. */
  purpose: z.string().min(1).max(200),
  messages: z.array(llmMessageSchema).min(1),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  responseFormat: responseFormatSchema.default('text'),
  /** When responseFormat is `json`, the schema the payload must satisfy (sent in the prompt). */
  expectedSchema: jsonSchemaSpecSchema.optional(),
  tools: z.array(llmToolSpecSchema).default([]),
  toolChoice: z.enum(['auto', 'none', 'required']).optional(),
  seed: z.number().int().optional(),
  stop: z.array(z.string().min(1)).optional(),
});
export type CompletionRequest = z.infer<typeof completionRequestSchema>;

export const completionResultSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  text: z.string(),
  /**
   * The model's separate reasoning channel, when the endpoint exposes one (Ollama's `reasoning`,
   * some gateways' `reasoning_content`). Kept because it is the only evidence of *why* a reasoning
   * model answered what it did — and because when the answer is missing, it is all there is.
   */
  reasoningText: z.string().max(400_000).optional(),
  toolCalls: z.array(llmToolCallSchema).default([]),
  usage: tokenUsageSchema,
  finishReason: z.string().max(64).optional(),
  latencyMs: z.number().int().nonnegative(),
  promptHash: sha256HexSchema,
  /** Provider-reported raw payload hash; the payload itself is never persisted by default. */
  attempts: z.number().int().positive().default(1),
  cost: costSchema.optional(),
});
export type CompletionResult = z.infer<typeof completionResultSchema>;

export const structuredCompletionSchema = z.object({
  result: completionResultSchema,
  /** Number of times the model had to repair its output before it validated. */
  validationRepairs: z.number().int().nonnegative().default(0),
  parseWarnings: z.array(z.string().max(1000)).default([]),
});
export type StructuredCompletion<T> = z.infer<typeof structuredCompletionSchema> & {
  value: T;
};

export const promptDefinitionSchema = z.object({
  promptId: z.string().min(1),
  /** Prompts are versioned; the version travels with every event and artifact that used it. */
  version: z.string().min(1),
  description: z.string().min(1).max(2000),
  audience: agentRoleSchema,
  template: z.string().min(1),
  requiredVariables: z.array(z.string().min(1)).default([]),
  /** Identifier of the schema the model must satisfy, when the prompt expects structured output. */
  outputSchemaId: z.string().min(1).optional(),
  sourcePath: z.string().min(1).optional(),
});
export type PromptDefinition = z.infer<typeof promptDefinitionSchema>;

export const promptRenderSchema = z.object({
  promptId: z.string().min(1),
  promptVersion: z.string().min(1),
  renderedAt: isoTimestampSchema,
  runId: z.string().min(1).optional(),
  variables: z.record(z.string(), z.unknown()),
  renderedText: z.string(),
  hash: sha256HexSchema,
  /** The rendered prompt is persisted so any run can be reproduced exactly. */
  artifactId: artifactIdSchema.optional(),
});
export type PromptRender = z.infer<typeof promptRenderSchema>;

export const llmPricingSchema = z.object({
  model: z.string().min(1),
  currency: z.string().length(3).default('USD'),
  inputPerMillionTokens: z.number().nonnegative(),
  outputPerMillionTokens: z.number().nonnegative(),
});
export type LlmPricing = z.infer<typeof llmPricingSchema>;

export const llmPricingTableSchema = z.object({
  currency: z.string().length(3).default('USD'),
  entries: z.array(llmPricingSchema).default([]),
});
export type LlmPricingTable = z.infer<typeof llmPricingTableSchema>;

/**
 * Cost is reported only when a pricing entry exists. Phoenix records `null` rather than
 * inventing a number, because an invented cost is worse than an unknown one.
 */
export function estimateCost(
  usage: z.infer<typeof tokenUsageSchema>,
  pricing: LlmPricing | undefined,
): z.infer<typeof costSchema> | undefined {
  if (pricing === undefined) return undefined;
  const amount =
    (usage.promptTokens / 1_000_000) * pricing.inputPerMillionTokens +
    (usage.completionTokens / 1_000_000) * pricing.outputPerMillionTokens;
  return costSchema.parse({
    currency: pricing.currency,
    amount: Number(amount.toFixed(6)),
    estimated: true,
  });
}

export function findPricing(
  table: LlmPricingTable | undefined,
  model: string,
): LlmPricing | undefined {
  if (table === undefined) return undefined;
  const exact = table.entries.find((entry) => entry.model === model);
  if (exact) return exact;
  return table.entries.find((entry) => entry.model.endsWith('*') && model.startsWith(entry.model.slice(0, -1)));
}

export function addUsage(
  a: z.infer<typeof tokenUsageSchema>,
  b: z.infer<typeof tokenUsageSchema>,
): z.infer<typeof tokenUsageSchema> {
  return tokenUsageSchema.parse({
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  });
}
