'use strict';
const $ = id => document.getElementById(id);
const enc = encodeURIComponent;
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const LS = {
  get: (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v))
};
const setStatus = s => { $('status').textContent = s || ''; };

/* ================= IndexedDB =================
   Die grossen Listen liegen NICHT im RAM oder localStorage, sondern hier.
   items: ein Eintrag pro Sender/Film, Indizes: ck (Kategorie), pt (Playlist+Typ), pl (Playlist) */
const DB = (() => {
  let db;
  const open = () => db ? Promise.resolve(db) : new Promise((res, rej) => {
    const r = indexedDB.open('iptv', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      const it = d.createObjectStore('items', { keyPath: 'k' });
      it.createIndex('ck', 'ck'); it.createIndex('pt', 'pt'); it.createIndex('pl', 'pl');
      const c = d.createObjectStore('cats', { keyPath: 'k' });
      c.createIndex('pt', 'pt'); c.createIndex('pl', 'pl');
      d.createObjectStore('meta');
    };
    r.onsuccess = () => { db = r.result; res(db); };
    r.onerror = () => rej(r.error);
  });
  const wrap = rq => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  const tx = async (s, m) => (await open()).transaction(s, m || 'readonly');
  return {
    async put(store, rows) {
      const t = await tx(store, 'readwrite'), s = t.objectStore(store);
      rows.forEach(r => s.put(r));
      return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    },
    async all(store, index, key) { return wrap((await tx(store)).objectStore(store).index(index).getAll(key)); },
    async getMeta(k) { return wrap((await tx('meta')).objectStore('meta').get(k)); },
    async setMeta(k, v) { (await tx('meta', 'readwrite')).objectStore('meta').put(v, k); },
    // Substring-Suche per Cursor ueber einen Typ (live/vod) einer Playlist, bricht bei cancel() ab
    async scan(pt, q, limit, cancel) {
      const t = await tx('items');
      const out = [];
      return new Promise((res, rej) => {
        const rq = t.objectStore('items').index('pt').openCursor(IDBKeyRange.only(pt));
        rq.onsuccess = () => {
          const c = rq.result;
          if (!c || cancel() || out.length >= limit) return res(out);
          if (c.value.n.toLowerCase().indexOf(q) > -1) out.push(c.value);
          c.continue();
        };
        rq.onerror = () => rej(rq.error);
      });
    },
    async removePlaylist(pl) {
      const t = await tx(['items', 'cats', 'meta'], 'readwrite');
      const del = rq => { rq.onsuccess = () => { const c = rq.result; if (c) { c.delete(); c.continue(); } }; };
      del(t.objectStore('items').index('pl').openCursor(IDBKeyRange.only(pl)));
      del(t.objectStore('cats').index('pl').openCursor(IDBKeyRange.only(pl)));
      del(t.objectStore('meta').openCursor(IDBKeyRange.bound(pl + '|', pl + '|\uffff')));
      return new Promise(r => { t.oncomplete = r; });
    }
  };
})();

/* ================= Quellen: Xtream + M3U ================= */
const apiUrl = (p, act, extra) =>
  `${p.server}/player_api.php?username=${enc(p.user)}&password=${enc(p.pass)}&action=${act}${extra || ''}`;
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const isVod = u => /\/movie\/|\.(mp4|mkv|avi)(\?|$)/i.test(u);
const jobs = {};

