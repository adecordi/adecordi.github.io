/* ==========================================================================
 * PaoloCAPTCHA 🧔🔴
 * --------------------------------------------------------------------------
 * Blocca la pagina con una griglia di foto: per continuare bisogna
 * selezionare TUTTE e SOLE le foto di Paolo. Superato il test, il blocco
 * sparisce e (se configurata) viene chiamata la funzione onSuccess.
 *
 * COME SI USA (2 righe nella pagina del gioco):
 *
 *   <link rel="stylesheet" href="paolocaptcha.css">
 *   <script src="paolocaptcha.js"></script>
 *
 * PERSONALIZZAZIONE (facoltativa): definisci window.PaoloCaptchaConfig
 * PRIMA di caricare questo script. Esempio:
 *
 *   <script>
 *     window.PaoloCaptchaConfig = {
 *       fotoPaolo: ['img/paolo/vera1.jpg', 'img/paolo/vera2.jpg', ...],
 *       fotoAltri: ['img/altri/amico1.jpg', 'img/altri/amico2.jpg', ...],
 *       onSuccess: function () { avviaIlGioco(); }
 *     };
 *   </script>
 *   <script src="paolocaptcha.js"></script>
 *
 * Per rimettere il blocco (es. per provarlo di nuovo nella stessa scheda):
 *   PaoloCaptcha.azzera(); location.reload();
 *
 * NOTA: è un gioco, non una vera protezione — chi apre gli strumenti
 * sviluppatore può aggirarlo. Perfetto per fermare chi non conosce Paolo,
 * non per fermare gli hacker. 😄
 * ========================================================================== */

