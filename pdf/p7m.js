// Estrazione del documento da buste firmate CAdES (.p7m), marche temporali
// (.tsd, .m7m) e verifica crittografica di base delle firme.
// Tutto avviene nel browser: nessun dato lascia il dispositivo.

const OID = {
  signedData: "1.2.840.113549.1.7.2",
  envelopedData: "1.2.840.113549.1.7.3",
  authEnvelopedData: "1.2.840.113549.1.9.16.1.23",
  timeStampedData: "1.2.840.113549.1.9.16.1.31",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  counterSignature: "1.2.840.113549.1.9.6",
  timeStampToken: "1.2.840.113549.1.9.16.2.14",
  subjectKeyId: "2.5.29.14",
  qcStatements: "1.3.6.1.5.5.7.1.3",
  qcCompliance: "0.4.0.1862.1.1",
  qcSSCD: "0.4.0.1862.1.4",
};

const HASHES = {
  "1.3.14.3.2.26": "SHA-1",
  "2.16.840.1.101.3.4.2.1": "SHA-256",
  "2.16.840.1.101.3.4.2.2": "SHA-384",
  "2.16.840.1.101.3.4.2.3": "SHA-512",
};

const SIG_ALGS = {
  "1.2.840.113549.1.1.1": { name: "RSASSA-PKCS1-v1_5", label: "RSA" },
  "1.2.840.113549.1.1.5": { name: "RSASSA-PKCS1-v1_5", label: "RSA", hash: "SHA-1" },
  "1.2.840.113549.1.1.11": { name: "RSASSA-PKCS1-v1_5", label: "RSA", hash: "SHA-256" },
  "1.2.840.113549.1.1.12": { name: "RSASSA-PKCS1-v1_5", label: "RSA", hash: "SHA-384" },
  "1.2.840.113549.1.1.13": { name: "RSASSA-PKCS1-v1_5", label: "RSA", hash: "SHA-512" },
  "1.2.840.113549.1.1.10": { name: "RSA-PSS", label: "RSA-PSS" },
  "1.2.840.10045.2.1": { name: "ECDSA", label: "ECDSA" },
  "1.2.840.10045.4.1": { name: "ECDSA", label: "ECDSA", hash: "SHA-1" },
  "1.2.840.10045.4.3.2": { name: "ECDSA", label: "ECDSA", hash: "SHA-256" },
  "1.2.840.10045.4.3.3": { name: "ECDSA", label: "ECDSA", hash: "SHA-384" },
  "1.2.840.10045.4.3.4": { name: "ECDSA", label: "ECDSA", hash: "SHA-512" },
};

const CURVES = {
  "1.2.840.10045.3.1.7": { name: "P-256", size: 32 },
  "1.3.132.0.34": { name: "P-384", size: 48 },
  "1.3.132.0.35": { name: "P-521", size: 66 },
};

const DN_NAMES = {
  "2.5.4.3": "CN",
  "2.5.4.4": "SN",
  "2.5.4.42": "GN",
  "2.5.4.5": "serialNumber",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.12": "T",
  "2.5.4.46": "dnQualifier",
  "2.5.4.65": "pseudonym",
  "2.5.4.97": "organizationIdentifier",
  "1.2.840.113549.1.9.1": "E",
};

const MAX_LAYERS = 16;

/* ---------------------------------------------------------------- ASN.1 */

class Asn1Error extends Error {}

