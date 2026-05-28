# Pull request workflow

Open a draft PR early; iterate in public. Title in imperative.

- Title format: `prefix: short summary` (`fix:`, `feat:`, `chore:`, `refactor:`, `docs:`, `test:`).
- Keep the title under 70 characters. Details go in the body.
- Body sections: Summary (1-3 bullets on the why), Test plan (what you ran).
- One concern per PR. If the diff covers two unrelated things, split it.
- Rebase, don't merge, when syncing with main. Force-push to your own branch is fine; never to main.
- Resolve review threads only when the reviewer agrees the issue is addressed.
- Squash on merge unless the commit history is genuinely useful to preserve.