(function () {
  'use strict';

  if (window.__paoloCaptchaAttivo) { return; }
  window.__paoloCaptchaAttivo = true;

  var PREDEFINITA = {
    // Prefisso aggiunto davanti a ogni percorso immagine (utile se la pagina
    // del gioco sta in un'altra cartella, es. basePath: '/paolo-sui-tetti/').
    basePath: '',

    // Le foto di Paolo: a ogni round ne vengono pescate `paoloPerRound`.
    fotoPaolo: [
      'img/paolo/paolo1.svg',
      'img/paolo/paolo2.svg',
      'img/paolo/paolo3.svg',
      'img/paolo/paolo4.svg'
    ],

    // Le foto di tutti gli altri (amici, sconosciuti, piccioni...).
    fotoAltri: [
      'img/altri/altro1.svg',
      'img/altri/altro2.svg',
      'img/altri/altro3.svg',
      'img/altri/altro4.svg',
      'img/altri/altro5.svg',
      'img/altri/altro6.svg',
      'img/altri/altro7.svg',
      'img/altri/altro8.svg'
    ],

    paoloPerRound: 3,   // quante foto di Paolo compaiono in ogni round
    celleTotali: 9,     // dimensione della griglia (9 = 3x3, 16 = 4x4)

    // Testi (personalizzabili)
    intestazione: 'PaoloCAPTCHA™ · verifica di sicurezza molto seria',
    titolo: 'Seleziona tutte le foto di <strong>Paolo</strong>',
    sottotitolo: 'Solo i veri amici di Paolo possono giocare.',
    testoVerifica: 'VERIFICA',
    messaggioErrore: 'Sbagliato! Seleziona tutte e sole le foto di Paolo.',
    messaggioVuoto: 'Non hai selezionato nessuna foto!',
    messaggioSuccesso: 'Verificato: conosci Paolo! Buon divertimento 🎉',

    // Se true, superato una volta non viene richiesto finché la scheda
    // del browser resta aperta. Se false, ricompare a ogni ricaricamento.
    ricordaSessione: true,
    chiaveSessione: 'paoloCaptchaOk',

    // Chiamata quando il captcha viene superato (o saltato perché già
    // superato in questa sessione). Qui puoi far partire il gioco.
    onSuccess: null
  };

  var config = {};
  var chiave;
  for (chiave in PREDEFINITA) {
    if (Object.prototype.hasOwnProperty.call(PREDEFINITA, chiave)) {
      config[chiave] = PREDEFINITA[chiave];
    }
  }
  var esterna = window.PaoloCaptchaConfig || {};
  for (chiave in esterna) {
    if (Object.prototype.hasOwnProperty.call(esterna, chiave)) {
      config[chiave] = esterna[chiave];
    }
  }

  function mescola(lista) {
    var a = lista.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  function giaVerificato() {
    if (!config.ricordaSessione) { return false; }
    try { return sessionStorage.getItem(config.chiaveSessione) === '1'; }
    catch (e) { return false; }
  }

  function segnaVerificato() {
    if (!config.ricordaSessione) { return; }
    try { sessionStorage.setItem(config.chiaveSessione, '1'); }
    catch (e) { /* modalità privata: pazienza */ }
  }

  function annunciaSuccesso() {
    try { document.dispatchEvent(new CustomEvent('paolocaptcha:successo')); }
    catch (e) { /* browser molto vecchio */ }
    if (typeof config.onSuccess === 'function') { config.onSuccess(); }
  }

  // Piccola API pubblica
  window.PaoloCaptcha = {
    // Dimentica la verifica: al prossimo caricamento il blocco ricompare.
    azzera: function () {
      try { sessionStorage.removeItem(config.chiaveSessione); }
      catch (e) { /* ignora */ }
    }
  };

  function avvia() {
    if (giaVerificato()) {
      annunciaSuccesso();
      return;
    }

    var overlay = document.createElement('div');
    overlay.id = 'paolocaptcha-overlay';

    var card = document.createElement('div');
    card.className = 'pc-card';

    var header = document.createElement('div');
    header.className = 'pc-header';
    var mini = document.createElement('p');
    mini.className = 'pc-header-mini';
    mini.textContent = config.intestazione;
    var titolo = document.createElement('h2');
    titolo.innerHTML = config.titolo;
    header.appendChild(mini);
    header.appendChild(titolo);

    var griglia = document.createElement('div');
    griglia.className = 'pc-griglia';
    var colonne = Math.max(2, Math.round(Math.sqrt(config.celleTotali)));
    griglia.style.gridTemplateColumns = 'repeat(' + colonne + ', 1fr)';

    var messaggio = document.createElement('p');
    messaggio.className = 'pc-messaggio';
    messaggio.setAttribute('role', 'alert');

    var footer = document.createElement('div');
    footer.className = 'pc-footer';
    var ricarica = document.createElement('button');
    ricarica.type = 'button';
    ricarica.className = 'pc-ricarica';
    ricarica.textContent = '⟳';
    ricarica.title = 'Nuove immagini';
    ricarica.setAttribute('aria-label', 'Nuove immagini');
    var nota = document.createElement('p');
    nota.className = 'pc-nota';
    nota.textContent = config.sottotitolo;
    var verifica = document.createElement('button');
    verifica.type = 'button';
    verifica.className = 'pc-verifica';
    verifica.textContent = config.testoVerifica;
    footer.appendChild(ricarica);
    footer.appendChild(nota);
    footer.appendChild(verifica);

    card.appendChild(header);
    card.appendChild(griglia);
    card.appendChild(messaggio);
    card.appendChild(footer);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.body.classList.add('pc-bloccata');

    var celle = [];

    function nuovoRound() {
      griglia.innerHTML = '';
      celle = [];
      var nPaolo = Math.min(config.paoloPerRound, config.fotoPaolo.length);
      var nAltri = Math.min(config.celleTotali - nPaolo, config.fotoAltri.length);
      var voci = mescola(config.fotoPaolo).slice(0, nPaolo).map(function (src) {
        return { src: src, ePaolo: true };
      }).concat(mescola(config.fotoAltri).slice(0, nAltri).map(function (src) {
        return { src: src, ePaolo: false };
      }));
      mescola(voci).forEach(function (voce, i) {
        var bottone = document.createElement('button');
        bottone.type = 'button';
        bottone.className = 'pc-cella';
        bottone.setAttribute('aria-pressed', 'false');
        var img = document.createElement('img');
        img.src = config.basePath + voce.src;
        img.alt = 'Fotografia ' + (i + 1);
        img.draggable = false;
        var spunta = document.createElement('span');
        spunta.className = 'pc-spunta';
        spunta.textContent = '✓';
        bottone.appendChild(img);
        bottone.appendChild(spunta);
        var cella = { el: bottone, ePaolo: voce.ePaolo, selezionata: false };
        bottone.addEventListener('click', function () {
          cella.selezionata = !cella.selezionata;
          bottone.classList.toggle('pc-selezionata', cella.selezionata);
          bottone.setAttribute('aria-pressed', String(cella.selezionata));
        });
        griglia.appendChild(bottone);
        celle.push(cella);
      });
    }

    function mostraMessaggio(testo, verde) {
      messaggio.textContent = testo;
      messaggio.classList.toggle('pc-verde', !!verde);
    }

    function scuoti() {
      card.classList.remove('pc-scossa');
      void card.offsetWidth; // forza il riavvio dell'animazione
      card.classList.add('pc-scossa');
    }

    function sbagliato() {
      mostraMessaggio(config.messaggioErrore, false);
      scuoti();
      setTimeout(nuovoRound, 550);
    }

    function superato() {
      card.classList.add('pc-ok');
      titolo.textContent = config.messaggioSuccesso;
      mostraMessaggio('', true);
      verifica.disabled = true;
      ricarica.disabled = true;
      griglia.style.pointerEvents = 'none';
      segnaVerificato();
      setTimeout(function () {
        overlay.classList.add('pc-via');
        setTimeout(function () {
          if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
          document.body.classList.remove('pc-bloccata');
          annunciaSuccesso();
        }, 450);
      }, 900);
    }

    function controlla() {
      var qualcosa = celle.some(function (c) { return c.selezionata; });
      if (!qualcosa) {
        mostraMessaggio(config.messaggioVuoto, false);
        scuoti();
        return;
      }
      var giusto = celle.every(function (c) { return c.selezionata === c.ePaolo; });
      if (giusto) { superato(); } else { sbagliato(); }
    }

    ricarica.addEventListener('click', function () {
      mostraMessaggio('', false);
      nuovoRound();
    });
    verifica.addEventListener('click', controlla);

    nuovoRound();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', avvia);
  } else {
    avvia();
  }
})();