function parseNode(buf, pos, limit = buf.length, depth = 0) {
  if (depth > 64) throw new Asn1Error("Struttura ASN.1 troppo annidata");
  const start = pos;
  if (pos + 2 > limit) throw new Asn1Error("Dati ASN.1 troncati");
  const first = buf[pos++];
  let num = first & 0x1f;
  if (num === 0x1f) {
    num = 0;
    let b;
    do {
      if (pos >= limit) throw new Asn1Error("Tag ASN.1 non valido");
      b = buf[pos++];
      num = num * 128 + (b & 0x7f);
    } while (b & 0x80);
  }
  if (pos >= limit) throw new Asn1Error("Dati ASN.1 troncati");
  let len = buf[pos++];
  const node = { buf, start, cls: first >> 6, cons: (first & 0x20) !== 0, num, indef: false };
  if (len === 0x80) {
    // Lunghezza indefinita (BER): il contenuto termina con 00 00.
    if (!node.cons) throw new Asn1Error("Lunghezza indefinita su tipo primitivo");
    node.indef = true;
    node.contentStart = pos;
    let p = pos;
    for (;;) {
      if (p + 2 > limit) throw new Asn1Error("Fine contenuto ASN.1 mancante");
      if (buf[p] === 0 && buf[p + 1] === 0) break;
      p = parseNode(buf, p, limit, depth + 1).end;
    }
    node.contentEnd = p;
    node.end = p + 2;
  } else {
    if (len > 0x80) {
      const n = len & 0x7f;
      if (n > 6 || pos + n > limit) throw new Asn1Error("Lunghezza ASN.1 non valida");
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + buf[pos++];
    }
    node.contentStart = pos;
    node.contentEnd = node.end = pos + len;
    if (node.end > limit) throw new Asn1Error("Dati ASN.1 troncati");
  }
  return node;
}

function children(node) {
  const out = [];
  if (!node.cons) return out;
  let p = node.contentStart;
  while (p < node.contentEnd) {
    const child = parseNode(node.buf, p, node.contentEnd);
    out.push(child);
    p = child.end;
  }
  return out;
}

const isUniv = (n, num) => !!n && n.cls === 0 && n.num === num;
const isCtx = (n, num) => !!n && n.cls === 2 && n.num === num;
const content = (n) => n.buf.subarray(n.contentStart, n.contentEnd);
const raw = (n) => n.buf.subarray(n.start, n.end);
// Il contenuto di un nodo OCTET/BIT STRING interpretato a sua volta come DER.
const inner = (n) => parseNode(n.buf, n.contentStart, n.contentEnd);

// OCTET STRING, anche nella forma BER "costruita" (a blocchi).
function octets(node) {
  if (!node.cons) return content(node);
  return concat(children(node).map(octets));
}

function decodeOid(node) {
  const b = content(node);
  const arcs = [];
  let v = 0;
  for (let i = 0; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      arcs.push(v);
      v = 0;
    }
  }
  if (!arcs.length) return "";
  const head = arcs.shift();
  const top = head < 40 ? 0 : head < 80 ? 1 : 2;
  return [top, head - top * 40, ...arcs].join(".");
}

