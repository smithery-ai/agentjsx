// Capability components — these declare tools and ambient fragments
// that grant the agent power over external systems. MVP implementations
// are placeholders that describe what they *would* have done; real
// Node-coupled implementations land in a follow-up. Proving the
// architecture (tools get declared, reconciler installs them, agent can
// call them) is what matters here.

import { Schema } from "effect";
import { defineTool } from "../define-tool";
import type { Fragment as RenderedFragment } from "../types";
import { emitFragment, emitTool } from "./runtime";
import type { Element, Node } from "./runtime";

// ---------------------------------------------------------------------
// <Workspace root="..." />
//
// Declares 5 placeholder tools (bash, read_file, write_file, grep,
// list_dir) and emits one ambient fragment describing the workspace
// tree. Tool `run` bodies stringify their inputs rather than touching
// disk — that's intentional for the MVP.
// ---------------------------------------------------------------------

export interface WorkspaceProps {
  readonly root: string;
}

export function Workspace(props: WorkspaceProps): Node {
  const { root } = props;

  const bash = defineTool({
    name: "bash",
    description: "Run a shell command in the workspace.",
    parameters: Schema.Struct({
      command: Schema.String,
    }),
    run: async (args) => `[bash] would have run: ${args.command}`,
  });

  const read_file = defineTool({
    name: "read_file",
    description: "Read a file from the workspace.",
    parameters: Schema.Struct({
      path: Schema.String,
    }),
    run: async (args) => `[read_file] would have read: ${args.path}`,
  });

  const write_file = defineTool({
    name: "write_file",
    description: "Write a file in the workspace.",
    parameters: Schema.Struct({
      path: Schema.String,
      contents: Schema.String,
    }),
    run: async (args) =>
      `[write_file] would have written ${args.contents.length} chars to ${args.path}`,
  });

  const grep = defineTool({
    name: "grep",
    description: "Search for a pattern in the workspace.",
    parameters: Schema.Struct({
      pattern: Schema.String,
      path: Schema.optional(Schema.String),
    }),
    run: async (args) =>
      `[grep] would have searched for "${args.pattern}" in ${args.path ?? root}`,
  });

  const list_dir = defineTool({
    name: "list_dir",
    description: "List the contents of a directory in the workspace.",
    parameters: Schema.Struct({
      path: Schema.optional(Schema.String),
    }),
    run: async (args) => `[list_dir] would have listed: ${args.path ?? root}`,
  });

  const treeFragment: RenderedFragment = {
    tag: "core/system",
    content: `<workspace root="${root}">\n  (placeholder tree)\n</workspace>`,
    source: "workspace",
  };

  const emits: Element[] = [
    emitTool(bash),
    emitTool(read_file),
    emitTool(write_file),
    emitTool(grep),
    emitTool(list_dir),
    emitFragment(treeFragment),
  ];
  return emits as Node;
}
