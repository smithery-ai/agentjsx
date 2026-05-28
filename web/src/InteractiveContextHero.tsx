import { useState } from "react"
import { HeroCodeBlock } from "./HeroCodeBlock"

// The hero snippet. Line indices below are 0-based against this string.
export const CODE = `import { createAgentRuntime, createAiGatewayInfer, render } from "@flamecast/agentjsx"
import {
  Agent, Block, Messages,
  Workspace, Skills, McpServer, Todo,
  Compact,
} from "@flamecast/agentjsx/components"
import { NodeContext } from "@flamecast/agentjsx/node"

const agent = createAgentRuntime({
  infer: createAiGatewayInfer({ model: "anthropic/claude-sonnet-4-6" }),
  platform: NodeContext.layer,
  context: () => render(
    <Agent>
      <Block name="role">You are a coding assistant.</Block>
      <Workspace root="./" />
      <Skills root="./skills" />
      <McpServer name="deepwiki" url="https://mcp.deepwiki.com/mcp" />
      <McpServer
        name="linear"
        url="https://mcp.linear.app/mcp"
        headers={{ Authorization: \`Bearer \${process.env.LINEAR_API_KEY}\` }}
      />
      <Todo />
      <Compact strategy="summary" threshold={4000}>
        <Messages />
      </Compact>
    </Agent>
  ),
})

await agent.run("Find the latest bug in Linear and open a PR fixing it.")`

// Each JSX line maps to one slice in the rendered context panel.
// "fs", "skill", and "mcp" are capability components: clicking them
// light up BOTH the tool pills they install AND the system block
// they contribute (when they contribute one). "role" is a manual
// Block; "messages" comes from the event log.
type Slice = "role" | "fs" | "skill" | "mcp" | "messages"

const LINE_SLICE: Record<number, Slice> = {
	13: "role",     // <Block name="role">
	14: "fs",       // <Workspace root="./" />
	15: "skill",    // <Skills root="./skills" />
	16: "mcp",      // <McpServer name="deepwiki" ... />
	17: "mcp",      // <McpServer name="linear" ...
	18: "mcp",
	19: "mcp",
	20: "mcp",
	21: "mcp",     // />
	24: "messages", // <Messages />
	30: "messages", // await agent.run("...")
}

const HIGHLIGHTED = new Set(Object.keys(LINE_SLICE).map(Number))

const WORKSPACE_TREE = `./
  src/
    agent.ts
    inference.ts
    tool-exec.ts
  package.json
  README.md`

const SKILLS_MENU = `- coding-style: when editing, match the surrounding style
- pull-request: safe PR creation workflow
- writeup: prose voice for docs, PRs, tickets`

type ToolGroup = "fs" | "skill" | "mcp"
const TOOLS: { name: string; group: ToolGroup }[] = [
	{ name: "bash", group: "fs" },
	{ name: "read_file", group: "fs" },
	{ name: "write_file", group: "fs" },
	{ name: "grep", group: "fs" },
	{ name: "list_dir", group: "fs" },
	{ name: "skill_lookup", group: "skill" },
	{ name: "skill_invoke", group: "skill" },
	{ name: "linear_create_issue", group: "mcp" },
	{ name: "linear_list_issues", group: "mcp" },
]

function hlClass(active: Slice | null, slice: Slice): string {
	if (active === null) return "ctx-piece"
	return active === slice ? "ctx-piece ctx-piece-active" : "ctx-piece ctx-piece-dim"
}

function pillClass(active: Slice | null, group: ToolGroup): string {
	if (active === null) return "ctx-pill"
	return active === group ? "ctx-pill ctx-pill-active" : "ctx-pill ctx-pill-dim"
}

function ContextPanel({ active }: { active: Slice | null }) {
	return (
		<div className="ctx-panel">
			<div className="ctx-body">
				<div className="ctx-section">
					<div className="ctx-label">system</div>
					<pre className={`${hlClass(active, "role")} ctx-mono`}>
<span className="ctx-tag">{"<role>"}</span>{"\n"}
You are a coding assistant.{"\n"}
<span className="ctx-tag">{"</role>"}</span>
					</pre>
					<pre className={`${hlClass(active, "fs")} ctx-mono`}>
<span className="ctx-tag">{"<workspace>"}</span>{"\n"}
{WORKSPACE_TREE}{"\n"}
<span className="ctx-tag">{"</workspace>"}</span>
					</pre>
					<pre className={`${hlClass(active, "skill")} ctx-mono`}>
<span className="ctx-tag">{"<skills>"}</span>{"\n"}
{SKILLS_MENU}{"\n"}
<span className="ctx-tag">{"</skills>"}</span>
					</pre>
				</div>

				<div className="ctx-section">
					<div className="ctx-label">tools</div>
					<div className="ctx-pills">
						{TOOLS.map(t => (
							<span key={t.name} className={pillClass(active, t.group)}>{t.name}</span>
						))}
					</div>
				</div>

				<div className="ctx-section">
					<div className="ctx-label">messages</div>
					<div className={hlClass(active, "messages")}>
						<span className="ctx-role">user</span>
						<span className="ctx-msg">find every TODO and group them by file</span>
					</div>
				</div>
			</div>
		</div>
	)
}

export function InteractiveContextHero() {
	const [activeLine, setActiveLine] = useState<number | null>(null)
	const activeSlice = activeLine !== null ? (LINE_SLICE[activeLine] ?? null) : null

	return (
		<div className="split-pane">
			<div className="split-head">
				<div>
					<span className="split-tab">
						<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
							<path d="M2 4l6-2 6 2v8l-6 2-6-2z" />
							<path d="M8 6v8" />
							<path d="M2 4l6 2 6-2" />
						</svg>
						agent.tsx
					</span>
				</div>
				<div />
			</div>
			<div className="split-body">
				<HeroCodeBlock
					code={CODE}
					highlightedLines={HIGHLIGHTED}
					activeLine={activeLine}
					onLineClick={(i) => {
						setActiveLine(activeLine === i ? null : i)
					}}
				/>
				<ContextPanel active={activeSlice} />
			</div>
		</div>
	)
}
