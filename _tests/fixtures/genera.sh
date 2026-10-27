#!/usr/bin/env bash
# Genera in fixtures/out tutti i file di prova: certificati (di una CA finta),
# PDF, buste .p7m nelle varie codifiche, .tsd, .m7m, fatture elettroniche.
# Requisiti: openssl, python3 (reportlab, pypdf, cryptography, pillow), node con playwright.
# Su Windows va eseguito da Git Bash.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash: non convertire "/C=IT/..." in percorsi Windows

# Git Bash: "C:/..." (pwd -W), perché con MSYS_NO_PATHCONV python e node non capirebbero "/c/..."
HERE="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"
OUT="$HERE/out"
PY="$(command -v python3 || command -v python)"
rm -rf "$OUT" && mkdir -p "$OUT" && cd "$OUT"
q() { "$@" >/dev/null 2>&1; }

echo "Certificati di prova…"
q openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 3650 \
  -subj "/C=IT/O=Certificatore di Prova S.p.A./CN=Prova Qualified CA"
cat > ext.cnf <<'X'
[signer]
basicConstraints=CA:FALSE
keyUsage=critical,nonRepudiation
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
1.3.6.1.5.5.7.1.3=DER:30143008060604008E4601013008060604008E460104
[tsa]
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,timeStamping
subjectKeyIdentifier=hash
X
q openssl req -newkey rsa:2048 -nodes -keyout rossi.key -out rossi.csr \
  -subj "/C=IT/O=NON PRESENTE/CN=ROSSI MARIO/SN=ROSSI/GN=MARIO/serialNumber=TINIT-RSSMRA80A01H501U/dnQualifier=2026123456"
q openssl x509 -req -in rossi.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out rossi.crt -days 1095 -extfile ext.cnf -extensions signer
# Soggetto con lettere accentate: da file, perché su Windows openssl riceve gli argomenti
# nella codifica di sistema e la "Ì" arriva come UTF-8 non valido.
cat > bianchi.cnf <<'X'
[req]
prompt=no
utf8=yes
string_mask=utf8only
distinguished_name=dn
[dn]
C=IT
O=Comune di Prova
CN=BIANCHI LUCÌA
SN=BIANCHI
GN=LUCÌA
serialNumber=TINIT-BNCLCU85M41F205X
X
q openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout bianchi.key -out bianchi.csr -config bianchi.cnf
q openssl x509 -req -in bianchi.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out bianchi.crt -days 1095 -extfile ext.cnf -extensions signer
q openssl genrsa -out old.key 2048
"$PY" "$HERE/cert_scaduto.py"
q openssl req -newkey rsa:2048 -nodes -keyout tsa.key -out tsa.csr -subj "/C=IT/O=Certificatore di Prova S.p.A./CN=Prova TSA 1"
q openssl x509 -req -in tsa.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out tsa.crt -days 1095 -extfile ext.cnf -extensions tsa
cat > tsa.cnf <<'X'
[ tsa ]
default_tsa = tsa_config1
[ tsa_config1 ]
dir = .
serial = ./tsaserial
signer_cert = ./tsa.crt
certs = ./tsa.crt
signer_key = ./tsa.key
signer_digest = sha256
default_policy = 1.2.3.4.1
digests = sha256, sha512
accuracy = secs:1
ordering = no
tsa_name = yes
ess_cert_id_chain = no
ess_cert_id_alg = sha256
X
echo 01 > tsaserial

echo "Documenti…"
"$PY" "$HERE/pdf_prova.py"
"$PY" "$HERE/immagine.py"
"$PY" "$HERE/scansione.py"
"$PY" "$HERE/pdf_grande.py"
"$PY" "$HERE/fatture.py"
node "$HERE/links.cjs"
if command -v magick >/dev/null || command -v convert >/dev/null; then
  IM="$(command -v magick || command -v convert)"
  q "$IM" immagine.png -compress JPEG2000 jpx.pdf || echo "  (jpx.pdf non creato: ImageMagick senza JPEG 2000)"
fi

echo "Buste firmate…"
S="openssl cms -sign -binary -nodetach -md sha256"
q $S -cades -in doc.pdf -signer rossi.crt -inkey rossi.key -certfile ca.crt -outform DER -out doc.pdf.p7m
q $S -cades -stream -in doc.pdf -signer rossi.crt -inkey rossi.key -outform DER -out doc_ber.pdf.p7m
q $S -in doc.pdf -signer rossi.crt -inkey rossi.key -outform PEM -out doc_pem.pdf.p7m
q openssl base64 -in doc.pdf.p7m -out doc_b64.pdf.p7m
q $S -in doc.pdf -signer bianchi.crt -inkey bianchi.key -outform DER -out doc_ec.pdf.p7m
q $S -in doc.pdf -signer rossi.crt -inkey rossi.key -keyopt rsa_padding_mode:pss -outform DER -out doc_pss.pdf.p7m
q $S -in doc.pdf -signer rossi.crt -inkey rossi.key -signer bianchi.crt -inkey bianchi.key -outform DER -out doc_due_firme.pdf.p7m
q $S -in doc.pdf.p7m -signer bianchi.crt -inkey bianchi.key -outform DER -out doc_doppia.pdf.p7m.p7m
q $S -in doc.pdf -signer old.crt -inkey old.key -outform DER -out doc_scaduto.pdf.p7m
q openssl cms -sign -binary -nodetach -md sha1 -noattr -in doc.pdf -signer rossi.crt -inkey rossi.key -outform DER -out doc_noattr_sha1.pdf.p7m
q $S -in protetto.pdf -signer rossi.crt -inkey rossi.key -outform DER -out protetto.pdf.p7m
q $S -in grande.pdf -signer rossi.crt -inkey rossi.key -cades -outform DER -out grande.pdf.p7m
q $S -in fattura.xml -signer rossi.crt -inkey rossi.key -outform DER -out IT01234567890_00001.xml.p7m
q $S -in IT01234567890_00042.xml -signer rossi.crt -inkey rossi.key -outform DER -out IT01234567890_00042.xml.p7m
q $S -in semplificata.xml -signer rossi.crt -inkey rossi.key -outform DER -out IT01234567890_S0001.xml.p7m
q $S -in nota.txt -signer rossi.crt -inkey rossi.key -outform DER -out nota.txt.p7m
q $S -in immagine.png -signer rossi.crt -inkey rossi.key -outform DER -out immagine.png.p7m
q openssl cms -sign -binary -md sha256 -in doc.pdf -signer rossi.crt -inkey rossi.key -outform DER -out doc_detached.pdf.p7s
q openssl cms -encrypt -binary -aes256 -in doc.pdf -outform DER -out doc_cifrato.pdf.p7m rossi.crt
"$PY" "$HERE/alterati.py"

echo "Marche temporali (.tsd, .m7m, firma con marca)…"
"$PY" "$HERE/marche.py"

rm -f ./*.csr ./*.srl ./*.tsq ./*.tsr ./*.tst sig.bin tsaserial* ext.cnf tsa.cnf
echo "Fatto: $(ls | wc -l) file in $OUT"