function decodeString(node) {
  const b = content(node);
  switch (node.num) {
    case 12: // UTF8String
      return new TextDecoder("utf-8").decode(b);
    case 30: // BMPString
      return new TextDecoder("utf-16be").decode(b);
    case 28: { // UniversalString
      let s = "";
      for (let i = 0; i + 3 < b.length; i += 4) {
        s += String.fromCodePoint(((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0);
      }
      return s;
    }
    default: // Printable, IA5, T61, Visible, Numeric...
      return bytesToLatin1(b);
  }
}

function decodeTime(node) {
  if (!node) return null;
  const s = bytesToLatin1(content(node)).trim();
  let m;
  if (node.num === 23) { // UTCTime
    m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(Z|[+-]\d{4})?$/.exec(s);
    if (!m) return null;
    const yy = +m[1];
    return makeDate(yy < 50 ? 2000 + yy : 1900 + yy, m[2], m[3], m[4], m[5], m[6], null, m[7]);
  }
  if (node.num === 24) { // GeneralizedTime
    m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)?(\d\d)?(?:[.,](\d+))?(Z|[+-]\d{4})?$/.exec(s);
    if (!m) return null;
    return makeDate(+m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
  }
  return null;
}

function makeDate(y, mo, d, h, mi, sec, frac, tz) {
  let t = Date.UTC(y, +mo - 1, +d, +h, +(mi || 0), +(sec || 0), frac ? Math.round(+("0." + frac) * 1000) : 0);
  if (tz && tz !== "Z") {
    const sign = tz[0] === "+" ? 1 : -1;
    t -= sign * (+tz.slice(1, 3) * 60 + +tz.slice(3, 5)) * 60000;
  }
  return new Date(t);
}

/* ------------------------------------------------------------ Utilità */

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function bytesToLatin1(b) {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  }
  return s;
}

function latin1ToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function base64ToBytes(s) {
  return latin1ToBytes(atob(s.replace(/[^A-Za-z0-9+/=]/g, "")));
}

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function intHex(b) {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return toHex(b.subarray(i));
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ------------------------------------------------------ Strutture CMS */

function parseContentInfo(buf) {
  const node = parseNode(buf, 0);
  if (!isUniv(node, 16)) return null;
  const [type, body] = children(node);
  if (!isUniv(type, 6)) return null;
  return { type: decodeOid(type), body: isCtx(body, 0) ? children(body)[0] : null, node };
}

function parseName(node) {
  const attrs = {};
  const list = [];
  for (const rdn of children(node)) {
    for (const atv of children(rdn)) {
      const [t, v] = children(atv);
      const id = decodeOid(t);
      const key = DN_NAMES[id] || id;
      const value = decodeString(v);
      (attrs[key] = attrs[key] || []).push(value);
      list.push([key, value]);
    }
  }
  return { attrs, list, raw: raw(node), text: list.map(([k, v]) => `${k}=${v}`).join(", ") };
}

function parseCertificate(node) {
  const tbs = children(node)[0];
  const f = children(tbs);
  let i = 0;
  if (isCtx(f[0], 0)) i++; // versione
  const serial = f[i++];
  i++; // algoritmo di firma
  const issuer = parseName(f[i++]);
  const [notBefore, notAfter] = children(f[i++]);
  const subject = parseName(f[i++]);
  const spki = f[i++];
  const spkiAlg = children(children(spki)[0]);
  const cert = {
    serialHex: intHex(content(serial)),
    issuer,
    subject,
    notBefore: decodeTime(notBefore),
    notAfter: decodeTime(notAfter),
    spki: raw(spki),
    keyAlg: decodeOid(spkiAlg[0]),
    keyParam: isUniv(spkiAlg[1], 6) ? decodeOid(spkiAlg[1]) : null,
    ski: null,
    qcStatements: [],
  };
  for (; i < f.length; i++) {
    if (!isCtx(f[i], 3)) continue;
    for (const ext of children(children(f[i])[0])) {
      try {
        const parts = children(ext);
        const id = decodeOid(parts[0]);
        const value = parts[parts.length - 1];
        if (id === OID.subjectKeyId) {
          cert.ski = toHex(content(inner(value)));
        } else if (id === OID.qcStatements) {
          for (const st of children(inner(value))) cert.qcStatements.push(decodeOid(children(st)[0]));
        }
      } catch {
        // Estensione malformata: la ignoriamo.
      }
    }
  }
  return cert;
}

function parseAttributes(node) {
  const map = new Map();
  for (const attr of children(node)) {
    const [type, values] = children(attr);
    map.set(decodeOid(type), children(values));
  }
  return map;
}

function parseSignerInfo(node) {
  const f = children(node);
  let i = 1; // versione
  const sidNode = f[i++];
  let sid;
  if (isCtx(sidNode, 0)) {
    sid = { ski: toHex(content(sidNode)) };
  } else {
    const [issuer, serial] = children(sidNode);
    sid = { issuerRaw: raw(issuer), serialHex: intHex(content(serial)) };
  }
  const digestAlg = decodeOid(children(f[i++])[0]);
  const signedAttrsNode = isCtx(f[i], 0) ? f[i++] : null;
  const sigAlgParts = children(f[i++]);
  const signature = octets(f[i++]);
  const unsignedAttrsNode = isCtx(f[i], 1) ? f[i] : null;

  const attrs = signedAttrsNode ? parseAttributes(signedAttrsNode) : new Map();
  const uattrs = unsignedAttrsNode ? parseAttributes(unsignedAttrsNode) : new Map();
  const md = attrs.get(OID.messageDigest);
  const st = attrs.get(OID.signingTime);
  const timestamps = [];
  for (const tok of uattrs.get(OID.timeStampToken) || []) {
    try {
      const ts = parseTimeStampToken(raw(tok));
      if (ts) timestamps.push(ts);
    } catch {
      // Marca temporale illeggibile: la ignoriamo.
    }
  }
  return {
    sid,
    digestAlg,
    signedAttrsNode,
    sigAlg: decodeOid(sigAlgParts[0]),
    sigAlgParams: sigAlgParts[1] || null,
    signature,
    messageDigest: md && md[0] ? content(md[0]) : null,
    signingTime: st && st[0] ? decodeTime(st[0]) : null,
    timestamps,
    counterSignatures: (uattrs.get(OID.counterSignature) || []).length,
  };
}

function parseSignedData(node) {
  const f = children(node);
  let i = 2; // versione, digestAlgorithms
  const eci = children(f[i++]);
  const eContentType = decodeOid(eci[0]);
  let data = null;
  if (isCtx(eci[1], 0)) {
    const v = children(eci[1])[0];
    data = !v ? new Uint8Array(0) : isUniv(v, 4) ? octets(v) : content(eci[1]);
  }
  const certs = [];
  const signers = [];
  for (; i < f.length; i++) {
    const n = f[i];
    if (isCtx(n, 0)) {
      for (const c of children(n)) {
        if (!isUniv(c, 16)) continue;
        try {
          certs.push(parseCertificate(c));
        } catch {
          // Certificato non interpretabile: lo saltiamo.
        }
      }
    } else if (isUniv(n, 17)) {
      for (const si of children(n)) signers.push(parseSignerInfo(si));
    }
  }
  return { eContentType, data, certs, signers };
}

function parseTimeStampToken(buf) {
  const ci = parseContentInfo(buf);
  if (!ci || ci.type !== OID.signedData || !ci.body) return null;
  const sd = parseSignedData(ci.body);
  if (sd.eContentType !== OID.tstInfo || !sd.data) return null;
  const f = children(parseNode(sd.data, 0));
  // TSTInfo: version, policy, messageImprint, serialNumber, genTime, ...
  const imprint = children(f[2]);
  const signer = sd.signers[0];
  const cert = signer ? findCert(signer.sid, sd.certs) : null;
  return {
    time: decodeTime(f[4]),
    imprintHash: HASHES[decodeOid(children(imprint[0])[0])] || null,
    imprint: content(imprint[1]),
    tsa: cert ? displayName(cert.subject) : null,
    sd,
  };
}

// Cerca token di marca temporale (ContentInfo SignedData) dentro una struttura.
function findTimeStampTokens(node, out, depth = 0) {
  if (depth > 4 || !node.cons) return out;
  for (const ch of children(node)) {
    if (!ch.cons) continue;
    const k = children(ch);
    if (isUniv(k[0], 6) && decodeOid(k[0]) === OID.signedData) {
      try {
        const ts = parseTimeStampToken(raw(ch));
        if (ts) out.push(ts);
      } catch {
        // ignorato
      }
    } else {
      findTimeStampTokens(ch, out, depth + 1);
    }
  }
  return out;
}

// RFC 5544 TimeStampedData (.tsd)
function parseTimeStampedData(node) {
  let data = null;
  let fileName = null;
  let metaData = null;
  let hashProtected = false;
  const timestamps = [];
  for (const c of children(node)) {
    if (isUniv(c, 4)) {
      data = octets(c);
    } else if (isUniv(c, 16)) { // metaData
      metaData = raw(c);
      for (const m of children(c)) {
        if (isUniv(m, 1)) hashProtected = content(m)[0] !== 0;
        else if (isUniv(m, 12)) fileName = decodeString(m);
      }
    } else if (isCtx(c, 0)) { // temporalEvidence
      findTimeStampTokens(c, timestamps);
    }
  }
  // Con hashProtected la marca copre anche i metadati.
  const stamped = data && hashProtected && metaData ? [data, concat([data, metaData]), concat([metaData, data])] : [data];
  return { data, fileName, timestamps, stamped };
}

/* ----------------------------------------------------------------- MIME */

function parseMime(text) {
  const sep = /\r?\n\r?\n/.exec(text);
  const head = sep ? text.slice(0, sep.index) : text;
  const body = sep ? text.slice(sep.index + sep[0].length) : "";
  const boundary = /boundary\s*=\s*"?([^";\r\n]+)"?/i.exec(head);
  if (boundary && /multipart\//i.test(head)) {
    const parts = [];
    const segments = body.split("--" + boundary[1].trim());
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].startsWith("--")) break;
      parts.push(...parseMime(segments[i].replace(/^\r?\n/, "")));
    }
    return parts;
  }
  const bytes = /content-transfer-encoding\s*:\s*base64/i.test(head)
    ? base64ToBytes(body)
    : latin1ToBytes(body.replace(/\r?\n$/, ""));
  return [{ head, bytes }];
}

