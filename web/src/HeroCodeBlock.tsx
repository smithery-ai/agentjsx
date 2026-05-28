import hljs from "highlight.js/lib/core"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"

hljs.registerLanguage("typescript", typescript)
hljs.registerLanguage("xml", xml)

// Highlight the whole snippet once, then split on real newlines.
// hljs spans for tsx don't cross newlines for this snippet, but we
// rebalance just in case so each line is a self-contained HTML fragment.
function highlightLines(code: string): string[] {
	const html = hljs.highlight(code, { language: "typescript" }).value
	const rawLines = html.split("\n")
	const openStack: string[] = []
	return rawLines.map(line => {
		const prefix = openStack.map(tag => tag).join("")
		const re = /<span class="[^"]*">|<\/span>/g
		let m: RegExpExecArray | null
		while ((m = re.exec(line)) !== null) {
			if (m[0] === "</span>") openStack.pop()
			else openStack.push(m[0])
		}
		const suffix = openStack.map(() => "</span>").join("")
		return prefix + line + suffix
	})
}

export function HeroCodeBlock({
	code,
	filename,
	highlightedLines,
	activeLine,
	onLineClick,
}: {
	code: string
	filename?: string
	highlightedLines?: Set<number>
	activeLine?: number | null
	onLineClick?: (i: number) => void
}) {
	const lines = highlightLines(code)
	return (
		<div className="ih-code-col">
			<div className="ih-code-head">
				{filename ? (
					<span className="ih-code-tab ih-code-tab-active">
						<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
							<path d="M2 4l6-2 6 2v8l-6 2-6-2z" />
							<path d="M8 6v8" />
							<path d="M2 4l6 2 6-2" />
						</svg>
						{filename}
					</span>
				) : null}
			</div>
			<pre className="ih-code-body hljs">
				<code>
					{lines.map((line, i) => {
						const isHighlighted = highlightedLines?.has(i) ?? false
						const isActive = activeLine === i
						const cls = [
							"ih-code-line",
							isHighlighted ? "ih-line-hl" : "",
							isActive ? "ih-line-active" : "",
						].filter(Boolean).join(" ")
						return (
							<div
								key={i}
								className={cls}
								style={isHighlighted ? { cursor: "pointer" } : undefined}
								onClick={isHighlighted ? () => onLineClick?.(i) : undefined}
							>
								<span className="ih-line-num">{i + 1}</span>
								<span
									className="ih-line-text"
									dangerouslySetInnerHTML={{ __html: line || "\n" }}
								/>
							</div>
						)
					})}
				</code>
			</pre>
		</div>
	)
}
