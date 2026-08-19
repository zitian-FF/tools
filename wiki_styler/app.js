// wiki14 — client-side pipeline
//
// Mirrors the algorithm validated by hand against a real wiki page:
//   1. Parse the EN sourcecode's real paragraph structure first (ground
//      truth): DOM walk into styled paragraphs, splitting on both <br><br>
//      and <p>/<div> block boundaries (buildStructure) — this is the
//      actual paragraph count and style map, not an approximation of it.
//   2. Map each matched Excel row to the span of EN paragraphs its content
//      falls within, by walking cumulative whitespace-stripped content
//      length rather than assuming any fixed delimiter between rows — the
//      real separator at a given row-to-row seam (a single <br> within one
//      shared paragraph, a real blank line, or nothing at all across a
//      bare block boundary) is a property of that page's markup at that
//      exact seam, not something a fixed "\n" or "\n\n" join could ever
//      guess correctly across different pages.
//   3. From that EN-only mapping, derive one merge/fresh-break boolean per
//      row-to-row transition (do the two rows share the same EN paragraph,
//      or not) — a structural property of the page, computed once and
//      reused identically for every target language.
//   4. For each target language: rebuild its own paragraph list from its
//      own rows' raw text (splitting each row on its own internal "\n\n",
//      always reliable since it's a single cell), applying the same
//      merge/fresh-break pattern at each row boundary.
//      - Paragraph count matches EN -> apply the style map directly.
//      - Paragraph count doesn't match -> ask the Gemini proxy to resolve
//        paragraph-range boundaries per styled section.
//   5. Reassemble HTML, merging consecutive same-style paragraphs into a
//      single continuous tag (matching how the EN source itself is written).
//
// Genuine mid-sentence (sub-phrase) styling — different styling on part of
// one line, e.g. a plain lead-in immediately followed by a bold clause with
// no line break between — has no structural anchor to place in translated
// text, so it's resolved via a dedicated Gemini call per line
// (applySubPhraseResolution / Worker route /resolve-subphrase) rather than
// offset/structure matching. This only runs on the direct (line-shape-
// matched) path, where each EN line maps to exactly one known target line;
// a mixed line inside a paragraph that needs the Gemini paragraph-range
// fallback instead still degrades to plain text + a flag (see
// paragraphStyleFromLines's "__mixed_" handling), since that path never
// resolves an individual target line to search within.

const CONFIG = {
  workerUrl: "https://wiki14-gemini-proxy.tianz-88.workers.dev", // TODO: set to your deployed Worker URL
  appToken: "sd2r39r97297r3237rg1g91g98", // TODO: must match the Worker's APP_TOKEN secret
};

let LANGUAGE_LOOKUP = null;

async function loadLanguageLookup() {
  if (LANGUAGE_LOOKUP) return LANGUAGE_LOOKUP;
  const resp = await fetch("language-lookup.json");
  LANGUAGE_LOOKUP = await resp.json();
  return LANGUAGE_LOOKUP;
}

function buildMutationMap(lookup) {
  const map = new Map();
  for (const lang of lookup.languages) {
    for (const m of lang.mutations) map.set(m, lang.code);
  }
  return map;
}

// ---------- Step 1: DOM walk -> token stream ----------

function tokenizeSourcecode(html) {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
  const root = doc.getElementById("root");
  const tokens = [];
  let nextTagInstanceId = 0;

  function styleKeyFor(stack) {
    return stack
      .map((s) => (s.attr ? `${s.tag}[${s.attr}]` : s.tag))
      .join(">");
  }
  // Identifies WHICH specific tag instance in the source a run came from,
  // not just what it looks like. Two adjacent lines can have identical
  // styleKeys ("bold") while coming from two separately-authored
  // <strong>...</strong> elements rather than one continuous one — merging
  // those when reassembling would silently change the source structure
  // even though it renders identically in a browser.
  function instanceKeyFor(stack) {
    return stack.map((s) => s.instanceId).join(">");
  }
  function openTagsFor(stack) {
    return stack.map((s) => s.openTag).join("");
  }
  function closeTagsFor(stack) {
    return [...stack].reverse().map((s) => s.closeTag).join("");
  }

  function walk(node, stack, linkHref) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent;
        if (text.length === 0) continue;
        tokens.push({
          type: "text",
          text,
          styleKey: styleKeyFor(stack),
          instanceKey: instanceKeyFor(stack),
          openTag: openTagsFor(stack),
          closeTag: closeTagsFor(stack),
          linkHref: linkHref || null,
        });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (tag === "br") {
          tokens.push({ type: "br" });
        } else if (tag === "img" || tag === "video") {
          tokens.push({
            type: "media",
            tag,
            src: child.getAttribute("src") || "",
            outerHTML: child.outerHTML,
          });
        } else if (tag === "hr") {
          // No src to localize — reuses the "media" token type purely for
          // the block-boundary flush + verbatim-reproduction behavior it
          // already gives img/video, so <hr> stops being silently dropped
          // and stops letting content on either side of it merge into one
          // continuous style run.
          tokens.push({ type: "media", tag: "hr", src: "", outerHTML: child.outerHTML });
        } else if (tag === "p" || tag === "div") {
          // Special-case: a div/p whose only element child is a single
          // img/video (the common "image block" wrapper, e.g.
          // `<div style="text-align:left"><img .../></div>`) becomes one
          // media token carrying the whole wrapper's outerHTML, rather
          // than being walked as a structural block.
          const elementChildren = [...child.children];
          const isImageWrapper =
            tag === "div" &&
            elementChildren.length === 1 &&
            (elementChildren[0].tagName === "IMG" || elementChildren[0].tagName === "VIDEO");
          if (isImageWrapper) {
            tokens.push({
              type: "media",
              tag: elementChildren[0].tagName.toLowerCase(),
              src: elementChildren[0].getAttribute("src") || "",
              outerHTML: child.outerHTML,
            });
          } else {
            tokens.push({ type: "block" });
            walk(child, stack, linkHref);
            tokens.push({ type: "block" });
          }
        } else if (tag === "a") {
          walk(child, stack, child.getAttribute("href") || "");
        } else if (tag === "span") {
          const style = child.getAttribute("style") || "";
          const entry = {
            tag: "span",
            attr: style,
            instanceId: nextTagInstanceId++,
            openTag: `<span style="${style}">`,
            closeTag: "</span>",
          };
          walk(child, [...stack, entry], linkHref);
        } else if (tag === "strong" || tag === "s" || tag === "em" || tag === "u") {
          const entry = {
            tag,
            attr: null,
            instanceId: nextTagInstanceId++,
            openTag: `<${tag}>`,
            closeTag: `</${tag}>`,
          };
          walk(child, [...stack, entry], linkHref);
        } else {
          // Unknown tag: descend without adding to the style stack, so we
          // don't silently lose its contents.
          walk(child, stack, linkHref);
        }
      }
    }
  }

  walk(root, [], null);
  return tokens;
}

