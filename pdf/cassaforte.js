// Cassaforte aziendale (Vaultwarden, https://cassaforte.it.fo) aperta DAL BROWSER, come fa l'app di Bitwarden:
// la password e i dati in chiaro restano su questo dispositivo; al server arrivano solo dati cifrati (30/10/2026).
// Due voci, note sicure dell'organizzazione:
//   «Dati per i moduli (C.A.R.T.A.)»               nella raccolta col nome di chi compila
//   «Dati della Vinicola per i moduli (C.A.R.T.A.)» in una raccolta che vedono tutti
// La sessione resta solo in memoria: chiudendo o ricaricando la pagina si rientra con la password.

export let URL_CASSAFORTE = "https://cassaforte.it.fo";
/** Solo per le prove (un Vaultwarden di prova). */
export function usaIndirizzo(u) {
  URL_CASSAFORTE = u;
}
export const VOCE_PERSONA = "Dati per i moduli (C.A.R.T.A.)";
export const VOCE_AZIENDA = "Dati della Vinicola per i moduli (C.A.R.T.A.)";
const STORE = "lettore-cassaforte"; // { email, raccolta: {<email>: id}, ricorda2fa: {<email>: token} } - niente segreti veri

const te = new TextEncoder();
const td = new TextDecoder();

/* ---------------------------------------------------------- Cifratura */

function b64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const unisci = (...parti) => {
  const out = new Uint8Array(parti.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parti) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};

async function pbkdf2(segreto, sale, giri) {
  const k = await crypto.subtle.importKey("raw", segreto, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: sale, iterations: giri, hash: "SHA-256" }, k, 256));
}
async function hmac(chiave, dati) {
  const k = await crypto.subtle.importKey("raw", chiave, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, dati));
}
// HKDF-Expand per 32 byte (un solo blocco), come Bitwarden per «stirare» la chiave principale
const espandi = (prk, info) => hmac(prk, unisci(te.encode(info), new Uint8Array([1])));

/** Stringa cifrata di tipo 2 (AES-256-CBC + HMAC-SHA256) -> byte in chiaro. chiave = 64 byte (cifra + firma). */
async function apri(cifrata, chiave) {
  const punto = cifrata.indexOf(".");
  if (cifrata.slice(0, punto) !== "2") throw new Error("Formato della cassaforte non previsto.");
  const [iv, ct, mac] = cifrata.slice(punto + 1).split("|").map(unb64);
  const atteso = await hmac(chiave.slice(32, 64), unisci(iv, ct));
  if (atteso.length !== mac.length || atteso.some((b, i) => b !== mac[i])) throw new Error("Dato della cassaforte alterato o chiave sbagliata.");
  const k = await crypto.subtle.importKey("raw", chiave.slice(0, 32), "AES-CBC", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, k, ct));
}
async function chiudi(chiaro, chiave) {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const k = await crypto.subtle.importKey("raw", chiave.slice(0, 32), "AES-CBC", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, k, chiaro));
  const mac = await hmac(chiave.slice(32, 64), unisci(iv, ct));
  return `2.${b64(iv)}|${b64(ct)}|${b64(mac)}`;
}
const apriTesto = async (c, k) => (c ? td.decode(await apri(c, k)) : "");
const chiudiTesto = (t, k) => chiudi(te.encode(t), k);

/* ---------------------------------------------------------- Server */

let sessione = null; // { email, token, chiaveUtente, orgs: {id: chiave}, profilo, sync }

function memoria() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || "{}");
  } catch {
    return {};
  }
}
function salvaMemoria(m) {
  try {
    localStorage.setItem(STORE, JSON.stringify(m));
  } catch { /* niente */ }
}
function dispositivo() {
  const m = memoria();
  if (!m.dispositivo) {
    m.dispositivo = crypto.randomUUID();
    salvaMemoria(m);
  }
  return m.dispositivo;
}

async function chiama(percorso, { metodo = "GET", json, form, token } = {}) {
  const headers = {};
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  }
  if (token) headers.Authorization = "Bearer " + token;
  let res;
  try {
    res = await fetch(URL_CASSAFORTE + percorso, { method: metodo, headers, body });
  } catch {
    throw new Error("Non raggiungo la cassaforte aziendale: controlla la connessione.");
  }
  const out = await res.json().catch(() => ({}));
  return { ok: res.ok, stato: res.status, out };
}

export const aperta = () => !!sessione;
export const emailRicordata = () => memoria().email || "";

/**
 * Entra nella cassaforte. codice = quello a 6 cifre dell'app di autenticazione, se l'account lo chiede.
 * Ritorna "ok" | "serve-codice". Errori con un messaggio da mostrare.
 */
