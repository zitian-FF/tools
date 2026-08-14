// wiki14 — UI wiring. Talks to window.wiki14.runPipeline from app.js.

const els = {
  sourcecode: document.getElementById("en-sourcecode"),
  fileInput: document.getElementById("excel-file"),
  sheetPicker: document.getElementById("sheet-picker"),
  sheetSelect: document.getElementById("sheet-select"),
  runButton: document.getElementById("run-button"),
  status: document.getElementById("status"),
  flags: document.getElementById("flags"),
  results: document.getElementById("results"),
  tabs: document.getElementById("result-tabs"),
  panels: document.getElementById("result-panels"),
  helpToggle: document.getElementById("help-toggle"),
  helpPanel: document.getElementById("help-panel"),
  sourceTabFile: document.getElementById("source-tab-file"),
  sourceTabSheets: document.getElementById("source-tab-sheets"),
  fileSourcePanel: document.getElementById("file-source-panel"),
  sheetsSourcePanel: document.getElementById("sheets-source-panel"),
  sheetsUrlInput: document.getElementById("sheets-url"),
  loadSheetButton: document.getElementById("load-sheet-button"),
  sheetsStatus: document.getElementById("sheets-status"),
};

els.helpToggle.addEventListener("click", () => {
  const isOpen = !els.helpPanel.classList.contains("hidden");
  els.helpPanel.classList.toggle("hidden", isOpen);
  els.helpToggle.setAttribute("aria-expanded", String(!isOpen));
});

document.addEventListener("click", (e) => {
  const clickedInsidePanel = els.helpPanel.contains(e.target) || els.helpToggle.contains(e.target);
  if (!clickedInsidePanel && !els.helpPanel.classList.contains("hidden")) {
    els.helpPanel.classList.add("hidden");
    els.helpToggle.setAttribute("aria-expanded", "false");
  }
});

// "file" or "sheets" — which translation-sheet source panel is active. Run
// uses whichever source is currently selected, not just whichever was
// loaded most recently, so switching tabs without loading the new one
// fails loudly instead of silently reusing stale data from the other tab.
let activeSourceMode = "file";

function setSourceMode(mode) {
  activeSourceMode = mode;
  const isFile = mode === "file";
  els.sourceTabFile.classList.toggle("active", isFile);
  els.sourceTabSheets.classList.toggle("active", !isFile);
  els.fileSourcePanel.classList.toggle("hidden", !isFile);
  els.sheetsSourcePanel.classList.toggle("hidden", isFile);
}

els.sourceTabFile.addEventListener("click", () => setSourceMode("file"));
els.sourceTabSheets.addEventListener("click", () => setSourceMode("sheets"));

function setSheetsStatus(text, isError) {
  els.sheetsStatus.textContent = text;
  els.sheetsStatus.classList.remove("hidden");
  els.sheetsStatus.classList.toggle("error", !!isError);
}

let sheetsCsv = null;

els.loadSheetButton.addEventListener("click", async () => {
  const url = els.sheetsUrlInput.value.trim();
  if (!url) {
    setSheetsStatus("Paste a Google Sheets URL first.", true);
    return;
  }

  let parsed;
  try {
    parsed = window.wiki14.parseGoogleSheetsUrl(url);
  } catch (e) {
    setSheetsStatus(e.message, true);
    return;
  }

  const gidWarning = !parsed.gid
    ? "No gid found in that URL — defaulting to the first tab. Re-copy the URL with the correct tab open if that's not the one you want. "
    : "";

  els.loadSheetButton.disabled = true;
  setSheetsStatus(`${gidWarning}Loading...`, !!gidWarning);

  try {
    sheetsCsv = await window.wiki14.fetchGoogleSheetCsv(parsed.sheetId, parsed.gid);
    setSheetsStatus(`${gidWarning}Sheet loaded.`, !!gidWarning);
  } catch (e) {
    sheetsCsv = null;
    setSheetsStatus(e.message, true);
  } finally {
    els.loadSheetButton.disabled = false;
  }
});