/* ------------------------------------------------------------- Verifica */

function findCert(sid, certs) {
  if (sid.ski) return certs.find((c) => c.ski === sid.ski) || null;
  return (
    certs.find((c) => c.serialHex === sid.serialHex && equalBytes(c.issuer.raw, sid.issuerRaw)) ||
    certs.find((c) => c.serialHex === sid.serialHex) ||
    null
  );
}

function ecdsaDerToRaw(der, size) {
  const [r, s] = children(parseNode(der, 0));
  const out = new Uint8Array(size * 2);
  [r, s].forEach((n, idx) => {
    let v = content(n);
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error("Firma ECDSA non valida");
    out.set(v, idx * size + size - v.length);
  });
  return out;
}

function pssParams(paramsNode) {
  let hash = "SHA-1";
  let saltLength = 20;
  if (paramsNode && paramsNode.cons) {
    for (const p of children(paramsNode)) {
      if (isCtx(p, 0)) hash = HASHES[decodeOid(children(children(p)[0])[0])] || null;
      else if (isCtx(p, 2)) saltLength = parseInt(intHex(content(children(p)[0])), 16);
    }
  }
  return { hash, saltLength };
}

async function verifyRawSignature(signer, cert, hash, signedBytes) {
  const alg = SIG_ALGS[signer.sigAlg];
  if (!alg) throw new Unverifiable(`algoritmo di firma non supportato (${signer.sigAlg})`);
  const sigHash = alg.hash || hash;
  const subtle = crypto.subtle;
  if (alg.name === "RSASSA-PKCS1-v1_5") {
    const key = await subtle.importKey("spki", cert.spki, { name: alg.name, hash: sigHash }, false, ["verify"]);
    return subtle.verify({ name: alg.name }, key, signer.signature, signedBytes);
  }
  if (alg.name === "RSA-PSS") {
    const p = pssParams(signer.sigAlgParams);
    if (!p.hash) throw new Unverifiable("parametri RSA-PSS non supportati");
    const key = await subtle.importKey("spki", cert.spki, { name: alg.name, hash: p.hash }, false, ["verify"]);
    return subtle.verify({ name: alg.name, saltLength: p.saltLength }, key, signer.signature, signedBytes);
  }
  const curve = CURVES[cert.keyParam];
  if (!curve) throw new Unverifiable("curva ellittica non supportata dal browser");
  const key = await subtle.importKey("spki", cert.spki, { name: "ECDSA", namedCurve: curve.name }, false, ["verify"]);
  const sig = ecdsaDerToRaw(signer.signature, curve.size);
  return subtle.verify({ name: "ECDSA", hash: sigHash }, key, sig, signedBytes);
}

