(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Fallback copy of data/language-lookup.json, used only if the fetch of
  // the real file fails (e.g. when the page is opened via file:// during
  // local testing). On GitHub Pages the fetch always succeeds and this is
  // never used, so data/language-lookup.json remains the single source of
  // truth.
  // ---------------------------------------------------------------------
  const EMBEDDED_LOOKUP_FALLBACK = {
    "ignored_languages": [
      { "name": "Chinese (Simplified)", "mutations": ["CN", "简体", "简体中文"] }
    ],
    "languages": [
      { "name": "English", "code": "EN", "mutations": ["EN", "English"] },
      { "name": "Chinese (Traditional)", "code": "TW", "mutations": ["TW", "zh_TW", "繁體中文", "繁體", "繁体中文"] },
      { "name": "Korean", "code": "KR", "mutations": ["KR", "ko", "KO", "한국어"] },
      { "name": "Japanese", "code": "JP", "mutations": ["JP", "ja", "jp", "日本語"] },
      { "name": "Arabic", "code": "AR", "mutations": ["AR", "ar", "Arab", "AH", "العربية"] },
      { "name": "German", "code": "DE", "mutations": ["DE", "de", "DH", "Deutsch"] },
      { "name": "Spanish", "code": "ES", "mutations": ["ES", "es", "ESP", "esp", "Español"] },
      { "name": "French", "code": "FR", "mutations": ["FR", "fr", "Français"] },
      { "name": "Indonesian", "code": "ID", "mutations": ["ID", "id", "IN", "Bahasa Indonesia"] },
      { "name": "Italian", "code": "IT", "mutations": ["IT", "it", "Italiano"] },
      { "name": "Portuguese", "code": "PT", "mutations": ["PT", "PTG", "Português"] },
      { "name": "Thai", "code": "TH", "mutations": ["TH", "th", "ภาษาไทย"] },
      { "name": "Turkish", "code": "TR", "mutations": ["TR", "tr", "TRK", "Türkçe"] },
      { "name": "Vietnamese", "code": "VN", "mutations": ["VN", "vi", "VET", "VIET", "Tiếng Việt"] }
    ]
  };

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const state = {
    lookup: null,
    lookupIndex: null,
    targetLanguages: null,
    workbook: null,
    fileName: ''
  };

  const els = {};

  // ---------------------------------------------------------------------
  // Language lookup helpers
  // ---------------------------------------------------------------------
  function normalizeHeaderKey(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  function buildLookupIndex(lookup) {
    const map = new Map();
    lookup.languages.forEach(function (lang) {
      lang.mutations.forEach(function (m) {
        const key = normalizeHeaderKey(m);
        if (key && !map.has(key)) map.set(key, { type: 'lang', code: lang.code, name: lang.name });
      });
    });
    (lookup.ignored_languages || []).forEach(function (lang) {
      lang.mutations.forEach(function (m) {
        const key = normalizeHeaderKey(m);
        if (key && !map.has(key)) map.set(key, { type: 'ignored', name: lang.name });
      });
    });
    return map;
  }

  async function loadLookup() {
    try {
      const res = await fetch('data/language-lookup.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      console.warn('Falling back to embedded language lookup (fetch failed):', e);
      return EMBEDDED_LOOKUP_FALLBACK;
    }
  }

  // ---------------------------------------------------------------------
  // Excel parsing: header row + column detection, content row extraction
  // ---------------------------------------------------------------------
  function detectHeaderRow(matrix, lookupIndex) {
    const maxScan = Math.min(matrix.length, 10);
    let best = { rowIdx: -1, score: 0 };
    for (let r = 0; r < maxScan; r++) {
      const row = matrix[r] || [];
      let score = 0;
      row.forEach(function (cell) {
        const key = normalizeHeaderKey(cell);
        if (key && lookupIndex.has(key)) score++;
      });
      if (score > best.score) best = { rowIdx: r, score: score };
    }
    return best.score >= 3 ? best.rowIdx : -1;
  }

  function buildColumnMap(matrix, headerRowIdx, lookupIndex) {
    const headerRow = matrix[headerRowIdx] || [];
    return headerRow.map(function (cell) {
      const key = normalizeHeaderKey(cell);
      const hit = lookupIndex.get(key);
      return hit ? hit : { type: 'other' };
    });
  }

  function extractContentRows(matrix, headerRowIdx, columnMap) {
    const langCols = [];
    const otherCols = [];
    columnMap.forEach(function (c, idx) {
      if (c.type === 'lang') langCols.push(idx);
      else if (c.type === 'other') otherCols.push(idx);
    });
    const rows = [];
    for (let r = headerRowIdx + 1; r < matrix.length; r++) {
      const row = matrix[r] || [];
      const anyLangContent = langCols.some(function (i) { return String(row[i] || '').trim() !== ''; });
      if (!anyLangContent) continue;
      const isMeta = otherCols.some(function (i) { return /checker|proofread/i.test(String(row[i] || '')); });
      if (isMeta) continue;
      const cells = {};
      langCols.forEach(function (i) {
        cells[columnMap[i].code] = String(row[i] !== undefined ? row[i] : '');
      });
      rows.push({ rowIndex: r, cells: cells });
    }
    return rows;
  }

  // ---------------------------------------------------------------------
  // EN sourcecode parsing: top-level blocks -> <br>-bounded segments
  // ---------------------------------------------------------------------
  function getAttrString(el) {
    return Array.prototype.map.call(el.attributes, function (a) {
      return a.name + '="' + String(a.value).replace(/"/g, '&quot;') + '"';
    }).join(' ');
  }

  function isMediaOnlyElement(node) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'img' || tag === 'video') return true;
    let hasOtherContent = false;
    Array.prototype.forEach.call(node.childNodes, function (c) {
      if (c.nodeType === Node.TEXT_NODE) {
        if (c.textContent.trim() !== '') hasOtherContent = true;
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        const t = c.tagName.toLowerCase();
        if (t !== 'img' && t !== 'video') hasOtherContent = true;
      }
    });
    if (hasOtherContent) return false;
    return !!(node.querySelector && node.querySelector('img, video'));
  }

  function extractSegments(rootNode) {
    const segments = [];
    let current = [];
    function pushBreak() {
      segments.push(current);
      current = [];
    }
    function walk(node, tagStack) {
      Array.prototype.forEach.call(node.childNodes, function (child) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.textContent !== '') {
            current.push({ type: 'text', text: child.textContent, tags: tagStack.slice() });
          }
          return;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) return;
        const tag = child.tagName.toLowerCase();
        if (tag === 'br') {
          pushBreak();
          return;
        }
        if (tag === 'img' || tag === 'video') {
          current.push({ type: 'media', html: child.outerHTML, tags: tagStack.slice() });
          return;
        }
        const tagInfo = { tag: tag, attrs: getAttrString(child) };
        walk(child, tagStack.concat([tagInfo]));
      });
    }
    walk(rootNode, []);
    segments.push(current);
    return segments;
  }

  function parseBlocks(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const body = doc.body;
    if (!body) throw new Error('Could not parse sourcecode as HTML.');
    const blocks = [];
    Array.prototype.forEach.call(body.childNodes, function (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent.trim() === '') return;
        blocks.push({ type: 'text', tag: null, attrs: '', segments: [[{ type: 'text', text: node.textContent, tags: [] }]] });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (isMediaOnlyElement(node)) {
        blocks.push({ type: 'media', html: node.outerHTML });
        return;
      }
      blocks.push({
        type: 'text',
        tag: node.tagName.toLowerCase(),
        attrs: getAttrString(node),
        segments: extractSegments(node)
      });
    });
    return blocks;
  }

  // ---------------------------------------------------------------------
  // Styling engine
  // ---------------------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function tagSig(tags) {
    return JSON.stringify(tags.map(function (t) { return t.tag + '|' + t.attrs; }));
  }

  function wrapTags(tags, inner) {
    if (!tags.length) return inner;
    const open = tags.map(function (t) { return '<' + t.tag + (t.attrs ? ' ' + t.attrs : '') + '>'; }).join('');
    const close = tags.slice().reverse().map(function (t) { return '</' + t.tag + '>'; }).join('');
    return open + inner + close;
  }

  function groupRuns(segment) {
    const groups = [];
    let i = 0;
    while (i < segment.length) {
      const run = segment[i];
      if (run.type === 'media') {
        groups.push({ type: 'media', html: run.html, tags: run.tags || [] });
        i++;
        continue;
      }
      const sig = tagSig(run.tags);
      let text = run.text;
      let j = i + 1;
      while (j < segment.length && segment[j].type === 'text' && tagSig(segment[j].tags) === sig) {
        text += segment[j].text;
        j++;
      }
      groups.push({ type: 'text', tags: run.tags, text: text });
      i = j;
    }
    return groups;
  }

  // Recognized delimiter pairs: [ ], " ", ' ', ( ), 「 」, « », „ "
  const DELIM_PATTERN = [
    '\\[[^\\[\\]]*\\]',
    '"[^"]*"',
    "'[^']*'",
    '\\([^()]*\\)',
    '「[^「」]*」',
    '«[^«»]*»',
    '„[^„"]*"'
  ].join('|');

  function findDelimMatches(text) {
    const re = new RegExp(DELIM_PATTERN, 'g');
    const matches = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      if (m[0].length === 0) re.lastIndex++;
    }
    return matches;
  }

  function computeGaps(text, matches) {
    const gaps = [];
    let prevEnd = 0;
    matches.forEach(function (m) {
      gaps.push(text.slice(prevEnd, m.start));
      prevEnd = m.end;
    });
    gaps.push(text.slice(prevEnd));
    return gaps;
  }

  // Up to 1-3 short connector/punctuation tokens between delimited terms
  // are allowed and dropped from styling; anything else disqualifies the
  // span from the delimiter-anchored rule (falls through to a warning).
  function isGlueGap(gap) {
    const trimmed = gap.trim();
    if (!trimmed) return true;
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length > 3) return false;
    const glueRe = /^(and|or|&)$/i;
    return tokens.every(function (tok) {
      const core = tok.replace(/^[^\w]+|[^\w]+$/g, '');
      if (core === '') return true; // pure punctuation, e.g. "," "/" "-"
      return glueRe.test(core);
    });
  }

  // Whether a segment's groups carry any real (non-whitespace) text.
  function groupsHaveRealText(groups) {
    return groups.some(function (g) { return g.type === 'text' && g.text.trim() !== ''; });
  }

  // A segment is "media-only" when it contains at least one image/video and
  // no real translatable text — translators never see or account for these
  // lines, so they must not consume a slot when matching against the
  // Excel \n-split translation (Section 4.1/5.1) and must not be dropped.
  function segmentIsMediaOnly(groups) {
    return groups.some(function (g) { return g.type === 'media'; }) && !groupsHaveRealText(groups);
  }

  function mediaGroupHtml(g, langCode) {
    return wrapTags(g.tags, rewriteMediaHtml(g.html, langCode));
  }

  // Reapplies EN styling (Section 5.2/5.3) to translated text, given only
  // the EN segment's text-bearing groups (media already stripped out by the
  // caller). Returns { html, warnings: [{type, ...}] }
  function styleTextGroups(textGroups, translatedText) {
    const warnings = [];

    if (textGroups.length === 0) {
      return { html: escapeHtml(translatedText), warnings: warnings };
    }

    if (textGroups.length === 1) {
      const g = textGroups[0];
      return { html: wrapTags(g.tags, escapeHtml(translatedText)), warnings: warnings };
    }

    // Mixed segment: evaluate each styled (non-empty tag) group for the
    // delimiter-anchored rule (Section 5.3).
    const styledGroups = textGroups.filter(function (g) { return g.tags.length > 0; });
    if (styledGroups.length === 0) {
      return { html: escapeHtml(translatedText), warnings: warnings };
    }

    let allQualify = true;
    const rules = [];
    for (let i = 0; i < styledGroups.length; i++) {
      const g = styledGroups[i];
      const matches = findDelimMatches(g.text);
      if (matches.length === 0) { allQualify = false; break; }
      const gaps = computeGaps(g.text, matches);
      if (!gaps.every(isGlueGap)) { allQualify = false; break; }
      rules.push({ tags: g.tags, count: matches.length });
    }

    if (!allQualify) {
      warnings.push({ type: 'unresolved-style' });
      return { html: escapeHtml(translatedText), warnings: warnings };
    }

    const totalExpected = rules.reduce(function (s, r) { return s + r.count; }, 0);
    const found = findDelimMatches(translatedText);
    if (found.length !== totalExpected) {
      warnings.push({ type: 'term-count-mismatch', enCount: totalExpected, foundCount: found.length });
      return { html: escapeHtml(translatedText), warnings: warnings };
    }

    let html = '';
    let cursor = 0;
    let matchIdx = 0;
    rules.forEach(function (rule) {
      for (let k = 0; k < rule.count; k++) {
        const m = found[matchIdx++];
        html += escapeHtml(translatedText.slice(cursor, m.start));
        html += wrapTags(rule.tags, escapeHtml(m.text));
        cursor = m.end;
      }
    });
    html += escapeHtml(translatedText.slice(cursor));
    return { html: html, warnings: warnings };
  }

  // Builds the translated HTML for one EN segment (an array of runs) against
  // one line of translated text. Images/videos inline within the segment are
  // never dropped: their filenames are localized and they're re-inserted at
  // the same relative position (before/after the translated text). Media
  // genuinely sandwiched between two separate text runs can't be positioned
  // exactly (translated word order differs), so it's placed after the text
  // and flagged for a quick manual check.
  // Returns { html, warnings: [{type, ...}] }
  function buildTranslatedSegmentHtml(enSegment, translatedText, langCode) {
    const warnings = [];
    const groups = groupRuns(enSegment);

    if (groups.length === 0) {
      // EN has nothing here (e.g. a blank line from "\n\n"). If the matched
      // translated line is also blank this is expected and produces nothing;
      // but if it actually has content, that content must never be silently
      // discarded — emit it plainly and flag it, since we can't know what
      // (if any) styling should apply to a run EN never had.
      if (translatedText.trim() !== '') {
        warnings.push({ type: 'unexpected-text-in-blank-segment' });
        return { html: escapeHtml(translatedText), warnings: warnings };
      }
      return { html: '', warnings: warnings };
    }

    const mediaGroups = groups.filter(function (g) { return g.type === 'media'; });
    if (mediaGroups.length === 0) {
      return styleTextGroups(groups, translatedText);
    }

    // Segment mixes media with real text. Split off leading media (before
    // the first text run), trailing media (after the last text run), and
    // any media stuck between two separate text runs.
    let firstTextIdx = -1;
    let lastTextIdx = -1;
    groups.forEach(function (g, i) {
      if (g.type === 'text') {
        if (firstTextIdx === -1) firstTextIdx = i;
        lastTextIdx = i;
      }
    });

    const leadingMedia = groups.slice(0, firstTextIdx).filter(function (g) { return g.type === 'media'; });
    const trailingMedia = groups.slice(lastTextIdx + 1).filter(function (g) { return g.type === 'media'; });
    const interspersedMedia = groups.slice(firstTextIdx, lastTextIdx + 1).filter(function (g) { return g.type === 'media'; });

    const textGroups = groups.filter(function (g) { return g.type === 'text'; });
    const textResult = styleTextGroups(textGroups, translatedText);
    textResult.warnings.forEach(function (w) { warnings.push(w); });

    if (interspersedMedia.length > 0) {
      warnings.push({ type: 'inline-media-approx' });
    }

    const leadHtml = leadingMedia.map(function (g) { return mediaGroupHtml(g, langCode); }).join('');
    const trailHtml = trailingMedia.concat(interspersedMedia).map(function (g) { return mediaGroupHtml(g, langCode); }).join('');

    return { html: leadHtml + textResult.html + trailHtml, warnings: warnings };
  }

  function formatSegmentWarning(w, blockIndex, segIndex) {
    const loc = 'Block ' + (blockIndex + 1) + ', segment ' + (segIndex + 1);
    if (w.type === 'unresolved-style') {
      return loc + ': mid-sentence styling could not be safely auto-applied (not a whole-segment or clean bracket/quote case) — please review and style manually.';
    }
    if (w.type === 'term-count-mismatch') {
      return loc + ': bracket/quote term count mismatch (EN styled span has ' + w.enCount + ', translation has ' + w.foundCount + ') — styling skipped, please review.';
    }
    if (w.type === 'inline-media-approx') {
      return loc + ': image/video sits between two separate runs of text mid-sentence — placed after the translated text rather than in its exact original spot; please verify placement.';
    }
    if (w.type === 'unexpected-text-in-blank-segment') {
      return loc + ': EN has a blank line here but the translation has text — kept as plain unstyled text; please check this is aligned to the right line.';
    }
    if (w.type === 'ran-out-of-lines') {
      return loc + ': ran out of translated lines for this language — EN text used as a placeholder, please review.';
    }
    return loc + ': could not be automatically resolved — please review manually.';
  }

  // A text block (e.g. a stray "<p></p>" from copy/paste) that has no real
  // text and no media anywhere in it has nothing for a translator to have
  // ever seen or typed a line for — it must not consume a translated line
  // (that would push every later segment in the document onto the wrong
  // line). It's reproduced as-is for every language instead.
  function blockHasContent(block) {
    return block.segments.some(function (seg) {
      return groupRuns(seg).some(function (g) {
        return g.type === 'media' || (g.type === 'text' && g.text.trim() !== '');
      });
    });
  }

  function reconstructSegmentHtml(groups, langCode) {
    return groups.map(function (g) {
      if (g.type === 'media') return mediaGroupHtml(g, langCode);
      return wrapTags(g.tags, escapeHtml(g.text));
    }).join('');
  }

  function reconstructEnBlockHtml(block, langCode) {
    const segs = block.segments.map(function (seg) { return reconstructSegmentHtml(groupRuns(seg), langCode); });
    const inner = segs.join('<br>');
    if (block.tag) {
      const attrs = block.attrs ? ' ' + block.attrs : '';
      return '<' + block.tag + attrs + '>' + inner + '</' + block.tag + '>';
    }
    return inner;
  }

  // ---------------------------------------------------------------------
  // Global (whole-document) line matching
  //
  // A single EN <p> does not reliably correspond to a single Excel row —
  // real wiki pages routinely combine what the translation sheet treats as
  // several rows into one paragraph (or vice versa), using "\n\n" inside a
  // cell rather than separate <p> tags. Matching row-by-row against
  // <p>-by-<p> breaks the moment that assumption doesn't hold.
  //
  // Instead, every row's cell text for a language is flattened into one
  // continuous ordered line sequence (Section 4.1's row order = block order
  // guarantee still applies, just at the whole-document level rather than
  // per block), and every real (non-media-only) EN segment across the whole
  // document is matched positionally against that sequence, regardless of
  // which <p> either side of the pair happens to sit in.
  // ---------------------------------------------------------------------
  function flattenLangLines(contentRows, code) {
    const lines = [];
    contentRows.forEach(function (row) {
      const cellText = row.cells[code];
      String(cellText == null ? '' : cellText).replace(/\r\n?/g, '\n').split('\n').forEach(function (l) {
        lines.push(l);
      });
    });
    return lines;
  }

  function countRealSegments(blocks) {
    let count = 0;
    blocks.forEach(function (block) {
      if (block.type !== 'text' || !blockHasContent(block)) return;
      block.segments.forEach(function (seg) {
        if (!segmentIsMediaOnly(groupRuns(seg))) count++;
      });
    });
    return count;
  }

  // Renders one EN block against the shared global line cursor. Returns
  // { html, nextCursor }.
  function buildTranslatedTextBlockGlobal(block, allLines, startCursor, blockIndex, warnings, langCode) {
    const enSegments = block.segments;
    const enGroupsPerSeg = enSegments.map(groupRuns);
    const mediaOnly = enGroupsPerSeg.map(segmentIsMediaOnly);

    const outSegs = [];
    let cursor = startCursor;
    for (let i = 0; i < enSegments.length; i++) {
      if (mediaOnly[i]) {
        outSegs.push(enGroupsPerSeg[i].map(function (g) { return mediaGroupHtml(g, langCode); }).join(''));
        continue;
      }
      if (cursor >= allLines.length) {
        warnings.push({ message: formatSegmentWarning({ type: 'ran-out-of-lines' }, blockIndex, i) });
        outSegs.push(reconstructSegmentHtml(enGroupsPerSeg[i], langCode));
        continue;
      }
      const trText = allLines[cursor];
      cursor++;
      const result = buildTranslatedSegmentHtml(enSegments[i], trText, langCode);
      result.warnings.forEach(function (w) {
        warnings.push({ message: formatSegmentWarning(w, blockIndex, i) });
      });
      outSegs.push(result.html);
    }

    const innerHtml = outSegs.join('<br>');
    const html = block.tag
      ? '<' + block.tag + (block.attrs ? ' ' + block.attrs : '') + '>' + innerHtml + '</' + block.tag + '>'
      : innerHtml;
    return { html: html, nextCursor: cursor };
  }

  // ---------------------------------------------------------------------
  // Filename rewriting (Section 7)
  // ---------------------------------------------------------------------
  function rewriteMediaHtml(html, code) {
    const container = document.createElement('div');
    container.innerHTML = html;
    container.querySelectorAll('img, video').forEach(function (el) {
      const src = el.getAttribute('src');
      if (!src) return;
      const rewritten = src.replace(/-(\s*)EN(\.[A-Za-z0-9]+)(?=$|[?#])/, '-$1' + code + '$2');
      if (rewritten !== src) el.setAttribute('src', rewritten);
    });
    return container.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Per-language assembly
  // ---------------------------------------------------------------------
  function generateLanguageOutput(blocks, contentRows, code, name) {
    const warnings = [];
    const allLines = flattenLangLines(contentRows, code);
    const totalReal = countRealSegments(blocks);

    if (allLines.length !== totalReal) {
      warnings.push({
        message: 'Total translatable line count mismatch: the EN sourcecode has ' + totalReal +
          ' line(s) to translate (excluding image/video-only lines), but this language\'s Excel rows have ' +
          allLines.length + ' line(s) in total across all rows — line-by-line matching may be misaligned ' +
          'from wherever the counts first diverge. Check the translator\'s line breaks against the EN source.'
      });
    }

    let cursor = 0;
    const parts = [];
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      if (block.type === 'media') {
        parts.push(rewriteMediaHtml(block.html, code));
        continue;
      }
      if (!blockHasContent(block)) {
        parts.push(reconstructEnBlockHtml(block, code));
        continue;
      }
      const blockWarnings = [];
      const result = buildTranslatedTextBlockGlobal(block, allLines, cursor, bi, blockWarnings, code);
      cursor = result.nextCursor;
      parts.push(result.html);
      blockWarnings.forEach(function (w) { warnings.push(w); });
    }

    if (cursor < allLines.length) {
      warnings.push({ message: 'Note: ' + (allLines.length - cursor) + ' extra translated line(s) across the Excel rows were not used.' });
    }

    return { code: code, name: name, html: parts.join(''), warnings: warnings };
  }

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  function cacheEls() {
    els.enSource = $('en-source');
    els.dropZone = $('drop-zone');
    els.fileInput = $('file-input');
    els.fileName = $('file-name');
    els.sheetSelectWrap = $('sheet-select-wrap');
    els.sheetSelect = $('sheet-select');
    els.processBtn = $('process-btn');
    els.globalError = $('global-error');
    els.outputPlaceholder = $('output-placeholder');
    els.outputGrid = $('output-grid');
  }

  function showGlobalError(msg) {
    els.globalError.textContent = msg;
    els.globalError.classList.remove('hidden');
  }
  function clearGlobalError() {
    els.globalError.textContent = '';
    els.globalError.classList.add('hidden');
  }

  function updateProcessButtonState() {
    els.processBtn.disabled = !(state.workbook && els.enSource.value.trim());
  }

  function handleFile(file) {
    if (!file) return;
    if (typeof XLSX === 'undefined') {
      showGlobalError('The Excel parsing library did not load from the CDN. Check your network connection (or firewall) and reload the page.');
      return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        state.workbook = workbook;
        state.fileName = file.name;
        els.fileName.textContent = file.name;
        populateSheetSelect(workbook);
        clearGlobalError();
        resetOutput();
        updateProcessButtonState();
      } catch (err) {
        state.workbook = null;
        showGlobalError('Could not read this Excel file: ' + err.message);
        updateProcessButtonState();
      }
    };
    reader.onerror = function () {
      showGlobalError('Could not read the selected file.');
    };
    reader.readAsArrayBuffer(file);
  }

  function populateSheetSelect(workbook) {
    els.sheetSelect.innerHTML = '';
    workbook.SheetNames.forEach(function (name) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      els.sheetSelect.appendChild(opt);
    });
    els.sheetSelectWrap.classList.toggle('hidden', workbook.SheetNames.length <= 1);
  }

  function resetOutput() {
    els.outputGrid.innerHTML = '';
    els.outputPlaceholder.classList.remove('hidden');
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  function renderOutputs(results) {
    els.outputPlaceholder.classList.add('hidden');
    els.outputGrid.innerHTML = '';

    results.forEach(function (result) {
      const card = document.createElement('div');
      card.className = 'lang-card';

      const head = document.createElement('div');
      head.className = 'lang-card-head';

      const titleWrap = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'lang-card-title';
      title.textContent = result.name;
      const code = document.createElement('div');
      code.className = 'lang-card-code';
      code.textContent = result.code;
      titleWrap.appendChild(title);
      titleWrap.appendChild(code);
      head.appendChild(titleWrap);

      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn';
      copyBtn.textContent = 'Copy';
      head.appendChild(copyBtn);

      card.appendChild(head);

      if (result.error) {
        card.classList.add('has-error');
        const errBox = document.createElement('div');
        errBox.className = 'lang-card-error';
        errBox.textContent = result.error;
        card.appendChild(errBox);
        copyBtn.disabled = true;
      } else {
        if (result.warnings.length) {
          card.classList.add('has-warning');
          const list = document.createElement('ul');
          list.className = 'warning-list';
          result.warnings.forEach(function (w) {
            const li = document.createElement('li');
            li.textContent = w.message;
            list.appendChild(li);
          });
          card.appendChild(list);
        }

        const details = document.createElement('details');
        details.className = 'preview';
        const summary = document.createElement('summary');
        summary.textContent = 'Preview sourcecode';
        const pre = document.createElement('pre');
        pre.textContent = result.html;
        details.appendChild(summary);
        details.appendChild(pre);
        card.appendChild(details);

        copyBtn.addEventListener('click', function () {
          copyToClipboard(result.html).then(function () {
            copyBtn.classList.add('copied');
            const prevText = copyBtn.textContent;
            copyBtn.textContent = 'Copied ✓';
            setTimeout(function () {
              copyBtn.textContent = prevText === 'Copied ✓' ? 'Copy' : prevText;
            }, 1600);
          }).catch(function () {
            showGlobalError('Clipboard copy failed for ' + result.name + '. Please copy manually from the preview.');
          });
        });
      }

      els.outputGrid.appendChild(card);
    });
  }

  function processAll() {
    clearGlobalError();
    const enHtml = els.enSource.value;
    if (!enHtml.trim()) {
      showGlobalError('Please paste the EN sourcecode first.');
      return;
    }
    if (!state.workbook) {
      showGlobalError('Please upload the translation Excel file first.');
      return;
    }

    const sheetName = els.sheetSelect.value || state.workbook.SheetNames[0];
    const sheet = state.workbook.Sheets[sheetName];
    if (!sheet) {
      showGlobalError('Could not find sheet "' + sheetName + '" in the workbook.');
      return;
    }
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

    const headerRowIdx = detectHeaderRow(matrix, state.lookupIndex);
    if (headerRowIdx === -1) {
      showGlobalError('Could not detect a language header row in sheet "' + sheetName + '". Make sure it has a row with language column headers (e.g. EN, KR, JP, ...).');
      return;
    }

    const columnMap = buildColumnMap(matrix, headerRowIdx, state.lookupIndex);
    const contentRows = extractContentRows(matrix, headerRowIdx, columnMap);
    if (contentRows.length === 0) {
      showGlobalError('No content rows were detected below the header row in sheet "' + sheetName + '".');
      return;
    }

    let blocks;
    try {
      blocks = parseBlocks(enHtml);
    } catch (err) {
      showGlobalError('Could not parse the EN sourcecode: ' + err.message);
      return;
    }

    const foundCodes = new Set(columnMap.filter(function (c) { return c.type === 'lang'; }).map(function (c) { return c.code; }));

    const results = state.targetLanguages.map(function (lang) {
      if (!foundCodes.has(lang.code)) {
        return { code: lang.code, name: lang.name, error: 'Language column for ' + lang.name + ' (' + lang.code + ') was not found in sheet "' + sheetName + '".' };
      }
      return generateLanguageOutput(blocks, contentRows, lang.code, lang.name);
    });

    renderOutputs(results);
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  function wireEvents() {
    els.enSource.addEventListener('input', updateProcessButtonState);

    els.fileInput.addEventListener('change', function (e) {
      handleFile(e.target.files[0]);
    });

    ['dragover', 'dragenter'].forEach(function (evt) {
      els.dropZone.addEventListener(evt, function (e) {
        e.preventDefault();
        els.dropZone.classList.add('drag-over');
      });
    });
    ['dragleave', 'dragend'].forEach(function (evt) {
      els.dropZone.addEventListener(evt, function () {
        els.dropZone.classList.remove('drag-over');
      });
    });
    els.dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      els.dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    els.sheetSelect.addEventListener('change', resetOutput);

    els.processBtn.addEventListener('click', processAll);
  }

  async function init() {
    cacheEls();
    wireEvents();
    if (typeof XLSX === 'undefined') {
      showGlobalError('Could not load the Excel parsing library from the CDN. Check your network connection (or firewall) and reload the page.');
    }
    state.lookup = await loadLookup();
    state.lookupIndex = buildLookupIndex(state.lookup);
    state.targetLanguages = state.lookup.languages.filter(function (l) { return l.code !== 'EN'; });
    updateProcessButtonState();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