let workbookArrayBuffer = null;
let workbookSheetNames = [];

els.fileInput.addEventListener("change", async () => {
  const file = els.fileInput.files[0];
  if (!file) return;
  workbookArrayBuffer = await file.arrayBuffer();

  try {
    const wb = XLSX.read(workbookArrayBuffer, { type: "array" });
    workbookSheetNames = wb.SheetNames;
    if (workbookSheetNames.length > 1) {
      els.sheetSelect.innerHTML = workbookSheetNames
        .map((name) => `<option value="${name}">${name}</option>`)
        .join("");
      els.sheetPicker.classList.remove("hidden");
    } else {
      els.sheetPicker.classList.add("hidden");
    }
  } catch (e) {
    setStatus(`Could not read that file: ${e.message}`, true);
  }
});

els.runButton.addEventListener("click", async () => {
  const sourcecode = els.sourcecode.value.trim();
  if (!sourcecode) {
    setStatus("Paste the EN sourcecode first.", true);
    return;
  }

  let workbookSource;
  let sheetName;
  if (activeSourceMode === "file") {
    if (!workbookArrayBuffer) {
      setStatus("Attach the translation sheet first.", true);
      return;
    }
    workbookSource = { type: "arraybuffer", data: workbookArrayBuffer };
    sheetName = workbookSheetNames.length > 1 ? els.sheetSelect.value : undefined;
  } else {
    if (!sheetsCsv) {
      setStatus("Load the Google Sheet first.", true);
      return;
    }
    workbookSource = { type: "csv", data: sheetsCsv };
    sheetName = undefined;
  }

  const mediaMode = document.querySelector('input[name="media-mode"]:checked').value;

  els.runButton.disabled = true;
  els.flags.classList.add("hidden");
  els.results.classList.add("hidden");
  setStatus("Starting...", false);

  try {
    const { outputs, flags } = await window.wiki14.runPipeline(
      sourcecode,
      workbookSource,
      sheetName,
      (msg) => setStatus(msg, false),
      mediaMode
    );
    setStatus(`Done — generated ${Object.keys(outputs).length} languages.`, false);
    renderFlags(flags);
    renderResults(outputs);
  } catch (e) {
    setStatus(e.message, true);
    console.error(e);
  } finally {
    els.runButton.disabled = false;
  }
});

function setStatus(text, isError) {
  els.status.textContent = text;
  els.status.classList.remove("hidden");
  els.status.classList.toggle("error", !!isError);
}

function renderFlags(flags) {
  if (!flags || flags.length === 0) return;
  els.flags.innerHTML =
    `<strong>Double-check before pasting:</strong><ul>${flags
      .map((f) => `<li>${escapeForDisplay(f)}</li>`)
      .join("")}</ul>`;
  els.flags.classList.remove("hidden");
}

function renderResults(outputs) {
  const codes = Object.keys(outputs);
  els.tabs.innerHTML = codes
    .map((code, i) => `<button class="tab${i === 0 ? " active" : ""}" data-code="${code}">${code}</button>`)
    .join("");
  els.panels.innerHTML = codes
    .map(
      (code, i) => `
      <div class="panel${i === 0 ? " active" : ""}" data-code="${code}">
        <div class="panel-toolbar"><button class="copy-button" data-code="${code}">Copy</button></div>
        <pre class="code-output">${escapeForDisplay(outputs[code])}</pre>
      </div>`
    )
    .join("");

  els.tabs.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const code = tab.dataset.code;
      els.tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      els.panels.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.dataset.code === code));
    });
  });

  els.panels.querySelectorAll(".copy-button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(outputs[btn.dataset.code]);
      btn.textContent = "Copied";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("copied");
      }, 1500);
    });
  });

  els.results.classList.remove("hidden");
}

function escapeForDisplay(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
