const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const XLSX = require("xlsx");

const dom = new JSDOM("<!doctype html><html><body></body></html>");
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;
global.XLSX = XLSX;

// Load app.js's source first (not yet executed) so the mock fetch below can
// match against the real CONFIG.workerUrl instead of a second hardcoded copy
// that would silently drift out of sync whenever the URL changes.
const appJsPath = path.join(__dirname, "..", "wiki_styler", "app.js");
const code = fs.readFileSync(appJsPath, "utf-8");
const workerUrlMatch = code.match(/workerUrl:\s*"([^"]+)"/);
if (!workerUrlMatch) {
  throw new Error(`Could not find CONFIG.workerUrl in ${appJsPath}`);
}
const WORKER_URL = workerUrlMatch[1];

global.fetch = async (url, opts) => {
  if (url === "language-lookup.json") {
    const data = fs.readFileSync(path.join(__dirname, "..", "wiki_styler", "language-lookup.json"), "utf-8");
    return { json: async () => JSON.parse(data) };
  }
  if (url === `${WORKER_URL}/resolve-styles`) {
    // Simulate the Gemini proxy using ground truth we hand-derived for
    // Korean earlier in this project, just to exercise the fallback code
    // path end-to-end without a real network call.
    const body = JSON.parse(opts.body);
    console.log("  [mock resolve-styles call] style_runs:", JSON.stringify(body.style_runs));
    console.log("  [mock resolve-styles call] target_paragraphs count:", body.target_paragraphs.length);
    const matches = body.style_runs.map((r) => {
      // Known-correct Korean paragraph ranges from the manual analysis
      // earlier in this project (title/red/orange/purple spans).
      if (r.start === 0) return { style: r.style, start: 0, end: 0, confidence: "high" };
      if (r.start === 3) return { style: r.style, start: 3, end: 6, confidence: "high" };
      if (r.start === 6) return { style: r.style, start: 7, end: 9, confidence: "high" };
      if (r.start === 9) return { style: r.style, start: 10, end: 13, confidence: "high" };
      return { style: r.style, start: r.start, end: r.end, confidence: "low" };
    });
    return { ok: true, json: async () => ({ matches }) };
  }
  if (url === `${WORKER_URL}/fetch-sheet`) {
    // Not exercised by this test run — it uses the local xlsx fixture, not
    // a Sheets URL. A real call here would indicate a wiring bug.
    throw new Error("unexpected /fetch-sheet call in this test run");
  }
  throw new Error("unexpected fetch: " + url);
};

// Load app.js into this context (it assigns window.wiki14)
const vm = require("vm");
vm.runInThisContext(code, { filename: "app.js" });

const enSourcecode = fs.readFileSync(path.join(__dirname, "en_source.html"), "utf-8");
const excelBuffer = fs.readFileSync(path.join(__dirname, "test_excel.xlsx"));
const arrayBuffer = excelBuffer.buffer.slice(excelBuffer.byteOffset, excelBuffer.byteOffset + excelBuffer.byteLength);

const EXPECTED_KR_STYLES = [
  "font-size: 24px",
  "color: rgb(255, 0, 0)",
  "color: rgb(255, 192, 0)",
  "color: rgb(115, 52, 197)",
];

(async () => {
  try {
    const { outputs, flags } = await window.wiki14.runPipeline(
      enSourcecode,
      { type: "arraybuffer", data: arrayBuffer },
      "Player Story 8.13",
      (msg) => console.log("progress:", msg),
      "localize"
    );
    console.log("\n=== FLAGS ===");
    console.log(flags.length ? flags.join("\n") : "(none)");
    console.log("\n=== LANGUAGES GENERATED ===");
    console.log(Object.keys(outputs));
    console.log("\n=== TW sample ===");
    console.log(outputs.TW.slice(0, 800));
    console.log("\n=== KR sample ===");
    console.log(outputs.KR.slice(0, 800));

    fs.writeFileSync(path.join(__dirname, "test_output.json"), JSON.stringify(outputs, null, 2));
    console.log("\nWrote test_output.json");

    const allLanguagesGenerated = Object.keys(outputs).length === 13;
    const zeroFlags = flags.length === 0;
    const krHasAllStyles = EXPECTED_KR_STYLES.every((s) => outputs.KR.includes(s));

    console.log("\n=== CHECKS ===");
    console.log("ALL 13 LANGUAGES GENERATED:", allLanguagesGenerated);
    console.log("ZERO FLAGS:", zeroFlags);
    console.log("KR HAS ALL 4 STYLE SPANS:", krHasAllStyles);
    if (!krHasAllStyles) {
      EXPECTED_KR_STYLES.forEach((s) => {
        console.log(`  "${s}" present:`, outputs.KR.includes(s));
      });
    }

    if (!allLanguagesGenerated || !zeroFlags || !krHasAllStyles) {
      console.error("\nFAIL: one or more checks did not pass.");
      process.exit(1);
    }

    // Second manual check: mediaMode = "dont-localize" should leave every
    // language's image src exactly as EN, never swapped per language.
    console.log("\n=== dont-localize mode check ===");
    const dontLocalizeResult = await window.wiki14.runPipeline(
      enSourcecode,
      { type: "arraybuffer", data: arrayBuffer },
      "Player Story 8.13",
      () => {},
      "dont-localize"
    );
    let allUnchanged = true;
    for (const [langCode, html] of Object.entries(dontLocalizeResult.outputs)) {
      const hasEnFilename = html.includes("_EN.png");
      const hasSwappedFilename = html.includes(`_${langCode}.png`);
      if (!hasEnFilename || hasSwappedFilename) {
        allUnchanged = false;
        console.error(
          `  ${langCode}: FAIL — expected unchanged "_EN.png" (hasEnFilename=${hasEnFilename}, hasSwappedFilename=${hasSwappedFilename})`
        );
      }
    }
    console.log("ALL LANGUAGES KEEP _EN.png UNCHANGED (dont-localize):", allUnchanged);
    if (!allUnchanged) {
      console.error("\nFAIL: dont-localize mode check failed.");
      process.exit(1);
    }

    console.log("\nALL CHECKS PASSED.");
  } catch (e) {
    console.error("PIPELINE ERROR:", e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
