// OpenRouter-backed InferFn. OpenRouter routes `<provider>/<model>`
// ids to underlying upstreams (same shape as the Vercel AI Gateway,
// different vendor). Uses `@openrouter/ai-sdk-provider` under the hood.

import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import type {
  InferFn,
  InferResponse,
  ProviderOptions,
} from "../core/types";

import {
  DEFAULT_COST_PER_1K,
  contextToModelMessages,
  isEmptyResponse,
  mapToolCalls,
  systemToString,
  toolsToSet,
  type SharedUsage,
} from "./shared";

export type OpenRouterUsage = SharedUsage;

export interface OpenRouterOptions {
  apiKey: string;
  // OpenRouter `<provider>/<model>` id — e.g. `anthropic/claude-sonnet-4`,
  // `openai/gpt-4o-mini`, `moonshotai/kimi-k2`.
  model: string;
  providerOptions?: ProviderOptions;
  temperature?: number;
  maxTokens?: number;
  spend?: { usd: number };
  costPer1k?: { input: number; output: number };
  onUsage?: (usage: OpenRouterUsage) => void;
  retryOnEmpty?: { maxAttempts: number };
  fetch?: typeof fetch;
  // Optional attribution headers OpenRouter recognises for the
  // "rankings" page. Both are harmless if omitted.
  referer?: string;
  appName?: string;
}

export function createOpenRouterInfer(opts: OpenRouterOptions): InferFn {
  const {
    apiKey,
    model,
    providerOptions,
    temperature,
    maxTokens,
    spend,
    costPer1k = DEFAULT_COST_PER_1K,
    onUsage,
    retryOnEmpty = { maxAttempts: 2 },
    referer,
    appName,
  } = opts;
  const maxAttempts = Math.max(1, retryOnEmpty.maxAttempts);
  void maxTokens;

  const router = createOpenRouter({
    apiKey,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(referer || appName
      ? {
          headers: {
            ...(referer ? { "HTTP-Referer": referer } : {}),
            ...(appName ? { "X-Title": appName } : {}),
          },
        }
      : {}),
  });
  const languageModel = router(model);

  return async (context): Promise<InferResponse> => {
    const system = systemToString(context.system);
    const messages = contextToModelMessages(context);
    const toolSet = toolsToSet(context.tools);

    let last: InferResponse = { content: "" };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await generateText({
        model: languageModel,
        ...(system !== undefined ? { system } : {}),
        messages,
        ...(providerOptions ? { providerOptions } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        tools: toolSet,
      });

      const usage = res.usage;
      const promptTok = usage.inputTokens ?? 0;
      const outTok = usage.outputTokens ?? 0;
      const cacheRead = usage.cachedInputTokens ?? 0;
      const cacheWrite = 0;
      const nonCachedInput = Math.max(0, promptTok - cacheRead);
      if (spend) {
        spend.usd +=
          (nonCachedInput / 1000) * costPer1k.input +
          (cacheRead / 1000) * costPer1k.input * 0.1 +
          (outTok / 1000) * costPer1k.output;
      }
      if (onUsage) {
        onUsage({ input: nonCachedInput, output: outTok, cacheRead, cacheWrite });
      }

      last = {
        content: res.text ?? "",
        tool_calls: mapToolCalls(res.toolCalls),
      };

      if (!isEmptyResponse(last)) return last;
    }
    return last;
  };
}
