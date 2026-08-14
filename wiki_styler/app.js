// wiki14 — client-side pipeline
//
// Mirrors the algorithm validated by hand against a real wiki page:
//   1. Flatten EN sourcecode (DOM walk, <br> -> \n) and diff against the
//      EN Excel column (rows joined by single \n) to confirm alignment
//      and to identify + exclude metadata rows.
//   2. Split the flattened EN text into paragraphs (\n\n) and record which
//      style wraps each paragraph (and where images/links sit).
//   3. For each target language: flatten + split the same way.
//      - Paragraph count matches EN -> apply the style map directly.
//      - Paragraph count doesn't match -> ask the Gemini proxy to resolve
//        paragraph-range boundaries per styled section.
//   4. Reassemble HTML, merging consecutive same-style paragraphs into a
//      single continuous tag (matching how the EN source itself is written).
//
// Known limitation (unchanged from the manual process): this only handles
// styling that is uniform across whole paragraphs / paragraph ranges. Genuine
// mid-sentence (sub-phrase) styling isn't handled by this tool yet — if you
// hit that on a real page, treat it as a signal to extend this, not to trust
// a silent guess.

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

  function styleKeyFor(stack) {
    return stack
      .map((s) => (s.attr ? `${s.tag}[${s.attr}]` : s.tag))
      .join(">");
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
          const entry = { tag: "span", attr: style, openTag: `<span style="${style}">`, closeTag: "</span>" };
          walk(child, [...stack, entry], linkHref);
        } else if (tag === "strong" || tag === "s" || tag === "em" || tag === "u") {
          const entry = { tag, attr: null, openTag: `<${tag}>`, closeTag: `</${tag}>` };
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
  const paragraphs = []; // array of lines; each line = array of {text, styleKey, openTag, closeTag, linkHref}
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

// Per-paragraph style: the styleKey shared by every line/run in that
// paragraph, if uniform; otherwise null (mixed / mid-sentence styling,
// which this tool doesn't attempt to auto-resolve).
function paragraphStyleKeys(paragraphs) {
  return paragraphs.map((lines) => {
    const keys = new Set();
    let sample = null;
    for (const line of lines) {
      for (const run of line) {
        keys.add(run.styleKey);
        if (!sample) sample = run;
      }
    }
    if (keys.size === 1) return { uniform: true, styleKey: sample.styleKey, openTag: sample.openTag, closeTag: sample.closeTag };
    return { uniform: false, styleKey: null };
  });
}

// Collapse consecutive paragraphs sharing the same styleKey into runs, e.g.
// paragraphs [3,4,5] all "red" become one run {styleKey:"red", start:3, end:5}.
function collapseStyleRuns(paraStyles) {
  const runs = [];
  let i = 0;
  while (i < paraStyles.length) {
    const cur = paraStyles[i];
    let j = i;
    while (j + 1 < paraStyles.length && paraStyles[j + 1].styleKey === cur.styleKey && cur.uniform) {
      j++;
    }
    runs.push({ styleKey: cur.styleKey, openTag: cur.openTag, closeTag: cur.closeTag, start: i, end: j });
    i = j + 1;
  }
  return runs;
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
  // Strip typographic quote marks and collapse whitespace before checking
  // containment. Real sourcecode sometimes has decorative curly quotes
  // around a heading that were never copied into the Excel's plain text
  // (cosmetic, added directly by whoever styled the EN version) — that
  // shouldn't cause a real content row to be misclassified as metadata.
  return s.replace(/[“”"'‘’]/g, "").replace(/\s+/g, " ").trim();
}

function identifyContentRows(rows, enColIdx, enFlatFromSourcecode) {
  // A row is "content" if its EN cell text appears (after normalization)
  // inside the flattened sourcecode text. This naturally excludes checker
  // names, proofread checkboxes, and blank rows without needing to know
  // the sheet's specific column layout.
  const normalizedFlat = normalizeForMatch(enFlatFromSourcecode);
  const contentRowIndices = [];
  for (let r = 1; r < rows.length; r++) {
    const cell = rows[r][enColIdx];
    if (typeof cell !== "string" || cell.trim().length === 0) continue;
    if (normalizedFlat.includes(normalizeForMatch(cell))) {
      contentRowIndices.push(r);
    }
  }
  return contentRowIndices;
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
//   "dont-localize"      — always return src unchanged.
//   "localize"           — swap "_EN." to "_{code}." when present; if the
//                           "_EN." pattern isn't found, leave src unchanged
//                           silently (assumes every file follows the
//                           convention, so a miss isn't worth flagging).
//   "localize-if-suffix" — same swap-if-present behavior, but a miss gets
//                           flagged so a mixed page (some assets
//                           per-language, some shared) stays visible
//                           instead of silently passing through either way.
function resolveMediaSrc(src, code, mediaMode, flagsOut, langCode) {
  if (mediaMode === "dont-localize") return src;
  if (src.includes("_EN.")) {
    return src.replace("_EN.", `_${code}.`);
  }
  if (mediaMode === "localize-if-suffix") {
    flagsOut.push(
      `${langCode}: media file "${src}" has no "_EN." naming pattern — left as-is (mode: localize only if suffix exists).`
    );
  }
  return src;
}

async function buildLanguageOutput(code, targetParagraphTexts, enStyleRuns, enLinks, mediaInsertions, flagsOut, mediaMode = "localize") {
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
        flagsOut.push(
          `${code}: could not confidently place "${run.styleKey}" styling — left unstyled and flagged inline.`
        );
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

  // Resolve each media insertion's position in TARGET paragraph space.
  // Anchor off the EN style run whose boundary it sits on (immediately
  // before that run starts, or immediately after it ends) — this holds up
  // even when paragraph counts differ, because style runs are the same
  // thing Gemini already resolved. If no run boundary anchors it (media
  // sitting in the middle of a long plain stretch), fall back to a
  // proportional estimate and flag it for a manual placement check.
  const resolvedMedia = mediaInsertions.map((m) => {
    if (directMapping) return { ...m, targetIndex: m.beforeParagraphIndex };

    const afterRun = enStyleRuns.find((r) => r.end + 1 === m.beforeParagraphIndex);
    const beforeRun = enStyleRuns.find((r) => r.start === m.beforeParagraphIndex);
    const anchorRun = afterRun || beforeRun;
    const assigned = anchorRun && assignedRuns.find((r) => r.styleKey === anchorRun.styleKey);

    if (assigned) {
      const targetIndex = afterRun ? assigned.end + 1 : assigned.start;
      return { ...m, targetIndex };
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
      const swappedSrc = resolveMediaSrc(m.src, code, mediaMode, flagsOut, code);
      // split/join instead of replace() since src typically also appears
      // in an alt="" attribute and both should be swapped.
      const html = m.src ? m.outerHTML.split(m.src).join(swappedSrc) : m.outerHTML;
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

  const contentRowIndices = identifyContentRows(rows, enColIdx, enFlat);
  if (contentRowIndices.length === 0) {
    throw new Error("No Excel rows matched the sourcecode — check the sheet and sourcecode are for the same page.");
  }

  // Validate: EN rows joined by \n should match the flattened sourcecode.
  // We check paragraph COUNT/boundaries rather than raw character equality,
  // because real pages can have decorative punctuation in the sourcecode
  // (curly quotes wrapping a heading, etc.) added directly by whoever
  // styled the EN version, which was never copied into the Excel's plain
  // text. That's cosmetic and doesn't affect paragraph structure — but a
  // genuine paragraph-count mismatch means something real is wrong (a
  // metadata row miscategorized as content, sheet/sourcecode out of sync,
  // etc.) and should stop the pipeline rather than guess past it.
  const enRowsFlat = contentRowIndices.map((r) => String(rows[r][enColIdx])).join("\n");
  const sourceParagraphCount = enFlat.split("\n\n").length;
  const excelParagraphCount = enRowsFlat.split("\n\n").length;
  if (sourceParagraphCount !== excelParagraphCount) {
    throw new Error(
      `Flatten-and-diff check failed: the EN sourcecode implies ${sourceParagraphCount} paragraphs but the ` +
        `EN Excel content implies ${excelParagraphCount}. This usually means a metadata row was miscategorized ` +
        "as content, or the sourcecode/sheet are out of sync. Not proceeding automatically — please check the two inputs match."
    );
  }
  if (enRowsFlat !== enFlat) {
    console.warn(
      "wiki14: EN sourcecode text has minor character differences from the Excel EN column " +
        "(often decorative punctuation not present in the sheet) — paragraph structure still lines up, proceeding."
    );
  }

  const { paragraphs: enParagraphs, mediaInsertions } = buildStructure(tokens);
  const paraStyles = paragraphStyleKeys(enParagraphs);
  const mixedParagraphs = paraStyles
    .map((s, i) => (s.uniform ? null : i))
    .filter((i) => i !== null);
  if (mixedParagraphs.length > 0) {
    throw new Error(
      `Paragraph(s) ${mixedParagraphs.join(", ")} contain mixed styling within a single paragraph ` +
        `(likely genuine mid-sentence / sub-phrase styling). This tool doesn't auto-resolve that case yet — ` +
        `see the SKILL.md notes on sub-phrase matching for the manual approach.`
    );
  }
  const enStyleRuns = collapseStyleRuns(paraStyles);

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

    const targetFlat = contentRowIndices.map((r) => String(rows[r][colIdx])).join("\n");
    const targetParagraphTexts = targetFlat.split("\n\n");

    const blocks = await buildLanguageOutput(
      lang.code,
      targetParagraphTexts,
      enStyleRuns,
      enLinks,
      mediaInsertions,
      flags,
      mediaMode
    );

    // Each block is already a complete <p>...</p> or media element;
    // join them as siblings. No leading empty <p></p><p></p> spacer is
    // assumed here — that was specific to the validated test page's own
    // layout, not a general rule, so it isn't reproduced automatically.
    outputs[lang.code] = blocks.map((b) => b.html).join("");
  }

  return { outputs, flags };
}

window.wiki14 = {
  runPipeline,
  parseGoogleSheetsUrl,
  fetchGoogleSheetCsv,
  // Exposed for debugging/testing in the browser console.
  _internal: { tokenizeSourcecode, flattenTokens, buildStructure, paragraphStyleKeys, collapseStyleRuns, paragraphPlainText },
};
