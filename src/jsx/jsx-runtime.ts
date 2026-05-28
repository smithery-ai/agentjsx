// Automatic JSX runtime entry. Consumers set:
//
//   tsconfig.json:
//     "jsx": "react-jsx",
//     "jsxImportSource": "@flamecast/agentjsx"
//
// The TS compiler then implicitly imports `jsx` / `jsxs` / `Fragment` from
// "@flamecast/agentjsx/jsx-runtime" for every .tsx file in the project, so
// users don't need an explicit `import { createElement }` at the top of
// each component file.
//
// The runtime delegates to `createElement` from runtime.ts, normalizing
// the props.children shape (automatic runtime passes children inline on
// `props`, classic runtime takes variadic args).

import type { ComponentFunction, Element, Node } from "./runtime"
import { createElement } from "./runtime"

export { Fragment } from "./runtime"

type AutoRuntimeProps = Record<string, unknown> & { children?: Node | ReadonlyArray<Node> }

function callCreateElement(type: string | ComponentFunction, props: AutoRuntimeProps | null): Element {
	if (props === null) return createElement(type as ComponentFunction, null)
	const { children, ...rest } = props
	if (children === undefined) return createElement(type as ComponentFunction, rest)
	if (Array.isArray(children)) return createElement(type as ComponentFunction, rest, ...children)
	return createElement(type as ComponentFunction, rest, children)
}

export function jsx(type: string | ComponentFunction, props: AutoRuntimeProps | null): Element {
	return callCreateElement(type, props)
}

export function jsxs(type: string | ComponentFunction, props: AutoRuntimeProps | null): Element {
	return callCreateElement(type, props)
}

// dev variant — same shape, ignores key/source extras
export function jsxDEV(type: string | ComponentFunction, props: AutoRuntimeProps | null): Element {
	return callCreateElement(type, props)
}