// M3U wird als Stream gelesen und in Bloecken in die DB geschrieben (nie die ganze Datei als Objekt im RAM)
async function loadM3U(p) {
  let buf = '', cur = null, n = 0, rows = [];
  const cats = new Map();
  const flush = async () => { if (rows.length) { const r = rows; rows = []; await DB.put('items', r); } };
  const add = async (h, u) => {
    if (/\/series\//i.test(u)) return;
    const t = isVod(u) ? 'vod' : 'live';
    const g = (/group-title="([^"]*)"/.exec(h) || [])[1] || 'Ohne Gruppe';
    const ico = (/tvg-logo="([^"]*)"/.exec(h) || [])[1] || '';
    const ck = `${p.id}|${t}|${g}`;
    if (!cats.has(ck)) cats.set(ck, { k: ck, pl: p.id, pt: `${p.id}|${t}`, id: g, n: g, o: cats.size });
    rows.push({ k: `${p.id}|${t}|${n}`, pl: p.id, pt: `${p.id}|${t}`, ck, id: n, n: h.slice(h.lastIndexOf(',') + 1).trim(), i: ico, e: u });
    n++;
    if (rows.length >= 3000) await flush();
  };
  const feed = async (s, end) => {
    buf += s;
    const ls = buf.split('\n');
    buf = end ? '' : ls.pop();
    for (const raw of ls) {
      const l = raw.trim();
      if (!l) continue;
      if (l.charCodeAt(0) === 35) { if (l.indexOf('#EXTINF') === 0) cur = l; }
      else if (cur) { const h = cur; cur = null; await add(h, l); }
    }
  };
  setStatus('Lade M3U …');
  const r = await fetch(p.url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (r.body && r.body.getReader) {
    const rd = r.body.getReader(), dec = new TextDecoder();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      await feed(dec.decode(value, { stream: true }));
      setStatus(`M3U: ${n} Einträge gelesen …`);
    }
    await feed(dec.decode(), true);
  } else {
    await feed(await r.text(), true);
  }
  await flush();
  await DB.put('cats', [...cats.values()]);
  await DB.setMeta(`${p.id}|live|cats`, 1);
  await DB.setMeta(`${p.id}|vod|cats`, 1);
}

const Src = {
  async cats(p, t) {
    const key = `${p.id}|${t}|cats`;
    if (!await DB.getMeta(key)) {
      if (p.type === 'm3u') {
        jobs[p.id] = jobs[p.id] || loadM3U(p).finally(() => { delete jobs[p.id]; });
        await jobs[p.id];
      } else {
        const j = await getJSON(apiUrl(p, t === 'live' ? 'get_live_categories' : 'get_vod_categories'));
        await DB.put('cats', (Array.isArray(j) ? j : []).map((c, o) => ({
          k: `${p.id}|${t}|${c.category_id}`, pl: p.id, pt: `${p.id}|${t}`, id: String(c.category_id), n: String(c.category_name || ''), o
        })));
        await DB.setMeta(key, 1);
      }
    }
    const list = await DB.all('cats', 'pt', `${p.id}|${t}`);
    return list.sort((a, b) => a.o - b.o);
  },
  // Xtream: Streams werden pro Kategorie geholt und gecacht (nie alle 240.000 auf einmal)
  async items(p, t, catId) {
    const ck = `${p.id}|${t}|${catId}`;
    if (p.type === 'xtream' && !await DB.getMeta(ck + '|done')) {
      const j = await getJSON(apiUrl(p, t === 'live' ? 'get_live_streams' : 'get_vod_streams', `&category_id=${enc(catId)}`));
      const rows = (Array.isArray(j) ? j : []).map(s => ({
        k: `${p.id}|${t}|${s.stream_id}`, pl: p.id, pt: `${p.id}|${t}`, ck,
        id: s.stream_id, n: String(s.name || ''), i: s.stream_icon || '', e: s.container_extension || 'mp4'
      }));
      for (let i = 0; i < rows.length; i += 5000) await DB.put('items', rows.slice(i, i + 5000));
      await DB.setMeta(ck + '|done', 1);
    }
    return DB.all('items', 'ck', ck);
  }
};

async function indexAll(p) {
  if (p.type === 'm3u') { await Src.cats(p, 'live'); setStatus('M3U ist bereits vollständig geladen.'); return; }
  for (const t of ['live', 'vod']) {
    const cs = await Src.cats(p, t);
    for (let i = 0; i < cs.length; i++) {
      setStatus(`Index ${t === 'live' ? 'Live' : 'Filme'}: Kategorie ${i + 1}/${cs.length} …`);
      try { await Src.items(p, t, cs[i].id); } catch (e) { /* einzelne Kategorie ueberspringen */ }
    }
  }
  await DB.setMeta(p.id + '|indexed', 1);
  setStatus('Index fertig – Suche findet jetzt alles.');
}

