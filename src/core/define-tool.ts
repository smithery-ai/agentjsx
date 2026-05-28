// Typed tool definition using Effect Schema for parameter validation.
// MCP-forwarded tools (remote servers that ship raw JSON Schema) stay
// on the raw `Tool` path — this helper is for hand-written tools.
//
// For fields the LLM may send as explicit `null` (JSON can't encode
// NaN/Infinity, and some models emit `null` for omitted args), use
// `.pipe(Schema.optionalWith({ nullable: true }))` — accepts `null`
// or `undefined` on input, decodes to `undefined`.

import { JSONSchema, Schema } from "effect";
import type { Tool, ToolContext, ToolOutcome } from "./types";

export interface DefineToolOptions<A> {
  name: string;
  description: string;
  // The encoded type is unconstrained — `decode` accepts `unknown`
  // (the raw JSON args) and produces the decoded type `A`.
  parameters: Schema.Schema<A, any, never>;
  run: (args: A, context: ToolContext) => Promise<ToolOutcome>;
}

export function defineTool<A>(opts: DefineToolOptions<A>): Tool {
  const parameters: Record<string, unknown> = { ...JSONSchema.make(opts.parameters) };
  delete parameters.$schema;
  const decode = Schema.decodeUnknownPromise(opts.parameters);
  return {
    name: opts.name,
    description: opts.description,
    parameters,
    run: async (args, ctx) => {
      let decoded: A;
      try {
        decoded = await decode(args);
      } catch (e) {
        return `Error: invalid arguments for tool "${opts.name}": ${
          e instanceof Error ? e.message : String(e)
        }`;
      }
      return opts.run(decoded, ctx);
    },
  };
}
