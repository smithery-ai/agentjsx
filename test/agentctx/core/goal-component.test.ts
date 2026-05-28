import { describe, expect, it } from "vitest";
import { Goal } from "../../../src/jsx/components/goal";
import { isEmitElement } from "../../../src/jsx/runtime";
import type { Command } from "../../../src/jsx/runtime";
import type { Fragment } from "../../../src/core/types";

describe("Goal component", () => {
  it("returns an emitFragment and an emitCommand named 'goal'", () => {
    const node = Goal();
    expect(Array.isArray(node)).toBe(true);
    const items = node as ReadonlyArray<unknown>;

    const emits = items.filter(isEmitElement);
    expect(emits.length).toBe(2);

    const fragmentEmits = emits.filter(
      (e) => (e.props as { __emit: string }).__emit === "fragment",
    );
    const commandEmits = emits.filter(
      (e) => (e.props as { __emit: string }).__emit === "command",
    );
    expect(fragmentEmits.length).toBe(1);
    expect(commandEmits.length).toBe(1);

    const fragment = (fragmentEmits[0]!.props as { value: Fragment }).value;
    expect(fragment.source).toBe("goal");
    expect(fragment.tag).toBe("core/system");

    const command = (commandEmits[0]!.props as { value: Command }).value;
    expect(command.name).toBe("goal");
    expect(typeof command.handler).toBe("function");
  });
});
