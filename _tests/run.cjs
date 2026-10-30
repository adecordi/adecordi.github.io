// Esegue tutti i test: genera i file di prova se mancano, avvia il server locale
// e lancia i test uno dopo l'altro. Uso: node run.cjs [nome-test ...]
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const TESTS = ["unwrap.mjs", "e2e.cjs", "mobile.cjs", "condividi.cjs", "ricezione.cjs", "outlook.cjs", "link.cjs", "stampa.cjs", "jpx.cjs", "strumenti.cjs", "annota.cjs", "tocco.cjs", "raddrizza.cjs", "uscita.cjs", "colleghi.cjs", "nitido.cjs"];
const selected = process.argv.slice(2).length ? process.argv.slice(2).map((t) => TESTS.find((x) => x.startsWith(t)) || t) : TESTS;

if (!fs.existsSync(path.join(__dirname, "fixtures", "out", "scansione.pdf"))) {
  console.log("Genero i file di prova…");
  const r = spawnSync("bash", [path.join(__dirname, "fixtures", "genera.sh")], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
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
