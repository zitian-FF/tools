# wiki14 site

Static site: paste EN sourcecode, attach the translation sheet, get 13
ready-to-paste language versions with a Copy button each.

## Deploy to GitHub Pages

1. Push this `site/` folder's contents to a repo (root or a `/docs` folder —
   whichever you point GitHub Pages at in repo Settings → Pages).
2. Enable GitHub Pages on that repo/branch.
3. Before or after pushing, set the two values in `app.js`'s `CONFIG` block
   at the top:
   - `workerUrl`: your deployed Cloudflare Worker's URL (see `../worker/README.md`)
   - `appToken`: the same random string you set as the Worker's `APP_TOKEN` secret

Nothing else needs a build step — it's plain HTML/CSS/JS plus the SheetJS
CDN script for reading `.xlsx`/`.xls`/`.csv` files.

## How it works (matches the wiki14 Claude skill's algorithm)

1. Parses the EN sourcecode's DOM, flattening `<br>` to `\n` and recording
   which style wraps each paragraph.
2. Cross-checks that against the Excel's EN column (rows joined by `\n`) to
   confirm paragraph counts/boundaries line up, and to auto-exclude metadata
   rows (checker names, proofread checkboxes) — a row only counts as content
   if its EN text actually appears in the sourcecode.
3. For each of the 13 target languages: if its paragraph count matches EN,
   applies the style map directly (no network call). If it doesn't — a
   translator merged or re-split paragraphs differently — it asks the Gemini
   proxy Worker to resolve the paragraph-range boundaries by meaning.
4. Reassembles HTML per language, merging consecutive same-style paragraphs
   into one continuous tag (matching how the EN source itself is written),
   swapping image/video filenames to the language code, and re-wrapping any
   untranslated URLs as links.
5. Anything it can't place confidently gets flagged in the UI rather than
   silently guessed or dropped — check the flags panel before pasting.

## Known limitations (read before trusting this on a new page shape)

This has been validated against one real page. A few things are explicitly
**not** handled yet, and will show up as errors or flags rather than silent
wrong output:

- **Genuine mid-sentence (sub-phrase) styling** — bolding one clause inside
  a longer sentence, with no paragraph boundary to anchor on. The pipeline
  throws an error listing the paragraph indices involved rather than
  guessing; see the wiki14 Claude skill's notes on sub-phrase matching for
  the manual approach until this is built out.
- **Page layout assumptions** — decorative spacing choices specific to one
  page (e.g. a couple of empty `<p></p>` tags at the very top, or a blank
  line before the body starts) aren't reproduced automatically, since
  they're not a general rule across pages. Real content and styling is
  preserved either way; only cosmetic whitespace at page boundaries may need
  a manual touch-up.
- **Media placement in mismatched-paragraph-count languages** is anchored to
  the nearest resolved style-run boundary; if an image sits in the middle of
  a long unstyled stretch with no nearby styled anchor, its position is
  estimated proportionally and flagged for a manual check.

If you hit any of these on a real page, that's useful signal for what to
extend next — please don't route around a flag by hand without checking it
first (the last version of this tool broke by silently dropping content on
exactly this kind of mismatch).