/* ================= Virtuelle Liste =================
   Nur sichtbare Zeilen existieren als DOM-Elemente, Knoten werden recycelt. */
class VList {
  constructor(el, o) {
    this.el = el; this.o = o; this.items = []; this.idx = 0; this.top = 0; this.sel = -1;
    this.pool = []; this.size = 0; this.cols = 1;
    this.inner = document.createElement('div'); this.inner.className = 'vi';
    el.appendChild(this.inner);
  }
  layout() {
    const W = this.el.clientWidth, H = this.el.clientHeight, o = this.o, g = o.gap || 0;
    if (!W) return;
    this.cols = o.cols || Math.max(1, Math.floor((W + g) / (o.w + g)));
    this.cw = (W + g) / this.cols - g; this.rh = o.h + g; this.H = H;
    this.size = (Math.ceil(H / this.rh) + 2) * this.cols;
    while (this.pool.length < this.size) {
      const n = o.make(); n.className += ' cell'; this.inner.appendChild(n); this.pool.push(n);
    }
    this.pool.forEach(n => { n.style.width = this.cw + 'px'; n.style.height = o.h + 'px'; n._i = -2; });
  }
  setItems(a) { this.items = a; this.idx = 0; this.top = 0; this.layout(); this.draw(); }
  draw() {
    if (!this.size) return;
    const c = this.cols, g = this.o.gap || 0;
    const first = Math.floor(this.top / this.rh) * c, end = this.items.length;
    this.inner.style.transform = `translate3d(0,${-this.top}px,0)`;
    for (let i = first; i < first + this.size; i++) {
      const n = this.pool[i % this.size];
      if (i >= end) { if (n._i !== -1) { n.style.display = 'none'; n._i = -1; } continue; }
      if (n._i !== i) {
        n._i = i; n.style.display = '';
        n.style.transform = `translate3d(${(i % c) * (this.cw + g)}px,${Math.floor(i / c) * this.rh}px,0)`;
        this.o.fill(n, this.items[i]);
      }
      n.classList.toggle('f', i === this.idx);
      n.classList.toggle('sel', i === this.sel);
    }
    if (this.o.img) { clearTimeout(this.t); this.t = setTimeout(() => this.imgs(), 150); }
  }
  // Bilder erst laden, wenn der Cursor kurz stillsteht und der Eintrag sichtbar ist
  imgs() {
    for (const n of this.pool) {
      if (n._i < 0) continue;
      const y = Math.floor(n._i / this.cols) * this.rh;
      if (y + this.rh > this.top && y < this.top + this.H) this.o.img(n);
    }
  }
  reveal() {
    const r = Math.floor(this.idx / this.cols) * this.rh;
    if (r < this.top) this.top = r;
    else if (r + this.rh > this.top + this.H) this.top = r + this.rh - this.H;
  }
  move(dx, dy) {
    const c = this.cols, n = this.items.length; let i = this.idx;
    if (!n) return false;
    if (dx) { const j = i + dx; if (j < 0 || j >= n || Math.floor(j / c) !== Math.floor(i / c)) return false; i = j; }
    if (dy) {
      let j = i + dy * c;
      if (j < 0) return false;
      if (j >= n) { if (Math.floor(i / c) === Math.floor((n - 1) / c)) return false; j = n - 1; }
      i = j;
    }
    this.idx = i; this.reveal(); this.draw(); return true;
  }
  cur() { return this.items[this.idx]; }
}