export async function entra(email, password, codice = "") {
  email = email.trim().toLowerCase();
  const pre = await chiama("/identity/accounts/prelogin", { metodo: "POST", json: { email } });
  if (!pre.ok) throw new Error("La cassaforte non risponde come previsto.");
  const kdf = pre.out.kdf ?? pre.out.Kdf ?? 0;
  const giri = pre.out.kdfIterations ?? pre.out.KdfIterations ?? 600000;
  if (kdf !== 0) throw new Error("Il tuo account usa la protezione Argon2, che C.A.R.T.A. non sa ancora aprire: avvisa Alessandro.");
  const chiaveMadre = await pbkdf2(te.encode(password), te.encode(email), giri);
  const hashMadre = b64(await pbkdf2(chiaveMadre, te.encode(password), 1));
  const m = memoria();
  const form = {
    grant_type: "password", username: email, password: hashMadre, scope: "api offline_access", client_id: "web",
    deviceType: "21", deviceIdentifier: dispositivo(), deviceName: "C.A.R.T.A.",
  };
  if (codice) Object.assign(form, { twoFactorToken: codice.replace(/\s/g, ""), twoFactorProvider: "0", twoFactorRemember: "1" });
  else if (m.ricorda2fa && m.ricorda2fa[email]) Object.assign(form, { twoFactorToken: m.ricorda2fa[email], twoFactorProvider: "5", twoFactorRemember: "0" });
  const r = await chiama("/identity/connect/token", { metodo: "POST", form });
  if (!r.ok) {
    if (r.out.TwoFactorProviders || r.out.TwoFactorProviders2) {
      if (m.ricorda2fa && m.ricorda2fa[email] && !codice) { // il «ricordami» è scaduto: si chiede il codice
        delete m.ricorda2fa[email];
        salvaMemoria(m);
      }
      if (codice) throw new Error("Codice a 6 cifre non valido: riprova con quello nuovo.");
      return "serve-codice";
    }
    const msg = (r.out.ErrorModel && r.out.ErrorModel.Message) || r.out.error_description || r.out.message || "";
    if (r.stato === 429 || /too many/i.test(msg)) throw new Error("Troppi tentativi di accesso: aspetta un minuto e riprova.");
    if (codice && !/username or password/i.test(msg)) throw new Error("Codice a 6 cifre non valido: riprova con quello nuovo.");
    throw new Error(/username|password/i.test(msg) || r.stato === 400 ? "E-mail o password della cassaforte sbagliate." : `Accesso non riuscito (${msg || r.stato}).`);
  }
  if (r.out.TwoFactorToken) {
    m.ricorda2fa = { ...(m.ricorda2fa || {}), [email]: r.out.TwoFactorToken };
  }
  // chiave madre «stirata» -> chiave dell'utente -> chiave privata -> chiavi delle organizzazioni
  const stirata = unisci(await espandi(chiaveMadre, "enc"), await espandi(chiaveMadre, "mac"));
  const chiaveUtente = await apri(r.out.Key, stirata);
  sessione = { email, token: r.out.access_token, chiaveUtente, privata: r.out.PrivateKey };
  m.email = email;
  salvaMemoria(m);
  await sincronizza();
  return "ok";
}

export function esci() {
  sessione = null;
}

async function sincronizza() {
  const r = await chiama("/api/sync?excludeDomains=true", { token: sessione.token });
  if (r.stato === 401) {
    sessione = null;
    throw new Error("La sessione della cassaforte è scaduta: rientra.");
  }
  if (!r.ok) throw new Error(`La cassaforte ha risposto con un errore (${r.stato}).`);
  const s = r.out;
  const profilo = s.profile || s.Profile || {};
  const privata = await crypto.subtle.importKey("pkcs8", await apri(profilo.privateKey || sessione.privata, sessione.chiaveUtente),
    { name: "RSA-OAEP", hash: "SHA-1" }, false, ["decrypt"]);
  const orgs = {};
  for (const o of profilo.organizations || []) {
    const dati = unb64(String(o.key).split(".")[1].split("|")[0]);
    orgs[o.id] = { chiave: new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privata, dati)), tipo: o.type, nome: o.name };
  }
  const raccolte = [];
  for (const c of s.collections || []) {
    const org = orgs[c.organizationId];
    if (!org) continue;
    raccolte.push({ id: c.id, org: c.organizationId, nome: await apriTesto(c.name, org.chiave).catch(() => "?"), solaLettura: !!c.readOnly });
  }
  Object.assign(sessione, { orgs, raccolte, voci: s.ciphers || [], nome: profilo.name || "", proprietario: Object.values(orgs).some((o) => o.tipo === 0 || o.tipo === 1) });
}

