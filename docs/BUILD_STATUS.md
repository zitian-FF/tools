# Build status

Baseline snapshot of the wiki14 tool as of this file's creation. Auto-
overwritten after every push by whichever Claude Code session made it — see
`AGENTS.md` for the rule. Reflects only the current state, not history.

## Current milestone

Sub-phrase (mid-line) styling resolution. Client side is complete and
pushed to `main`. The Worker side (`worker-wiki14/index.js`'s new
`/resolve-subphrase` route) is also committed to this repo, but **has not
yet been deployed** — it still needs to be manually pasted into the
Cloudflare dashboard before it's live. Until that happens, a page with a
mixed-styling line (e.g. a plain lead-in immediately followed by a bold
clause, no line break between) will fail with "sub-phrase styling
resolution failed" flags on the live site, even though the local code
handles it.

## What was implemented

**Pipeline** (`wiki_styler/app.js`):
- DOM walk → token stream → paragraph/line structure
  (`tokenizeSourcecode` → `buildStructure`), tracking both a style's
  *description* (`styleKey`, e.g. `"strong"`) and the specific tag
  *instance* it came from (`instanceKey`) — two separately-authored,
  identical-looking tags never get merged into one continuous run.
- Line-level style tracking: a paragraph containing multiple
  differently-styled but each internally-uniform lines (e.g. a bold header
  line directly followed by a plain body line) is handled directly, no
  longer an error.
- Offset-based content mapping: each matched Excel row is assigned to the
  span of EN lines its content falls within by walking cumulative
  whitespace-stripped content length, not by assuming any fixed delimiter
  between rows (an earlier `"\n\n"`-join approach was tried and rejected
  after it produced wrong output on a real page).
- Two render paths per language: **direct** (no network call) when a
  target language's paragraph count *and* every paragraph's own line count
  matches EN's exactly; otherwise **Gemini fallback**, which asks the
  Worker's `/resolve-styles` route to resolve paragraph-range boundaries by
  meaning.
