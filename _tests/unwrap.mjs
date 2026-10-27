// Estrazione e verifica delle buste firmate con p7m.js (in Node, senza browser).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { FX, check } = createRequire(import.meta.url)("./common.cjs");
// p7m.js è un modulo ES ma pdf/ non ha "type": "module": Node < 22 lo leggerebbe come CommonJS
const src = readFileSync(new URL("../pdf/p7m.js", import.meta.url));
const { unwrap, sniff, innerFileName } = await import("data:text/javascript;base64," + src.toString("base64"));

// file -> [nome estratto, tipo, esito atteso per ogni busta, partendo dall'esterno]
const cases = {
  "doc.pdf.p7m": ["doc.pdf", "pdf", ["p7m:valid"]],
  "doc_ber.pdf.p7m": ["doc_ber.pdf", "pdf", ["p7m:valid"]],
  "doc_pem.pdf.p7m": ["doc_pem.pdf", "pdf", ["p7m:valid"]],
  "doc_b64.pdf.p7m": ["doc_b64.pdf", "pdf", ["p7m:valid"]],
  "doc_ec.pdf.p7m": ["doc_ec.pdf", "pdf", ["p7m:valid"]],
  "doc_pss.pdf.p7m": ["doc_pss.pdf", "pdf", ["p7m:valid"]],
  "doc_noattr_sha1.pdf.p7m": ["doc_noattr_sha1.pdf", "pdf", ["p7m:valid"]],
  "doc_due_firme.pdf.p7m": ["doc_due_firme.pdf", "pdf", ["p7m:valid,valid"]],
  "doc_doppia.pdf.p7m.p7m": ["doc_doppia.pdf", "pdf", ["p7m:valid", "p7m:valid"]],
  "doc_alterato.pdf.p7m": ["doc_alterato.pdf", "pdf", ["p7m:invalid"]],
  "doc_firma_corrotta.pdf.p7m": ["doc_firma_corrotta.pdf", "pdf", ["p7m:invalid"]],
  "doc_scaduto.pdf.p7m": ["doc_scaduto.pdf", "pdf", ["p7m:valid"]],
  "doc_marca.pdf.p7m": ["doc_marca.pdf", "pdf", ["p7m:valid"]],
  "doc.pdf.tsd": ["doc.pdf", "pdf", ["tsd:valid", "p7m:valid"]],
  "doc.pdf.m7m": ["doc.pdf", "pdf", ["m7m:valid", "p7m:valid"]],
  "IT01234567890_00042.xml.p7m": ["IT01234567890_00042.xml", "xml", ["p7m:valid"]],
  "nota.txt.p7m": ["nota.txt", "text", ["p7m:valid"]],
  "immagine.png.p7m": ["immagine.png", "image", ["p7m:valid"]],
  "doc.pdf": ["doc.pdf", "pdf", []],
};

for (const [file, [name, kind, expected]] of Object.entries(cases)) {
  const r = unwrap(new Uint8Array(readFileSync(FX + file)));
  await r.verification;
  const t = sniff(r.data);
  const got = r.layers.map((l) => `${l.type}:${(l.signers || l.timestamps).map((x) => x.status).join(",")}`);
  check(file, innerFileName(r.fileName || file, t.ext) === name && t.kind === kind && got.join(" ") === expected.join(" "),
    `${innerFileName(r.fileName || file, t.ext)} ${t.kind} ${got.join(" ")}`);
}

const scaduto = unwrap(new Uint8Array(readFileSync(FX + "doc_scaduto.pdf.p7m")));
check("certificato scaduto alla data della firma", scaduto.layers[0].signers[0].certStatus === "expired");
const marca = unwrap(new Uint8Array(readFileSync(FX + "doc_marca.pdf.p7m")));
await marca.verification;
check("marca temporale sulla firma", marca.layers[0].signers[0].timestamps[0]?.status === "valid");

for (const [file, words] of [["doc_cifrato.pdf.p7m", "cifrato"], ["doc_detached.pdf.p7s", "detached"]]) {
  let message = "";
  try { unwrap(new Uint8Array(readFileSync(FX + file))); } catch (e) { message = e.message; }
  check(`${file}: messaggio chiaro`, message.includes(words), message.slice(0, 60));
}
