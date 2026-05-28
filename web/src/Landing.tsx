import { useCallback, useState } from "react"
import { HeroCodeBlock } from "./HeroCodeBlock"
import { CODE } from "./InteractiveContextHero"

function LandingHeader() {
	return (
		<header className="landing-head">
			<a className="brand" href="/">
				agentctx
			</a>
			<a className="landing-cta" href="#docs">
				Docs
			</a>
		</header>
	)
}

function CopySnippetCta() {
	const [copied, setCopied] = useState(false)
	const handleCopy = useCallback(() => {
		navigator.clipboard.writeText(CODE).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		})
	}, [])

	return (
		<button type="button" className="cta-primary" onClick={handleCopy}>
			{copied ? "Copied" : "Copy snippet"}
		</button>
	)
}

const LINKS = [
	{
		href: "https://github.com/smithery-ai/effectctx",
		label: "GitHub",
		desc: "Source, issues, and the full extension catalog.",
	},
	{
		href: "https://www.npmjs.com/package/@flamecast/agentctx",
		label: "npm",
		desc: "Install with bun add @flamecast/agentctx.",
	},
	{
		href: "https://github.com/smithery-ai/effectctx/tree/main/examples",
		label: "Examples",
		desc: "Local coding agent and Cloudflare Sandbox variants.",
	},
]

export function Landing() {
	return (
		<div className="landing" data-theme="dark">
			<LandingHeader />
			<main className="landing-main">
				<div className="landing-hero">
					<div className="landing-hero-text">
						<h1>Render your agent's context like a UI</h1>
						<p className="lede">
							Event log to JSX to context. agentctx is an
							Effect-based agent harness that treats LLM context
							like React treats the DOM: composable steering
							extensions shape what your model sees and does, and
							the same code runs anywhere V8 does.
						</p>
						<div className="landing-hero-cta">
							<CopySnippetCta />
							<a
								className="cta-secondary"
								href="https://github.com/smithery-ai/effectctx"
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
					className="landing-section"
					aria-labelledby="section-where"
				>
					<h2 id="section-where" className="caption">
						Where to go
					</h2>
					<ul className="landing-links">
						{LINKS.map(l => (
							<li key={l.href}>
								<a href={l.href}>
									<span className="landing-link-label">
										{l.label}
									</span>
									<span className="landing-link-desc">
										{l.desc}
									</span>
								</a>
							</li>
						))}
					</ul>
				</section>
			</main>
		</div>
	)
}
