import { useCallback, useState } from "react"
import { HeroCodeBlock } from "./HeroCodeBlock"
import { CODE } from "./InteractiveContextHero"
import agentjsxSkill from "../../skills/agentjsx/SKILL.md?raw"

const COPY_PROMPT = `I want to build a coding agent using @flamecast/agentjsx. Read the skill below to understand the library, then scaffold a minimal agent for me. Ask me what tools and capabilities I want before writing code.

---

${agentjsxSkill}`

const COMPONENT_CODE = `import {
  emitFragment, emitHaltPredicate,
} from "@flamecast/agentjsx/components"

// Halting is gated by a separate inference call that judges the
// transcript against the condition. Invoked as \`/goal <condition>\`.
export function Goal({ condition }: { condition: string }) {
  return [
    emitFragment({
      tag: "core/system",
      source: "goal",
      content: \`<goal>\${condition}</goal>\\n(stopping is blocked until this holds)\`,
    }),
    emitHaltPredicate(async ({ events, infer }) => {
      const transcript = events
        .filter(e => e.type === "user.message" || e.type === "assistant.message")
        .map(e => \`[\${e.type}] \${"content" in e ? e.content : ""}\`)
        .join("\\n")
      const res = await infer({
        system: \`Judge whether this condition holds: "\${condition}".
          Reply with JSON {"ok": boolean, "reason": string}.\`,
        messages: [{ role: "user", content: transcript }],
        tools: [],
      })
      return JSON.parse(res.content)
    }),
  ]
}`

function LandingHeader() {
	return (
		<header className="landing-head">
			<a className="brand" href="/">
				agentjsx
			</a>
		</header>
	)
}

function CopyPromptCta() {
	const [copied, setCopied] = useState(false)
	const handleCopy = useCallback(() => {
		navigator.clipboard.writeText(COPY_PROMPT).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		})
	}, [])

	return (
		<button type="button" className="cta-primary" onClick={handleCopy}>
			{copied ? "Copied" : "Copy prompt"}
		</button>
	)
}


export function Landing() {
	return (
		<div className="landing" data-theme="dark">
			<LandingHeader />
			<main className="landing-main">
				<div className="landing-hero">
					<div className="landing-hero-text">
						<h1>
							Write your own Claude Code.
							<br />
							Run it anywhere.
						</h1>
						<p className="lede">
							A runtime agnostic agent harness framework. Compose
							your agent from reusable JSX components, then run it
							anywhere V8 does: Node, Bun, or a browser tab.
						</p>
						<div className="landing-hero-cta">
							<CopyPromptCta />
							<a
								className="cta-secondary"
								href="https://github.com/smithery-ai/agentjsx"
							>
								View on GitHub
							</a>
						</div>
					</div>
				</div>

				<div className="landing-section landing-code-section">
					<HeroCodeBlock code={CODE} filename="agent.tsx" />
				</div>

				<section
					className="landing-section landing-build-section"
					aria-labelledby="section-build"
				>
					<div className="landing-build-text">
						<h2 id="section-build" className="landing-build-heading">
							Build your own components.
						</h2>
						<p className="landing-build-lede">
							Components are functions that contribute tools,
							prompt content, or both. Some wrap others to
							reshape what they produce. Drop them inside{" "}
							<code>{"<Agent>"}</code>; the runtime handles
							diffing and tool reconciliation between renders.
						</p>
					</div>
					<div className="landing-code-section">
						<HeroCodeBlock
							code={COMPONENT_CODE}
							filename="goal.tsx"
						/>
					</div>
				</section>
			</main>
		</div>
	)
}
