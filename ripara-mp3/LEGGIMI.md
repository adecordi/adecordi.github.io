# RiparaMP3

Programma per Windows che sistema la raccolta di mp3 su una chiavetta:

1. **controlla** ogni brano e trova quelli rovinati, cioè quelli che "saltano";
2. **sostituisce** i brani rovinati con le copie sane che trova sull'hard disk del PC;
3. se una copia sana non c'è, **ripara** il file togliendo le parti rovinate;
4. **sistema nomi, tag e copertine**:
   - i file si chiamano `Artista - Titolo.mp3`, tutti nella cartella principale della chiavetta;
   - i brani con tag sbagliati vengono **riconosciuti dall'audio** (AcoustID) e corretti;
   - album e anno mancanti vengono cercati su MusicBrainz;
   - le **copertine** sono quelle ufficiali degli album, prese da Deezer, Apple Music o Cover Art Archive (vedi sotto);
5. crea **`elenco.html`**, una pagina con tutti i brani: si apre nel browser e permette di cercare, ordinare e ascoltare.

## Come si usa

1. Scarica [`RiparaMP3.exe`](https://github.com/adecordi/adecordi.github.io/raw/claude/jolly-faraday-0ii7a5/ripara-mp3/RiparaMP3.exe).
2. Collega la chiavetta al PC.
3. Fai doppio clic su `RiparaMP3.exe`.

   La prima volta Windows potrebbe mostrare **"Windows ha protetto il PC"**: clicca **Ulteriori informazioni** e poi **Esegui comunque**. Succede con tutti i programmi che non sono firmati da un'azienda. Anche il browser potrebbe chiedere conferma durante il download: scegli **Mantieni**.

4. Rispondi alle domande. Basta premere **Invio** per accettare la scelta consigliata:
   - quale chiavetta usare;
   - se fare la **copia di sicurezza** sul PC (consigliato: la chiavetta è difettosa);
   - se cercare su Internet album, anno e copertine;
   - dove cercare le copie sane (per default tutti i dischi del PC; puoi trascinare nella finestra una cartella specifica).
5. Il programma mostra un riepilogo e chiede conferma prima di modificare qualsiasi cosa.

Alla fine si apre `elenco.html`.

## Cosa trovi sulla chiavetta alla fine

| File / cartella | Cosa contiene |
| --- | --- |
| `Artista - Titolo.mp3` | i brani sistemati |
| `elenco.html` | l'elenco dei brani, da aprire con il browser |
| `RiparaMP3-registro.txt` | tutte le operazioni fatte: vecchio nome → nuovo nome, file sostituiti e da dove |
| `_Doppioni` | i brani presenti due volte (audio identico): non vengono cancellati, solo spostati qui |
| `_Rovinati` | solo se servono: gli originali con settori illeggibili, conservati dopo averne fatto una versione riparata |

Le cartelle rimaste vuote vengono tolte. Quelle che contengono ancora altri file (immagini, documenti) restano dove sono.

La **copia di sicurezza** della chiavetta, così com'era prima, si trova in `Musica\RiparaMP3 backup <data>` sul PC. Per tornare indietro basta ricopiarla sulla chiavetta.

## Riconoscimento dall'audio (tag sbagliati)

Alcuni brani hanno tag del tutto sbagliati, per esempio titolo "Easy" e artista "lady". Per correggerli il programma **ascolta** ogni brano: ne calcola l'impronta audio e la confronta con il database gratuito [AcoustID](https://acoustid.org). Così sa che canzone è anche se nome e tag non c'entrano niente, e prende da MusicBrainz artista, titolo, album, anno e numero di traccia giusti.

Serve una **chiave gratuita**, da chiedere una sola volta:
1. apri https://acoustid.org/new-application e accedi (va bene anche un account Google);
2. compila il modulo (nome: `RiparaMP3`, versione: `1.4`, la tua email) e conferma;
3. copia la **API key** che compare;
4. avvia RiparaMP3: alla domanda sulla chiave incollala nella finestra (tasto destro oppure Ctrl+V) e premi Invio.

Il programma la ricorda per le volte successive. È una chiave personale: non mandarla a nessuno.

- Un brano viene corretto solo se il riconoscimento è sicuro (somiglianza almeno all'85% e durata uguale entro 10 secondi). Gli altri seguono le regole normali.
- Nel registro ogni correzione compare così: `[RICONOSCIUTO] Lady - Easy -> Commodores - Easy (album "Commodores")`. Nell'elenco HTML il brano ha la nota "Riconosciuto dall'audio".
- La prima volta ci vuole circa un secondo e mezzo a brano. Le volte successive i brani già riconosciuti non vengono riascoltati.
- Per saltare il riconoscimento: premi solo Invio alla domanda sulla chiave, oppure usa `--non-riconoscere`.

## Le copertine

Per ogni album il programma cerca la copertina **ufficiale**, nell'ordine:
1. Deezer;
2. Apple Music;
3. Cover Art Archive.

Le prime due hanno le immagini pubblicate dalle case discografiche, pulite e in alta qualità.

- Le copertine vengono salvate a **600×600 pixel** in JPEG semplice, un formato che anche le autoradio meno recenti mostrano senza problemi.
- Le copertine già presenti nei brani vengono **sostituite** con quelle ufficiali. Se online non si trova nulla resta quella che c'era, purché non sia una miniatura minuscola. Per tenere le copertine già presenti usa `--tieni-copertine`.
- **Compilation**: se l'album nei tag è una raccolta ("Festivalbar 98", "Greatest Hits", artista dell'album "Artisti vari"...), il programma cerca l'**album originale** del brano e corregge album, anno e numero di traccia. La copertina diventa quella dell'album originale. Ogni correzione è scritta nel registro, per esempio `[ALBUM] Lucio Dalla - Attenti al lupo: "Festivalbar 90" -> "Cambio"`.

## Gli stati nell'elenco

- **Sano**: il file era integro.
- **Recuperato dall'HD**: era rovinato ed è stato sostituito con la copia sana trovata sul PC.
- **Riparato in parte**: era rovinato e non c'era una copia. Le parti rovinate sono state tolte, quindi può mancare qualche istante di audio.
- **Difettoso**: troppo rovinato per essere riparato. Va recuperato da un'altra fonte, per esempio il CD originale.
- **Altro formato**: il file ha l'estensione `.mp3` ma è in un altro formato (M4A, WMA...). Non viene toccato.
- **da controllare**: non è stato possibile capire artista o titolo.

## Consigli

- Se il controllo trova **molti** brani rovinati, il problema è la chiavetta: dopo la sistemazione conviene copiare tutto su una chiavetta nuova.
- Se invece i brani risultano quasi tutti **sani** ma saltano lo stesso, probabilmente la chiavetta legge male o è troppo lenta. Anche in questo caso la soluzione è una chiavetta nuova.
- Il programma si può rilanciare quante volte vuoi: i file già a posto non vengono riscritti e le ricerche online già fatte restano in memoria.

## Limiti

- Un danno molto piccolo (un singolo bit cambiato) si riconosce solo se l'mp3 contiene il codice di controllo LAME. È così nella maggior parte degli mp3 creati con LAME o ffmpeg.
- Un file tagliato esattamente alla fine di un frame si riconosce solo se ha l'intestazione Xing (quasi tutti gli mp3 recenti la hanno).
- Quando un tag viene riscritto si conservano titolo, artista, album, artista dell'album, anno, traccia, disco, genere, compositore, commento, testo e copertina. Informazioni particolari come ReplayGain, valutazioni a stelle o identificativi MusicBrainz non vengono riportate (restano nella copia di sicurezza).
- La ricerca su Internet funziona solo per i brani di cui si conoscono artista e titolo. MusicBrainz permette una ricerca al secondo, quindi per raccolte grandi ci vuole qualche minuto. Le copertine si cercano una volta per album e restano in memoria per le volte successive.
- Le compilation si riconoscono dall'artista dell'album, dal titolo e da quanti artisti diversi ci sono nello stesso album: un album che si chiama per esempio "Gold" o "Singles" viene trattato come raccolta. Se l'album originale non si trova, i tag restano com'erano.

## Collegare il PC al sito delle playlist

Dalla versione 1.3 lo stesso programma può anche fare da **collegamento** con il sito delle playlist: dal sito (anche dal telefono) si decidono le playlist, e il programma sul PC legge la chiavetta, cerca i brani nei dischi e li copia.

1. Apri il link che ti è stato mandato: scarica `RiparaMP3-Collega-….exe` (il nome contiene il codice per collegarsi: non cambiarlo).
2. Fai doppio clic (se Windows dice **"Windows ha protetto il PC"**: **Ulteriori informazioni** e poi **Esegui comunque**). Il programma si collega da solo al sito.
3. Alla domanda **"Vuoi che parta da solo quando accendi il PC?"** puoi rispondere di no (basta Invio). Per ricollegarti un'altra volta fai doppio clic sullo stesso file: il programma resta dove l'hai scaricato e non installa niente.
4. **Lascia aperta la finestra** (puoi ridurla a icona) con la chiavetta attaccata. Il resto si fa dal sito.

Cosa fa sulla chiavetta, quando dal sito si dà l'OK. Per la **Tesla** (la scelta predefinita):

- tutto va nella cartella **`Music`**, con una cartella per ogni playlist (anche quelle proposte: la Tesla non legge le playlist .m3u);
- i brani si chiamano `01 - Artista - Titolo - Anno.mp3`: il numero davanti tiene l'ordine della playlist, perché la Tesla mette i brani in ordine alfabetico;

per un'**autoradio normale** (si sceglie dal sito):

- ogni playlist diventa una **cartella**; i brani si chiamano `Artista - Titolo - Anno.mp3`;
- le playlist "proposte" diventano file **.m3u**, che puntano ai brani già presenti senza copiarli due volte (i brani che stanno solo lì vanno nella cartella `Altri brani`);

e in tutti e due i casi:

- tag e copertina ufficiale in ogni brano;
- i brani mancanti o rovinati vengono copiati dai dischi del PC, oppure da un'altra chiavetta attaccata (per passare a una chiavetta nuova);
- i file che non stanno più in nessuna playlist **non vengono cancellati**: finiscono nella cartella `_Tolti`;
- prima di riscrivere un brano ne fa una copia sul PC, in `Musica\RiparaMP3 backup <data>`.

Una chiavetta organizzata così contiene il file `RiparaMP3-playlist.json`: in quel caso `RiparaMP3.exe` da solo non la tocca, perché metterebbe tutti i brani nella cartella principale e le playlist andrebbero perse.

## Opzioni (per utenti esperti)

Si possono passare da riga di comando, per esempio `RiparaMP3.exe --chiavetta E:\ --offline`:

| Opzione | Effetto |
| --- | --- |
| `--chiavetta E:\` | cartella o unità con la musica |
| `--cerca D:\Musica` | dove cercare le copie sane (si può ripetere) |
| `--prova` | mostra cosa farebbe, senza modificare nulla |
| `--offline` | non usa Internet |
| `--nobackup` | non fa la copia di sicurezza |
| `--backup-dir D:\Backup` | dove salvare la copia di sicurezza |
| `--acoustid-key CHIAVE` | chiave AcoustID per il riconoscimento dall'audio (viene ricordata) |
| `--non-riconoscere` | non riconosce i brani dall'audio |
| `--tieni-copertine` | tiene le copertine già presenti nei brani e cerca solo quelle che mancano |
| `--si` | risponde sì a tutte le domande |
| `--collega --sito URL` | fa da collegamento con il sito delle playlist (anche con il nome `RiparaMP3-Collega.exe`) |
| `--server` | avvia il sito delle playlist (sul server; vedi le altre opzioni con `--help`) |

## Per chi sviluppa

Il programma è scritto in Go. Lo stesso eseguibile ha tre modi: la console di sempre, l'agente (`agente*.go`, che parla con il sito solo con richieste in uscita, `proto.go`) e il sito (`server*.go`, pagina in `web/`, scritta in ES5 per i vecchi iPad).

```sh
go test ./...                        # i test usano ffmpeg per creare mp3 di prova (e fpcalc, se c'è)
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o RiparaMP3.exe .
go build -o riparamp3 .              # il sito: riparamp3 --server --indirizzo 127.0.0.1:8036 ...
```

Il riconoscimento dal microfono del sito usa [songrec](https://github.com/marin-m/SongRec) (deve essere installato sul server) e `ffmpeg`. Le playlist proposte usano Gemini o Groq, se sul server ci sono le chiavi.

## Componenti di terze parti

Il riconoscimento dall'audio usa `fpcalc` di [Chromaprint](https://github.com/acoustid/chromaprint) 1.5.1, incluso senza modifiche (licenza LGPL 2.1, vedi `fpcalc/LICENSE.md`). Il servizio AcoustID è gratuito per uso non commerciale.
