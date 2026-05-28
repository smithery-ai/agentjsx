// Lifted from flamecast-agents' InteractiveHero. Custom 4-token tokenizer
// (keyword / string / fn / punct) so we don't pull in highlight.js or shiki
// for a single block. Lines can be made clickable by passing
// `highlightedLines` + `onLineClick`; pair with `activeLine` to render
// the currently-selected state.

const KW = /\b(import|export|from|const|let|var|async|await|function|return|type|interface)\b/g
const STR = /(["'`])(?:(?!\1).)*?\1/g
const COMMENT = /(\/\/.*$|#.*$)/gm
const FN = /\b([a-zA-Z_]\w*)\s*(?=\()/g

function tokenizeLine(line: string): { type: string; text: string }[] {
	type Span = { start: number; end: number; type: string }
	const spans: Span[] = []
	// Strings first so later passes (comment / keyword / fn) can skip
	// matches that start inside a string. Without this, the "//" in
	// a URL like "https://example.com" gets misread as a line comment.
	for (const m of line.matchAll(STR)) spans.push({ start: m.index!, end: m.index! + m[0].length, type: "string" })
	for (const m of line.matchAll(COMMENT)) {
		if (!spans.some(s => m.index! >= s.start && m.index! < s.end))
			spans.push({ start: m.index!, end: m.index! + m[0].length, type: "punct" })
	}
	for (const m of line.matchAll(KW)) {
		if (!spans.some(s => m.index! >= s.start && m.index! < s.end))
			spans.push({ start: m.index!, end: m.index! + m[0].length, type: "keyword" })
	}
	for (const m of line.matchAll(FN)) {
		if (!spans.some(s => m.index! >= s.start && m.index! < s.end))
			spans.push({ start: m.index!, end: m.index! + m[1].length, type: "fn" })
	}
	spans.sort((a, b) => a.start - b.start)
	const tokens: { type: string; text: string }[] = []
	let pos = 0
	for (const s of spans) {
		// Defensive: drop spans that overlap a previously emitted one.
		// The inside-string check above usually catches this, but this
		// guarantees no slice of input is ever emitted twice.
		if (s.start < pos) continue
		if (s.start > pos) tokens.push({ type: "plain", text: line.slice(pos, s.start) })
		tokens.push({ type: s.type, text: line.slice(s.start, s.end) })
		pos = s.end
	}
	if (pos < line.length) tokens.push({ type: "plain", text: line.slice(pos) })
	return tokens.length ? tokens : [{ type: "plain", text: line }]
}

function CodeToken({ type, text }: { type: string; text: string }) {
	const classMap: Record<string, string> = {
		keyword: "ih-tok-keyword",
		string: "ih-tok-string",
		fn: "ih-tok-fn",
		punct: "ih-tok-punct",
		plain: "",
	}
	const cls = classMap[type] || ""
	return cls ? <span className={cls}>{text}</span> : <>{text}</>
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
	const lines = code.split("\n")
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
			<pre className="ih-code-body">
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
								<span className="ih-line-text">
									{line ? tokenizeLine(line).map((tok, j) => (
										<CodeToken key={j} type={tok.type} text={tok.text} />
									)) : "\n"}
								</span>
							</div>
						)
					})}
				</code>
			</pre>
		</div>
	)
}