/* ================= Zustand ================= */
let pls = LS.get('pls', []);
const oldAuth = LS.get('xtream_auth', null);       // Migration der alten Version
if (oldAuth && !pls.length) {
  pls.push({ id: 'p' + Date.now(), name: 'Xtream', type: 'xtream', server: oldAuth.server, user: oldAuth.username, pass: oldAuth.password });
  LS.set('pls', pls);
}
let favs = LS.get('favs', {});                      // key -> kompletter Eintrag
let P = null, T = 'live', GRID = null, zone = 'cats', screen = 'main', tok = 0, E = null, editing = false, delArmed = false;
const isFav = it => !!favs[it.k];

const CATS = new VList($('cats'), {
  cols: 1, h: 60, gap: 2,
  make: () => { const n = document.createElement('div'); n.className = 'cat'; return n; },
  fill: (n, it) => { n.textContent = it.n; }
});

function makeGrid(mode) {
  $('grid').innerHTML = '';
  const poster = mode === 'vod';
  GRID = new VList($('grid'), {
    w: poster ? 190 : 420, h: poster ? 330 : 84, gap: poster ? 20 : 14,
    make: () => {
      const n = document.createElement('div'); n.className = poster ? 'poster' : 'live';
      n.innerHTML = '<img alt=""><div class="t"></div><b class="star">★</b>';
      n.im = n.children[0]; n.t = n.children[1]; n.s = n.children[2];
      n.im.onerror = () => { n.im.src = BLANK; };
      return n;
    },
    fill: (n, it) => { n.t.textContent = it.n; n.im._s = it.i; n.im.src = BLANK; n.s.style.display = isFav(it) ? 'block' : 'none'; },
    img: n => { const s = n.im._s || BLANK; if (n.im.getAttribute('src') !== s) n.im.src = s; }
  });
  GRID.el.classList.toggle('on', zone === 'grid');
}

function show(id) {
  screen = id;
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  if (id === 'main') { CATS.layout(); CATS.draw(); GRID.layout(); GRID.draw(); }
  if (id !== 'main' && id !== 'player' && document.activeElement) document.activeElement.blur();
  if (id === 'player') setStatus('');
}

function setZone(z) {
  zone = z;
  if (z !== 'top' && document.activeElement && document.activeElement.blur) document.activeElement.blur();
  CATS.el.classList.toggle('on', z === 'cats');
  GRID.el.classList.toggle('on', z === 'grid');
  if (z === 'top') $('tab-' + T).focus();
}

/* ================= Hauptablauf ================= */
async function openPlaylist(p) {
  P = p; LS.set('cur', p.id);
  $('pl-name').textContent = p.name;
  show('main');
  await loadTab(T);
}

async function loadTab(t) {
  T = t; const my = ++tok;
  $('tab-live').classList.toggle('act', t === 'live');
  $('tab-vod').classList.toggle('act', t === 'vod');
  $('search').value = '';
  $('title').textContent = 'Kategorie wählen';
  makeGrid(t); GRID.layout(); GRID.draw();
  CATS.sel = -1; CATS.setItems([]);
  setStatus('Lade Kategorien …');
  try {
    const cats = await Src.cats(P, t);
    if (my !== tok) return;
    CATS.setItems([{ id: '__fav', n: '★ Favoriten' }, ...cats]);
    setStatus('OK = Abspielen · Rot/Gelb = Favorit · Suche: oben');
    setZone('cats');
  } catch (e) {
    if (my === tok) setStatus('Fehler: ' + e.message + ' (Zugangsdaten, Server oder CORS prüfen)');
  }
}

async function selectCat(i, stay) {
  const c = CATS.items[i]; if (!c) return;
  CATS.sel = i; CATS.draw();
  const my = ++tok;
  $('title').textContent = c.n;
  setStatus('Lade …');
  try {
    const items = c.id === '__fav'
      ? Object.values(favs).filter(x => x.pt === `${P.id}|${T}`)
      : await Src.items(P, T, c.id);
    if (my !== tok) return;
    GRID.setItems(items);
    setStatus(items.length + ' Einträge');
    if (!stay) setZone('grid');
  } catch (e) {
    if (my === tok) setStatus('Fehler: ' + e.message);
  }
}

