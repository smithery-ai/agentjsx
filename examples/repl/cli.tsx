// Interactive agentjsx REPL.
//
// Run from this directory:
//
//   AI_GATEWAY_API_KEY=... npx tsx cli.tsx
//
// or under Infisical (Smithery contributors):
//
//   infisical run --silent -- npx tsx cli.tsx
//
// The program is wrapped in `NodeRuntime.runMain`, which owns SIGINT/SIGTERM
// handling and closes the scope (running finalizers) on shutdown. The
// agentjsx public API stays Promise-based; we bridge with `Effect.promise`
// / `Effect.tryPromise`.

import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { createAgentRuntime, createAiGatewayInfer, render } from "@flamecast/agentjsx"
import {
	Agent,
	Block,
	Compact,
	Messages,
	Skills,
	Todo,
	Workspace,
} from "@flamecast/agentjsx/components"
import { Console, Effect } from "effect"
import path from "node:path"
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SKILLS_ROOT = path.resolve(__dirname, "./skills")

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`
const BLUE = (s: string) => `\x1b[34m${s}\x1b[0m`
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`

type AgentRuntime = ReturnType<typeof createAgentRuntime>

// Polling helper. Kept as a plain async function — converting the
// event-drain loop into pure Effect would double its size for no real
// readability win.
async function turn(agent: AgentRuntime, input: string): Promise<void> {
	const startLen = (await agent.events()).length
	await agent.send(input)

	let printed = startLen
	while (true) {
		await new Promise((r) => setTimeout(r, 80))
		const events = await agent.events()
		for (let i = printed; i < events.length; i++) {
			const e = events[i]!
			if (e.type === "tool.call.started") {
				console.log(DIM(`  ${YELLOW("→")} calling ${e.tool_name}`))
			} else if (e.type === "tool.result") {
				const snippet = e.content.length > 80 ? `${e.content.slice(0, 80)}…` : e.content
				console.log(DIM(`  ${YELLOW("←")} ${snippet}`))
			} else if (e.type === "assistant.message") {
				if (e.content.length > 0) console.log(`${GREEN("agent")}  ${e.content}`)
				if (e.tool_calls?.length) {
					for (const tc of e.tool_calls) {
						console.log(DIM(`  ${tc.function.name}(${tc.function.arguments})`))
					}
				}
			} else if (e.type === "inference.failed") {
				console.log(DIM(`  ${YELLOW("!")} inference failed: ${e.cause}`))
			} else if (e.type === "assistant.halted") {
				console.log(DIM(`  ${YELLOW("!")} halted: ${e.reason}`))
			}
		}
		printed = events.length

		const last = events[events.length - 1]
		const noPendingTools = !last || last.type !== "assistant.message" || !last.tool_calls?.length
		const isTerminal =
			(last?.type === "assistant.message" && noPendingTools) ||
			last?.type === "assistant.halted" ||
			last?.type === "inference.failed"
		if (isTerminal) break
	}
}

const program = Effect.gen(function* () {
	const apiKey = process.env.AI_GATEWAY_API_KEY
	if (!apiKey) {
		return yield* Effect.die(
			new Error("Set AI_GATEWAY_API_KEY (or run under `infisical run --silent`)."),
		)
	}

	const agent: AgentRuntime = createAgentRuntime({
		infer: createAiGatewayInfer({ apiKey, model: "anthropic/claude-sonnet-4-6" }),
		platform: NodeContext.layer,
		context: () =>
			render(
				<Agent>
					<Block name="role">
						You are a helpful coding assistant working in the current directory. Use
						tools to inspect and modify files. Track multi-step work as todos. Look
						up skills for guidance on conventions.
					</Block>
					<Workspace root="./" />
					<Skills root={SKILLS_ROOT} />
					<Todo />
					<Compact strategy="truncate-tool-outputs" limit={800}>
						<Messages />
					</Compact>
				</Agent>,
			),
	})

	// Finalizers run when the scope closes — i.e. when NodeRuntime.runMain
	// catches SIGINT/SIGTERM, when the program returns, or when it dies.
	yield* Effect.addFinalizer(() => Effect.promise(() => agent.dispose()))

	const rl: ReadlineInterface = createInterface({
		input: process.stdin,
		output: process.stdout,
	})
	yield* Effect.addFinalizer(() => Effect.sync(() => rl.close()))

	yield* Console.log(DIM("agentjsx REPL  ·  ctrl-c to exit") + "\n")

	while (true) {
		// On SIGINT, NodeRuntime closes stdin and readline rejects with
		// ERR_USE_AFTER_CLOSE. Catch it as a clean exit sentinel rather than
		// letting it propagate as a program failure.
		const raw = yield* Effect.tryPromise({
			try: () => rl.question(`${BLUE("you")}    `),
			catch: () => "__exit__" as const,
		})
		const input = raw.trim()
		if (input === "__exit__") return
		if (!input) continue

		yield* Effect.promise(() => turn(agent, input))
		yield* Console.log("")
	}
}).pipe(Effect.scoped)

NodeRuntime.runMain(program)
