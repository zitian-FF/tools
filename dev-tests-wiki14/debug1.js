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
const vm = require("vm");
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "wiki_styler", "app.js"), "utf-8"), { filename: "app.js" });

const enSourcecode = fs.readFileSync(path.join(__dirname, "en_source.html"), "utf-8");
const { tokenizeSourcecode, flattenTokens } = window.wiki14._internal;
const tokens = tokenizeSourcecode(enSourcecode);
const flat = flattenTokens(tokens);

const wb = XLSX.readFile("test_excel.xlsx");
const sheet = wb.Sheets["Player Story 8.13"];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
const header = rows[0];
let enCol = -1;
header.forEach((h,i)=>{ if(String(h).trim()==="EN") enCol=i; });
console.log("EN col idx:", enCol);

// mimic identifyContentRows
const contentRows = [];
for (let r=1;r<rows.length;r++){
  const cell = rows[r][enCol];
  if (typeof cell === "string" && cell.trim().length>0 && flat.includes(cell)) contentRows.push(r);
}
console.log("content rows:", contentRows);
const enRowsFlat = contentRows.map(r=>String(rows[r][enCol])).join("\n");

console.log("flat length:", flat.length, "enRowsFlat length:", enRowsFlat.length);
console.log("equal:", flat === enRowsFlat);

// find first diff
const n = Math.min(flat.length, enRowsFlat.length);
let diffAt = -1;
for (let i=0;i<n;i++){ if(flat[i]!==enRowsFlat[i]){ diffAt=i; break; } }
console.log("first diff at:", diffAt);
if (diffAt>=0){
  console.log("flat around:", JSON.stringify(flat.slice(Math.max(0,diffAt-40), diffAt+40)));
  console.log("excel around:", JSON.stringify(enRowsFlat.slice(Math.max(0,diffAt-40), diffAt+40)));
}

console.log("\n--- row 4 check ---");
console.log("row4 EN cell:", JSON.stringify(rows[4][enCol]).slice(0,200));
console.log("includes?", flat.includes(rows[4][enCol]));
console.log("\nflat[0:300]:", JSON.stringify(flat.slice(0,300)));