let st;
$('search').addEventListener('input', () => { clearTimeout(st); st = setTimeout(runSearch, 450); });
async function runSearch() {
  const raw = $('search').value.trim(), q = raw.toLowerCase();
  if (q.length < 2) { if (CATS.sel >= 0) selectCat(CATS.sel, true); return; }
  const my = ++tok;
  $('title').textContent = 'Suche: ' + raw;
  setStatus('Suche läuft …');
  try {
    const r = await DB.scan(`${P.id}|${T}`, q, 500, () => my !== tok);
    if (my !== tok) return;
    GRID.setItems(r);
    const full = P.type === 'm3u' || await DB.getMeta(P.id + '|indexed');
    setStatus(`${r.length}${r.length >= 500 ? '+' : ''} Treffer` + (full ? '' : ' – nur bereits geladene Kategorien (Playlists → Index)'));
  } catch (e) { setStatus('Suchfehler: ' + e.message); }
}

function toggleFav() {
  const it = GRID.cur(); if (!it) return;
  if (favs[it.k]) delete favs[it.k]; else favs[it.k] = it;
  LS.set('favs', favs);
  const c = CATS.items[CATS.sel];
  if (c && c.id === '__fav') {
    GRID.items = GRID.items.filter(x => favs[x.k]);
    GRID.idx = Math.min(GRID.idx, Math.max(0, GRID.items.length - 1));
    GRID.layout();
  }
  GRID.pool.forEach(n => { n._i = -2; });
  GRID.draw();
}

/* ================= Player ================= */
const vid = $('vid');
let osdT;
function osd(txt) {
  const o = $('osd'); if (txt != null) o.textContent = txt;
  o.classList.add('show'); clearTimeout(osdT); osdT = setTimeout(() => o.classList.remove('show'), 3000);
}
function urlFor(it) {
  if (P.type === 'm3u') return it.e;
  const base = `${P.server}/${T === 'live' ? 'live' : 'movie'}/${enc(P.user)}/${enc(P.pass)}/${it.id}`;
  return T === 'live' ? base + '.m3u8' : `${base}.${it.e}`;
}
function play(i) {
  const it = GRID.items[i]; if (!it) return;
  GRID.idx = i;
  show('player'); osd(it.n);
  vid.src = urlFor(it);
  const pr = vid.play && vid.play(); if (pr && pr.catch) pr.catch(() => {});
}
function closePlayer() {
  vid.pause(); vid.removeAttribute('src'); vid.load();
  show('main'); GRID.reveal(); GRID.draw();
}
vid.addEventListener('error', () => osd('Wiedergabefehler – Format oder Server nicht erreichbar'));
function playerKey(e, k) {
  const stop = () => e.preventDefault();
  if (k === 10009 || k === 27 || k === 413) { stop(); closePlayer(); }
  else if (k === 13 || k === 415 || k === 19 || k === 10252) { stop(); vid.paused ? vid.play() : vid.pause(); osd(); }
  else if ((k === 37 || k === 39 || k === 412 || k === 417) && T === 'vod' && isFinite(vid.duration)) {
    stop(); vid.currentTime += (k === 37 || k === 412 ? -10 : 10);
    const m = Math.floor(vid.currentTime / 60), s = Math.floor(vid.currentTime % 60);
    osd(`${m}:${s < 10 ? '0' : ''}${s}`);
  } else if ((k === 38 || k === 40) && T === 'live') {      // Zappen
    stop(); const n = GRID.idx + (k === 38 ? -1 : 1);
    if (n >= 0 && n < GRID.items.length) play(n);
  }
}

