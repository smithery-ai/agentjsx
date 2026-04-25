# Cloudflare Sandbox agent

`effectctx` running inside a Cloudflare Worker, with the agent's shell and file system backed by a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/). The Sandbox is a persistent isolated Linux environment, so files the model writes in turn N are still there in turn N+1, even though the effectctx runtime itself is rebuilt per request.

## Why this is interesting

The local example in [`../coding-agent/`](../coding-agent/) shells out on the host. Fine for a demo, dangerous for anything else. This example shows the same agent embedded in a serverless environment with a real isolation boundary: each session gets its own ephemeral Linux container, the Worker holds no state between requests, and the Sandbox SDK handles all the snapshot/restore plumbing. (Cloudflare Sandboxes [went GA in April 2026](https://blog.cloudflare.com/sandbox-ga/).)

The interesting code is the **adapter layer** in [`src/index.ts`](src/index.ts), lines 30–100. That's where Cloudflare's `sandbox.exec` / `sandbox.readFile` / `sandbox.writeFile` get wrapped into effectctx's `Shell` and `FileStore` interfaces. Once those exist, the agent itself is the same five-line `extensions: [workspace(...), maxSteps(...)]` array as the local example.

## API

One route: `POST /chat`.

```bash
curl -X POST https://your-worker.workers.dev/chat \
  -H 'content-type: application/json' \
  -d '{ "message": "find every TODO and group by file", "sandbox": "user-42" }'
```

The `sandbox` field names which Sandbox to talk to. Reuse the same name across calls and the model sees a persistent file system; use a fresh name for an empty workspace.

## Setup

```bash
cd examples/cloudflare-sandbox
npm install
wrangler secret put AI_GATEWAY_API_KEY
wrangler deploy
```

The first deploy builds and uploads the `cloudflare/sandbox` container image, which can take a few minutes.

## What's missing

- **No durable event log.** Each request builds a fresh agent. The model sees a persistent *file system* (because the Sandbox persists), but not a persistent *conversation*. To add that, persist the agent's `events()` array into a Durable Object or KV keyed by sandbox name, and pass it as `initialEvents` on the next call.
- **No streaming.** The Worker waits for `agent.until(...)` and returns the final text. Wire `agent.eventChanges` into a Server-Sent Events response if you want token-by-token output.
- **No auth.** Production workloads should gate `/chat` behind a real auth check.

The point of this example is the *embedding pattern*. Production extensions live in your real app.
