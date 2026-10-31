// Esegue tutti i test: genera i file di prova se mancano, avvia il server locale
// e lancia i test uno dopo l'altro. Uso: node run.cjs [nome-test ...]
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const TESTS = ["unwrap.mjs", "e2e.cjs", "mobile.cjs", "condividi.cjs", "ricezione.cjs", "outlook.cjs", "link.cjs", "stampa.cjs", "jpx.cjs", "strumenti.cjs", "annota.cjs", "tocco.cjs", "raddrizza.cjs", "uscita.cjs", "colleghi.cjs", "nitido.cjs", "sottolinea_storta.cjs", "ocr_storta.cjs", "proposte.cjs", "traduci.cjs", "impostazioni.cjs"];
const selected = process.argv.slice(2).length ? process.argv.slice(2).map((t) => TESTS.find((x) => x.startsWith(t)) || t) : TESTS;

if (!fs.existsSync(path.join(__dirname, "fixtures", "out", "scansione.pdf"))) {
  console.log("Genero i file di prova…");
  const r = spawnSync("bash", [path.join(__dirname, "fixtures", "genera.sh")], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
}

// Prima di tutto la sintassi dei file del sito: un errore (31/10/2026: una variabile dichiarata due volte) bloccava
// il visualizzatore e le prove finivano in attese scadute senza dire perché.
{
  const os = require("os");
  const sito = path.join(__dirname, "..", "pdf");
  for (const f of fs.readdirSync(sito).filter((x) => x.endsWith(".js") && x !== "sw.js")) {
    const copia = path.join(os.tmpdir(), "carta-check-" + f.replace(/\.js$/, ".mjs"));
    fs.copyFileSync(path.join(sito, f), copia);
    const r = spawnSync(process.execPath, ["--check", copia], { encoding: "utf8" });
    if (r.status !== 0) {
      console.log(`✘ Errore di sintassi in pdf/${f}:\n${(r.stderr || "").split("\n").slice(0, 6).join("\n")}`);
      process.exit(1);
    }
  }
}

const server = spawn(process.execPath, [path.join(__dirname, "server.cjs")], { stdio: "ignore" });
const up = () => new Promise((resolve) => http.get("http://127.0.0.1:8766/pdf/", (res) => resolve(res.statusCode === 200)).on("error", () => resolve(false)));

(async () => {
  for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100));
  const failed = [];
  for (const test of selected) {
    console.log(`\n▶ ${test}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, test)], { stdio: "inherit" });
    if (r.status !== 0) failed.push(test);
  }
  server.kill();
  console.log(failed.length ? `\n✘ Test non superati: ${failed.join(", ")}` : `\n✔ Tutti i test superati (${selected.length})`);
  console.log(`Screenshot e PDF di stampa in ${path.join(__dirname, "shots")}`);
  process.exit(failed.length ? 1 : 0);
})();