// ---------- Step 2: token stream -> flattened text + paragraph/style structure ----------

function flattenTokens(tokens) {
  // Plain text only, <br> -> \n. Used purely for the diff-against-Excel check.
  return tokens
    .map((t) => {
      if (t.type === "text") return t.text;
      if (t.type === "br") return "\n";
      return "";
    })
    .join("");
}

function buildStructure(tokens) {
  const paragraphs = []; // array of lines; each line = array of {text, styleKey, instanceKey, openTag, closeTag, linkHref}
  const mediaInsertions = []; // {beforeParagraphIndex, outerHTML, src}
  let currentParagraph = [];
  let currentLine = [];
  let brCount = 0;

  function flushLine() {
    if (currentLine.length > 0) {
      currentParagraph.push(currentLine);
      currentLine = [];
    }
  }
  function flushParagraph() {
    flushLine();
    if (currentParagraph.length > 0) {
      paragraphs.push(currentParagraph);
      currentParagraph = [];
    }
  }

  for (const tok of tokens) {
    if (tok.type === "text") {
      brCount = 0;
      currentLine.push(tok);
    } else if (tok.type === "br") {
      flushLine();
      brCount++;
      if (brCount === 2) flushParagraph();
    } else if (tok.type === "media") {
      flushParagraph();
      mediaInsertions.push({
        beforeParagraphIndex: paragraphs.length,
        outerHTML: tok.outerHTML,
        src: tok.src,
        tag: tok.tag,
      });
      brCount = 0;
    } else if (tok.type === "block") {
      flushParagraph();
      brCount = 0;
    }
  }
  flushParagraph();

  // Drop whitespace-only paragraphs. Empty <p></p> tags never produce
  // tokens in the first place (nothing to filter), but stray whitespace
  // text nodes outside any real tag (e.g. a trailing newline at the end of
  // a pasted/saved HTML file) do produce a spurious trailing "paragraph".
  // Remap mediaInsertions' indices to account for any removed paragraphs.
  const keepFlags = paragraphs.map((p) => paragraphPlainText(p).trim().length > 0);
  const remap = [];
  let kept = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    remap.push(kept);
    if (keepFlags[i]) kept++;
  }
  const filteredParagraphs = paragraphs.filter((_, i) => keepFlags[i]);
  const remappedMedia = mediaInsertions.map((m) => ({
    ...m,
    beforeParagraphIndex: remap[m.beforeParagraphIndex] ?? filteredParagraphs.length,
  }));

  return { paragraphs: filteredParagraphs, mediaInsertions: remappedMedia };
}

// Flattens paragraphs -> lines into one ordered flat array, so row-mapping
// and style-run collapsing can operate at line granularity while each
// entry still knows which paragraph (and position within it) it came from.
function flattenToLines(paragraphs) {
  const flatLines = [];
  paragraphs.forEach((lines, paragraphIndex) => {
    lines.forEach((runs, lineIndexInParagraph) => {
      flatLines.push({ paragraphIndex, lineIndexInParagraph, runs });
    });
  });
  return flatLines;
}

// Per-line style: the styleKey/instanceKey shared by every run on that
// line, if uniform; otherwise null (genuine mid-line / sub-phrase styling,
// which this tool doesn't attempt to auto-resolve).
function lineStyleKeys(flatLines) {
  return flatLines.map((line) => {
    const keys = new Set();
    let sample = null;
    for (const run of line.runs) {
      keys.add(run.styleKey);
      if (!sample) sample = run;
    }
    if (keys.size <= 1) {
      return {
        uniform: true,
        styleKey: sample ? sample.styleKey : "",
        instanceKey: sample ? sample.instanceKey : "",
        openTag: sample ? sample.openTag : "",
        closeTag: sample ? sample.closeTag : "",
      };
    }
    return { uniform: false, styleKey: null };
  });
}

// Collapse consecutive items (lines or paragraphs, whatever index space
// the caller passes) sharing the same styleKey AND the same instanceKey
// into runs — instanceKey is required too so two separately-authored
// same-looking tags never get merged into one continuous tag just because
// they describe the same style.
function collapseStyleRuns(itemStyles) {
  const runs = [];
  let i = 0;
  while (i < itemStyles.length) {
    const cur = itemStyles[i];
    let j = i;
    while (
      j + 1 < itemStyles.length &&
      itemStyles[j + 1].styleKey === cur.styleKey &&
      itemStyles[j + 1].instanceKey === cur.instanceKey &&
      cur.uniform
    ) {
      j++;
    }
    runs.push({ styleKey: cur.styleKey, openTag: cur.openTag, closeTag: cur.closeTag, start: i, end: j });
    i = j + 1;
  }
  return runs;
}

// Paragraph-level style info kept specifically for the Gemini-fallback
// path, which still resolves at paragraph granularity. A paragraph mixing
// multiple line-level styles (e.g. a bold header line directly followed by
// a plain body line, both within the same paragraph) is a normal case now
// — line-level tracking (lineStyleKeys) handles it directly — so this no
// longer throws; it's marked with a unique-per-paragraph "__mixed_N__"
// placeholder key so mixed paragraphs never accidentally collapse into a
// run with each other or with anything else.
function paragraphStyleFromLines(paragraphs) {
  return paragraphs.map((lines, paragraphIndex) => {
    const keys = new Set();
    let sample = null;
    for (const line of lines) {
      for (const run of line) {
        keys.add(run.styleKey);
        if (!sample) sample = run;
      }
    }
    if (keys.size <= 1) {
      return {
        uniform: true,
        styleKey: sample ? sample.styleKey : "",
        instanceKey: sample ? sample.instanceKey : "",
        openTag: sample ? sample.openTag : "",
        closeTag: sample ? sample.closeTag : "",
      };
    }
    const placeholder = `__mixed_${paragraphIndex}__`;
    return { uniform: false, styleKey: placeholder, instanceKey: placeholder, openTag: "", closeTag: "", mixed: true };
  });
}

