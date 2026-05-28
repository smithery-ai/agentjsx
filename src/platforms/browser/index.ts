// Browser runtime adapter.
//
// Placeholder: `@effect/platform-browser` does not currently export a
// unified `BrowserContext` layer (browsers don't expose a CommandExecutor
// and the FileSystem story is split across BrowserKeyValueStore / OPFS).
// Individual capabilities — Clipboard, Geolocation, Permissions,
// BrowserHttpClient, BrowserKeyValueStore, BrowserSocket, BrowserStream,
// BrowserWorker — are available directly from `@effect/platform-browser`.
//
// When a unified browser platform layer ships (or we compose one in this
// package), it will be exported from here as `platform`.

export {}