/* ================= Playlist-Verwaltung ================= */
function renderPls() {
  const box = $('pl-list'); box.innerHTML = '';
  pls.forEach(p => {
    const r = document.createElement('div'); r.className = 'plrow';
    const nm = document.createElement('span'); nm.className = 'pn';
    nm.textContent = `${p.name} (${p.type === 'm3u' ? 'M3U' : 'Xtream'})`;
    r.appendChild(nm);
    [['Öffnen', () => openPlaylist(p)], ['Bearbeiten', () => editPl(p)],
     ['Neu laden', () => reloadPl(p)], ['Index', () => runIndex(p)]].forEach(([t, f]) => {
      const b = document.createElement('button'); b.textContent = t; b.setAttribute('data-nav', ''); b.onclick = f; r.appendChild(b);
    });
    box.appendChild(r);
  });
  if (!pls.length) setStatus('Noch keine Playlist – unten eine hinzufügen.');
}
function showPls() {
  renderPls(); show('pls');
  const f = document.querySelector('#pls [data-nav]'); if (f) f.focus();
}
async function reloadPl(p) {
  setStatus('Cache wird geleert …');
  await DB.removePlaylist(p.id);
  openPlaylist(p);
}
let indexing = false;
async function runIndex(p) {
  if (indexing) return; indexing = true;
  try { await indexAll(p); } catch (e) { setStatus('Index-Fehler: ' + e.message); }
  indexing = false;
}

function editPl(p, type) {
  editing = !!p; delArmed = false; $('f-del').textContent = 'Löschen';
  E = p ? Object.assign({}, p) : { id: 'p' + Date.now(), name: '', type: type, server: '', user: '', pass: '', url: '' };
  const m = E.type === 'm3u';
  $('edit-title').textContent = editing ? 'Playlist bearbeiten' : (m ? 'M3U-Playlist hinzufügen' : 'Xtream-Playlist hinzufügen');
  $('l-server').textContent = m ? 'M3U-URL' : 'Server-URL';
  document.querySelector('#edit .xt').style.display = m ? 'none' : '';
  $('f-name').value = E.name; $('f-server').value = m ? E.url : E.server;
  $('f-user').value = E.user; $('f-pass').value = E.pass;
  $('f-del').style.display = editing ? '' : 'none';
  show('edit'); $('f-name').focus();
}
$('add-x').onclick = () => editPl(null, 'xtream');
$('add-m').onclick = () => editPl(null, 'm3u');
$('pl-back').onclick = () => { if (P) { show('main'); setZone('cats'); } };
$('btn-pl').onclick = showPls;
$('f-cancel').onclick = showPls;
$('f-save').onclick = async () => {
  const m = E.type === 'm3u', old = pls.find(x => x.id === E.id);
  const v = $('f-server').value.trim();
  const n = Object.assign({}, E, { name: $('f-name').value.trim() || 'Playlist' });
  if (m) n.url = v; else { n.server = v.replace(/\/+$/, ''); n.user = $('f-user').value.trim(); n.pass = $('f-pass').value.trim(); }
  if (!(m ? n.url : n.server && n.user && n.pass)) { setStatus('Bitte alle Felder ausfüllen.'); return; }
  if (old && (old.server !== n.server || old.user !== n.user || old.url !== n.url)) await DB.removePlaylist(n.id);
  const i = pls.findIndex(x => x.id === n.id);
  if (i < 0) pls.push(n); else pls[i] = n;
  LS.set('pls', pls); if (P && P.id === n.id) P = n;
  setStatus(''); showPls();
};
$('f-del').onclick = async () => {
  if (!delArmed) { delArmed = true; $('f-del').textContent = 'Wirklich löschen?'; return; }
  await DB.removePlaylist(E.id);
  pls = pls.filter(x => x.id !== E.id); LS.set('pls', pls);
  Object.keys(favs).forEach(k => { if (favs[k].pl === E.id) delete favs[k]; }); LS.set('favs', favs);
  if (P && P.id === E.id) P = null;
  showPls();
};
document.querySelectorAll('.tab').forEach(b => { b.onclick = () => { if (P) loadTab(b.dataset.tab); }; });

