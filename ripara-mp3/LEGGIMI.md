# RiparaMP3

Programma per Windows che sistema la raccolta di mp3 su una chiavetta:

1. **controlla** ogni brano e trova quelli rovinati, cioè quelli che "saltano";
2. **sostituisce** i brani rovinati con le copie sane che trova sull'hard disk del PC;
3. se una copia sana non c'è, **ripara** il file togliendo le parti rovinate;
4. **sistema nomi, tag e copertine**:
   - i file si chiamano `Artista - Titolo.mp3`, tutti nella cartella principale della chiavetta;
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
| `--tieni-copertine` | tiene le copertine già presenti nei brani e cerca solo quelle che mancano |
| `--si` | risponde sì a tutte le domande |

## Per chi sviluppa

Il programma è scritto in Go.

```sh
go test ./...                        # i test usano ffmpeg per creare mp3 di prova
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o RiparaMP3.exe .
```