function isMixedStyleKey(styleKey) {
  return typeof styleKey === "string" && styleKey.startsWith("__mixed_");
}

function paragraphPlainText(lines) {
  return lines.map((line) => line.map((r) => r.text).join("")).join("\n");
}

// ---------- Excel handling ----------

// workbookSource is { type: "arraybuffer", data } for a local file upload,
// or { type: "csv", data } for a Google Sheets CSV export (the /fetch-sheet
// Worker route always returns exactly the one tab identified by gid, so
// there's no multi-sheet ambiguity to resolve on that path).
function readWorkbook(workbookSource) {
  if (workbookSource.type === "csv") {
    return XLSX.read(workbookSource.data, { type: "string" });
  }
  return XLSX.read(workbookSource.data, { type: "array" });
}

// ---------- Google Sheets URL handling ----------

function parseGoogleSheetsUrl(url) {
  const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch) {
    throw new Error(
      "That doesn't look like a Google Sheets URL — expected something like " +
        "https://docs.google.com/spreadsheets/d/<id>/edit#gid=<gid>."
    );
  }
  const gidMatch = url.match(/[#&?]gid=(\d+)/);
  return { sheetId: idMatch[1], gid: gidMatch ? gidMatch[1] : null };
}

// Google's CSV export endpoint doesn't reliably send CORS headers for a
// cross-origin browser fetch, so this goes through the Worker instead of
// calling Google directly.
async function fetchGoogleSheetCsv(sheetId, gid) {
  const resp = await fetch(`${CONFIG.workerUrl}/fetch-sheet`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-app-token": CONFIG.appToken,
    },
    body: JSON.stringify({ sheetId, gid: gid || "0" }),
  });
  if (!resp.ok) {
    let message = `Fetch-sheet request failed: ${resp.status}`;
    try {
      const body = await resp.json();
      if (body && body.error) message = body.error;
    } catch {
      // Response body wasn't JSON — keep the generic status-based message.
    }
    throw new Error(message);
  }
  const body = await resp.json();
  return body.csv;
}

function sheetToRows(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
}

function findEnColumn(headerRow) {
  for (let i = 0; i < headerRow.length; i++) {
    const h = String(headerRow[i]).trim();
    if (h === "EN" || h.toLowerCase() === "english") return i;
  }
  return -1;
}

