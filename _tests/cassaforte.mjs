// pdf/cassaforte.js contro un Vaultwarden VERO di prova (mai quello aziendale):
//   VW=http://127.0.0.1:8299 node cassaforte.mjs
// Registra un utente finto, crea l'organizzazione con due raccolte, poi entra, scrive e rilegge con cassaforte.js.
// Non sta in run.cjs: serve un Vaultwarden di prova acceso (vedi LEGGIMI del compilatore).
const VW = process.env.VW;
if (!VW) {
  console.log("VW non impostato: prova saltata.");
  process.exit(0);
}
const mem = {};
globalThis.localStorage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); } };
// copia .mjs: senza package.json «type: module» Node leggerebbe il .js come CommonJS
const fs = await import("node:fs");
const copia = new URL("./cassaforte-copia.mjs", import.meta.url);
fs.copyFileSync(new URL("../pdf/cassaforte.js", import.meta.url), copia);
const cf = await import(copia.href);
cf.usaIndirizzo(VW);

const te = new TextEncoder();
const b64 = (u8) => Buffer.from(u8).toString("base64");
let falliti = 0;
const check = (nome, ok, det = "") => {
  console.log(`${ok ? "✔" : "✘"} ${nome}${det ? " — " + det : ""}`);
  if (!ok) falliti++;
};
async function pbkdf2(segreto, sale, giri) {
  const k = await crypto.subtle.importKey("raw", segreto, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: sale, iterations: giri, hash: "SHA-256" }, k, 256));
}
async function hmac(k, d) {
  const kk = await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", kk, d));
}
const espandi = (prk, info) => hmac(prk, Buffer.concat([te.encode(info), Buffer.from([1])]));
async function chiudi(chiaro, k) {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ak = await crypto.subtle.importKey("raw", k.slice(0, 32), "AES-CBC", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ak, chiaro));
  return `2.${b64(iv)}|${b64(ct)}|${b64(await hmac(k.slice(32), Buffer.concat([iv, ct])))}`;
}
async function coppiaRsa(chiave) {
  const kp = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" }, true, ["encrypt", "decrypt"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  return { kp, publicKey: b64(pub), encryptedPrivateKey: await chiudi(priv, chiave) };
}
async function http(percorso, metodo, corpo, token, form = false) {
  const h = { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(VW + percorso, { method: metodo, headers: h, body: corpo ? (form ? new URLSearchParams(corpo).toString() : JSON.stringify(corpo)) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${percorso} ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}

const email = `prova${Date.now()}@carta.test`;
const password = "Prova-carta-1234!";
const nome = "Mario Prova";
// registrazione come la fa Bitwarden
const madre = await pbkdf2(te.encode(password), te.encode(email), 600000);
const hash = b64(await pbkdf2(madre, te.encode(password), 1));
const stirata = new Uint8Array([...(await espandi(madre, "enc")), ...(await espandi(madre, "mac"))]);
const chiaveUtente = crypto.getRandomValues(new Uint8Array(64));
const rsaUtente = await coppiaRsa(chiaveUtente);
await http("/identity/accounts/register", "POST", {
  email, name: nome, masterPasswordHash: hash, masterPasswordHint: null, key: await chiudi(chiaveUtente, stirata),
  kdf: 0, kdfIterations: 600000, keys: { publicKey: rsaUtente.publicKey, encryptedPrivateKey: rsaUtente.encryptedPrivateKey },
});
const tok = (await http("/identity/connect/token", "POST", { grant_type: "password", username: email, password: hash, scope: "api offline_access",
  client_id: "web", deviceType: "21", deviceIdentifier: crypto.randomUUID(), deviceName: "prova" }, null, true)).access_token;
// organizzazione con la raccolta personale e una per tutti
const chiaveOrg = crypto.getRandomValues(new Uint8Array(64));
const orgKeyRsa = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaUtente.kp.publicKey, chiaveOrg));
const rsaOrg = await coppiaRsa(chiaveOrg);
const org = await http("/api/organizations", "POST", { name: "Vinicola di prova", billingEmail: email, planType: 0,
  collectionName: await chiudi(te.encode(nome), chiaveOrg), key: `4.${b64(orgKeyRsa)}`,
  keys: { publicKey: rsaOrg.publicKey, encryptedPrivateKey: rsaOrg.encryptedPrivateKey } }, tok);
const tutti = await http(`/api/organizations/${org.id || org.Id}/collections`, "POST", { name: await chiudi(te.encode("Tutti"), chiaveOrg), groups: [], users: [] }, tok);
check("utente e organizzazione di prova creati", !!(org.id || org.Id) && !!(tutti.id || tutti.Id));

// --- cassaforte.js
check("password sbagliata: messaggio chiaro", await cf.entra(email, "sbagliata").then(() => false, (e) => /sbagliat/.test(e.message)));
check("entra", (await cf.entra(email.toUpperCase(), password)) === "ok" && cf.aperta());
check("nome dell'utente", cf.nomeUtente() === nome, cf.nomeUtente());
const mia = cf.raccoltaPersonale();
check("trova la raccolta col suo nome", !!mia && cf.raccolteScrivibili().find((c) => c.id === mia).nome === nome);
let s = await cf.leggiSchede();
check("all'inizio le voci non ci sono", s.persona === "" && s.azienda === "");
await cf.scriviVoce(cf.VOCE_PERSONA, "- **Nome e cognome**: Mario Prova\n- **E-mail**: mario@prova.it", mia);
await cf.scriviVoce(cf.VOCE_AZIENDA, "Ragione sociale: Vinicola di prova S.p.A.", tutti.id || tutti.Id);
s = await cf.leggiSchede();
check("crea e rilegge la voce personale", s.persona.includes("mario@prova.it"), JSON.stringify(s.persona));
check("crea e rilegge la voce della Vinicola", s.azienda === "Ragione sociale: Vinicola di prova S.p.A.");
await cf.scriviVoce(cf.VOCE_PERSONA, s.persona + "\n- Patente B (da «modulo», 30/10/2026)", mia);
s = await cf.leggiSchede();
check("modifica la voce personale (una sola voce, aggiornata)", s.persona.endsWith("Patente B (da «modulo», 30/10/2026)"));
cf.esci();
check("rientrando la ritrova", (await cf.entra(email, password)) === "ok" && (await cf.leggiSchede()).persona.includes("Patente B"));

// --- codice a 6 cifre (Alessandro ha l'autenticatore)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const segreto = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => B32[b & 31]).join(""); // 160 bit, come vuole Vaultwarden
async function totp(sec) {
  let bit = "";
  for (const c of sec) bit += B32.indexOf(c).toString(2).padStart(5, "0");
  const chiave = new Uint8Array(bit.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const contatore = new Uint8Array(8);
  let t = Math.floor(Date.now() / 30000);
  for (let i = 7; i >= 0; i--) { contatore[i] = t & 255; t = Math.floor(t / 256); }
  const k = await crypto.subtle.importKey("raw", chiave, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", k, contatore));
  const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0");
}
await http("/api/two-factor/authenticator", "POST", { key: segreto, token: await totp(segreto), masterPasswordHash: hash }, tok);
cf.esci();
check("con l'autenticatore chiede il codice", (await cf.entra(email, password)) === "serve-codice");
check("codice sbagliato: messaggio chiaro", await cf.entra(email, password, "000000").then(() => false, (e) => /codice/i.test(e.message)));
await new Promise((r) => setTimeout(r, 31000)); // il codice usato per attivarlo non si riusa: si aspetta il successivo
check("col codice entra", (await cf.entra(email, password, await totp(segreto))) === "ok");
cf.esci();
check("sullo stesso dispositivo se lo ricorda", (await cf.entra(email, password)) === "ok");
console.log(falliti ? `\n✘ ${falliti} controlli falliti` : "\n✔ cassaforte.js funziona con Vaultwarden");
process.exit(falliti ? 1 : 0);
