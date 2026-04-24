// Helpers shared across AI SDK-based providers (ai-gateway, openrouter, …).
// A provider typically only needs to bind a model factory and call
// `generateText` — everything else here is pure message/tool translation.

import {
  jsonSchema,
  type AssistantModelMessage,
  type JSONSchema7,
  type ModelMessage,
  type ToolCallPart,
  type ToolModelMessage,
  type ToolSet,
} from "ai";

import type {
  InferResponse,
  ProviderContentChunk,
  ProviderContext,
  ProviderMessage,
  ToolDefinition,
} from "../types";

export interface SharedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const DEFAULT_COST_PER_1K = { input: 0.00025, output: 0.002 };

// Flatten ProviderContentChunks to plain text parts.
export function chunksToParts(
  content: string | ReadonlyArray<ProviderContentChunk>,
): string | Array<{ type: "text"; text: string }> {
  if (typeof content === "string") return content;
  return content.map((c) => ({ type: "text" as const, text: c.text }));
}

export function messageToModel(msg: ProviderMessage): ModelMessage {
  if (msg.role === "user") {
    const content = chunksToParts(msg.content);
    return { role: "user", content: typeof content === "string" ? content : content };
  }
  if (msg.role === "assistant") {
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const parts: Exclude<AssistantModelMessage["content"], string> = [];
      const textContent = chunksToParts(msg.content);
      if (typeof textContent === "string") {
        if (textContent.length > 0) parts.push({ type: "text", text: textContent });
      } else {
        for (const p of textContent) parts.push(p);
      }
      for (const tc of msg.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = {};
        }
        const call: ToolCallPart = {
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.function.name,
          input,
        };
        parts.push(call);
      }
      return { role: "assistant", content: parts };
    }
    const content = chunksToParts(msg.content);
    return { role: "assistant", content };
  }
  // tool
  const toolText =
    typeof msg.content === "string" ? msg.content : msg.content.map((c) => c.text).join("");
  const toolMsg: ToolModelMessage = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: msg.toolCallId,
        toolName: "",
        output: { type: "text", value: toolText },
      },
    ],
  };
  return toolMsg;
}

export function contextToModelMessages(context: ProviderContext): ModelMessage[] {
  return context.messages.map(messageToModel);
}

export function systemToString(
  system: ProviderContext["system"],
): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system.length > 0 ? system : undefined;
  const joined = system.map((c) => c.text).join("\n\n");
  return joined.length > 0 ? joined : undefined;
}

export function toolsToSet(tools: ReadonlyArray<ToolDefinition>): ToolSet | undefined {
  if (tools.length === 0) return undefined;
  const out: ToolSet = {};
  for (const t of tools) {
    out[t.name] = {
      type: "dynamic",
      description: t.description,
      inputSchema: jsonSchema(t.parameters as JSONSchema7),
    };
  }
  return out;
}

export function isEmptyResponse(r: InferResponse): boolean {
  const hasContent = r.content.length > 0;
  const hasToolCalls = !!r.tool_calls && r.tool_calls.length > 0;
  return !hasContent && !hasToolCalls;
}

// Map AI SDK's tool-call response into the effectctx InferResponse shape.
export function mapToolCalls(
  raw: ReadonlyArray<{ toolCallId: string; toolName: string; input?: unknown }> | undefined,
): InferResponse["tool_calls"] {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((tc) => ({
    id: tc.toolCallId,
    type: "function" as const,
    function: {
      name: tc.toolName,
      arguments: JSON.stringify(tc.input ?? {}),
    },
  }));
}
