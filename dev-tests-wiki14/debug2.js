const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>");
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;
const vm = require("vm");
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "wiki_styler", "app.js"), "utf-8"), { filename: "app.js" });

const enSourcecode = fs.readFileSync(path.join(__dirname, "en_source.html"), "utf-8");
const { tokenizeSourcecode, buildStructure, paragraphStyleKeys, collapseStyleRuns, paragraphPlainText } = window.wiki14._internal;
const tokens = tokenizeSourcecode(enSourcecode);
const { paragraphs, mediaInsertions } = buildStructure(tokens);
console.log("num paragraphs:", paragraphs.length);
console.log("media insertions:", mediaInsertions.map(m=>({before:m.beforeParagraphIndex, src:m.src})));
const styles = paragraphStyleKeys(paragraphs);
paragraphs.forEach((p,i)=>{
  console.log(i, JSON.stringify(paragraphPlainText(p)).slice(0,60), "| style:", styles[i].styleKey);
});
console.log("\nstyle runs:", JSON.stringify(collapseStyleRuns(styles), null, 2));