class Unverifiable extends Error {}

// Impronte già calcolate: con più firme sullo stesso contenuto si calcolano una volta sola.
const digestCache = new WeakMap();
function digest(hash, bytes) {
  let byHash = digestCache.get(bytes);
  if (!byHash) digestCache.set(bytes, (byHash = new Map()));
  let result = byHash.get(hash);
  if (!result) byHash.set(hash, (result = crypto.subtle.digest(hash, bytes).then((d) => new Uint8Array(d))));
  return result;
}

// Esito: { status: "valid" | "invalid" | "unknown", message }
async function verifySigner(signer, cert, data) {
  if (!cert) return { status: "unknown", message: "Il certificato del firmatario non è incluso nel file." };
  if (!globalThis.crypto || !crypto.subtle) {
    return { status: "unknown", message: "Verifica non disponibile: apri il lettore tramite HTTPS." };
  }
  const hash = HASHES[signer.digestAlg];
  if (!hash) return { status: "unknown", message: `Algoritmo di impronta non supportato (${signer.digestAlg}).` };
  try {
    let signedBytes = data;
    if (signer.signedAttrsNode) {
      if (!signer.messageDigest) return { status: "invalid", message: "Manca l'impronta del documento negli attributi firmati." };
      if (!equalBytes(await digest(hash, data), signer.messageDigest)) {
        return { status: "invalid", message: "L'impronta non corrisponde: il documento è stato modificato dopo la firma." };
      }
      if (signer.signedAttrsNode.indef) throw new Unverifiable("attributi firmati non in formato DER");
      // La firma è calcolata sugli attributi codificati come SET (tag 0x31).
      signedBytes = raw(signer.signedAttrsNode).slice();
      signedBytes[0] = 0x31;
    }
    const ok = await verifyRawSignature(signer, cert, hash, signedBytes);
    return ok
      ? { status: "valid", message: "La firma è integra: il documento non è stato modificato dopo la firma." }
      : { status: "invalid", message: "La firma non corrisponde al certificato: file alterato o firma corrotta." };
  } catch (e) {
    const why = e instanceof Unverifiable ? e.message : (e && e.message) || String(e);
    return { status: "unknown", message: `Impossibile verificare la firma: ${why}.` };
  }
}