async function chiaveVoce(v) {
  const org = sessione.orgs[v.organizationId];
  const base = org ? org.chiave : sessione.chiaveUtente;
  return v.key ? apri(v.key, base) : base;
}

// Le voci con quel nome (decifrato), facoltativamente solo in una raccolta.
async function trova(nome, raccolta = null) {
  const out = [];
  for (const v of sessione.voci) {
    if (v.deletedDate || v.type !== 2) continue;
    if (raccolta && !(v.collectionIds || []).includes(raccolta)) continue;
    try {
      const k = await chiaveVoce(v);
      if ((await apriTesto(v.name, k)) === nome) out.push({ v, k });
    } catch { /* voce che non si apre: si salta */ }
  }
  return out;
}

/** La raccolta personale: quella col nome di chi entra (o scelta una volta e ricordata). */
export function raccoltaPersonale() {
  const m = memoria();
  const scelta = m.raccolta && m.raccolta[sessione.email];
  const scrivibili = sessione.raccolte.filter((c) => !c.solaLettura);
  if (scelta && scrivibili.some((c) => c.id === scelta)) return scelta;
  const norm = (s) => s.toLowerCase().replace(/[^a-zàèéìòù]/g, "");
  const chi = norm(sessione.nome || sessione.email.split("@")[0]);
  const mie = scrivibili.filter((c) => chi && (norm(c.nome) === chi || norm(c.nome).includes(chi) || chi.includes(norm(c.nome))));
  return mie.length === 1 ? mie[0].id : null;
}
export function scegliRaccolta(id) {
  const m = memoria();
  m.raccolta = { ...(m.raccolta || {}), [sessione.email]: id };
  salvaMemoria(m);
}
export const raccolteScrivibili = () => sessione.raccolte.filter((c) => !c.solaLettura);
export const nomeUtente = () => (sessione ? sessione.nome : "");
export const proprietario = () => !!(sessione && sessione.proprietario);

/** {persona, azienda}: i testi delle due voci ("" se mancano). Si risincronizza ogni volta. */
export async function leggiSchede() {
  await sincronizza();
  const raccolta = raccoltaPersonale();
  const persona = raccolta ? (await trova(VOCE_PERSONA, raccolta))[0] : null;
  const azienda = (await trova(VOCE_AZIENDA))[0];
  return {
    persona: persona ? await apriTesto(persona.v.notes, persona.k) : "",
    azienda: azienda ? await apriTesto(azienda.v.notes, azienda.k) : "",
    raccolta,
  };
}

/** Scrive (o crea) una delle due voci. raccolta: dove crearla se non c'è. */
export async function scriviVoce(nome, testo, raccolta) {
  await sincronizza();
  const esistente = (await trova(nome, nome === VOCE_PERSONA ? raccolta : null))[0];
  if (esistente) {
    const { v, k } = esistente;
    const corpo = {
      type: 2, organizationId: v.organizationId, folderId: v.folderId || null, favorite: !!v.favorite, reprompt: v.reprompt || 0,
      name: v.name, notes: await chiudiTesto(testo, k), secureNote: { type: 0 }, fields: v.fields || null, key: v.key || null,
      lastKnownRevisionDate: v.revisionDate,
    };
    const r = await chiama(`/api/ciphers/${v.id}`, { metodo: "PUT", json: corpo, token: sessione.token });
    if (!r.ok) throw new Error(`Non riesco a salvare nella cassaforte (${(r.out.ErrorModel && r.out.ErrorModel.Message) || r.stato}).`);
    return;
  }
  const c = sessione.raccolte.find((x) => x.id === raccolta);
  if (!c) throw new Error("Non so in quale raccolta della cassaforte salvare.");
  const k = sessione.orgs[c.org].chiave;
  const corpo = {
    cipher: { type: 2, organizationId: c.org, name: await chiudiTesto(nome, k), notes: await chiudiTesto(testo, k),
      secureNote: { type: 0 }, favorite: false, reprompt: 0, folderId: null, fields: null, login: null },
    collectionIds: [c.id],
  };
  const r = await chiama("/api/ciphers/create", { metodo: "POST", json: corpo, token: sessione.token });
  if (!r.ok) throw new Error(`Non riesco a creare la voce nella cassaforte (${(r.out.ErrorModel && r.out.ErrorModel.Message) || r.stato}).`);
}
