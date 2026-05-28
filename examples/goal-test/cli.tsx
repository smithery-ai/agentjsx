// End-to-end test of the `<Goal>` component + `/goal` slash command +
// halt-gate fiber. This replaces the prior userspace orchestration —
// the runtime now owns the loop. We just set the goal and run.
//
// Run:
//   infisical run --silent -- npx tsx cli.tsx
// Env:
//   AI_GATEWAY_API_KEY=...

import { NodeContext } from "@effect/platform-node"
import {
	createAgentRuntime,
	createAiGatewayInfer,
	render,
} from "@flamecast/agentjsx"
import {
	Agent,
	Block,
	Goal,
	Messages,
	Workspace,
} from "@flamecast/agentjsx/components"

const GOAL = "The assistant has greeted the user in pirate speak (e.g. 'Ahoy')."
const INITIAL_PROMPT = "Greet me."

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`
const BLUE = (s: string) => `\x1b[34m${s}\x1b[0m`
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`

async function main(): Promise<void> {
	const apiKey = process.env.AI_GATEWAY_API_KEY
	if (!apiKey) {
		console.error("Set AI_GATEWAY_API_KEY (or run under `infisical run --silent`).")
		process.exit(1)
	}

	const infer = createAiGatewayInfer({
		apiKey,
		model: "anthropic/claude-sonnet-4-6",
	})

	const agent = createAgentRuntime({
		infer,
		platform: NodeContext.layer,
		context: () =>
			render(
				<Agent>
					<Block name="role">
						You are a friendly assistant. Respond briefly to the user.
					</Block>
					<Goal />
					<Workspace root="./" />
					<Messages />
				</Agent>,
			),
	})

	try {
		console.log(DIM(`goal: ${GOAL}`))
		console.log("")

		await agent.run(`/goal ${GOAL}`)
		console.log(`${BLUE("you")}    /goal …`)

		console.log(`${BLUE("you")}    ${INITIAL_PROMPT}`)
		await agent.run(INITIAL_PROMPT)

		// Stream events. The halt-gate fiber will reprompt automatically
		// on assistant.halted if the predicate fails; we just observe.
		let printed = (await agent.events()).length
		const startTs = Date.now()
		while (Date.now() - startTs < 60_000) {
			await new Promise((r) => setTimeout(r, 200))
			const events = await agent.events()
			for (let i = printed; i < events.length; i++) {
				const e = events[i]!
				if (e.type === "assistant.message" && e.content) {
					console.log(`${GREEN("agent")}  ${e.content}`)
				} else if (e.type === "user.message") {
					const c = typeof e.content === "string" ? e.content : JSON.stringify(e.content)
					if (i > printed - 1) console.log(`${DIM(YELLOW("reprompt"))} ${c}`)
				} else if (e.type === "assistant.halted") {
					console.log(DIM(`  ${YELLOW("!")} halted: ${e.reason}`))
				}
			}
			printed = events.length
			const last = events[events.length - 1]
			// Terminal when last event is an unanswered halt (gate decided
			// the predicate is satisfied) OR a clean assistant.message
			// with no further tool calls and no reprompt queued.
			if (last?.type === "assistant.halted") break
		}

		console.log("")
		console.log(GREEN("done"))
	} finally {
		await agent.dispose()
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