function normalizeForMatch(s) {
  // Normalize formatting differences that can drift between the sourcecode
  // and the Excel EN column without being a real content mismatch: line
  // ending style, smart dashes, non-breaking spaces, and decorative curly
  // quotes (real sourcecode sometimes has these wrapping a heading that
  // were never copied into the Excel's plain text, added directly by
  // whoever styled the EN version) — none of that should cause a real
  // content row to be misclassified as metadata, or vice versa. Collapse
  // whitespace last so the earlier substitutions feed into one final pass.
  return s
    .replace(/\r\n|\r/g, "\n")
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/[“”"'‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Content-identity comparison: strip decorative quotes and normalize
// dashes (same as normalizeForMatch), then remove ALL whitespace rather
// than collapsing it. Paragraph/line-break position is exactly the thing
// that can legitimately differ between the sourcecode and Excel without
// being a real content difference (that's the whole reason offset-based
// row-to-line mapping exists below) — so comparisons that care about
// content identity, not layout, need whitespace out of the way entirely.
function stripAllWhitespace(s) {
  return s
    .replace(/[–—]/g, "-")
    .replace(/[“”"'‘’]/g, "")
    .replace(/\s+/g, "");
}

function identifyContentRows(rows, enColIdx, enFlatFromSourcecode) {
  // A row is "content" if its EN cell text appears (after normalization)
  // inside the flattened sourcecode text. This naturally excludes checker
  // names, proofread checkboxes, and blank rows without needing to know
  // the sheet's specific column layout. Rows with EN text that don't match
  // are returned too (excludedRows) so a content mismatch later can point
  // at exactly which row is the likely culprit instead of just two
  // numbers.
  const normalizedFlat = normalizeForMatch(enFlatFromSourcecode);
  const contentRowIndices = [];
  const excludedRows = [];
  for (let r = 1; r < rows.length; r++) {
    const cell = rows[r][enColIdx];
    if (typeof cell !== "string" || cell.trim().length === 0) continue;
    if (normalizedFlat.includes(normalizeForMatch(cell))) {
      contentRowIndices.push(r);
    } else {
      excludedRows.push({ row: r, preview: cell.slice(0, 60) });
    }
  }
  return { contentRowIndices, excludedRows };
}

// Maps each matched Excel row (in order) to the span of EN flat-lines its
// content falls within, using cumulative whitespace-stripped content
// length rather than any assumption about what character (if any)
// separates two adjacent rows in the sourcecode — that separator is a
// property of the page's markup at that specific seam (a single <br>
// within one shared paragraph, a real blank line, or nothing at all across
// a bare block boundary), not a property of the rows themselves, so no
// fixed delimiter is ever correct across different pages. Throws if the
// rows' total stripped content length doesn't exactly equal the EN lines'
// total stripped content length — a genuine content difference (a
// missing/extra word or sentence), not just formatting.
// Returns [{row, firstLineIdx, lastLineIdx, firstParaIdx, lastParaIdx, coreLen}, ...]
// per content row.
function mapRowsToLines(contentRowIndices, rows, colIdx, enFlatLines, rowLabelForError) {
  const lineTexts = enFlatLines.map((l) => l.runs.map((r) => r.text).join(""));
  const lineLens = lineTexts.map((t) => stripAllWhitespace(t).length);
  const lineCumulative = [0];
  for (const len of lineLens) lineCumulative.push(lineCumulative[lineCumulative.length - 1] + len);
  const totalLen = lineCumulative[lineCumulative.length - 1];

  function lineIndexForOffset(offset) {
    for (let i = 0; i < enFlatLines.length; i++) {
      if (offset >= lineCumulative[i] && offset < lineCumulative[i + 1]) return i;
    }
    return enFlatLines.length - 1;
  }

  const rowSpans = [];
  let cursor = 0;
  for (const r of contentRowIndices) {
    const rowText = String(rows[r][colIdx] == null ? "" : rows[r][colIdx]);
    const coreLen = stripAllWhitespace(rowText).length;
    const startOffset = cursor;
    const endOffsetExclusive = cursor + coreLen;
    const firstLineIdx = lineIndexForOffset(startOffset);
    const lastLineIdx = coreLen > 0 ? lineIndexForOffset(endOffsetExclusive - 1) : firstLineIdx;
    rowSpans.push({
      row: r,
      firstLineIdx,
      lastLineIdx,
      firstParaIdx: enFlatLines[firstLineIdx].paragraphIndex,
      lastParaIdx: enFlatLines[lastLineIdx].paragraphIndex,
      coreLen,
    });
    cursor = endOffsetExclusive;
  }

  if (cursor !== totalLen) {
    throw new Error(
      `${rowLabelForError} content length mismatch: the matched Excel rows' combined content is ${cursor} ` +
        `characters (ignoring whitespace/quotes/dash style) but the sourcecode's parsed lines total ${totalLen}. ` +
        "This is a genuine content difference (e.g. a missing or extra word/sentence), not just formatting."
    );
  }

  return rowSpans;
}

// For each consecutive pair of row spans, true if the previous row's
// content ends in the same EN paragraph the next row's content starts in
// — i.e. no block boundary separates them in the sourcecode, so their
// content must be reassembled as one continuous paragraph for every
// language. Computed once from the EN-derived rowSpans and reused
// identically for every target language, since it's a structural property
// of the page, not of any one language's translation.
function computeRowTransitionMerges(rowSpans) {
  const merges = [];
  for (let i = 0; i < rowSpans.length - 1; i++) {
    merges.push(rowSpans[i].lastParaIdx === rowSpans[i + 1].firstParaIdx);
  }
  return merges;
}

// Builds one language's paragraph/line structure directly from its own
// rows' raw text — no cross-row delimiter guessing, since each row's
// internal "\n\n" split is always reliable (a single cell, not spanning
// rows). rowTransitionMerges (from the EN-only mapping) says whether the
// transition INTO each row continues the previous row's last paragraph or
// starts fresh. Returns an array of paragraphs, each an array of
// {text, row} line objects (row = which Excel row produced that line).
function buildLineStructureFromRows(contentRowIndices, rows, colIdx, rowTransitionMerges) {
  const paragraphs = [];
  let accumulator = null; // pending paragraph (array of {text, row} lines), open across a merged row boundary

  function linesOf(text, row) {
    return text.split("\n").map((t) => ({ text: t, row }));
  }

  contentRowIndices.forEach((r, i) => {
    const rowText = String(rows[r][colIdx] == null ? "" : rows[r][colIdx]);
    const subParas = rowText.split("\n\n");
    const mergeIntoThisRow = i > 0 && rowTransitionMerges[i - 1];
    const firstSubParaLines = linesOf(subParas[0], r);

    if (mergeIntoThisRow && accumulator !== null) {
      accumulator.push(...firstSubParaLines);
    } else {
      if (accumulator !== null) paragraphs.push(accumulator);
      accumulator = [...firstSubParaLines];
    }

    // Sub-paragraphs strictly between this row's first and last are
    // complete standalone paragraphs — nothing before or after them in
    // this row shares them.
    for (let k = 1; k < subParas.length - 1; k++) {
      paragraphs.push(accumulator);
      accumulator = linesOf(subParas[k], r);
    }

    // The row's last sub-paragraph becomes the new pending accumulator,
    // staying open in case the next row's transition merges into it.
    if (subParas.length > 1) {
      paragraphs.push(accumulator);
      accumulator = linesOf(subParas[subParas.length - 1], r);
    }
  });

  if (accumulator !== null) paragraphs.push(accumulator);

  return paragraphs;
}

function paragraphsShape(paragraphs) {
  return paragraphs.map((p) => p.length);
}

function shapesMatch(shapeA, shapeB) {
  if (shapeA.length !== shapeB.length) return false;
  for (let i = 0; i < shapeA.length; i++) {
    if (shapeA[i] !== shapeB[i]) return false;
  }
  return true;
}

// For feeding the paragraph-level fallback path its expected
// plain-string-per-paragraph input.
function joinLinesToPlainText(paragraphs) {
  return paragraphs.map((lines) => lines.map((l) => l.text).join("\n"));
}

// ---------- Gemini fallback ----------

async function resolveViaGemini(styleRuns, targetParagraphTexts) {
  const resp = await fetch(`${CONFIG.workerUrl}/resolve-styles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-app-token": CONFIG.appToken,
    },
    body: JSON.stringify({
      style_runs: styleRuns.map((r) => ({
        style: r.styleKey,
        start: r.start,
        end: r.end,
      })),
      target_paragraphs: targetParagraphTexts,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Gemini proxy request failed: ${resp.status}`);
  }
  return resp.json(); // { matches: [{style, start, end, confidence}, ...] }
}

// ---------- Assembly ----------

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function linkify(text, enLinks) {
  let out = escapeHtml(text);
  for (const link of enLinks) {
    if (text.includes(link.text)) {
      const esc = escapeHtml(link.text);
      out = out.split(esc).join(
        `<a target="_blank" rel="noopener noreferrer nofollow" href="${link.href}">${esc}</a>`
      );
    }
  }
  return out;
}

function renderParagraphRange(paragraphTexts, start, end, openTag, closeTag, enLinks) {
  const rendered = paragraphTexts
    .slice(start, end + 1)
    .map((p) => p.split("\n").map((line) => linkify(line, enLinks)).join("<br>"));
  const inner = rendered.join("<br><br>");
  return `${openTag}${inner}${closeTag}`;
}

// Applies the media localization mode to one image/video src:
//   "dont-localize" — always return src unchanged.
//   "localize"      — swap "_EN." to "_{code}." when present; if the "_EN."
//                      pattern isn't found, leave src unchanged (assumes
//                      every file follows the convention).
// Best-effort: the article title lives in whichever metadata row has no
// match in the sourcecode body — the same set of rows the content-mismatch
// diagnostic above lists as EXCLUDED. It's usually the first such row, but
// occasionally a contributor-name/checker row comes first instead — there's
// no reliable structural signal to tell them apart (column layout varies,
// human error happens), so this is intentionally just a best-effort guess
// for a manual-review copy field, not something pasted into the body output
// automatically. A wrong or blank guess for one language isn't flagged
// individually — it's caught by eyeballing the field before copying it.
function extractTitle(excludedRows, rows, colIdx) {
  if (excludedRows.length === 0) return "";
  const cell = rows[excludedRows[0].row][colIdx];
  return typeof cell === "string" ? cell.trim() : "";
}

function resolveMediaSrc(src, code, mediaMode) {
  if (mediaMode === "dont-localize") return src;
  if (src.includes("_EN.")) {
    return src.replace("_EN.", `_${code}.`);
  }
  return src;
}

// Used when a target language's shape (paragraph count AND every
// paragraph's own line count) matches EN's exactly — applies EN's
// per-line style runs directly by flat-line-index, no Gemini call.
//
// ---------- Sub-phrase (mid-line) styling resolution ----------

// Sentinel markers stand in for a resolved sub-phrase's open/close tags
// while the target line text still has to pass through escapeHtml/linkify
// (inside buildLanguageOutputDirect) — splicing the real HTML tags in here
// directly would get them escaped into visible text. Private Use Area
// characters are used since real translated text can never contain them and
// escapeHtml never touches them.
function subPhraseOpenMarker(idx) {
  return `${idx}`;
}
function subPhraseCloseMarker(idx) {
  return `${idx}`;
}

// Swaps sentinel markers for the real tags they stand in for, over the
// final assembled HTML for one language. sentinelTags is the array returned
// by applySubPhraseResolution — index N's {openTag, closeTag} corresponds to
// marker index N.
function resolveSentinelMarkers(html, sentinelTags) {
  return html
    .replace(/(\d+)/g, (_, idx) => sentinelTags[Number(idx)].openTag)
    .replace(/(\d+)/g, (_, idx) => sentinelTags[Number(idx)].closeTag);
}

async function resolveSubPhraseViaGemini(items) {
  const resp = await fetch(`${CONFIG.workerUrl}/resolve-subphrase`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-app-token": CONFIG.appToken,
    },
    body: JSON.stringify({
      items: items.map((it) => ({
        id: it.id,
        context_line: it.contextText,
        styled_text: it.styledText,
        target_text: it.targetText,
      })),
    }),
  });
  if (!resp.ok) {
    throw new Error(`Gemini proxy request failed: ${resp.status}`);
  }
  return resp.json(); // { matches: [{id, target_text, confidence}, ...] }
}

// Resolves genuine mid-line (sub-phrase) styling: a line that mixes multiple
// styles WITHIN itself (e.g. a plain lead-in immediately followed by a bold
// clause, no line break between) has no structural anchor to place the
// equivalent styling in translated text — word order and phrasing differ
// too much across languages for offset-based matching to work here, so this
// asks Gemini directly, one task per non-plain run on the line. Only usable
// on the direct (line-shape-matched) path, where each EN line maps to
// exactly one known target line, giving Gemini an unambiguous per-task
// search space; a mixed line inside a paragraph that needs the Gemini
// paragraph-range fallback instead stays on the existing "__mixed_" plain
// text + flag behavior, since that path doesn't resolve a single target line
// at all.
//
// Mutates targetFlatLineTexts in place, splicing sentinel markers (not real
// tags) around each resolved substring. Returns the sentinelTags array the
// caller must pass into resolveSentinelMarkers() over the final assembled
// HTML.
async function applySubPhraseResolution(code, targetFlatLineTexts, subPhraseTasksByFlatLine, flagsOut) {
  const items = [];
  for (const [flatLineIndex, entry] of subPhraseTasksByFlatLine) {
    entry.tasks.forEach((task, taskIndex) => {
      items.push({
        id: `${flatLineIndex}:${taskIndex}`,
        contextText: entry.contextText,
        styledText: task.text,
        targetText: targetFlatLineTexts[flatLineIndex],
      });
    });
  }
  if (items.length === 0) return [];

  let matches = [];
  try {
    const result = await resolveSubPhraseViaGemini(items);
    matches = result.matches || [];
  } catch (e) {
    flagsOut.push(`${code}: sub-phrase styling resolution failed (${e.message}) — left unstyled and flagged inline.`);
  }
  const matchById = new Map(matches.map((m) => [m.id, m]));

  const sentinelTags = [];
  for (const [flatLineIndex, entry] of subPhraseTasksByFlatLine) {
    let lineText = targetFlatLineTexts[flatLineIndex];
    entry.tasks.forEach((task, taskIndex) => {
      const id = `${flatLineIndex}:${taskIndex}`;
      const m = matchById.get(id);
      if (!m || m.confidence === "low" || !m.target_text || !lineText.includes(m.target_text)) {
        flagsOut.push(
          `${code}: could not confidently place "${task.styleKey}" sub-phrase styling — left unstyled and flagged inline.`
        );
        return;
      }
      const idx = sentinelTags.length;
      sentinelTags.push({ openTag: task.openTag, closeTag: task.closeTag });
      lineText = lineText.replace(
        m.target_text,
        `${subPhraseOpenMarker(idx)}${m.target_text}${subPhraseCloseMarker(idx)}`
      );
    });
    targetFlatLineTexts[flatLineIndex] = lineText;
  }
  return sentinelTags;
}

// Processes lines in a single sequential pass (not paragraph-outer/
// segment-inner, and not segment-outer either — both were tried and both
// had real bugs). This is what correctly handles both: (a) one continuous
// style run legitimately spanning multiple paragraphs (open/close the tag
// exactly once, with "<br><br>" inserted inside it at the paragraph
// boundary), and (b) media sitting between two paragraphs that are part of
// the same otherwise-continuous style run (splits the tag around the media
// correctly — a tag can't wrap a block-level media element in the middle,
// so the style continuing after the media gets a fresh tag instance).
function buildLanguageOutputDirect(code, targetFlatLineTexts, enFlatLines, enLineStyleRuns, enLinks, mediaInsertions, mediaMode, flagsOut) {
  const segments = [];
  let cursor = 0;
  for (const run of enLineStyleRuns) {
    if (run.start > cursor) {
      segments.push({ styleKey: "", openTag: "", closeTag: "", start: cursor, end: run.start - 1 });
    }
    segments.push(run);
    cursor = run.end + 1;
  }
  if (cursor < targetFlatLineTexts.length) {
    segments.push({ styleKey: "", openTag: "", closeTag: "", start: cursor, end: targetFlatLineTexts.length - 1 });
  }

  const segmentForLine = new Array(targetFlatLineTexts.length);
  segments.forEach((seg, segIdx) => {
    for (let i = seg.start; i <= seg.end; i++) segmentForLine[i] = segIdx;
  });

  const totalParagraphCount = enFlatLines.length > 0 ? enFlatLines[enFlatLines.length - 1].paragraphIndex + 1 : 0;

  const sortedMedia = [...mediaInsertions].sort((a, b) => a.beforeParagraphIndex - b.beforeParagraphIndex);
  let mediaCursor = 0;

  function mediaBlocksBefore(paragraphIndex) {
    const blocks = [];
    while (mediaCursor < sortedMedia.length && sortedMedia[mediaCursor].beforeParagraphIndex <= paragraphIndex) {
      const m = sortedMedia[mediaCursor];
      // No src (e.g. <hr>) means nothing to localize — reproduce verbatim
      // instead of calling resolveMediaSrc.
      const html = m.src ? m.outerHTML.split(m.src).join(resolveMediaSrc(m.src, code, mediaMode)) : m.outerHTML;
      blocks.push({ type: "media", html });
      mediaCursor++;
    }
    return blocks;
  }

  const blocks = [];
  let currentPParts = "";
  let openSegIdx = null;
  let prevLineIdx = null;

  function closeOpenTag() {
    if (openSegIdx !== null) {
      currentPParts += segments[openSegIdx].closeTag;
      openSegIdx = null;
    }
  }

  function flushP() {
    closeOpenTag();
    if (currentPParts.length > 0) {
      blocks.push({ type: "p", html: `<p>${currentPParts}</p>` });
    }
    currentPParts = "";
  }

  for (let i = 0; i < targetFlatLineTexts.length; i++) {
    const paragraphIndex = enFlatLines[i].paragraphIndex;
    const isFirstLineOfParagraph = enFlatLines[i].lineIndexInParagraph === 0;

    if (isFirstLineOfParagraph) {
      const media = mediaBlocksBefore(paragraphIndex);
      if (media.length > 0) {
        flushP();
        blocks.push(...media);
        prevLineIdx = null;
      }
    }

    const segIdx = segmentForLine[i];
    const sameParagraphAsPrev = prevLineIdx !== null && enFlatLines[prevLineIdx].paragraphIndex === paragraphIndex;
    const separator = prevLineIdx === null ? "" : sameParagraphAsPrev ? "<br>" : "<br><br>";

    if (segIdx !== openSegIdx) {
      closeOpenTag();
      currentPParts += separator + segments[segIdx].openTag;
      openSegIdx = segIdx;
    } else {
      currentPParts += separator;
    }

    currentPParts += linkify(targetFlatLineTexts[i], enLinks);
    prevLineIdx = i;
  }

  flushP();
  blocks.push(...mediaBlocksBefore(totalParagraphCount));

  return blocks;
}

// Used when a target language's shape doesn't match EN's — resolves via
// Gemini at paragraph-range granularity (same gap-filling, same
// media-anchoring-off-style-runs logic as before line-level tracking
// existed), since Gemini can't be asked to reason about arbitrary
// per-line structure it's never seen.
async function buildLanguageOutputFallback(code, targetParagraphTexts, enStyleRuns, enLinks, mediaInsertions, mediaMode, flagsOut) {
  const enParagraphCount = enStyleRuns.reduce((max, r) => Math.max(max, r.end), 0) + 1;
  const directMapping = targetParagraphTexts.length === enParagraphCount;

  let assignedRuns; // [{styleKey, openTag, closeTag, start, end}] in target-paragraph index space

  if (directMapping) {
    assignedRuns = enStyleRuns.map((r) => ({ ...r }));
  } else {
    // Ask Gemini to resolve paragraph-range boundaries by meaning. Plain
    // (unstyled) runs don't need resolving — they're inferred as gaps below.
    const nonPlainRuns = enStyleRuns.filter((r) => r.styleKey !== "");
    let matches = [];
    try {
      const result = await resolveViaGemini(nonPlainRuns, targetParagraphTexts);
      matches = result.matches || [];
    } catch (e) {
      flagsOut.push(`${code}: Gemini fallback failed (${e.message}) — all styling flagged for manual review.`);
    }

    assignedRuns = [];
    for (const run of nonPlainRuns) {
      const m = matches.find((x) => x.style === run.styleKey);
      if (!m || m.confidence === "low") {
        // A paragraph mixing multiple line-level styles in EN gets its own
        // more specific flag below (once/if it's actually placed) — avoid
        // double-flagging the same paragraph here.
        if (!isMixedStyleKey(run.styleKey)) {
          flagsOut.push(
            `${code}: could not confidently place "${run.styleKey}" styling — left unstyled and flagged inline.`
          );
        }
        continue;
      }
      assignedRuns.push({ ...run, start: m.start, end: m.end });
    }
  }

  // Fill gaps between assigned runs with plain (unstyled) ranges, covering
  // every target paragraph.
  assignedRuns.sort((a, b) => a.start - b.start);
  const segments = [];
  let cursor = 0;
  for (const run of assignedRuns) {
    if (run.start > cursor) {
      segments.push({ styleKey: "", openTag: "", closeTag: "", start: cursor, end: run.start - 1 });
    }
    segments.push(run);
    cursor = run.end + 1;
  }
  if (cursor < targetParagraphTexts.length) {
    segments.push({ styleKey: "", openTag: "", closeTag: "", start: cursor, end: targetParagraphTexts.length - 1 });
  }

  // A paragraph that mixes multiple line-level styles in EN can't be
  // safely styled at paragraph granularity even once Gemini has placed it
  // — we know WHICH target paragraph it corresponds to, but not which of
  // ITS lines should get which style. Render as plain text and flag for
  // manual review rather than emitting the "__mixed_N__" placeholder as if
  // it were a real tag.
  for (const seg of segments) {
    if (isMixedStyleKey(seg.styleKey)) {
      flagsOut.push(
        `${code}: paragraph has multiple line-level styles in EN, but this language's shape didn't match EN's — rendered as plain text, please check and style manually.`
      );
      seg.styleKey = "";
      seg.openTag = "";
      seg.closeTag = "";
    }
  }

  // Resolve each media insertion's position in TARGET paragraph space.
  // Anchor off the EN style run whose boundary it sits on (immediately
  // before that run starts, or immediately after it ends) — this holds up
  // even when paragraph counts differ, because style runs are the same
  // thing Gemini already resolved. If no run boundary anchors it (media
  // sitting in the middle of a long plain stretch), fall back to a
  // proportional estimate and flag it for a manual placement check.
  const resolvedMedia = mediaInsertions.map((m) => {
    if (directMapping) return { ...m, targetIndex: m.beforeParagraphIndex };

    // A media item can sit at a boundary that's simultaneously the end of
    // one run and the start of another (e.g. a plain stretch immediately
    // followed by a styled paragraph). Plain runs never get an explicit
    // assignedRuns entry (they're inferred later as gaps), so anchoring off
    // the plain side alone would always fail here even when the other side
    // of the same boundary is a real, resolved run — try both sides and use
    // whichever one actually resolved, instead of committing to just one.
    const afterRun = enStyleRuns.find((r) => r.end + 1 === m.beforeParagraphIndex);
    const beforeRun = enStyleRuns.find((r) => r.start === m.beforeParagraphIndex);
    const afterAssigned = afterRun && assignedRuns.find((r) => r.styleKey === afterRun.styleKey);
    const beforeAssigned = beforeRun && assignedRuns.find((r) => r.styleKey === beforeRun.styleKey);

    if (afterAssigned) {
      return { ...m, targetIndex: afterAssigned.end + 1 };
    }
    if (beforeAssigned) {
      return { ...m, targetIndex: beforeAssigned.start };
    }

    flagsOut.push(`${code}: image/video position estimated (no exact style-run anchor found) — please verify placement.`);
    const ratio = m.beforeParagraphIndex / enParagraphCount;
    return { ...m, targetIndex: Math.round(ratio * targetParagraphTexts.length) };
  });

  // Render segments, splicing in media tags at their resolved positions.
  // Media are block-level siblings, not inline content, so they split the
  // surrounding text into separate <p> blocks rather than nesting inside one
  // — this returns an ordered list of top-level blocks
  // ({type:'p', html} | {type:'media', html}) for the caller to join.
  let mediaCursor = 0;
  const sortedMedia = [...resolvedMedia].sort((a, b) => a.targetIndex - b.targetIndex);

  function mediaBlocksBefore(paragraphIndex) {
    const blocks = [];
    while (mediaCursor < sortedMedia.length && sortedMedia[mediaCursor].targetIndex <= paragraphIndex) {
      const m = sortedMedia[mediaCursor];
      // No src (e.g. <hr>) means nothing to localize — reproduce verbatim
      // instead of calling resolveMediaSrc. Otherwise split/join instead of
      // replace() since src typically also appears in an alt="" attribute
      // and both should be swapped.
      const html = m.src ? m.outerHTML.split(m.src).join(resolveMediaSrc(m.src, code, mediaMode)) : m.outerHTML;
      blocks.push({ type: "media", html });
      mediaCursor++;
    }
    return blocks;
  }

  const blocks = [];
  let currentPParts = [];
  function flushP() {
    if (currentPParts.length > 0) {
      blocks.push({ type: "p", html: `<p>${currentPParts.join("<br><br>")}</p>` });
      currentPParts = [];
    }
  }

  for (const seg of segments) {
    const media = mediaBlocksBefore(seg.start);
    if (media.length > 0) {
      flushP();
      blocks.push(...media);
    }
    currentPParts.push(renderParagraphRange(targetParagraphTexts, seg.start, seg.end, seg.openTag, seg.closeTag, enLinks));
  }
  flushP();
  blocks.push(...mediaBlocksBefore(targetParagraphTexts.length)); // any trailing media

  return blocks;
}

// ---------- Top-level orchestration ----------

async function runPipeline(enSourcecode, workbookSource, sheetName, onProgress, mediaMode = "localize") {
  const lookup = await loadLanguageLookup();
  const mutationMap = buildMutationMap(lookup);

  const wb = readWorkbook(workbookSource);
  const sheet = wb.Sheets[sheetName || wb.SheetNames[0]];
  const rows = sheetToRows(sheet);
  const headerRow = rows[0];
  const enColIdx = findEnColumn(headerRow);
  if (enColIdx === -1) throw new Error("Could not find an EN column in the sheet header row.");

  const tokens = tokenizeSourcecode(enSourcecode);
  const enFlat = flattenTokens(tokens);

  const { contentRowIndices, excludedRows } = identifyContentRows(rows, enColIdx, enFlat);
  if (contentRowIndices.length === 0) {
    throw new Error("No Excel rows matched the sourcecode — check the sheet and sourcecode are for the same page.");
  }

  const { paragraphs: enParagraphs, mediaInsertions } = buildStructure(tokens);

  const enFlatLines = flattenToLines(enParagraphs);
  const enLineStyles = lineStyleKeys(enFlatLines);

  // A line that mixes multiple styles WITHIN itself (genuine mid-sentence /
  // sub-phrase styling — different styling on PART of one line, not just
  // different lines within a paragraph, which collapseStyleRuns already
  // handles) has no structural anchor to place in translated text — so it's
  // resolved per language via applySubPhraseResolution (Gemini) rather than
  // thrown as an error. Extract each of the line's non-plain runs as a task,
  // then treat the line as plain for the rest of this function; the correct
  // tags get spliced back in once each language's own line text is known.
  const subPhraseTasksByFlatLine = new Map();
  const sanitizedLineStyles = enLineStyles.map((s, i) => {
    if (s.uniform) return s;
    const line = enFlatLines[i];
    const tasks = line.runs
      .filter((r) => r.styleKey !== "")
      .map((r) => ({ text: r.text, styleKey: r.styleKey, openTag: r.openTag, closeTag: r.closeTag }));
    if (tasks.length > 0) {
      subPhraseTasksByFlatLine.set(i, { contextText: line.runs.map((r) => r.text).join(""), tasks });
    }
    return { uniform: true, styleKey: "", instanceKey: "", openTag: "", closeTag: "" };
  });
  const enLineStyleRuns = collapseStyleRuns(sanitizedLineStyles);

  const enParagraphStyles = paragraphStyleFromLines(enParagraphs);
  const enStyleRuns = collapseStyleRuns(enParagraphStyles);
  const enParagraphTexts = enParagraphs.map(paragraphPlainText);
  const enShape = paragraphsShape(enParagraphs);

  // Map each matched Excel row to the EN lines its content falls within,
  // by content length rather than any assumption about what separates two
  // adjacent rows in the sourcecode (see the file-level comment above). A
  // thrown error here means a genuine content difference, not just
  // formatting — append the same included/excluded row diagnostic the old
  // paragraph-count check used, so whoever hits this can still see
  // exactly which row is the problem.
  let rowSpans;
  try {
    rowSpans = mapRowsToLines(contentRowIndices, rows, enColIdx, enFlatLines, "EN");
  } catch (e) {
    const contentLines = contentRowIndices
      .map((r) => `  CONTENT row ${r + 1}: "${String(rows[r][enColIdx]).slice(0, 60)}"`)
      .join("\n");
    const excludedLines = excludedRows
      .map((x) => `  EXCLUDED row ${x.row + 1}: "${x.preview}"`)
      .join("\n");
    throw new Error(
      `${e.message}\n\n` +
        `Rows classified as CONTENT:\n${contentLines || "  (none)"}\n\n` +
        `Rows classified as EXCLUDED (had EN text, but it wasn't found in the sourcecode):\n${excludedLines || "  (none)"}\n\n` +
        "Likely cause: a real content row was wrongly excluded (formatting drift between the sourcecode and the sheet), " +
        "or a metadata row was wrongly included (its text happens to overlap with the sourcecode). Check the rows above."
    );
  }
  const rowTransitionMerges = computeRowTransitionMerges(rowSpans);

  const enLinks = [];
  for (const p of enParagraphs) {
    for (const line of p) {
      for (const run of line) {
        if (run.linkHref) enLinks.push({ text: run.text, href: run.linkHref });
      }
    }
  }

  const flags = [];
  const outputs = {};
  const titles = {};

  if (excludedRows.length === 0) {
    flags.push("No title row found in sheet (no rows were excluded from the body match) — title fields left blank.");
  }

  for (const lang of lookup.languages) {
    if (lang.code === "EN") continue;
    let colIdx = -1;
    for (let i = 0; i < headerRow.length; i++) {
      const h = String(headerRow[i]).trim();
      if (mutationMap.get(h) === lang.code) {
        colIdx = i;
        break;
      }
    }
    if (colIdx === -1) {
      flags.push(`${lang.code}: no matching column found in sheet — skipped.`);
      continue;
    }

    onProgress && onProgress(`Processing ${lang.code}...`);

    titles[lang.code] = extractTitle(excludedRows, rows, colIdx);

    // Rebuilt directly from this language's own row text, applying the
    // same merge/fresh-break pattern EN's rows established at each row
    // boundary — no delimiter guessing between rows.
    const targetParagraphs = buildLineStructureFromRows(contentRowIndices, rows, colIdx, rowTransitionMerges);
    const targetShape = paragraphsShape(targetParagraphs);

    // Each block is already a complete <p>...</p> or media element; joined
    // as siblings below. No leading empty <p></p><p></p> spacer is assumed
    // here — that was specific to the validated test page's own layout, not
    // a general rule, so it isn't reproduced automatically.
    if (shapesMatch(targetShape, enShape)) {
      const targetFlatLineTexts = targetParagraphs.flatMap((p) => p.map((l) => l.text));
      const sentinelTags =
        subPhraseTasksByFlatLine.size > 0
          ? await applySubPhraseResolution(lang.code, targetFlatLineTexts, subPhraseTasksByFlatLine, flags)
          : [];
      const blocks = buildLanguageOutputDirect(
        lang.code,
        targetFlatLineTexts,
        enFlatLines,
        enLineStyleRuns,
        enLinks,
        mediaInsertions,
        mediaMode || "localize",
        flags
      );
      outputs[lang.code] = resolveSentinelMarkers(blocks.map((b) => b.html).join(""), sentinelTags);
    } else {
      const targetParagraphTexts = joinLinesToPlainText(targetParagraphs);
      const blocks = await buildLanguageOutputFallback(
        lang.code,
        targetParagraphTexts,
        enStyleRuns,
        enLinks,
        mediaInsertions,
        mediaMode || "localize",
        flags
      );
      outputs[lang.code] = blocks.map((b) => b.html).join("");
    }
  }

  return { outputs, titles, flags };
}

window.wiki14 = {
  runPipeline,
  parseGoogleSheetsUrl,
  fetchGoogleSheetCsv,
  // Exposed for debugging/testing in the browser console.
  _internal: {
    tokenizeSourcecode,
    flattenTokens,
    buildStructure,
    flattenToLines,
    lineStyleKeys,
    paragraphStyleFromLines,
    collapseStyleRuns,
    paragraphPlainText,
    stripAllWhitespace,
    extractTitle,
    mapRowsToLines,
    computeRowTransitionMerges,
    buildLineStructureFromRows,
    paragraphsShape,
    shapesMatch,
    joinLinesToPlainText,
    isMixedStyleKey,
    subPhraseOpenMarker,
    subPhraseCloseMarker,
    resolveSentinelMarkers,
    applySubPhraseResolution,
  },
};
