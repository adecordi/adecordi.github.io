# PaoloCAPTCHA 🧔🔴 — per "Paolo sui tetti"

Un finto captcha che **blocca la pagina del gioco** con una griglia di foto:
per entrare bisogna selezionare **tutte e sole le foto di Paolo**. Se sbagli,
la griglia si rimescola e si riprova. Superato il test, il blocco sparisce e
il gioco è utilizzabile.

È un modulo autonomo (niente librerie, niente dipendenze): un file JS, un file
CSS e una cartella di immagini. Qui su GitHub Pages c'è anche una **pagina
demo** (`index.html`) per provarlo dal browser.

## Contenuto della cartella

| File | A cosa serve |
|---|---|
| `paolocaptcha.js` | Il modulo: crea il blocco, gestisce la selezione e la verifica |
| `paolocaptcha.css` | Lo stile del blocco (tutte le classi hanno prefisso `pc-`) |
| `img/paolo/` | Le foto di Paolo (ora 4 avatar segnaposto) |
| `img/altri/` | Le foto degli altri (ora 8 avatar segnaposto) |
| `index.html` | Pagina demo: mostra il captcha davanti a un finto gioco |

## Installazione sulla VPS

1. **Copia i file nel progetto del gioco** (adatta utente, host e percorso):

   ```bash
   scp -r paolocaptcha.js paolocaptcha.css img \
       utente@tua-vps:/percorso/del/progetto/
   ```

2. **Aggancia il modulo alla pagina del gioco**, dentro l'HTML:

   ```html
   <!-- nel <head> -->
   <link rel="stylesheet" href="paolocaptcha.css">

   <!-- in fondo, prima di </body> -->
   <script src="paolocaptcha.js"></script>
   ```

   Fatto: al caricamento la pagina è coperta dal captcha finché non lo si
   supera. I percorsi delle immagini sono relativi alla pagina; se il gioco
   sta in un'altra cartella usa l'opzione `basePath` (vedi sotto).

3. **(Consigliato) Fai partire il gioco solo dopo la verifica.** Definisci la
   configurazione **prima** di caricare lo script:

   ```html
   <script>
     window.PaoloCaptchaConfig = {
       onSuccess: function () {
         // qui avvii il gioco, es.: avviaGioco();
       }
     };
   </script>
   <script src="paolocaptcha.js"></script>
   ```

   In alternativa c'è l'evento: `document.addEventListener('paolocaptcha:successo', ...)`.
   `onSuccess` viene chiamata anche quando il captcha è saltato perché già
   superato nella stessa scheda.

## Mettere le foto vere

1. Metti le foto di Paolo in `img/paolo/` e quelle degli altri in
   `img/altri/` (JPG/PNG/WebP vanno benissimo; meglio se **quadrate** o quasi,
   tanto vengono ritagliate al centro con `object-fit: cover`).
2. Elenca i file nella configurazione:

   ```html
   <script>
     window.PaoloCaptchaConfig = {
       fotoPaolo: [
         'img/paolo/paolo-mare.jpg',
         'img/paolo/paolo-pizza.jpg',
         'img/paolo/paolo-tetto.jpg',
         'img/paolo/paolo-bici.jpg'
       ],
       fotoAltri: [
         'img/altri/luca.jpg',
         'img/altri/anna.jpg',
         'img/altri/marco.jpg',
         'img/altri/nonno.jpg',
         'img/altri/giulia.jpg',
         'img/altri/piccione.jpg'
       ]
     };
   </script>
   ```

   Servono **almeno** `paoloPerRound` foto di Paolo (di serie 3) e
   `celleTotali − paoloPerRound` foto di altri (di serie 6). Con più foto di
   così, ogni round ne pesca un sottoinsieme a caso: più varietà.

## Tutte le opzioni

| Opzione | Predefinito | Significato |
|---|---|---|
| `fotoPaolo` | 4 SVG segnaposto | Elenco foto di Paolo |
| `fotoAltri` | 8 SVG segnaposto | Elenco foto degli altri |
| `paoloPerRound` | `3` | Foto di Paolo presenti in ogni round |
| `celleTotali` | `9` | Celle della griglia (9 = 3×3, 16 = 4×4) |
| `basePath` | `''` | Prefisso aggiunto a ogni percorso immagine |
| `titolo` | "Seleziona tutte le foto di **Paolo**" | Titolo della scheda (HTML ammesso) |
| `intestazione` | "PaoloCAPTCHA™ · …" | Riga piccola sopra il titolo |
| `sottotitolo` | "Solo i veri amici…" | Nota accanto al pulsante |
| `testoVerifica` | `'VERIFICA'` | Testo del pulsante |
| `messaggioErrore` / `messaggioVuoto` / `messaggioSuccesso` | — | Messaggi di esito |
| `ricordaSessione` | `true` | Se `true` non lo richiede più finché la scheda resta aperta |
| `chiaveSessione` | `'paoloCaptchaOk'` | Chiave usata in `sessionStorage` |
| `onSuccess` | `null` | Funzione chiamata al superamento |

Utility: `PaoloCaptcha.azzera()` dimentica la verifica (al prossimo
caricamento il blocco ricompare) — comodo per testare.

## Note oneste

- **Non è vera sicurezza**: gira tutto nel browser, chi apre gli strumenti
  sviluppatore lo aggira. Serve a divertirsi e a fermare chi non conosce
  Paolo, non gli hacker.
- Funziona anche da telefono (tocco singolo per selezionare).
- Consiglio per la difficoltà: metti tra gli "altri" qualcuno che assomiglia
  un po' a Paolo. 😈