- **New**: sub-phrase (mid-line) styling resolution. A line mixing styles
  *within itself* (no structural anchor — word order/phrasing differs too
  much across languages for offset matching) is resolved per language via
  the Worker's new `/resolve-subphrase` route, one task per non-plain run on
  the line. Only runs on the direct path, where each EN line maps to
  exactly one known target line; on the fallback path a mixed line still
  degrades to the pre-existing plain-text + flag behavior
  (`paragraphStyleFromLines`'s `"__mixed_"` placeholder), since that path
  never resolves a single target line to search within. Resolved
  substrings are spliced in via Private-Use-Area sentinel markers (not raw
  HTML) so they survive `escapeHtml`/`linkify` before being swapped for the
  real tags at the very end.
- Media handling: `<img>`/`<video>` filenames get `"_EN."` swapped to
  `"_<CODE>."` (two modes: `localize` / `dont-localize` — a third
  `"localize-if-suffix"` mode was removed as functionally redundant with
  `localize`). `<hr>` is tokenized as a block boundary (reused via the
  media-insertion mechanism, `src: ""`) so it's reproduced verbatim in every
  language's output and forces a paragraph split, instead of silently
  vanishing.
- Google Sheets URL as an alternative to file upload: `parseGoogleSheetsUrl`
  + `fetchGoogleSheetCsv`, going through the Worker's `/fetch-sheet` route
  (Google's CSV export doesn't reliably send CORS headers for a direct
  browser fetch), which also detects when Google hands back a login/
  "request access" HTML page instead of CSV and reports that as a clear
  sharing-settings error.
- Per-language title copy field: best-effort text pulled from the first
  Excel row excluded from the sourcecode-body match (checker/proofread rows
  sometimes precede the real title row with no reliable structural signal
  to tell them apart, so this is intentionally not flagged per language —
  it's a manual-review field).
- Warnings UI: grouped by message text with affected language codes listed
  in parentheses, instead of one near-duplicate line per language.

**Worker** (`worker-wiki14/index.js`) — three routes, all gated by the same
`x-app-token` header check:
- `/resolve-styles` (also served at bare `/` for backwards compatibility):
  paragraph-range resolution by meaning.
- `/resolve-subphrase`: mid-line substring resolution (see above) — written
  but not yet deployed.
- `/fetch-sheet`: server-side Google Sheets CSV fetch.

**Tests** (`dev-tests-wiki14/test_harness.js`): runs the real `app.js` in a
Node `vm` + `jsdom` context, mocking `fetch` for `language-lookup.json` and
both `/resolve-styles`/`/fetch-sheet` (reading `CONFIG.workerUrl` out of
`app.js` via regex so the mock URL can't drift from the real one). Asserts
13 languages generate, zero flags, a known Korean paragraph-range resolution
produces all 4 expected style spans, and `dont-localize` mode leaves every
filename unchanged. Currently does **not** exercise the new
`/resolve-subphrase` path — that was verified via one-off scratchpad
scripts during development, not added to this harness.

## Key technical decisions

- Content mapping is offset/length-based, never delimiter-based — the real
  separator at a given row-to-row seam is a property of that page's markup,
  not something a fixed `"\n"` or `"\n\n"` join could guess correctly across
  different pages.
- Sub-phrase resolution is deliberately scoped to the direct path only, not
  the Gemini-fallback path. Extending it to fallback would require first
  identifying *which* line within an already paragraph-range-guessed,
  possibly multi-line target blob to search — compounding one uncertainty
  on top of another. Left as an explicit open question below rather than
  built speculatively.
- The Worker is dashboard-deployed only — this repo's `worker-wiki14/`
  is version-controlled reference code, not an auto-deployed artifact. Any
  session's job ends at "committed here"; "live" is a separate, manual step
  the user always performs themselves.
- Every unresolved-styling case (low Gemini confidence, no match, network
  failure, a returned substring that doesn't literally exist in the target
  text) is flagged for manual review and left unstyled — never guessed
  silently.

## Open questions

- Should sub-phrase resolution be extended to the Gemini paragraph-range
  fallback path too, or is the direct-path-only scope permanent?
- `README.md` (repo root) still describes an entirely different, older
  architecture (pre-wiki14 rewrite: "`<br>`-bounded runs",
  "delimiter-anchored styling"). `wiki_styler/README.md` is closer but
  still describes sub-phrase styling as an unhandled error. Should these be
  brought current, and if so is that in scope for a Claude Code session or
  something the design chat should draft first?
- Should the Excel header-column matching (`findEnColumn` /
  language-mutation lookup) be made case-insensitive generally, or was the
  recent manual fix (adding lowercase `"pt"` to Portuguese's mutation list)
  meant to stay a one-off?

## Known issues

- **`/resolve-subphrase` Worker route not yet deployed live** — see
  "Current milestone" above.
- **User-reported "Failed to fetch" on the Google Sheets URL feature** on
  the live site — not yet root-caused. Most likely either the live Worker
  predates the `/fetch-sheet` route, or a CORS misconfiguration; browser
  DevTools Network-tab confirmation from the user is pending.
- **Stale documentation**: `README.md` (repo root) and
  `wiki_styler/README.md` both describe out-of-date behavior (see "Open
  questions"). `wiki_styler/README.md` also links a stale
  `../worker/README.md` path (should be `../worker-wiki14/README.md`).
- **Stale debug scripts**: `dev-tests-wiki14/debug1.js` and `debug2.js` are
  leftover scratch scripts from an earlier phase. `debug2.js` references
  `paragraphStyleKeys`, which no longer exists in `app.js`'s `_internal`
  exports (renamed to `paragraphStyleFromLines`) — it would throw if run.
  Neither is invoked by `test_harness.js`, so this doesn't affect test
  results, but it's confusing clutter for a future session.
- No regression-test fixture exists yet for a "Their Story" page variant
  used in earlier manual testing (different header sizes, an `<em>` tag) —
  only the gold-bricks/`test_excel3` scenario has a saved fixture.

## Next proposed step

1. Deploy the updated `worker-wiki14/index.js` (with `/resolve-subphrase`)
   to the live Cloudflare Worker.
2. Root-cause and fix the Google Sheets URL "Failed to fetch" report.
3. Decide on the two open documentation/scope questions above before they
   accumulate further drift.
