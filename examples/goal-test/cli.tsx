// Userspace emulation of Claude Code's /goal:
//
//  1. Set a natural-language condition.
//  2. Run the agent.
//  3. When the agent halts, call a SEPARATE `infer` (the judge) to
//     evaluate whether the condition holds against the transcript.
//  4. If the judge says ok=false, re-prompt the agent with the judge's
//     reason. Loop until ok=true (or iteration budget is exhausted).
//
// No runtime modification: this is pure userspace orchestration around
// `agent.run` + `agent.events` + a second `infer` call. The judge is
// the same model family but isolated — it never sees the agent's tools,
// only the transcript.
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
	Messages,
	Workspace,
} from "@flamecast/agentjsx/components"
import type { Event, InferFn } from "@flamecast/agentjsx"

// --- Config ---------------------------------------------------------------

const GOAL = "The assistant has greeted the user in pirate speak (e.g. 'Ahoy')."
const INITIAL_PROMPT = "Greet me."
const MAX_ITERATIONS = 4

// --- Pretty-printing ------------------------------------------------------

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`
const BLUE = (s: string) => `\x1b[34m${s}\x1b[0m`
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`

// --- Judge ----------------------------------------------------------------

interface Verdict {
	ok: boolean
	reason: string
}

function buildTranscript(events: ReadonlyArray<Event>): string {
	const lines: string[] = []
	for (const e of events) {
		if (e.type === "user.message") {
			lines.push(`[user] ${typeof e.content === "string" ? e.content : JSON.stringify(e.content)}`)
		} else if (e.type === "assistant.message") {
			if (e.content) lines.push(`[assistant] ${e.content}`)
		} else if (e.type === "tool.call.started") {
			lines.push(`[tool.call] ${e.tool_name}`)
		} else if (e.type === "tool.result") {
			lines.push(`[tool.result] ${e.content.slice(0, 400)}`)
		}
	}
	return lines.join("\n")
}

async function judge(
	infer: InferFn,
	condition: string,
	transcript: string,
): Promise<Verdict> {
	const system = [
		"You are evaluating a hook condition in agentjsx.",
		"Judge whether the user-provided condition is met against the transcript below.",
		'Respond with a JSON object EXACTLY of the shape {"ok": boolean, "reason": string}.',
		"Always include a reason. Quote specific text from the transcript when possible.",
		"If there is no clear evidence, return ok: false with reason \"insufficient evidence\".",
	].join("\n")

	const userMsg = `CONDITION:\n${condition}\n\nTRANSCRIPT:\n${transcript}\n\nRespond with JSON only.`

	const res = await infer({
		system,
		messages: [{ role: "user", content: userMsg }],
		tools: [],
	})

	const raw = res.content.trim()
	// Strip ```json fences if the model adds them
	const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim()
	try {
		const parsed = JSON.parse(cleaned)
		if (typeof parsed?.ok === "boolean" && typeof parsed?.reason === "string") {
			return parsed
		}
		return { ok: false, reason: `judge returned malformed JSON: ${raw}` }
	} catch {
		return { ok: false, reason: `judge returned non-JSON: ${raw}` }
	}
}

// --- Agent loop -----------------------------------------------------------

async function drainTurn(agent: ReturnType<typeof createAgentRuntime>): Promise<void> {
	const startLen = (await agent.events()).length
	let printed = startLen
	while (true) {
		await new Promise((r) => setTimeout(r, 100))
		const events = await agent.events()
		for (let i = printed; i < events.length; i++) {
			const e = events[i]!
			if (e.type === "assistant.message" && e.content) {
				console.log(`${GREEN("agent")}  ${e.content}`)
			} else if (e.type === "tool.call.started") {
				console.log(DIM(`  ${YELLOW("→")} ${e.tool_name}`))
			} else if (e.type === "tool.result") {
				const snippet = e.content.length > 80 ? `${e.content.slice(0, 80)}…` : e.content
				console.log(DIM(`  ${YELLOW("←")} ${snippet}`))
			} else if (e.type === "assistant.halted") {
				console.log(DIM(`  ${YELLOW("!")} halted: ${e.reason}`))
			}
		}
		printed = events.length
		const last = events[events.length - 1]
		const isTerminal =
			(last?.type === "assistant.message" && !last.tool_calls?.length) ||
			last?.type === "assistant.halted" ||
			last?.type === "inference.failed"
		if (isTerminal) break
	}
}

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
					<Workspace root="./" />
					<Messages />
				</Agent>,
			),
	})

	try {
		console.log(DIM(`goal: ${GOAL}`))
		console.log("")
		console.log(`${BLUE("you")}    ${INITIAL_PROMPT}`)
		await agent.run(INITIAL_PROMPT)
		await drainTurn(agent)

		for (let i = 1; i <= MAX_ITERATIONS; i++) {
			const events = await agent.events()
			const transcript = buildTranscript(events)
			console.log("")
			console.log(DIM(`  judging iteration ${i}/${MAX_ITERATIONS}…`))
			const verdict = await judge(infer, GOAL, transcript)
			if (verdict.ok) {
				console.log(GREEN(`  ✓ goal met: ${verdict.reason}`))
				return
			}
			console.log(RED(`  ✗ not met: ${verdict.reason}`))
			const reprompt = `[goal: ${GOAL}]: ${verdict.reason}`
			console.log(`${BLUE("you")}    ${reprompt}`)
			await agent.run(reprompt)
			await drainTurn(agent)
		}
		console.log("")
		console.log(RED(`exhausted ${MAX_ITERATIONS} iterations without meeting goal`))
		process.exit(2)
	} finally {
		await agent.dispose()
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
