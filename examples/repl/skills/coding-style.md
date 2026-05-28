# Coding style

Match the surrounding code style. Read nearby files before editing.

- Prefer existing patterns over introducing new abstractions.
- Keep imports grouped: stdlib, third-party, local. No reordering on unrelated edits.
- Two-space indent for TS/TSX unless the file already uses tabs; follow the file.
- Comments explain *why*, not *what*. If the code needs a comment to explain what it does, rename the variable.
- No dead code. If you remove a call site, remove the function.
- Prefer narrow exports. Default to `export function foo`, not `export default`.
- When you touch a file, leave it at least as readable as you found it.
