// Vercel AI Gateway-backed InferFn. Routes every completion through the
// Gateway, which proxies `<provider>/<model>` ids to the upstream —
// no client-side dispatch table. Auth is a standard Bearer header.

import { createGateway, generateText } from "ai";

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

export type AiGatewayUsage = SharedUsage;

export interface AiGatewayOptions {
  apiKey: string;
  // Canonical AI Gateway `<provider>/<model>` id —
  // e.g. `openai/gpt-5-mini`, `anthropic/claude-opus-4.7`.
  model: string;
  providerOptions?: ProviderOptions;
  temperature?: number;
  maxTokens?: number;
  spend?: { usd: number };
  costPer1k?: { input: number; output: number };
  onUsage?: (usage: AiGatewayUsage) => void;
  // Per-call hook fired after each `generateText` returns. Receives the
  // raw AI SDK result so integrators can capture provider-side metadata
  // that isn't surfaced through `onUsage` — e.g. Vercel's
  // `providerMetadata.gateway.generationId`, required by the deferred
  // `/v1/generation` cost-lookup endpoint.
  //
  // Why this exists: without an extension hook here, integrators that
  // need such metadata vendor the entire provider — and historically
  // that's where message-shape bugs creep in (cloud-claude shipped a
  // converter that dropped `assistant.toolCalls` because the vendored
  // copy missed a branch). Surface the data they need; keep the
  // converter authoritative.
  onResponse?: (
    res: Awaited<ReturnType<typeof generateText>>,
  ) => void | Promise<void>;
  retryOnEmpty?: { maxAttempts: number };
  fetch?: typeof fetch;
}

export function createAiGatewayInfer(opts: AiGatewayOptions): InferFn {
  const {
    apiKey,
    model,
    providerOptions,
    // Leave temperature + maxTokens unset by default. Newer OpenAI
    // models (gpt-5.x) reject any non-default temperature AND reject
    // `max_tokens` in favor of `max_completion_tokens`.
    temperature,
    maxTokens,
    spend,
    costPer1k = DEFAULT_COST_PER_1K,
    onUsage,
    onResponse,
    retryOnEmpty = { maxAttempts: 2 },
  } = opts;
  const maxAttempts = Math.max(1, retryOnEmpty.maxAttempts);
  void maxTokens;

  const gateway = createGateway({
    apiKey,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const languageModel = gateway(model);

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
          (cacheWrite / 1000) * costPer1k.input * 1.25 +
          (outTok / 1000) * costPer1k.output;
      }
      if (onUsage) {
        onUsage({ input: nonCachedInput, output: outTok, cacheRead, cacheWrite });
      }
      if (onResponse) {
        await onResponse(res);
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
