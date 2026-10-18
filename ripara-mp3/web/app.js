/* Musica: le playlist della chiavetta.
   Scritto in JavaScript "vecchio" (ES5, XMLHttpRequest, niente moduli)
   perché funzioni anche sul vecchio iPad. */
(function () {
  'use strict';

  var vista = document.getElementById('vista');
  var stato = null;
  var rotta = { nome: '', parti: [], q: {} };
  var timerStato = null;
  var selezione = null; // { pl: id, ids: {} } durante la selezione dei brani
  var ultimaPlaylist = '';
  try { ultimaPlaylist = window.localStorage.getItem('musica-pl') || ''; } catch (e) { ultimaPlaylist = ''; }

  // --- Utilità ------------------------------------------------------------------

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(metodo, url, corpo, cb) {
    var x = new XMLHttpRequest();
    x.open(metodo, url, true);
    x.setRequestHeader('X-Richiesta', '1');
    var dati = null;
    if (corpo !== null && corpo !== undefined) {
      if (window.Blob && corpo instanceof window.Blob) {
        dati = corpo;
      } else {
        x.setRequestHeader('Content-Type', 'application/json');
        dati = JSON.stringify(corpo);
      }
    }
    x.onreadystatechange = function () {
      if (x.readyState !== 4) { return; }
      var r = null;
      try { r = JSON.parse(x.responseText); } catch (e) { r = null; }
      if (x.status === 200) { cb(null, r); return; }
      var msg = (r && r.errore) || (x.status === 0 ? 'Il sito non risponde: controlla la connessione.' : 'Errore ' + x.status);
      cb(msg, r);
    };
    x.send(dati);
  }

  function avviso(testo, errore) {
    var el = document.getElementById('avviso');
    el.textContent = testo;
    el.className = 'avviso visibile' + (errore ? ' errore' : '');
    clearTimeout(avviso.t);
    avviso.t = setTimeout(function () { el.className = 'avviso'; }, errore ? 6000 : 3500);
  }

  function cop(id, classe) {
    classe = 'cop' + (classe ? ' ' + classe : '');
    if (!id) { return '<span class="' + classe + ' senza"></span>'; }
    return '<img class="' + classe + '" src="/copertine/' + esc(id) + '_160.jpg" alt="">';
  }

  function mosaico(ids, grande) {
    var c = 'mosaico' + (grande ? ' grande' : '');
    if (!ids || ids.length === 0) { return '<span class="' + c + '"></span>'; }
    if (ids.length < 4) { return '<span class="' + c + '"><img class="una" src="/copertine/' + esc(ids[0]) + '_160.jpg" alt=""></span>'; }
    var h = '<span class="' + c + '">';
    for (var i = 0; i < 4; i++) { h += '<img src="/copertine/' + esc(ids[i]) + '_160.jpg" alt="">'; }
    return h + '</span>';
  }

  function minuti(sec) {
    sec = Math.round(sec || 0);
    if (!sec) { return ''; }
    var s = sec % 60;
    return Math.floor(sec / 60) + ':' + (s < 10 ? '0' : '') + s;
  }

  function peso(n) {
    if (!n) { return '0 MB'; }
    if (n >= 1073741824) { return (n / 1073741824).toFixed(1).replace('.', ',') + ' GB'; }
    return Math.max(1, Math.round(n / 1048576)) + ' MB';
  }

  function plur(n, uno, molti) { return n === 1 ? uno : n + ' ' + molti; }

  var STATI = {
    ok: ['Sulla chiavetta', 'ok'],
    sistemare: ['Da sistemare', 'info'],
    da_chiavetta: ['Copio dalla chiavetta', 'info'],
    disco: ['Sul disco', 'info'],
    disco_staccato: ['Collega il disco', 'att'],
    confermare: ['Da confermare', 'att'],
    rovinato: ['Rovinato', 'err'],
    manca: ['Non trovato', 'err']
  };

  function chip(st, disco) {
    var s = STATI[st];
    if (!s) { return ''; }
    var t = s[0];
    if ((st === 'disco' || st === 'disco_staccato') && disco) { t += ' «' + disco + '»'; }
    return '<span class="chip ' + s[1] + '">' + esc(t) + '</span>';
  }

  function riepilogo(c) {
    if (!c) { return ''; }
    var parti = [];
    if (c.ok) { parti.push(c.ok + ' sulla chiavetta'); }
    var copiare = (c.sistemare || 0) + (c.da_chiavetta || 0) + (c.disco || 0);
    if (copiare) { parti.push(copiare + ' da copiare o sistemare'); }
    if (c.disco_staccato) { parti.push(c.disco_staccato + ' su un disco da collegare'); }
    if (c.confermare) { parti.push(c.confermare + ' da confermare'); }
    if (c.rovinato) { parti.push(plur(c.rovinato, '1 rovinato', 'rovinati')); }
    if (c.manca) { parti.push(plur(c.manca, '1 non trovato', 'non trovati')); }
    return parti.join(', ');
  }

  function ricordaPlaylist(id) {
    ultimaPlaylist = id;
    try { window.localStorage.setItem('musica-pl', id); } catch (e) { /* niente */ }
  }

  function scegliPlaylist(lista, scelta, id) {
    var h = '<select id="' + (id || 'destinazione') + '">';
    for (var i = 0; i < lista.length; i++) {
      h += '<option value="' + esc(lista[i].id) + '"' + (lista[i].id === scelta ? ' selected' : '') + '>' + esc(lista[i].nome) + '</option>';
    }
    return h + '</select>';
  }

  function caricando() { vista.innerHTML = '<p class="vuoto">Carico...</p>'; }

  function errore(msg) {
    vista.innerHTML = '<div class="nota err">' + esc(msg) + '</div><p><a href="#/">Torna alle playlist</a></p>';
  }

  // --- Stato del PC (in alto) e aggiornamenti -----------------------------------------

  function occupato() {
    if (!stato) { return false; }
    if (stato.attivita && stato.attivita.fase) { return true; }
    for (var i = 0; i < (stato.lavori || []).length; i++) {
      var s = stato.lavori[i].stato;
      if (s === 'in_coda' || s === 'inviato' || s === 'in_corso') { return true; }
    }
    return false;
  }

  function aggiornaStato(dopo) {
    api('GET', '/api/stato', null, function (err, s) {
      if (!err) {
        var prima = occupato();
        stato = s;
        disegnaPC();
        if (rotta.nome === 'chiavetta') { disegnaLavori(); }
        if (prima && !occupato() && (rotta.nome === 'chiavetta' || rotta.nome === 'playlist' || rotta.nome === 'proposte')) {
          vai(); // un lavoro è appena finito: si ridisegna la pagina
        }
      }
      if (dopo) { dopo(); }
      clearTimeout(timerStato);
      timerStato = setTimeout(aggiornaStato, occupato() ? 2500 : 15000);
    });
  }

  function disegnaPC() {
    var el = document.getElementById('pc');
    if (!stato || !stato.agente) {
      el.className = 'pc';
      el.textContent = 'Nessun PC collegato';
      return;
    }
    var a = stato.agente;
    el.className = 'pc ' + (a.online ? 'acceso' : 'spento');
    el.textContent = (a.nome || 'PC') + (a.online ? ': collegato' : ': spento, visto ' + a.visto);
  }

  // --- Navigazione ---------------------------------------------------------------------

  function leggiRotta() {
    var h = (location.hash || '#/').replace(/^#/, '');
    var q = {};
    var i = h.indexOf('?');
    if (i >= 0) {
      var coppie = h.slice(i + 1).split('&');
      for (var k = 0; k < coppie.length; k++) {
        var kv = coppie[k].split('=');
        if (kv[0]) { q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ''); }
      }
      h = h.slice(0, i);
    }
    var parti = [];
    var pezzi = h.split('/');
    for (var j = 0; j < pezzi.length; j++) { if (pezzi[j]) { parti.push(decodeURIComponent(pezzi[j])); } }
    var nome = parti[0] || 'playlist';
    var nomi = { p: 'una', b: 'brano' };
    rotta = { nome: nomi[nome] || nome, parti: parti, q: q };
  }

  function segnaScheda() {
    var mappa = { playlist: 'playlist', una: 'playlist', brano: 'playlist', cerca: 'cerca', ascolta: 'ascolta', proposte: 'proposte',
      chiavetta: 'chiavetta', copia: 'chiavetta', importa: 'chiavetta', pc: 'pc' };
    var s = mappa[rotta.nome] || '';
    var link = document.getElementById('schede').getElementsByTagName('a');
    for (var i = 0; i < link.length; i++) {
      link[i].className = link[i].getAttribute('data-s') === s ? 'attiva' : '';
    }
  }

  function vai() {
    leggiRotta();
    segnaScheda();
    if (rotta.nome !== 'una') { selezione = null; }
    var v = {
      playlist: vistaPlaylist, una: vistaUna, brano: vistaBrano, cerca: vistaCerca, ascolta: vistaAscolta,
      proposte: vistaProposte, chiavetta: vistaChiavetta, copia: vistaCopia, importa: vistaImporta, pc: vistaPC
    }[rotta.nome] || vistaPlaylist;
    v();
  }

  window.onhashchange = function () { fermaAscolto(); vai(); };

  // --- Azioni (un solo gestore per tutti i clic) ------------------------------------------

  var azioni = {};

  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== document && !(el.getAttribute && el.getAttribute('data-azione'))) { el = el.parentNode; }
    if (!el || el === document) { return; }
    var a = azioni[el.getAttribute('data-azione')];
    if (a) {
      e.preventDefault();
      a(el, e);
    }
  });

  // --- Playlist -----------------------------------------------------------------------------

  function bannerPC() {
    if (!stato) { return ''; }
    var h = '';
    if (!stato.agente) {
      h += '<div class="nota info">Per leggere la chiavetta e copiare i brani serve il programma sul PC a cui si attacca la chiavetta: <a href="#/pc">collegalo dalla pagina PC</a>.</div>';
    }
    if (stato.chiavetta && stato.chiavetta.da_importare > 0) {
      h += '<div class="nota info">Sulla chiavetta ci sono ' + plur(stato.chiavetta.da_importare, 'un brano che non è', 'brani che non sono') +
        ' in nessuna playlist. <a href="#/importa">Guarda e importa</a>.</div>';
    }
    return h;
  }

  function vistaPlaylist() {
    caricando();
    api('GET', '/api/playlist', null, function (err, lista) {
      if (err) { errore(err); return; }
      var h = '<div class="riga-titolo"><h1>Playlist</h1><button class="primario" data-azione="nuova-playlist">Nuova playlist</button></div>';
      h += bannerPC();
      if (lista.length === 0) {
        h += '<p class="vuoto">Non ci sono ancora playlist.<br>Leggi la chiavetta dalla pagina <a href="#/chiavetta">Chiavetta</a>, oppure creane una nuova.</p>';
      }
      for (var i = 0; i < lista.length; i++) {
        var p = lista[i];
        h += '<a class="scheda-pl" href="#/p/' + esc(p.id) + '">' + mosaico(p.copertine) + '<span class="testo"><b>' + esc(p.nome) +
          '<span class="tipo">' + (p.tipo === 'm3u' ? 'playlist .m3u' : 'cartella') + '</span></b>' +
          '<small>' + plur(p.n, '1 brano', 'brani') + (p.n ? ' · ' + esc(riepilogo(p.conteggi)) : '') + '</small></span></a>';
      }
      vista.innerHTML = h;
    });
  }

  azioni['nuova-playlist'] = function () {
    var nome = window.prompt('Nome della nuova playlist:', '');
    if (!nome) { return; }
    api('POST', '/api/playlist', { nome: nome, tipo: 'cartella' }, function (err, r) {
      if (err) { avviso(err, true); return; }
      ricordaPlaylist(r.id);
      location.hash = '#/p/' + r.id;
    });
  };

  // --- Una playlist -----------------------------------------------------------------------------

  var plCorrente = null;

  function vistaUna() {
    var id = rotta.parti[1];
    caricando();
    api('GET', '/api/playlist/' + encodeURIComponent(id), null, function (err, pl) {
      if (err) { errore(err); return; }
      plCorrente = pl;
      ricordaPlaylist(pl.id);
      disegnaUna();
    });
  }

  function disegnaUna() {
    var pl = plCorrente;
    var covers = [];
    for (var i = 0; i < pl.brani.length && covers.length < 4; i++) {
      if (pl.brani[i].copertina && covers.indexOf(pl.brani[i].copertina) < 0) { covers.push(pl.brani[i].copertina); }
    }
    var h = '<p><a href="#/">Tutte le playlist</a></p>';
    h += '<div class="intestazione">' + mosaico(covers, true) + '<div><h1>' + esc(pl.nome) + '</h1>' +
      '<small>' + plur(pl.brani.length, '1 brano', 'brani') + ' · ' + (pl.tipo === 'm3u' ? 'playlist .m3u (i brani restano nelle loro cartelle)' : 'cartella sulla chiavetta') + '</small>' +
      (pl.descrizione ? '<p class="tenue">' + esc(pl.descrizione) + '</p>' : '') + '</div></div>';
    if (!selezione) {
      h += '<div class="azioni"><a class="bottone primario" href="#/cerca?p=' + esc(pl.id) + '">Aggiungi brani</a>' +
        '<a class="bottone" href="#/ascolta?p=' + esc(pl.id) + '">Ascolta e aggiungi</a></div>' +
        '<div class="azioni secondarie">' +
        (pl.brani.length ? '<button class="piccolo" data-azione="seleziona">Seleziona</button>' : '') +
        '<button class="piccolo" data-azione="rinomina">Rinomina</button>' +
        '<button class="piccolo" data-azione="cambia-tipo">' + (pl.tipo === 'm3u' ? 'Fanne una cartella' : 'Fanne una .m3u') + '</button>' +
        '<button class="piccolo pericolo" data-azione="elimina-playlist">Elimina</button></div>';
    }
    if (pl.brani.length === 0) {
      h += '<p class="vuoto">La playlist è vuota: aggiungi dei brani cercandoli per nome o facendoli ascoltare al telefono.</p>';
    }
    h += '<div class="riquadro"><ul class="elenco">';
    for (var j = 0; j < pl.brani.length; j++) {
      var b = pl.brani[j];
      var sel = selezione && selezione.ids[b.id];
      h += '<li class="voce cliccabile" data-azione="' + (selezione ? 'spunta' : 'apri-brano') + '" data-id="' + esc(b.id) + '">' +
        (selezione ? '<input type="checkbox"' + (sel ? ' checked' : '') + ' tabindex="-1">' : '') +
        cop(b.copertina) + '<span class="testo"><b>' + esc(b.titolo) + '</b><span>' + esc(b.artista) + (b.anno ? ' · ' + b.anno : '') +
        '</span>' + (b.album ? '<small>' + esc(b.album) + '</small>' : '') + '</span>' + chip(b.stato, b.disco) + '</li>';
    }
    h += '</ul></div>';
    if (selezione) {
      var n = contaSel();
      h += '<div class="barra-sel"><div class="dentro"><b>' + plur(n, '1 brano selezionato', 'brani selezionati') + '</b><br>' +
        '<button class="piccolo pericolo" data-azione="togli-sel"' + (n ? '' : ' disabled') + '>Togli</button>' +
        '<button class="piccolo" data-azione="sposta-sel" data-copia="0"' + (n ? '' : ' disabled') + '>Sposta in...</button>' +
        '<button class="piccolo" data-azione="sposta-sel" data-copia="1"' + (n ? '' : ' disabled') + '>Copia in...</button>' +
        '<button class="piccolo" data-azione="su"' + (n === 1 ? '' : ' disabled') + '>Su</button>' +
        '<button class="piccolo" data-azione="giu"' + (n === 1 ? '' : ' disabled') + '>Giù</button>' +
        '<button class="piccolo primario" data-azione="fine-sel">Fatto</button></div></div>';
    }
    vista.innerHTML = h;
  }

  function contaSel() {
    var n = 0;
    for (var k in selezione.ids) { if (selezione.ids.hasOwnProperty(k) && selezione.ids[k]) { n++; } }
    return n;
  }

  function idsSel() {
    var out = [];
    for (var i = 0; i < plCorrente.brani.length; i++) {
      if (selezione.ids[plCorrente.brani[i].id]) { out.push(plCorrente.brani[i].id); }
    }
    return out;
  }

  azioni['apri-brano'] = function (el) {
    location.hash = '#/b/' + el.getAttribute('data-id') + (rotta.nome === 'una' ? '?p=' + plCorrente.id : '');
  };
  azioni.seleziona = function () { selezione = { pl: plCorrente.id, ids: {} }; disegnaUna(); };
  azioni['fine-sel'] = function () { selezione = null; disegnaUna(); };
  azioni.spunta = function (el) {
    var id = el.getAttribute('data-id');
    selezione.ids[id] = !selezione.ids[id];
    disegnaUna();
  };

  azioni.rinomina = function () {
    var nome = window.prompt('Nuovo nome della playlist:', plCorrente.nome);
    if (!nome || nome === plCorrente.nome) { return; }
    api('PATCH', '/api/playlist/' + plCorrente.id, { nome: nome }, function (err) {
      if (err) { avviso(err, true); return; }
      vistaUna();
    });
  };

  azioni['cambia-tipo'] = function () {
    var nuovo = plCorrente.tipo === 'm3u' ? 'cartella' : 'm3u';
    var msg = nuovo === 'm3u' ?
      'La playlist diventa un file .m3u: i brani non vengono copiati due volte, ma alcune autoradio non leggono le .m3u. Continuo?' :
      'La playlist diventa una cartella sulla chiavetta con i suoi brani dentro (funziona su tutte le autoradio). Continuo?';
    if (!window.confirm(msg)) { return; }
    api('PATCH', '/api/playlist/' + plCorrente.id, { tipo: nuovo }, function (err) {
      if (err) { avviso(err, true); return; }
      vistaUna();
    });
  };

  azioni['elimina-playlist'] = function () {
    if (!window.confirm('Eliminare la playlist «' + plCorrente.nome + '»? Alla prossima copia i suoi brani verranno spostati nella cartella _Tolti della chiavetta (non cancellati).')) { return; }
    api('DELETE', '/api/playlist/' + plCorrente.id, null, function (err) {
      if (err) { avviso(err, true); return; }
      avviso('Playlist eliminata.');
      location.hash = '#/';
    });
  };

  azioni['togli-sel'] = function () {
    var ids = idsSel();
    if (!window.confirm('Togliere ' + plur(ids.length, 'il brano selezionato', 'brani selezionati') + ' dalla playlist?')) { return; }
    api('POST', '/api/playlist/' + plCorrente.id + '/togli', { brani: ids }, function (err) {
      if (err) { avviso(err, true); return; }
      selezione = null;
      vistaUna();
    });
  };

  azioni['sposta-sel'] = function (el) {
    var copia = el.getAttribute('data-copia') === '1';
    api('GET', '/api/playlist', null, function (err, lista) {
      if (err) { avviso(err, true); return; }
      var altre = [];
      for (var i = 0; i < lista.length; i++) { if (lista[i].id !== plCorrente.id) { altre.push(lista[i]); } }
      if (altre.length === 0) { avviso('Non ci sono altre playlist.', true); return; }
      var h = '<div class="riquadro"><h2>' + (copia ? 'Copia' : 'Sposta') + ' in quale playlist?</h2><ul class="elenco">';
      for (var j = 0; j < altre.length; j++) {
        h += '<li class="voce cliccabile" data-azione="sposta-in" data-id="' + esc(altre[j].id) + '" data-copia="' + (copia ? 1 : 0) + '">' +
          mosaico(altre[j].copertine) + '<span class="testo"><b>' + esc(altre[j].nome) + '</b></span></li>';
      }
      h += '</ul><button data-azione="fine-sposta">Annulla</button></div>';
      vista.innerHTML = h;
    });
  };
  azioni['fine-sposta'] = function () { disegnaUna(); };
  azioni['sposta-in'] = function (el) {
    var copia = el.getAttribute('data-copia') === '1';
    api('POST', '/api/playlist/' + plCorrente.id + '/sposta', { brani: idsSel(), a: el.getAttribute('data-id'), copia: copia }, function (err) {
      if (err) { avviso(err, true); return; }
      avviso(copia ? 'Copiati.' : 'Spostati.');
      selezione = null;
      vistaUna();
    });
  };

  function spostaSel(d) {
    var ids = [];
    for (var i = 0; i < plCorrente.brani.length; i++) { ids.push(plCorrente.brani[i].id); }
    var sel = idsSel()[0];
    var p = ids.indexOf(sel);
    var q = p + d;
    if (q < 0 || q >= ids.length) { return; }
    ids[p] = ids[q];
    ids[q] = sel;
    api('POST', '/api/playlist/' + plCorrente.id + '/ordine', { brani: ids }, function (err) {
      if (err) { avviso(err, true); return; }
      var b = plCorrente.brani[p];
      plCorrente.brani[p] = plCorrente.brani[q];
      plCorrente.brani[q] = b;
      disegnaUna();
    });
  }
  azioni.su = function () { spostaSel(-1); };
  azioni.giu = function () { spostaSel(1); };

  // --- Un brano -------------------------------------------------------------------------------------

  var branoCorrente = null;

  function vistaBrano() {
    var id = rotta.parti[1];
    caricando();
    api('GET', '/api/brani/' + encodeURIComponent(id), null, function (err, r) {
      if (err) { errore(err); return; }
      branoCorrente = r;
      var b = r.brano;
      var back = rotta.q.p ? '#/p/' + esc(rotta.q.p) : '#/';
      var h = '<p><a href="' + back + '">Torna alla playlist</a></p>';
      h += '<div class="intestazione">' + cop(b.copertina, 'grande') + '<div><h1>' + esc(b.titolo) + '</h1><p>' + esc(b.artista) +
        (b.anno ? ' · ' + b.anno : '') + '</p>' + chip(r.vista.stato, r.vista.disco) +
        (r.vista.file ? '<p><small>Sulla chiavetta: ' + esc(r.vista.file) + '</small></p>' : '') + '</div></div>';
      h += '<div class="riquadro"><h2>Informazioni</h2>' +
        '<label class="campo"><span>Artista</span><input type="text" id="f-artista" value="' + esc(b.artista) + '"></label>' +
        '<label class="campo"><span>Titolo</span><input type="text" id="f-titolo" value="' + esc(b.titolo) + '"></label>' +
        '<label class="campo"><span>Album</span><input type="text" id="f-album" value="' + esc(b.album) + '"></label>' +
        '<label class="campo"><span>Anno</span><input type="number" id="f-anno" value="' + esc(b.anno || '') + '"></label>' +
        '<button class="primario" data-azione="salva-brano">Salva</button>' +
        '<p><small>Nome del file sulla chiavetta: «Artista - Titolo - Anno.mp3». Copertina da ' + esc(b.fonte_cop || 'nessuna fonte') + '.</small></p></div>';
      h += '<div class="riquadro"><h2>Copie sui dischi</h2>';
      if (r.candidati.length === 0) {
        h += '<p class="tenue">Nessuna copia trovata sui dischi' + (stato && stato.dischi && stato.dischi.length ? '.' : ': i dischi non sono ancora stati esplorati (pagina Chiavetta, «Cerca negli HD»).') + '</p>';
      } else {
        h += '<ul class="elenco">';
        for (var i = 0; i < r.candidati.length; i++) {
          var c = r.candidati[i];
          h += '<li class="voce"><span class="testo"><b>' + esc(c.artista + ' - ' + c.titolo) + '</b><span>«' + esc(c.disco) + '» ' + esc(c.p) +
            '</span><small>' + (c.kbps ? c.kbps + ' kbps · ' : '') + minuti(c.durata) + (c.collegato ? '' : ' · disco non collegato') + '</small></span>' +
            (c.scelto ? '<span class="chip ok">Scelta</span>' : '<button class="piccolo" data-azione="usa-copia" data-i="' + i + '">Usa questa</button>') + '</li>';
        }
        h += '</ul>';
        if (b.fonte) { h += '<button class="piccolo" data-azione="copia-automatica">Torna alla scelta automatica</button>'; }
      }
      h += '</div>';
      if (r.chiavetta && r.chiavetta.length) {
        h += '<div class="riquadro"><h2>File sulla chiavetta</h2><ul class="elenco">';
        for (var k = 0; k < r.chiavetta.length; k++) {
          var f = r.chiavetta[k];
          h += '<li class="voce"><span class="testo"><b>' + esc(f.p) + '</b><small>' + (f.kbps ? f.kbps + ' kbps' : '') +
            (f.rovinato ? ' · rovinato: ' + esc((f.problemi || []).join('; ')) : '') + '</small></span></li>';
        }
        h += '</ul></div>';
      }
      h += '<p class="tenue">Nelle playlist: ' + esc((r.playlist || []).join(', ') || 'nessuna') + '</p>';
      if (rotta.q.p) { h += '<button class="pericolo" data-azione="togli-brano">Togli da questa playlist</button>'; }
      vista.innerHTML = h;
    });
  }

  azioni['salva-brano'] = function () {
    var anno = parseInt(document.getElementById('f-anno').value, 10) || 0;
    api('PATCH', '/api/brani/' + branoCorrente.brano.id, {
      artista: document.getElementById('f-artista').value,
      titolo: document.getElementById('f-titolo').value,
      album: document.getElementById('f-album').value,
      anno: anno
    }, function (err) {
      if (err) { avviso(err, true); return; }
      avviso('Salvato.');
      vistaBrano();
    });
  };

  azioni['usa-copia'] = function (el) {
    var c = branoCorrente.candidati[parseInt(el.getAttribute('data-i'), 10)];
    api('PATCH', '/api/brani/' + branoCorrente.brano.id, { fonte: { volume: c.volume, p: c.p } }, function (err) {
      if (err) { avviso(err, true); return; }
      avviso('Userò questa copia.');
      vistaBrano();
    });
  };

  azioni['copia-automatica'] = function () {
    api('PATCH', '/api/brani/' + branoCorrente.brano.id, { automatica: true }, function (err) {
      if (err) { avviso(err, true); return; }
      vistaBrano();
    });
  };

  azioni['togli-brano'] = function () {
    api('POST', '/api/playlist/' + encodeURIComponent(rotta.q.p) + '/togli', { brani: [branoCorrente.brano.id] }, function (err) {
      if (err) { avviso(err, true); return; }
      avviso('Tolto dalla playlist.');
      location.hash = '#/p/' + rotta.q.p;
    });
  };

  // --- Aggiungere brani --------------------------------------------------------------------------------

  var playlistElenco = [];

  // conPlaylist carica l'elenco delle playlist e sceglie quella di destinazione.
  function conPlaylist(cb) {
    api('GET', '/api/playlist', null, function (err, lista) {
      if (err) { errore(err); return; }
      playlistElenco = lista;
      var scelta = rotta.q.p || ultimaPlaylist;
      var ok = false;
      for (var i = 0; i < lista.length; i++) { if (lista[i].id === scelta) { ok = true; } }
      if (!ok) { scelta = lista.length ? lista[0].id : ''; }
      cb(scelta);
    });
  }

  function destinazione() {
    var el = document.getElementById('destinazione');
    return el ? el.value : '';
  }

  function aggiungi(corpo, bottone) {
    var pl = destinazione();
    if (!pl) { avviso('Crea prima una playlist.', true); return; }
    ricordaPlaylist(pl);
    if (bottone) { bottone.disabled = true; }
    api('POST', '/api/playlist/' + pl + '/brani', corpo, function (err, r) {
      if (bottone) { bottone.disabled = false; }
      if (err) { avviso(err, true); return; }
      if (bottone) { bottone.textContent = 'Aggiunto'; }
      avviso(r.gia_presente ? 'Era già nella playlist.' : 'Aggiunto: ' + r.brano.artista + ' - ' + r.brano.titolo);
    });
  }

  var cercaTimer = null;
  var ultimaRicerca = null;

  function vistaCerca() {
    caricando();
    conPlaylist(function (scelta) {
      var h = '<h1>Cerca e aggiungi</h1>';
      if (playlistElenco.length === 0) {
        h += '<div class="nota info">Non ci sono playlist: <a href="#/" data-azione="nuova-playlist">creane una</a> per aggiungere i brani.</div>';
      } else {
        h += '<label class="campo"><span>Aggiungi alla playlist</span>' + scegliPlaylist(playlistElenco, scelta) + '</label>';
      }
      h += '<label class="campo"><span>Cerca per artista o titolo, sui dischi e nel catalogo</span><input type="search" id="q" autocomplete="off" placeholder="Per esempio: Vasco Albachiara" value="' + esc(rotta.q.q || '') + '"></label>' +
        '<div id="risultati"></div>' +
        '<details><summary>Non lo trovi? Aggiungilo scrivendo artista e titolo</summary>' +
        '<label class="campo"><span>Artista</span><input type="text" id="n-artista"></label>' +
        '<label class="campo"><span>Titolo</span><input type="text" id="n-titolo"></label>' +
        '<button data-azione="aggiungi-nuovo">Aggiungi</button>' +
        '<p><small>Il sito cercherà anno, album e copertina, e il brano verrà copiato quando lo trova su un disco.</small></p></details>';
      vista.innerHTML = h;
      var q = document.getElementById('q');
      q.oninput = function () {
        clearTimeout(cercaTimer);
        cercaTimer = setTimeout(function () { cerca(q.value); }, 400);
      };
      if (q.value) { cerca(q.value); } else { q.focus(); }
    });
  }

  function cerca(testo) {
    var box = document.getElementById('risultati');
    if (!box) { return; }
    if (testo.replace(/\s/g, '').length < 2) { box.innerHTML = ''; return; }
    box.innerHTML = '<p class="tenue">Cerco...</p>';
    var mia = {};
    ultimaRicerca = mia;
    api('GET', '/api/cerca?q=' + encodeURIComponent(testo), null, function (err, r) {
      if (ultimaRicerca !== mia || !document.getElementById('risultati')) { return; }
      if (err) { box.innerHTML = '<div class="nota err">' + esc(err) + '</div>'; return; }
      risultatiCerca = r;
      var h = '';
      if (r.libreria.length) {
        h += '<h2>Già nelle playlist</h2><div class="riquadro"><ul class="elenco">';
        for (var i = 0; i < r.libreria.length; i++) {
          var l = r.libreria[i];
          h += '<li class="voce">' + cop(l.copertina) + '<span class="testo"><b>' + esc(l.titolo) + '</b><span>' + esc(l.artista) + (l.anno ? ' · ' + l.anno : '') +
            '</span><small>' + esc(l.playlist.join(', ') || 'in nessuna playlist') + '</small></span><button class="piccolo" data-azione="aggiungi-lib" data-i="' + i + '">Aggiungi</button></li>';
        }
        h += '</ul></div>';
      }
      h += '<h2>Sui dischi</h2>';
      if (r.dischi.length === 0) {
        h += '<p class="tenue">' + (stato && stato.dischi && stato.dischi.length ? 'Niente sui dischi.' : 'I dischi non sono ancora stati esplorati: vai in Chiavetta e premi «Cerca negli HD».') + '</p>';
      } else {
        h += '<div class="riquadro"><ul class="elenco">';
        for (var j = 0; j < r.dischi.length; j++) {
          var d = r.dischi[j];
          h += '<li class="voce"><span class="testo"><b>' + esc(d.titolo) + '</b><span>' + esc(d.artista) + (d.anno ? ' · ' + d.anno : '') + (d.album ? ' · ' + esc(d.album) : '') +
            '</span><small>«' + esc(d.disco) + '»' + (d.kbps ? ', ' + d.kbps + ' kbps' : '') + (d.copie > 1 ? ', ' + d.copie + ' copie' : '') +
            (d.collegato ? '' : ', disco non collegato') + '</small></span><button class="piccolo" data-azione="aggiungi-disco" data-i="' + j + '">Aggiungi</button></li>';
        }
        h += '</ul></div>';
      }
      h += '<h2>Catalogo Deezer</h2>';
      if (r.deezer_errore) { h += '<p class="tenue">' + esc(r.deezer_errore) + '</p>'; }
      if (r.deezer.length) {
        h += '<p><small>I brani del catalogo vengono copiati solo se si trovano su un disco del PC: il sito non scarica musica.</small></p><div class="riquadro"><ul class="elenco">';
        for (var k = 0; k < r.deezer.length; k++) {
          var z = r.deezer[k];
          h += '<li class="voce">' + (z.copertina ? '<img class="cop" src="' + esc(z.copertina) + '" alt="">' : cop('')) +
            '<span class="testo"><b>' + esc(z.titolo) + '</b><span>' + esc(z.artista) + '</span><small>' + esc(z.album) + (z.durata ? ' · ' + minuti(z.durata) : '') + '</small></span>' +
            (z.ascolta ? '<button class="piccolo" data-azione="anteprima" data-i="' + k + '">Ascolta</button>' : '') +
            '<button class="piccolo" data-azione="aggiungi-deezer" data-i="' + k + '">Aggiungi</button></li>';
        }
        h += '</ul></div>';
      } else if (!r.deezer_errore) {
        h += '<p class="tenue">Niente nel catalogo.</p>';
      }
      box.innerHTML = h;
    });
  }

  var risultatiCerca = null;
  var lettore = null;

  azioni['aggiungi-lib'] = function (el) { aggiungi({ brano: risultatiCerca.libreria[+el.getAttribute('data-i')].id }, el); };
  azioni['aggiungi-disco'] = function (el) {
    var d = risultatiCerca.dischi[+el.getAttribute('data-i')];
    aggiungi({ disco: { volume: d.volume, p: d.p } }, el);
  };
  azioni['aggiungi-deezer'] = function (el) { aggiungi({ deezer: risultatiCerca.deezer[+el.getAttribute('data-i')].id }, el); };
  azioni['aggiungi-nuovo'] = function (el) {
    var a = document.getElementById('n-artista').value;
    var t = document.getElementById('n-titolo').value;
    if (!t) { avviso('Scrivi almeno il titolo.', true); return; }
    aggiungi({ nuovo: { artista: a, titolo: t } }, el);
  };
  azioni.anteprima = function (el) {
    var z = risultatiCerca.deezer[+el.getAttribute('data-i')];
    if (lettore) { lettore.pause(); }
    if (lettore && lettore.getAttribute('data-id') === String(z.id)) { lettore = null; el.textContent = 'Ascolta'; return; }
    lettore = new Audio(z.ascolta);
    lettore.setAttribute('data-id', String(z.id));
    lettore.play();
    el.textContent = 'Ferma';
  };

  // --- Ascolta (come Shazam) ---------------------------------------------------------------------------

  var ascolto = null; // registrazione in corso
  var risultatoAscolto = null;
  var SECONDI = 14;

  function vistaAscolta() {
    caricando();
    conPlaylist(function (scelta) {
      var h = '<h1>Ascolta e aggiungi</h1><p class="tenue">Fai sentire al telefono la canzone che sta suonando: il sito la riconosce, come Shazam.</p>';
      if (playlistElenco.length) {
        h += '<label class="campo"><span>Aggiungi alla playlist</span>' + scegliPlaylist(playlistElenco, scelta) + '</label>';
      }
      h += '<div class="ascolta"><button class="tasto-ascolta" id="tasto" data-azione="ascolta">Ascolta</button>' +
        '<p id="ascolta-stato" class="tenue">Tieni il telefono vicino alla musica.</p></div><div id="ascolta-risultato"></div>' +
        '<details><summary>Il microfono non funziona?</summary><p>Registra qualche secondo con l\'app del telefono e caricalo qui:</p>' +
        '<input type="file" id="file-audio" accept="audio/*" capture></details>';
      vista.innerHTML = h;
      document.getElementById('file-audio').onchange = function () {
        if (this.files && this.files[0]) { invia(this.files[0]); }
      };
      if (!puoRegistrare()) {
        document.getElementById('ascolta-stato').textContent = 'Questo browser non può usare il microfono: carica una registrazione qui sotto.';
      }
    });
  }

  function puoRegistrare() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function statoAscolto(t) {
    var el = document.getElementById('ascolta-stato');
    if (el) { el.textContent = t; }
  }

  function fermaAscolto() {
    if (!ascolto) { return; }
    try { ascolto.ferma(true); } catch (e) { /* niente */ }
    ascolto = null;
  }

  azioni.ascolta = function (el) {
    if (ascolto) { return; }
    if (!puoRegistrare()) { avviso('Questo browser non può usare il microfono.', true); return; }
    document.getElementById('ascolta-risultato').innerHTML = '';
    // il contesto audio va creato durante il tocco, altrimenti Safari lo blocca
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = (!window.MediaRecorder && Ctx) ? new Ctx() : null;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      ascolto = window.MediaRecorder ? registraConRecorder(stream) : registraConWebAudio(stream, ctx);
      el.className = 'tasto-ascolta ascolto';
      var resto = SECONDI;
      statoAscolto('Ascolto... ' + resto);
      ascolto.conto = setInterval(function () {
        resto--;
        if (resto > 0) { statoAscolto('Ascolto... ' + resto); }
      }, 1000);
      ascolto.timer = setTimeout(function () { if (ascolto) { ascolto.ferma(false); } }, SECONDI * 1000);
    }, function () {
      if (ctx && ctx.close) { ctx.close(); }
      avviso('Non ho il permesso di usare il microfono: consentilo nelle impostazioni del browser.', true);
    });
  };

  function fineRegistrazione(blob, annullata) {
    var t = document.getElementById('tasto');
    if (t) { t.className = 'tasto-ascolta'; }
    if (ascolto) {
      clearInterval(ascolto.conto);
      clearTimeout(ascolto.timer);
    }
    ascolto = null;
    if (!annullata && blob) { invia(blob); }
  }

  function registraConRecorder(stream) {
    var tipi = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'];
    var opz = {};
    for (var i = 0; i < tipi.length; i++) {
      if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(tipi[i])) { opz.mimeType = tipi[i]; break; }
    }
    var rec = opz.mimeType ? new window.MediaRecorder(stream, opz) : new window.MediaRecorder(stream);
    var pezzi = [];
    var annullata = false;
    rec.ondataavailable = function (e) { if (e.data && e.data.size) { pezzi.push(e.data); } };
    rec.onstop = function () {
      var tracce = stream.getTracks();
      for (var j = 0; j < tracce.length; j++) { tracce[j].stop(); }
      fineRegistrazione(new Blob(pezzi, { type: rec.mimeType || opz.mimeType || 'audio/webm' }), annullata);
    };
    rec.start();
    return { ferma: function (annulla) { annullata = annulla; if (rec.state !== 'inactive') { rec.stop(); } } };
  }

  // Safari vecchi senza MediaRecorder: si raccolgono i campioni e si scrive un WAV.
  function registraConWebAudio(stream, ctx) {
    var src = ctx.createMediaStreamSource(stream);
    var proc = ctx.createScriptProcessor(4096, 1, 1);
    var buffer = [];
    proc.onaudioprocess = function (e) { buffer.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    src.connect(proc);
    proc.connect(ctx.destination);
    return {
      ferma: function (annulla) {
        src.disconnect();
        proc.disconnect();
        var tracce = stream.getTracks();
        for (var j = 0; j < tracce.length; j++) { tracce[j].stop(); }
        var wav = annulla ? null : creaWav(buffer, ctx.sampleRate);
        if (ctx.close) { ctx.close(); }
        fineRegistrazione(wav, annulla);
      }
    };
  }

  function creaWav(pezzi, rate) {
    var uscita = 16000;
    var passo = rate / uscita;
    var tot = 0;
    for (var i = 0; i < pezzi.length; i++) { tot += pezzi[i].length; }
    var n = Math.floor(tot / passo);
    var dati = new DataView(new ArrayBuffer(44 + n * 2));
    function scrivi(off, s) { for (var k = 0; k < s.length; k++) { dati.setUint8(off + k, s.charCodeAt(k)); } }
    scrivi(0, 'RIFF'); dati.setUint32(4, 36 + n * 2, true); scrivi(8, 'WAVE'); scrivi(12, 'fmt ');
    dati.setUint32(16, 16, true); dati.setUint16(20, 1, true); dati.setUint16(22, 1, true);
    dati.setUint32(24, uscita, true); dati.setUint32(28, uscita * 2, true); dati.setUint16(32, 2, true); dati.setUint16(34, 16, true);
    scrivi(36, 'data'); dati.setUint32(40, n * 2, true);
    var p = 0, idx = 0, off = 0;
    for (var j = 0; j < n; j++) {
      var pos = Math.floor(j * passo) - off;
      while (p < pezzi.length && pos >= pezzi[p].length) { off += pezzi[p].length; pos -= pezzi[p].length; p++; }
      var v = p < pezzi.length ? pezzi[p][pos] : 0;
      v = Math.max(-1, Math.min(1, v));
      dati.setInt16(44 + idx * 2, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
      idx++;
    }
    return new Blob([dati], { type: 'audio/wav' });
  }

  function invia(blob) {
    statoAscolto('Riconosco il brano...');
    api('POST', '/api/riconosci', blob, function (err, r) {
      if (!document.getElementById('ascolta-risultato')) { return; }
      if (err) { statoAscolto(err); return; }
      risultatoAscolto = r;
      if (!r.trovato) {
        statoAscolto('');
        document.getElementById('ascolta-risultato').innerHTML = '<div class="nota att">' + esc(r.messaggio) + '</div>';
        return;
      }
      statoAscolto('Trovato!');
      var h = '<div class="riquadro risultato"><div class="intestazione">' + cop(r.copertina, 'grande') + '<div><h1>' + esc(r.titolo) + '</h1><p>' +
        esc(r.artista) + (r.anno ? ' · ' + r.anno : '') + '</p>' + (r.album ? '<p class="tenue">' + esc(r.album) + '</p>' : '') + '</div></div>';
      if (r.dischi && r.dischi.length) {
        var d = r.dischi[0];
        h += '<div class="nota ok">È sul disco «' + esc(d.disco) + '»' + (d.kbps ? ' (' + d.kbps + ' kbps)' : '') + ': verrà copiato sulla chiavetta.</div>';
      } else {
        h += '<div class="nota att">Non l\'ho trovato sui dischi: lo aggiungo lo stesso, e verrà copiato quando sarà su un disco del PC.</div>';
      }
      if (r.in_libreria && r.in_libreria.length) {
        h += '<p class="tenue">È già in: ' + esc(r.in_libreria[0].playlist.join(', ') || 'nessuna playlist') + '</p>';
      }
      h += '<button class="primario grande" data-azione="aggiungi-shazam">Aggiungi alla playlist</button></div>';
      document.getElementById('ascolta-risultato').innerHTML = h;
    });
  }

  azioni['aggiungi-shazam'] = function (el) { aggiungi({ shazam: risultatoAscolto }, el); };

  // --- Proposte -------------------------------------------------------------------------------------------

  var proposte = null;

  function vistaProposte() {
    caricando();
    api('GET', '/api/proposte', null, function (err, r) {
      if (err) { errore(err); return; }
      proposte = r;
      var h = '<div class="riga-titolo"><h1>Playlist proposte</h1><button class="primario" data-azione="genera"' + (r.in_corso ? ' disabled' : '') + '>Proponi playlist</button></div>';
      h += '<p class="tenue">Il sito raggruppa i brani simili (epoca, genere, lingua, ritmo)' + (r.ai ? ' e chiede a un\'AI di inventare gruppi a tema' : '') +
        '. Le proposte che accetti diventano playlist .m3u: i brani non vengono copiati due volte.</p>';
      if (r.in_corso) { h += '<div class="nota info">Sto preparando le proposte...</div><div class="progresso indeterminato"><div></div></div>'; }
      if (r.errore) { h += '<div class="nota att">' + esc(r.errore) + '</div>'; }
      if (r.motore && !r.in_corso) { h += '<p><small>Proposte di ' + esc(r.create) + ', con ' + esc(r.motore) + '.</small></p>'; }
      if (!r.lista.length && !r.in_corso) {
        h += '<p class="vuoto">Nessuna proposta da guardare. Premi «Proponi playlist».</p>';
      }
      for (var i = 0; i < r.lista.length; i++) {
        var p = r.lista[i];
        h += '<div class="riquadro"><div class="intestazione">' + mosaico(p.copertine) + '<div style="flex:1 1 auto">' +
          '<input type="text" id="pn-' + esc(p.id) + '" value="' + esc(p.nome) + '"><p class="tenue">' + esc(p.descrizione) + ' ' +
          plur(p.brani.length, '1 brano', 'brani') + (p.fonte === 'ai' ? ', idea dell\'AI' : '') + '.</p></div></div>' +
          '<details><summary>Guarda i brani</summary><ul class="elenco">';
        for (var j = 0; j < p.esempi.length; j++) {
          var b = p.esempi[j];
          h += '<li class="voce"><input type="checkbox" checked class="pb-' + esc(p.id) + '" value="' + esc(b.id) + '">' + cop(b.copertina) +
            '<span class="testo"><b>' + esc(b.titolo) + '</b><span>' + esc(b.artista) + (b.anno ? ' · ' + b.anno : '') + '</span></span></li>';
        }
        h += '</ul></details><button class="primario" data-azione="accetta" data-id="' + esc(p.id) + '" data-tipo="m3u">Accetta (.m3u)</button>' +
          '<button data-azione="accetta" data-id="' + esc(p.id) + '" data-tipo="cartella">Accetta come cartella</button>' +
          '<button class="pericolo" data-azione="scarta" data-id="' + esc(p.id) + '">Scarta</button></div>';
      }
      vista.innerHTML = h;
      if (r.in_corso) { setTimeout(function () { if (rotta.nome === 'proposte') { vistaProposte(); } }, 3000); }
    });
  }

  azioni.genera = function () {
    api('POST', '/api/proposte/genera', {}, function (err) {
      if (err) { avviso(err, true); return; }
      setTimeout(vistaProposte, 600);
    });
  };

  azioni.accetta = function (el) {
    var id = el.getAttribute('data-id');
    var spunte = document.getElementsByClassName('pb-' + id);
    var brani = [];
    for (var i = 0; i < spunte.length; i++) { if (spunte[i].checked) { brani.push(spunte[i].value); } }
    var nome = document.getElementById('pn-' + id).value;
    api('POST', '/api/proposte/' + id + '/accetta', { nome: nome, brani: brani, tipo: el.getAttribute('data-tipo') }, function (err, r) {
      if (err) { avviso(err, true); return; }
      avviso('Creata la playlist «' + r.nome + '».');
      vistaProposte();
    });
  };

  azioni.scarta = function (el) {
    api('POST', '/api/proposte/' + el.getAttribute('data-id') + '/scarta', {}, function (err) {
      if (err) { avviso(err, true); return; }
      vistaProposte();
    });
  };

  // --- Chiavetta e lavori ------------------------------------------------------------------------------------

  var NOMI_LAVORI = { scansiona_chiavetta: 'Lettura della chiavetta', indicizza_hd: 'Ricerca degli mp3 nei dischi', copia: 'Copia sulla chiavetta', svuota_tolti: 'Svuotamento di _Tolti' };
  var NOMI_STATI = { in_coda: 'in attesa del PC', inviato: 'consegnato al PC', in_corso: 'in corso', fatto: 'fatto', errore: 'non riuscito', annullato: 'fermato' };

  function vistaChiavetta() {
    aggiornaStato(function () {
      var s = stato;
      var h = '<h1>Chiavetta e dischi</h1>';
      var a = s.agente;
      if (!a) {
        h += '<div class="nota info">Nessun PC collegato. <a href="#/pc">Collega il PC della chiavetta</a>.</div>';
      } else if (!a.online) {
        h += '<div class="nota att">Il PC «' + esc(a.nome) + '» è spento o il programma è chiuso (visto ' + esc(a.visto) + '). I lavori partiranno quando si ricollega.</div>';
      }
      h += '<div class="riquadro"><h2>La chiavetta</h2>';
      if (s.chiavetta) {
        h += '<p><b>' + esc(s.chiavetta.etichetta) + '</b>: ' + plur(s.chiavetta.file, '1 brano', 'brani') + ', letta ' + esc(s.chiavetta.letta) +
          (s.chiavetta.liberi ? ', liberi ' + peso(s.chiavetta.liberi) : '') + '.</p>';
        if (s.chiavetta.da_importare) {
          h += '<div class="nota info">' + plur(s.chiavetta.da_importare, 'Un brano non è', 'brani non sono') + ' in nessuna playlist. <a href="#/importa">Guarda e importa</a>.</div>';
        }
      } else {
        h += '<p class="tenue">Non è ancora stata letta. Attacca la chiavetta al PC collegato e premi «Leggi la chiavetta».</p>';
      }
      var collegata = '';
      if (a && a.unita) {
        for (var i = 0; i < a.unita.length; i++) {
          if (a.unita[i].rimovibile) { collegata += (collegata ? ', ' : '') + a.unita[i].lettera + ' ' + (a.unita[i].etichetta || '') + (a.unita[i].giusta ? ' (quella delle playlist)' : ''); }
        }
      }
      if (a && a.online) { h += '<p><small>Chiavette collegate adesso: ' + esc(collegata || 'nessuna') + '</small></p>'; }
      h += '<button data-azione="lavoro" data-tipo="scansiona">Leggi la chiavetta</button>' +
        '<a class="bottone primario" href="#/copia">Prepara la copia</a></div>';
      h += '<div class="riquadro"><h2>Gli hard disk</h2>';
      if (s.dischi && s.dischi.length) {
        h += '<ul class="elenco">';
        for (var j = 0; j < s.dischi.length; j++) {
          var d = s.dischi[j];
          var on = false;
          if (a && a.online && a.unita) { for (var k = 0; k < a.unita.length; k++) { if (a.unita[k].volume === d.volume) { on = true; } } }
          h += '<li class="voce"><span class="punto' + (on ? ' acceso' : '') + '"></span><span class="testo"><b>' + esc(d.etichetta || d.lettera) + '</b><span>' +
            plur(d.file, '1 mp3', 'mp3') + ', esplorato ' + esc(d.indicizzato) + (on ? '' : ', non collegato') + '</span></span></li>';
        }
        h += '</ul>';
      } else {
        h += '<p class="tenue">I dischi non sono ancora stati esplorati.</p>';
      }
      h += '<button data-azione="lavoro" data-tipo="indicizza">Cerca negli HD</button><p><small>Esplora tutti i dischi del PC (anche quelli USB) e ricorda dove sono gli mp3: la prima volta può volerci parecchio.</small></p></div>';
      h += '<div id="lavori"></div>';
      h += '<details><summary>La cartella _Tolti</summary><p>I brani che escono dalle playlist non vengono cancellati: finiscono nella cartella _Tolti della chiavetta. Quando sei sicuro, puoi svuotarla.</p>' +
        '<button class="pericolo" data-azione="svuota">Svuota _Tolti</button></details>';
      vista.innerHTML = h;
      disegnaLavori();
    });
  }

  function disegnaLavori() {
    var box = document.getElementById('lavori');
    if (!box || !stato) { return; }
    var h = '';
    var at = stato.attivita;
    if (at && at.fase) {
      h += '<div class="riquadro"><b>Il sito: ' + esc(at.fase) + '</b>' + barra(at.fatti, at.totale) + '</div>';
    }
    var lav = stato.lavori || [];
    var storia = '';
    for (var i = 0; i < lav.length; i++) {
      var l = lav[i];
      var attivo = l.stato === 'in_coda' || l.stato === 'inviato' || l.stato === 'in_corso';
      if (attivo) {
        h += '<div class="riquadro"><b>' + esc(NOMI_LAVORI[l.tipo] || l.tipo) + '</b> <small>' + esc(NOMI_STATI[l.stato]) + '</small>' +
          (l.avanz && l.avanz.fase ? '<p>' + esc(l.avanz.fase) + (l.avanz.totale ? ': ' + l.avanz.fatti + ' di ' + l.avanz.totale : '') + '</p>' : '') +
          barra(l.avanz ? l.avanz.fatti : 0, l.avanz ? l.avanz.totale : 0) +
          (l.avanz && l.avanz.corrente ? '<p><small>' + esc(l.avanz.corrente) + '</small></p>' : '') +
          '<button class="piccolo pericolo" data-azione="ferma" data-id="' + esc(l.id) + '">Ferma</button></div>';
      } else {
        var cls = l.stato === 'fatto' ? 'ok' : (l.stato === 'errore' ? 'err' : 'att');
        storia += '<li class="voce"><span class="testo"><b>' + esc(NOMI_LAVORI[l.tipo] || l.tipo) + '</b><span>' + esc(l.messaggio || '') +
          '</span><small>' + esc(l.finito || l.creato) + (l.errori ? ', ' + l.errori + ' errori' : '') + '</small></span><span class="chip ' + cls + '">' + esc(NOMI_STATI[l.stato] || l.stato) + '</span></li>';
      }
    }
    if (storia) { h += '<h2>Ultimi lavori</h2><div class="riquadro"><ul class="elenco">' + storia + '</ul></div>'; }
    box.innerHTML = h;
  }

  function barra(fatti, totale) {
    if (!totale) { return '<div class="progresso indeterminato"><div></div></div>'; }
    var p = Math.min(100, Math.round(100 * fatti / totale));
    return '<div class="progresso"><div style="width:' + p + '%"></div></div>';
  }

  azioni.lavoro = function (el) {
    api('POST', '/api/lavori', { tipo: el.getAttribute('data-tipo') }, function (err) {
      if (err) { avviso(err, true); return; }
      avviso(stato && stato.agente && stato.agente.online ? 'Fatto: il PC comincia subito.' : 'In coda: partirà quando il PC si collega.');
      aggiornaStato();
    });
  };

  azioni.ferma = function (el) {
    api('POST', '/api/lavori/' + el.getAttribute('data-id') + '/annulla', {}, function (err) {
      if (err) { avviso(err, true); return; }
      avviso('Chiesto di fermarsi: il PC finisce il file in corso.');
      aggiornaStato();
    });
  };

  azioni.svuota = function () {
    if (!window.confirm('Cancellare davvero tutti i file nella cartella _Tolti della chiavetta? Non si possono recuperare.')) { return; }
    api('POST', '/api/lavori', { tipo: 'svuota' }, function (err) {
      if (err) { avviso(err, true); return; }
      avviso('In coda.');
      aggiornaStato();
    });
  };

  // --- Importazione --------------------------------------------------------------------------------------------

  var gruppiImport = null;

  function vistaImporta() {
    caricando();
    api('GET', '/api/importa', null, function (err, r) {
      if (err) { errore(err); return; }
      gruppiImport = r.gruppi || [];
      var h = '<p><a href="#/chiavetta">Torna alla chiavetta</a></p><h1>Brani nuovi sulla chiavetta</h1>';
      if (!gruppiImport.length) {
        vista.innerHTML = h + '<p class="vuoto">Tutti i brani della chiavetta sono già nelle playlist.</p>';
        return;
      }
      h += '<p class="tenue">Ogni cartella della chiavetta diventa una playlist. Puoi cambiare il nome, aggiungerla a una playlist che c\'è già o lasciarla fuori.</p>';
      for (var i = 0; i < gruppiImport.length; i++) {
        var g = gruppiImport[i];
        var opz = '<option value="">una playlist nuova</option>';
        for (var k = 0; k < r.playlist.length; k++) {
          opz += '<option value="' + esc(r.playlist[k].id) + '"' + (r.playlist[k].id === g.playlist ? ' selected' : '') + '>' + esc(r.playlist[k].nome) + '</option>';
        }
        h += '<div class="riquadro"><label class="voce"><input type="checkbox" id="gi-' + i + '" checked><span class="testo"><b>' +
          esc(g.chiave ? 'Cartella «' + g.chiave + '»' : 'Cartella principale') + '</b><span>' + plur(g.brani.length, '1 brano', 'brani') + '</span></span></label>' +
          '<label class="campo"><span>Mettili in</span><select id="gp-' + i + '">' + opz + '</select></label>' +
          '<label class="campo"><span>Nome della playlist nuova</span><input type="text" id="gn-' + i + '" value="' + esc(g.nome) + '"></label>' +
          '<details><summary>Guarda i brani</summary><ul class="elenco">';
        for (var j = 0; j < g.brani.length; j++) {
          var b = g.brani[j];
          h += '<li class="voce">' + cop(b.copertina) + '<span class="testo"><b>' + esc(b.titolo) + '</b><span>' + esc(b.artista) + (b.anno ? ' · ' + b.anno : '') +
            '</span></span>' + (b.rovinato ? '<span class="chip err">Rovinato</span>' : '') + '</li>';
        }
        h += '</ul></details></div>';
      }
      h += '<button class="primario grande" data-azione="importa">Importa</button>';
      vista.innerHTML = h;
    });
  }

  azioni.importa = function (el) {
    var scelte = [];
    for (var i = 0; i < gruppiImport.length; i++) {
      scelte.push({
        chiave: gruppiImport[i].chiave,
        includi: document.getElementById('gi-' + i).checked,
        playlist: document.getElementById('gp-' + i).value,
        nome: document.getElementById('gn-' + i).value
      });
    }
    el.disabled = true;
    api('POST', '/api/importa', { gruppi: scelte }, function (err, r) {
      el.disabled = false;
      if (err) { avviso(err, true); return; }
      avviso('Importati ' + r.brani + ' brani' + (r.playlist ? ' in ' + plur(r.playlist, 'una playlist nuova', 'playlist nuove') : '') + '.');
      aggiornaStato();
      location.hash = '#/';
    });
  };

  // --- Piano di copia ------------------------------------------------------------------------------------------

  var pianoCorrente = null;

  function vistaCopia() {
    caricando();
    api('GET', '/api/piano', null, function (err, r) {
      if (err) { errore(err); return; }
      pianoCorrente = r.piano;
      var p = r.piano;
      var h = '<p><a href="#/chiavetta">Torna alla chiavetta</a></p><h1>Copia sulla chiavetta</h1>';
      if (r.copia_in_corso) {
        h += '<div class="nota info">C\'è già una copia in corso: guardala nella pagina <a href="#/chiavetta">Chiavetta</a>.</div>';
      }
      var ops = p.ops || {};
      var c = p.conteggi || {};
      var voci = '';
      if (ops.copia) {
        voci += '<li>Copio ' + plur(ops.copia, 'un brano', 'brani') + ' (circa ' + peso(p.byte) + ')' + (c.disco ? ', di cui ' + c.disco + ' dai dischi' : '') + '</li>';
      }
      if (ops.riscrivi || ops.rinomina) {
        voci += '<li>Sistemo nome, tag e copertina di ' + plur((ops.riscrivi || 0) + (ops.rinomina || 0), 'un brano', 'brani') + '</li>';
      }
      if (p.tolti.length) {
        voci += '<li>Sposto in _Tolti ' + plur(p.tolti.length, 'un file che non è', 'file che non sono') + ' in nessuna playlist</li>';
      }
      if (ops.m3u) {
        voci += '<li>Scrivo ' + plur(ops.m3u, 'una playlist .m3u', 'playlist .m3u') + '</li>';
      }
      if (c.ok) {
        voci += '<li>' + plur(c.ok, 'Un brano è già a posto', 'brani sono già a posto') + '</li>';
      }
      h += '<div class="riquadro"><h2>' + (ops.copia || ops.riscrivi || ops.rinomina || ops.m3u || p.tolti.length ? 'Cosa farò' : 'Niente da fare') +
        '</h2><ul>' + (voci || '<li>Le playlist sono vuote.</li>') + '</ul>' +
        (p.etichetta ? '<p><small>Chiavetta «' + esc(p.etichetta) + '»' + (p.liberi ? ', liberi ' + peso(p.liberi) : '') + '.</small></p>' : '') + '</div>';
      for (var i = 0; i < p.bloccanti.length; i++) { h += '<div class="nota err">' + esc(p.bloccanti[i]) + '</div>'; }
      for (var j = 0; j < p.avvisi.length; j++) { h += '<div class="nota att">' + esc(p.avvisi[j]) + '</div>'; }
      if (!r.pc_collegato) {
        h += '<div class="nota info">Il PC della chiavetta adesso non è collegato: se confermi, la copia partirà appena il programma sul PC si ricollega con la chiavetta attaccata.</div>';
      } else if (!r.chiavetta_collegata && p.volume) {
        h += '<div class="nota info">La chiavetta non è attaccata al PC: la copia partirà quando la attacchi.</div>';
      }
      for (var k = 0; k < r.playlist.length; k++) {
        var pl = r.playlist[k];
        if (!pl.righe || !pl.righe.length) { continue; }
        h += '<details><summary><b>' + esc(pl.nome) + '</b> <small>' + plur(pl.righe.length, '1 brano', 'brani') + '</small></summary><ul class="elenco">';
        for (var m = 0; m < pl.righe.length; m++) {
          var x = pl.righe[m];
          h += '<li class="voce cliccabile" data-azione="apri-brano" data-id="' + esc(x.b) + '">' + cop(x.copertina) + '<span class="testo"><b>' + esc(x.titolo) + '</b><span>' + esc(x.artista) +
            (x.anno ? ' · ' + x.anno : '') + '</span></span>' + chip(x.st, x.disco) + '</li>';
        }
        h += '</ul></details>';
      }
      if (p.tolti.length) {
        h += '<details><summary>File che vanno in _Tolti (' + p.tolti.length + ')</summary><ul>';
        for (var t = 0; t < p.tolti.length; t++) { h += '<li><small>' + esc(p.tolti[t]) + '</small></li>'; }
        h += '</ul></details>';
      }
      var nOps = 0;
      for (var o in ops) { if (ops.hasOwnProperty(o)) { nOps += ops[o]; } }
      h += '<label class="voce"><input type="checkbox" id="backup" checked><span class="testo">Prima di riscrivere un brano ne salvo una copia sul PC (consigliato)</span></label>';
      h += '<button class="primario grande" data-azione="conferma"' + (p.bloccanti.length || !nOps || r.copia_in_corso ? ' disabled' : '') + '>' +
        (nOps ? 'OK, copia sulla chiavetta' : 'La chiavetta è già a posto') + '</button>';
      vista.innerHTML = h;
    });
  }

  azioni.conferma = function (el) {
    el.disabled = true;
    api('POST', '/api/piano/' + pianoCorrente.id + '/conferma', { backup: document.getElementById('backup').checked }, function (err) {
      if (err) {
        el.disabled = false;
        avviso(err, true);
        if (err.indexOf('cambiato') >= 0) { vistaCopia(); }
        return;
      }
      avviso('Copia in coda: segui l\'avanzamento qui.');
      location.hash = '#/chiavetta';
    });
  };

  // --- PC --------------------------------------------------------------------------------------------------------

  function vistaPC() {
    caricando();
    api('GET', '/api/agenti', null, function (err, r) {
      if (err) { errore(err); return; }
      var h = '<h1>PC collegati</h1>';
      if (!r.agenti.length) {
        h += '<p class="tenue">Nessun PC è ancora collegato al sito.</p>';
      }
      for (var i = 0; i < r.agenti.length; i++) {
        var a = r.agenti[i];
        h += '<div class="riquadro"><b><span class="punto' + (a.online ? ' acceso' : '') + '"></span>' + esc(a.nome || 'PC') + '</b>' +
          '<p class="tenue">' + (a.online ? 'Collegato adesso' : 'Visto ' + esc(a.visto)) + (a.versione ? ', programma ' + esc(a.versione) : '') + '</p>';
        if (a.unita && a.unita.length) {
          h += '<ul class="elenco">';
          for (var k = 0; k < a.unita.length; k++) {
            var u = a.unita[k];
            h += '<li class="voce"><span class="testo"><b>' + esc(u.lettera) + ' ' + esc(u.etichetta || '') + '</b><small>' + (u.rimovibile ? 'chiavetta' : 'disco') +
              (u.liberi ? ', liberi ' + peso(u.liberi) : '') + '</small></span></li>';
          }
          h += '</ul>';
        }
        h += '<button class="piccolo pericolo" data-azione="scollega" data-id="' + esc(a.id) + '" data-nome="' + esc(a.nome) + '">Scollega</button></div>';
      }
      h += '<div class="riquadro"><h2>Collega un PC</h2>';
      if (r.programma) {
        h += '<p>1. Prepara il link e mandalo a chi usa il PC della chiavetta: lo apre da quel PC, scarica il programma e fa doppio clic: si collega da solo.</p>' +
          '<button class="primario" data-azione="biglietto">Prepara il link per il PC</button><div id="biglietto"></div>' +
          '<p><small>Windows potrebbe dire «Windows ha protetto il PC»: si clicca «Ulteriori informazioni» e poi «Esegui comunque».</small></p>';
      }
      h += '<p>' + (r.programma ? '2. Oppure, se' : 'Se') + ' sul PC la finestra del programma mostra un codice, scrivilo qui:</p>' +
        '<input type="text" id="codice" class="codice" inputmode="numeric" maxlength="7" placeholder="000 000">' +
        '<button data-azione="abbina">Collega</button>';
      if (r.programma) { h += '<p><small><a href="/api/programma">Scarica il programma</a> (senza collegamento automatico).</small></p>'; }
      h += '</div>';
      vista.innerHTML = h;
    });
  }

  azioni.biglietto = function () {
    api('POST', '/api/agenti/biglietto', {}, function (err, r) {
      if (err) { avviso(err, true); return; }
      document.getElementById('biglietto').innerHTML = '<span class="link-copia" id="link-pc">' + esc(r.url) + '</span>' +
        '<button class="piccolo" data-azione="copia-link">Copia il link</button><p><small>Vale fino al ' + esc(r.scade) + ' e funziona una volta sola.</small></p>';
    });
  };

  azioni['copia-link'] = function () {
    var testo = document.getElementById('link-pc').textContent;
    var area = document.createElement('textarea');
    area.value = testo;
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    avviso(ok ? 'Link copiato.' : 'Tieni premuto sul link per copiarlo.', !ok);
  };

  azioni.abbina = function () {
    var c = document.getElementById('codice').value;
    api('POST', '/api/agenti/abbina', { codice: c }, function (err, r) {
      if (err) { avviso(err, true); return; }
      avviso('Collegato: ' + (r.nome || 'PC'));
      aggiornaStato();
      setTimeout(vistaPC, 1500);
    });
  };

  azioni.scollega = function (el) {
    if (!window.confirm('Scollegare «' + el.getAttribute('data-nome') + '»? Per ricollegarlo servirà un link o un codice nuovo.')) { return; }
    api('DELETE', '/api/agenti/' + el.getAttribute('data-id'), null, function (err) {
      if (err) { avviso(err, true); return; }
      aggiornaStato();
      vistaPC();
    });
  };

  // --- Partenza ----------------------------------------------------------------------------------------------------

  aggiornaStato(vai);
})();
