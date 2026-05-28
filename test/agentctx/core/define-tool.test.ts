import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { defineTool } from "@flamecast/agentctx/define-tool";

describe("agentctx: defineTool", () => {
  it("generates JSON Schema 7 object shape without the $schema dialect URL", async () => {
    const tool = defineTool({
      name: "echo",
      description: "Echo args.",
      parameters: Schema.Struct({
        msg: Schema.String.annotations({ description: "The message." }),
      }),
      run: async (args) => args.msg,
    });

    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        msg: { type: "string", description: "The message." },
      },
      required: ["msg"],
    });
    expect(tool.parameters).not.toHaveProperty("$schema");
  });

  it("decodes and passes typed args to run on the happy path", async () => {
    const tool = defineTool({
      name: "add",
      description: "Add two numbers.",
      parameters: Schema.Struct({
        a: Schema.Number,
        b: Schema.Number,
      }),
      run: async (args) => String(args.a + args.b),
    });

    const result = await tool.run({ a: 2, b: 3 }, {});
    expect(result).toBe("5");
  });

  it("returns an error string (not a throw) when args fail to decode", async () => {
    const tool = defineTool({
      name: "strict",
      description: "Strict numeric arg.",
      parameters: Schema.Struct({ n: Schema.Number }),
      run: async (args) => String(args.n * 2),
    });

    const result = await tool.run({ n: "not a number" }, {});
    // defineTool's decode failure returns a plain string outcome.
    expect(typeof result).toBe("string");
    expect(
      (result as string).startsWith('Error: invalid arguments for tool "strict":'),
    ).toBe(true);
  });

  it("accepts null and undefined for fields declared optionalWith nullable", async () => {
    const tool = defineTool({
      name: "maybe-num",
      description: "Optional number.",
      parameters: Schema.Struct({
        n: Schema.Number.pipe(Schema.optionalWith({ nullable: true })),
      }),
      run: async (args) => (args.n === undefined ? "none" : String(args.n)),
    });

    expect(await tool.run({ n: null }, {})).toBe("none");
    expect(await tool.run({}, {})).toBe("none");
    expect(await tool.run({ n: 7 }, {})).toBe("7");
  });
});
