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
  if (url === WORKER_URL) {
    // Simulate the Gemini proxy using ground truth we hand-derived for
    // Korean earlier in this conversation, just to exercise the fallback
    // code path end-to-end without a real network call.
    const body = JSON.parse(opts.body);
    console.log("  [mock gemini call] style_runs:", JSON.stringify(body.style_runs));
    console.log("  [mock gemini call] target_paragraphs count:", body.target_paragraphs.length);
    // Map by style run start index (0-based EN paragraph index) since we
    // know this doc's structure from the earlier manual analysis.
    const byStart = {};
    for (const r of body.style_runs) byStart[r.start] = r.style;
    const matches = body.style_runs.map((r) => {
      // Known-correct Korean paragraph ranges from the manual analysis
      // earlier in this conversation.
      if (r.start === 0) return { style: r.style, start: 0, end: 0, confidence: "high" };
      if (r.start === 3) return { style: r.style, start: 3, end: 6, confidence: "high" };
      if (r.start === 6) return { style: r.style, start: 7, end: 9, confidence: "high" };
      if (r.start === 9) return { style: r.style, start: 10, end: 13, confidence: "high" };
      return { style: r.style, start: r.start, end: r.end, confidence: "low" };
    });
    return { ok: true, json: async () => ({ matches }) };
  }
  throw new Error("unexpected fetch: " + url);
};

// Load app.js into this context (it assigns window.wiki14)
const vm = require("vm");
vm.runInThisContext(code, { filename: "app.js" });

const enSourcecode = fs.readFileSync(path.join(__dirname, "en_source.html"), "utf-8");
const excelBuffer = fs.readFileSync(path.join(__dirname, "test_excel.xlsx"));
const arrayBuffer = excelBuffer.buffer.slice(excelBuffer.byteOffset, excelBuffer.byteOffset + excelBuffer.byteLength);

(async () => {
  try {
    const { outputs, flags } = await window.wiki14.runPipeline(
      enSourcecode,
      arrayBuffer,
      "Player Story 8.13",
      (msg) => console.log("progress:", msg)
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
  } catch (e) {
    console.error("PIPELINE ERROR:", e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
