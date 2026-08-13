# Wiki Multi-Language Styling Tool

A static, client-side-only tool: style a wiki page once in English, then auto-generate
ready-to-paste sourcecode for 13 other languages, reusing the same styling and renaming
embedded image/video filenames to match each language's convention.

No backend — everything (Excel parsing, matching, styling reapplication, filename
rewriting) runs in the browser.

Lives at `wiki_styler/` in this repo, deployed at
`https://zitian-ff.github.io/tools/wiki_styler/`.

## Use

Open `wiki_styler/index.html` (or the deployed GitHub Pages URL):

1. Paste the styled EN wiki sourcecode into the textarea.
2. Upload the translation `.xlsx` (one sheet per wiki page; if the workbook has
   multiple sheets, pick the one for this page).
3. Click **Generate translations**. Each of the 13 target languages gets its own
   **Copy** button — it turns green once you've copied that language's sourcecode.
4. Any styling or structure that can't be safely auto-resolved is called out as a
   warning next to that language's output instead of being silently guessed.

## How it works

- **Excel parsing**: `data/language-lookup.json` normalizes messy column headers
  (`EN `, `zh_TW`, `ko`, ...) to language codes, and skips non-language columns
  (e.g. "Checker", "Proofread check") and the ignored Simplified Chinese column.
- **Styling engine**: EN sourcecode is segmented into `<br>`-bounded runs. Whole-segment
  styling (e.g. an entire line wrapped in `<strong>`) is reapplied positionally to each
  language. Delimiter-anchored styling (e.g. `<strong>[Term A] and [Term B]</strong>`)
  is detected and reapplied per bracketed/quoted term, in order of appearance. Anything
  else (genuine mid-sentence prose styling, segment count mismatches, term count
  mismatches) is surfaced as a warning rather than guessed.
- **Filename rewriting**: `... - EN.ext` image/video filenames become `... - <CODE>.ext`
  for each target language.

## Local development

No build step — it's plain HTML/CSS/JS. `.xlsx` parsing uses
[SheetJS](https://sheetjs.com) (Apache-2.0), loaded from a pinned jsDelivr CDN URL in
`index.html` (all parsing still happens entirely in the browser — this is just where
the library file is fetched from). Serve the `wiki_styler/` directory with any static
file server, e.g.:

```
python3 -m http.server 8000 --directory wiki_styler
```

## Deployment

Deploys to GitHub Pages via `.github/workflows/deploy-pages.yml` on every push to
`main` (requires the repo's Pages source to be set to "GitHub Actions" in Settings →
Pages). If Pages is instead configured to deploy from a branch, no workflow is needed —
this is a static site servable straight from the repo root.
