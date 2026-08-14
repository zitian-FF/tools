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
};

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
  if (!workbookArrayBuffer) {
    setStatus("Attach the translation sheet first.", true);
    return;
  }

  els.runButton.disabled = true;
  els.flags.classList.add("hidden");
  els.results.classList.add("hidden");
  setStatus("Starting...", false);

  const sheetName = workbookSheetNames.length > 1 ? els.sheetSelect.value : undefined;

  try {
    const { outputs, flags } = await window.wiki14.runPipeline(
      sourcecode,
      workbookArrayBuffer,
      sheetName,
      (msg) => setStatus(msg, false)
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
