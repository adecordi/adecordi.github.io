// Un utente finto in un Vaultwarden DI PROVA (mai quello aziendale): registrazione e organizzazione fatte come
// Bitwarden, con la raccolta col suo nome e una «Tutti». Usato da cassaforte.mjs e colleghi.cjs.
const te = new TextEncoder();
const b64 = (u8) => Buffer.from(u8).toString("base64");

export async function pbkdf2(segreto, sale, giri) {
  const k = await crypto.subtle.importKey("raw", segreto, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: sale, iterations: giri, hash: "SHA-256" }, k, 256));
}
async function hmac(k, d) {
  const kk = await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", kk, d));
}
const espandi = (prk, info) => hmac(prk, Buffer.concat([te.encode(info), Buffer.from([1])]));
export async function chiudi(chiaro, k) {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ak = await crypto.subtle.importKey("raw", k.slice(0, 32), "AES-CBC", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ak, chiaro));
  return `2.${b64(iv)}|${b64(ct)}|${b64(await hmac(k.slice(32), Buffer.concat([iv, ct])))}`;
}
async function coppiaRsa(chiave) {
  const kp = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" }, true, ["encrypt", "decrypt"]);
  return { kp, publicKey: b64(new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey))),
    encryptedPrivateKey: await chiudi(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), chiave) };
}
export async function http(vw, percorso, metodo, corpo, token, form = false) {
  const h = { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(vw + percorso, { method: metodo, headers: h, body: corpo ? (form ? new URLSearchParams(corpo).toString() : JSON.stringify(corpo)) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${percorso} ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}

/** -> { email, password, hash, token, org, raccolta, tutti, chiaveOrg } */
export async function creaUtente(vw, nome) {
  const email = `prova${Date.now()}${Math.floor(Math.random() * 1000)}@carta.test`;
  const password = "Prova-carta-1234!";
  const madre = await pbkdf2(te.encode(password), te.encode(email), 600000);
  const hash = b64(await pbkdf2(madre, te.encode(password), 1));
  const stirata = new Uint8Array([...(await espandi(madre, "enc")), ...(await espandi(madre, "mac"))]);
  const chiaveUtente = crypto.getRandomValues(new Uint8Array(64));
  const rsa = await coppiaRsa(chiaveUtente);
  await http(vw, "/identity/accounts/register", "POST", {
    email, name: nome, masterPasswordHash: hash, masterPasswordHint: null, key: await chiudi(chiaveUtente, stirata),
    kdf: 0, kdfIterations: 600000, keys: { publicKey: rsa.publicKey, encryptedPrivateKey: rsa.encryptedPrivateKey },
  });
  const token = (await http(vw, "/identity/connect/token", "POST", { grant_type: "password", username: email, password: hash,
    scope: "api offline_access", client_id: "web", deviceType: "21", deviceIdentifier: crypto.randomUUID(), deviceName: "prova" }, null, true)).access_token;
  const chiaveOrg = crypto.getRandomValues(new Uint8Array(64));
  const rsaOrg = await coppiaRsa(chiaveOrg);
  const org = await http(vw, "/api/organizations", "POST", { name: "Vinicola di prova", billingEmail: email, planType: 0,
    collectionName: await chiudi(te.encode(nome), chiaveOrg),
    key: `4.${b64(new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa.kp.publicKey, chiaveOrg)))}`,
    keys: { publicKey: rsaOrg.publicKey, encryptedPrivateKey: rsaOrg.encryptedPrivateKey } }, token);
  const orgId = org.id || org.Id;
  const tutti = await http(vw, `/api/organizations/${orgId}/collections`, "POST", { name: await chiudi(te.encode("Tutti"), chiaveOrg), groups: [], users: [] }, token);
  return { email, password, hash, token, org: orgId, tutti: tutti.id || tutti.Id, chiaveOrg };
}
