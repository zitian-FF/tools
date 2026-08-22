# AGENTS.md

Operating rules for any Claude Code session (or other coding agent) working
in this repo. Product/architecture decisions for the wiki multi-language
tooling are made in a separate design-discussion chat, not here — this
repo, plus `docs/BUILD_STATUS.md`, is the shared memory layer between that
chat and Claude Code sessions, so a new session doesn't need the whole
history re-explained. Read `docs/BUILD_STATUS.md` first, before doing
anything else.

## Scope boundary

Only modify files inside `wiki_styler/`, `worker-wiki14/`, and
`dev-tests-wiki14/`, unless a task explicitly says otherwise. `AGENTS.md`
(this file) and `docs/BUILD_STATUS.md` are the standing exception — both
live outside those three folders by design.

## The Cloudflare Worker has no CLI deploy access

`worker-wiki14/` is **dashboard-managed only**. No CLI or API deploy path
exists or should be assumed, from this session or any automated context.

- Never attempt to deploy it (no `wrangler deploy`, no Cloudflare API calls).
- If the Worker's code needs to change, write the updated code into
  `worker-wiki14/index.js` as normal — that's still the version-controlled
  source of truth. But explicitly call out in `docs/BUILD_STATUS.md` that it
  still needs to be manually pasted into the Cloudflare dashboard by the
  user before it's live.
- Treat "committed to this repo" and "live on the Worker" as two separate,
  independently-tracked states. Don't conflate them.

## Preserve `CONFIG.workerUrl` in `dev-tests-wiki14/test_harness.js`

`test_harness.js` extracts `CONFIG.workerUrl` out of `wiki_styler/app.js`
via a regex (`workerUrl:\s*"([^"]+)"`) so its mock Worker URL can never drift
from the real deployed one. Keep that variable's name (`workerUrl`) and its
simple `workerUrl: "..."` assignment format inside the `CONFIG` object in
`app.js` — don't rename it, restructure it (e.g. into a nested object or a
computed value), or reformat the line in a way the regex wouldn't match.

## Test before shipping

Before shipping any change, run the existing test harness:

```
cd dev-tests-wiki14 && node test_harness.js
```

- **If it fails**: do NOT open a PR. Write the failure details into
  `docs/BUILD_STATUS.md` under "Known issues" and stop there.
- **If it passes**: commit, push to a branch, open a PR against `main`, and
  enable GitHub's auto-merge on it so it merges on its own once mergeable.
  No manual diff review step — this is a solo project and the user doesn't
  review PRs by hand — but every change still goes through a PR now rather
  than a direct push to `main`.

## Update `docs/BUILD_STATUS.md` after every shipped (or blocked) change

After every change — whether it shipped via a merged PR, or was blocked by
a test failure — **overwrite** `docs/BUILD_STATUS.md` using the section
structure below.
Always overwrite the whole file, never append to it; it should reflect only
the latest state, not a running log.

```
## Current milestone
## What was implemented
## Key technical decisions
## Open questions
## Known issues
## Next proposed step
```

If the change was blocked by a failing test, "Known issues" is where that
failure's details go. Otherwise "Known issues" reflects whatever real gaps
or bugs are currently known (stale docs, undeployed Worker changes,
unconfirmed live bugs, etc.) — it isn't reserved exclusively for test
failures.