/* ================= Fernbedienung ================= */
try {
  ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'MediaPlay', 'MediaPause', 'MediaPlayPause',
   'MediaStop', 'MediaRewind', 'MediaFastForward'].forEach(k => tizen.tvinputdevice.registerKey(k));
} catch (e) { /* ausserhalb von Tizen */ }

// Raeumliche Navigation fuer normale DOM-Elemente (Buttons/Inputs mit data-nav)
function navDom(dx, dy) {
  const cur = document.activeElement, root = document.querySelector('.screen.active');
  const els = [...root.querySelectorAll('[data-nav]')].filter(e => e.offsetParent);
  if (!cur || els.indexOf(cur) < 0) { if (els[0]) els[0].focus(); return true; }
  const a = cur.getBoundingClientRect(); let best = null, bs = 1e9;
  els.forEach(e => {
    if (e === cur) return;
    const b = e.getBoundingClientRect();
    const vx = b.left + b.width / 2 - (a.left + a.width / 2), vy = b.top + b.height / 2 - (a.top + a.height / 2);
    if ((dx && vx * dx <= 0) || (dy && vy * dy <= 0)) return;
    const s = (dx ? Math.abs(vx) : Math.abs(vy)) + (dx ? Math.abs(vy) : Math.abs(vx)) * 3;
    if (s < bs) { bs = s; best = e; }
  });
  if (best) { best.focus(); if (best.scrollIntoView) best.scrollIntoView({ block: 'nearest' }); return true; }
  return false;
}
function exitApp() { try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* Browser */ } }

document.addEventListener('keydown', e => {
  const k = e.keyCode;
  if (screen === 'player') return playerKey(e, k);
  const d = { 37: [-1, 0], 38: [0, -1], 39: [1, 0], 40: [0, 1] }[k];
  const ae = document.activeElement, inInput = ae && ae.tagName === 'INPUT';
  const back = k === 10009 || k === 27;

  if (screen !== 'main') {                                   // Playlists / Formular
    if (back) { e.preventDefault(); if (screen === 'edit') showPls(); else if (P) { show('main'); setZone('cats'); } else exitApp(); return; }
    if (inInput && (k === 37 || k === 39)) return;
    if (d) { e.preventDefault(); navDom(d[0], d[1]); }
    else if (k === 13 && ae && ae.tagName === 'BUTTON') { e.preventDefault(); ae.click(); }
    return;
  }

  if (back) {
    e.preventDefault();
    if (inInput) { ae.blur(); setZone('cats'); }
    else if (zone !== 'cats') setZone('cats');
    else exitApp();
    return;
  }
  if (zone === 'top') {
    if (inInput && (k === 37 || k === 39)) return;           // Cursor im Textfeld
    if (d) { e.preventDefault(); if (!navDom(d[0], d[1]) && d[1] > 0) setZone('cats'); }
    else if (k === 13) {
      e.preventDefault();
      if (inInput) { runSearch(); setZone('grid'); } else if (ae) ae.click();
    }
  } else if (zone === 'cats') {
    if (d) { e.preventDefault(); if (d[0] > 0) { if (GRID.items.length) setZone('grid'); } else if (!CATS.move(d[0], d[1]) && d[1] < 0) setZone('top'); }
    else if (k === 13) { e.preventDefault(); selectCat(CATS.idx); }
  } else if (zone === 'grid') {
    if (d) { e.preventDefault(); if (!GRID.move(d[0], d[1])) { if (d[0] < 0) setZone('cats'); else if (d[1] < 0) setZone('top'); } }
    else if (k === 13) { e.preventDefault(); play(GRID.idx); }
    else if (k === 403 || k === 405 || k === 70) { e.preventDefault(); toggleFav(); }
  }
});

/* ================= Start ================= */
makeGrid('live');
if (pls.length) {
  const last = pls.find(p => p.id === LS.get('cur', '')) || pls[0];
  openPlaylist(last);
} else {
  showPls();
}
