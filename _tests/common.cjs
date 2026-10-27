// Percorsi e utilità comuni ai test.
const fs = require("fs");
const path = require("path");

const FX = path.join(__dirname, "fixtures", "out") + path.sep;
const SHOTS = path.join(__dirname, "shots") + path.sep;
const BASE = process.env.BASE_URL || "http://127.0.0.1:8766/pdf/";
fs.mkdirSync(SHOTS, { recursive: true });

// Stampa l'esito di un controllo; un controllo fallito rende il test non superato.
function check(label, ok, detail = "") {
  console.log(`${ok ? "✔" : "✘"} ${label}${detail !== "" ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

// Raccoglie errori della pagina e della console.
function watchErrors(page, errors) {
  page.on("pageerror", (e) => errors.push("[pageerror] " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("[console] " + m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`[${r.status()}] ${r.url()}`); });
}

// Apre un file di prova e attende la fine dell'apertura e della verifica delle firme.
async function openFixture(page, name) {
  await page.setInputFiles("#fileInput", FX + name);
  await page.waitForFunction(() => document.getElementById("busy").hidden
    && !document.getElementById("sigChip").classList.contains("pending"), null, { timeout: 20000 });
  await page.waitForTimeout(300);
}

const text = async (page, sel) => ((await page.textContent(sel)) || "").replace(/\s+/g, " ").trim();

module.exports = { FX, SHOTS, BASE, check, watchErrors, openFixture, text };