// `stamped`: i dati (o le possibili varianti dei dati) coperti dalla marca.
async function verifyTimestamp(ts, stamped) {
  const signer = ts.sd.signers[0];
  if (!signer) return { status: "unknown", message: "Marca temporale priva di firma." };
  if (!ts.imprintHash || !globalThis.crypto || !crypto.subtle) {
    return { status: "unknown", message: "Impossibile verificare la marca temporale." };
  }
  let matches = false;
  for (const bytes of Array.isArray(stamped) ? stamped : [stamped]) {
    if (equalBytes(await digest(ts.imprintHash, bytes), ts.imprint)) matches = true;
  }
  if (!matches) {
    return { status: "invalid", message: "La marca temporale non si riferisce a questo contenuto." };
  }
  const r = await verifySigner(signer, findCert(signer.sid, ts.sd.certs), ts.sd.data);
  if (r.status === "valid") r.message = "Marca temporale integra e riferita a questo contenuto.";
  return r;
}

function signatureLabel(signer) {
  const alg = SIG_ALGS[signer.sigAlg];
  const hash = (alg && alg.hash) || HASHES[signer.digestAlg] || signer.digestAlg;
  return `${hash} con ${alg ? alg.label : signer.sigAlg}`;
}

export function displayName(name) {
  const a = name.attrs;
  if (a.GN && a.SN) return `${a.GN[0]} ${a.SN[0]}`;
  if (a.CN) return a.CN[0];
  if (a.O) return a.O[0];
  return name.text;
}

const PENDING = { status: "pending", message: "Verifica in corso…" };

// Esegue una verifica e ne copia l'esito in `target` (che inizialmente è "pending").
function settle(target, verification) {
  return verification
    .catch((e) => ({ status: "unknown", message: `Impossibile verificare: ${(e && e.message) || e}.` }))
    .then((result) => Object.assign(target, result));
}

function describeTimestamp(ts, stamped, jobs) {
  const info = { time: ts.time, tsa: ts.tsa, ...PENDING };
  jobs.push(settle(info, verifyTimestamp(ts, stamped)));
  return info;
}

// I dati del firmatario sono subito disponibili; l'esito delle verifiche
// crittografiche arriva dopo, tramite le promesse aggiunte a `jobs`.
function describeSigner(signer, sd, jobs) {
  const cert = findCert(signer.sid, sd.certs);
  const timestamps = signer.timestamps.map((ts) => describeTimestamp(ts, signer.signature, jobs));
  // Riferimento temporale: marca temporale se presente, altrimenti data dichiarata.
  const refTime = (timestamps[0] && timestamps[0].time) || signer.signingTime || null;
  let certStatus = null;
  if (cert && cert.notBefore && cert.notAfter) {
    const t = refTime || new Date();
    if (t < cert.notBefore) certStatus = "notYetValid";
    else if (t > cert.notAfter) certStatus = "expired";
    else certStatus = "valid";
  }
  const info = {
    name: cert ? displayName(cert.subject) : "Firmatario sconosciuto",
    cert,
    signingTime: signer.signingTime,
    timestamps,
    algorithm: signatureLabel(signer),
    counterSignatures: signer.counterSignatures,
    qualified: !!cert && cert.qcStatements.includes(OID.qcCompliance),
    qscd: !!cert && cert.qcStatements.includes(OID.qcSSCD),
    certStatus,
    certCheckedAt: refTime,
    ...PENDING,
  };
  jobs.push(settle(info, verifySigner(signer, cert, sd.data)));
  return info;
}

/* --------------------------------------------------- Rilevamento buste */

function asCms(bytes) {
  if (bytes[0] !== 0x30) return null;
  try {
    const ci = parseContentInfo(bytes);
    if (ci && ci.body && [OID.signedData, OID.timeStampedData, OID.envelopedData, OID.authEnvelopedData].includes(ci.type)) {
      return ci;
    }
  } catch {
    // Non è una struttura CMS.
  }
  return null;
}

function looksTextual(bytes) {
  const n = Math.min(bytes.length, 512);
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c < 9 || (c > 13 && c < 32) || c > 126) return false;
  }
  return n > 0;
}

// Restituisce { kind: "cms", ci, bytes } | { kind: "mime", text } | null
function detectEnvelope(bytes) {
  const ci = asCms(bytes);
  if (ci) return { kind: "cms", ci, bytes };
  if (!looksTextual(bytes)) return null;
  const head = bytesToLatin1(bytes.subarray(0, 2048)).trimStart();
  if (/^(mime-version|content-type)\s*:/i.test(head)) return { kind: "mime", text: bytesToLatin1(bytes) };
  // .p7m codificato in Base64 (con o senza intestazioni PEM).
  if (!/^[A-Za-z0-9+/=\s#-]*$/.test(head)) return null;
  const text = bytesToLatin1(bytes);
  const pem = /-----BEGIN [A-Z0-9 #]+-----([\s\S]*?)-----END [A-Z0-9 #]+-----/.exec(text);
  const b64 = pem ? pem[1] : text;
  if (/^[A-Za-z0-9+/=\s]+$/.test(b64) && b64.replace(/\s/g, "").length >= 16) {
    try {
      const decoded = base64ToBytes(b64);
      const inner = asCms(decoded);
      if (inner) return { kind: "cms", ci: inner, bytes: decoded };
    } catch {
      // Base64 non valido.
    }
  }
  return null;
}

/**
 * Estrae il documento contenuto in una o più buste (p7m annidati, tsd, m7m).
 * L'estrazione è immediata; le verifiche crittografiche proseguono in parallelo
 * e aggiornano `layers` quando `verification` si risolve.
 * @returns {{data: Uint8Array, fileName: string|null, layers: object[], verification: Promise<object[]>}}
 */
export function unwrap(bytes) {
  const layers = [];
  const jobs = [];
  let data = bytes;
  let fileName = null;
  for (let depth = 0; depth < MAX_LAYERS; depth++) {
    const env = detectEnvelope(data);
    if (!env) break;

    if (env.kind === "mime") {
      const parts = parseMime(env.text);
      let doc = null;
      const stamps = [];
      for (const part of parts) {
        const ci = asCms(part.bytes);
        if (ci && ci.type !== OID.signedData) {
          doc = doc || part.bytes;
          continue;
        }
        let ts = null;
        try {
          ts = ci ? parseTimeStampToken(part.bytes) : findTimeStampTokens(parseNode(part.bytes, 0), [])[0];
        } catch {
          // Parte non interpretabile.
        }
        if (ts) stamps.push(ts);
        else if (ci) doc = doc || part.bytes;
      }
      if (!doc) throw new Error("Il file .m7m non contiene un documento firmato leggibile.");
      layers.push({ type: "m7m", timestamps: stamps.map((ts) => describeTimestamp(ts, doc, jobs)) });
      data = doc;
      continue;
    }

    const { ci } = env;
    if (ci.type === OID.envelopedData || ci.type === OID.authEnvelopedData) {
      throw new Error(
        "Il file è cifrato per un destinatario specifico (CMS EnvelopedData): " +
          "si può aprire solo con la chiave privata del destinatario, ad esempio la sua smart card."
      );
    }
    if (ci.type === OID.timeStampedData) {
      const tsd = parseTimeStampedData(ci.body);
      if (!tsd.data) throw new Error("Il file .tsd non include il documento (contenuto separato).");
      const timestamps = tsd.timestamps.map((ts) => describeTimestamp(ts, tsd.stamped, jobs));
      layers.push({ type: "tsd", timestamps, fileName: tsd.fileName });
      if (tsd.fileName) fileName = tsd.fileName;
      data = tsd.data;
      continue;
    }

    const sd = parseSignedData(ci.body);
    if (sd.eContentType === OID.tstInfo) break; // È solo una marca temporale.
    if (!sd.data) {
      throw new Error(
        "Questo file contiene solo la firma (firma \"detached\") e non il documento: " +
          "serve anche il file originale firmato."
      );
    }
    layers.push({ type: "p7m", signers: sd.signers.map((signer) => describeSigner(signer, sd, jobs)) });
    data = sd.data;
  }
  return { data, fileName, layers, verification: Promise.all(jobs).then(() => layers) };
}

/* ------------------------------------------------ Tipo del contenuto */

export function sniff(b) {
  const head = bytesToLatin1(b.subarray(0, 1024));
  if (head.includes("%PDF-")) return { kind: "pdf", mime: "application/pdf", ext: "pdf" };
  if (head.startsWith("\x89PNG")) return { kind: "image", mime: "image/png", ext: "png" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  if (head.startsWith("GIF8")) return { kind: "image", mime: "image/gif", ext: "gif" };
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return { kind: "image", mime: "image/webp", ext: "webp" };
  if (head.startsWith("BM")) return { kind: "image", mime: "image/bmp", ext: "bmp" };
  if (head.startsWith("II*\0") || head.startsWith("MM\0*")) return { kind: "image", mime: "image/tiff", ext: "tif" };
  if (head.startsWith("PK\x03\x04")) {
    const zipHead = bytesToLatin1(b.subarray(0, 4096));
    if (zipHead.includes("word/")) return { kind: "binary", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" };
    if (zipHead.includes("xl/")) return { kind: "binary", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" };
    if (zipHead.includes("ppt/")) return { kind: "binary", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" };
    const odf = /mimetypeapplication\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation)/.exec(zipHead);
    if (odf) return { kind: "binary", mime: `application/vnd.oasis.opendocument.${odf[1]}`, ext: { text: "odt", spreadsheet: "ods", presentation: "odp" }[odf[1]] };
    return { kind: "binary", mime: "application/zip", ext: "zip" };
  }
  if (head.startsWith("\xD0\xCF\x11\xE0")) return { kind: "binary", mime: "application/msword", ext: "doc" };
  if (head.startsWith("{\\rtf")) return { kind: "binary", mime: "application/rtf", ext: "rtf" };
  const text = head.replace(/^\xEF\xBB\xBF|^\xFE\xFF|^\xFF\xFE/, "").trimStart();
  if (/^<(\?xml|[A-Za-z_!])/.test(text)) return { kind: "xml", mime: "application/xml", ext: "xml" };
  if (b.length && isProbablyText(b)) return { kind: "text", mime: "text/plain", ext: "txt" };
  return { kind: "binary", mime: "application/octet-stream", ext: "bin" };
}

function isProbablyText(b) {
  const n = Math.min(b.length, 4096);
  if (b[0] === 0xff && b[1] === 0xfe) return true;
  if (b[0] === 0xfe && b[1] === 0xff) return true;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0 || (c < 9) || (c > 13 && c < 27)) return false;
  }
  return true;
}

/** Nome del documento estratto: "contratto.pdf.p7m" -> "contratto.pdf". */
export function innerFileName(name, ext) {
  let n = (name || "documento").trim();
  const re = /\.(p7m|p7s|p7c|tsd|m7m)$/i;
  while (re.test(n)) n = n.replace(re, "");
  n = n || "documento";
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(n);
  if (!m) return `${n}.${ext}`;
  if (ext !== "bin" && m[1].toLowerCase() !== ext && ["pdf", "xml", "txt"].includes(ext)) return `${n}.${ext}`;
  return n;
}
