import { PDFDocument, StandardFonts, rgb } from './vendor/pdf-lib.esm.min.js';

const APP_VERSION = '1.1.0';

/* ---------- Konstanten ---------- */

const CATS = [
  { id: 'kfz', label: 'Kraftfahrzeugkosten', short: 'Tanken / Laden', pos: 'I', color: '#0a84ff' },
  { id: 'praesente', label: 'Präsente', short: 'Präsente', pos: 'II', color: '#bf5af2' },
  { id: 'sonstiges', label: 'Sonstiges', short: 'Sonstiges', pos: 'II', color: '#ff9f0a' },
  { id: 'bewirtung', label: 'Bewirtung', short: 'Bewirtung', pos: 'II', color: '#30d158' },
];
const CAT = Object.fromEntries(CATS.map((c) => [c.id, c]));

const DEFAULT_SETTINGS = {
  name: '',
  bank: '',
  iban: '',
  recipients: 'celik@schroederimmobilien.de, buchhaltung@schroederimmobilien.de',
  company: 'Schröder Immobilien',
  ocr: true,
};

/* ---------- Hilfsfunktionen ---------- */

const $ = (sel, el = document) => el.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const fmtMoney = (cents) => eur.format((cents || 0) / 100);
const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
const fmtDateShort = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.` : '');
const monthName = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
};
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const shiftMonth = (key, delta) => {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
};
const todayIso = () => {
  const d = new Date();
  return `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;
};

/** "12,50" / "12.50" / "1.234,56" → Cent */
function parseMoney(str) {
  let s = String(str || '').replace(/[€\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
const moneyInput = (cents) => (cents / 100).toFixed(2).replace('.', ',');
const fmtIban = (iban) => String(iban || '').replace(/\s+/g, '').toUpperCase().replace(/(.{4})/g, '$1 ').trim();

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

/* ---------- Speicher (IndexedDB, nur auf diesem Gerät) ---------- */

const dbp = new Promise((resolve, reject) => {
  const r = indexedDB.open('spesen-si', 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore('entries', { keyPath: 'id' });
    db.createObjectStore('files', { keyPath: 'id' });
    db.createObjectStore('kv');
  };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

function tx(stores, mode, fn) {
  return dbp.then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        const req = fn(t);
        t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Speichern abgebrochen'));
      }),
  );
}
const db = {
  allEntries: () => tx('entries', 'readonly', (t) => t.objectStore('entries').getAll()),
  allFiles: () => tx('files', 'readonly', (t) => t.objectStore('files').getAll()),
  getFile: (id) => tx('files', 'readonly', (t) => t.objectStore('files').get(id)),
  get: (key) => tx('kv', 'readonly', (t) => t.objectStore('kv').get(key)),
  set: (key, val) => tx('kv', 'readwrite', (t) => t.objectStore('kv').put(val, key)),
  del: (key) => tx('kv', 'readwrite', (t) => t.objectStore('kv').delete(key)),
  saveEntry: (entry, newFiles = [], removedIds = []) =>
    tx(['entries', 'files'], 'readwrite', (t) => {
      const fs = t.objectStore('files');
      newFiles.forEach((f) => fs.put(f));
      removedIds.forEach((id) => fs.delete(id));
      return t.objectStore('entries').put(entry);
    }),
  deleteEntry: (entry) =>
    tx(['entries', 'files'], 'readwrite', (t) => {
      (entry.receipts || []).forEach((r) => t.objectStore('files').delete(r.id));
      return t.objectStore('entries').delete(entry.id);
    }),
};

/* ---------- Zustand ---------- */

const state = {
  month: monthKey(new Date()),
  entries: [],
  settings: { ...DEFAULT_SETTINGS },
  logo: null, // Blob (PNG)
};

const entriesOfMonth = (key) =>
  state.entries
    .filter((e) => e.date.startsWith(key))
    .sort((a, b) => a.date.localeCompare(b.date) || a.created - b.created);

function totals(list) {
  const byCat = Object.fromEntries(CATS.map((c) => [c.id, 0]));
  list.forEach((e) => (byCat[e.cat] += e.amount));
  const I = byCat.kfz;
  const II = byCat.praesente + byCat.sonstiges + byCat.bewirtung;
  return { byCat, I, II, total: I + II };
}

/* ---------- Hauptansicht ---------- */

function render() {
  $('#monthLabel').textContent = monthName(state.month);
  const list = entriesOfMonth(state.month);
  const t = totals(list);
  $('#sumI').textContent = fmtMoney(t.I);
  $('#sumII').textContent = fmtMoney(t.II);
  $('#sumTotal').textContent = fmtMoney(t.total);

  const html = CATS.map((c) => {
    const items = list.filter((e) => e.cat === c.id);
    if (!items.length) return '';
    return `
      <div class="cat-head"><span class="dot" style="background:${c.color}"></span>${esc(c.label)}<span class="cat-sum">${fmtMoney(t.byCat[c.id])}</span></div>
      <div class="card entries">
        ${items
          .map((e) => {
            const sub = e.cat === 'kfz' ? e.fuel : [e.detail, e.occasion].filter(Boolean).join(' · ');
            const n = (e.receipts || []).length;
            const badge = n
              ? `<span class="badge ok">📎 ${n} Beleg${n > 1 ? 'e' : ''}</span>`
              : '<span class="badge warn">Kein Beleg</span>';
            return `<button class="entry" data-id="${e.id}">
              <span class="date">${fmtDateShort(e.date)}</span>
              <span class="main"><div class="t">${esc(e.title)}</div><div class="s">${esc(sub || '')}</div>${badge}</span>
              <span class="amt">${fmtMoney(e.amount)}</span>
            </button>`;
          })
          .join('')}
      </div>`;
  }).join('');
  $('#list').innerHTML = html;
  $('#emptyHint').hidden = list.length > 0;
}

function renderBrand() {
  const img = $('#brandLogo');
  if (state.logo) {
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    img.dataset.url = URL.createObjectURL(state.logo);
    img.src = img.dataset.url;
    img.hidden = false;
    $('#brandText').hidden = true;
  } else {
    img.hidden = true;
    $('#brandText').hidden = false;
  }
}

/* ---------- Bilder verkleinern ---------- */

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'));
    img.src = url;
  });
}

async function convertImage(file, { max = 2000, type = 'image/jpeg', quality = 0.82 } = {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext('2d');
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, type, quality));
    if (!blob) throw new Error('Bild konnte nicht umgewandelt werden');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------- Ausgabe erfassen ---------- */

const form = {
  entry: null, // aktueller Eintrag (Kopie)
  newFiles: [], // {id, type, name, blob}
  removed: [], // ids
  urls: [],
  isNew: false,
  touched: new Set(), // vom Nutzer geänderte Felder – werden nie automatisch überschrieben
  ocrToken: 0,
};

function buildCatSeg() {
  $('#catSeg').innerHTML = CATS.map(
    (c) => `<label><input type="radio" name="cat" value="${c.id}"><span>${esc(c.short)}</span></label>`,
  ).join('');
}

function applyCatVisibility() {
  const f = $('#entryForm');
  const cat = f.cat.value;
  document.querySelectorAll('#entryForm .only-kfz').forEach((el) => (el.hidden = cat !== 'kfz'));
  document.querySelectorAll('#entryForm .not-kfz').forEach((el) => (el.hidden = cat === 'kfz'));
  document.querySelectorAll('#entryForm .only-bew').forEach((el) => (el.hidden = cat !== 'bewirtung'));
  $('#lblTitle').textContent = cat === 'kfz' ? 'Tankstelle' : cat === 'bewirtung' ? 'Restaurant' : 'Bezeichnung';
  f.title.placeholder = cat === 'kfz' ? 'z. B. Diverse, Aral' : cat === 'bewirtung' ? 'z. B. Balkan' : 'z. B. Carwash';
}

function openEntry(entry) {
  const isNew = !entry;
  form.entry = entry
    ? structuredClone(entry)
    : { id: uid(), created: Date.now(), cat: 'bewirtung', date: defaultDate(), amount: 0, title: '', fuel: 'Strom', detail: '', occasion: '', persons: '', place: '', note: '', receipts: [] };
  form.newFiles = [];
  form.removed = [];
  form.isNew = isNew;
  form.touched = new Set();
  form.ocrToken++;
  setOcrStatus(null);
  const f = $('#entryForm');
  f.reset();
  f.cat.value = form.entry.cat;
  f.date.value = form.entry.date;
  f.amount.value = form.entry.amount ? moneyInput(form.entry.amount) : '';
  f.title.value = form.entry.title || '';
  f.fuel.value = form.entry.fuel || 'Strom';
  f.detail.value = form.entry.detail || '';
  f.occasion.value = form.entry.occasion || '';
  f.persons.value = form.entry.persons || '';
  f.place.value = form.entry.place || '';
  f.note.value = form.entry.note || '';
  f.querySelectorAll('.invalid, .auto').forEach((el) => el.classList.remove('invalid', 'auto'));
  $('#entryTitle').textContent = isNew ? 'Neue Ausgabe' : 'Ausgabe bearbeiten';
  $('#btnDelete').hidden = isNew;
  applyCatVisibility();
  renderReceipts();
  $('#entryDlg').showModal();
  $('#entryDlg .sheet-body').scrollTop = 0;
}

/** Neue Einträge landen im angezeigten Monat (heute, falls es der aktuelle ist). */
function defaultDate() {
  const today = todayIso();
  if (today.startsWith(state.month)) return today;
  const [y, m] = state.month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${state.month}-${String(last).padStart(2, '0')}`;
}

function revokeFormUrls() {
  form.urls.forEach((u) => URL.revokeObjectURL(u));
  form.urls = [];
}

async function renderReceipts() {
  revokeFormUrls();
  const box = $('#receipts');
  const items = [
    ...form.entry.receipts.filter((r) => !form.removed.includes(r.id)).map((r) => ({ ...r, stored: true })),
    ...form.newFiles,
  ];
  const tiles = await Promise.all(
    items.map(async (r) => {
      let inner = '<span class="pdf">PDF</span>';
      if (r.type.startsWith('image/')) {
        const blob = r.blob || (await db.getFile(r.id))?.blob;
        if (blob) {
          const u = URL.createObjectURL(blob);
          form.urls.push(u);
          inner = `<img src="${u}" alt="">`;
        }
      }
      return `<div class="receipt">${inner}<button type="button" data-remove="${r.id}" aria-label="Beleg entfernen">✕</button></div>`;
    }),
  );
  box.innerHTML = tiles.join('');
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const before = form.newFiles.length;
  for (const file of files) {
    try {
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        form.newFiles.push({ id: uid(), type: 'application/pdf', name: file.name, blob: file });
      } else {
        const blob = await convertImage(file);
        form.newFiles.push({ id: uid(), type: 'image/jpeg', name: file.name.replace(/\.\w+$/, '') + '.jpg', blob });
      }
    } catch (err) {
      console.error(err);
      toast(`„${file.name}“ konnte nicht gelesen werden.`);
    }
  }
  renderReceipts();
  const firstImage = form.newFiles.slice(before).find((f) => f.type.startsWith('image/'));
  const amountEmpty = !$('#entryForm').amount.value.trim();
  if (firstImage && state.settings.ocr !== false && (form.isNew || amountEmpty)) autoFill(firstImage.blob);
}

/* ---------- Belegerkennung ---------- */

let ocrModule;
function setOcrStatus(html, cls = '') {
  const el = $('#ocrStatus');
  el.hidden = !html;
  el.className = 'ocr-status ' + cls;
  if (html) el.innerHTML = html;
}

async function autoFill(blob) {
  const token = ++form.ocrToken;
  const progress = (p) => {
    if (token !== form.ocrToken) return;
    const pct = Math.round(p * 100);
    setOcrStatus(`🔍 Beleg wird gelesen … ${pct} %<div class="bar"><i style="width:${pct}%"></i></div>`);
  };
  progress(0);
  let r;
  try {
    ocrModule ||= await import('./ocr.js');
    r = await ocrModule.readReceipt(blob, progress);
  } catch (err) {
    console.error(err);
    if (token === form.ocrToken) setOcrStatus('Automatisches Auslesen hat nicht geklappt – bitte von Hand ausfüllen.');
    return;
  }
  if (token !== form.ocrToken || !$('#entryDlg').open) return;
  console.debug('OCR', r);

  const f = $('#entryForm');
  const found = [];
  const mark = (input) => input.closest('.field')?.classList.add('auto');
  if (r.cat && form.isNew && !form.touched.has('cat')) {
    f.cat.value = r.cat;
    applyCatVisibility();
    if (r.cat !== 'sonstiges') found.push(CAT[r.cat].label);
  }
  if (r.fuel && f.cat.value === 'kfz' && !form.touched.has('fuel')) {
    f.fuel.value = r.fuel;
    mark(f.fuel);
  }
  if (r.date && !form.touched.has('date')) {
    f.date.value = r.date;
    mark(f.date);
    found.push('Datum');
  }
  if (r.amount && !f.amount.value.trim()) {
    f.amount.value = moneyInput(r.amount);
    mark(f.amount);
    found.push('Betrag');
  }
  if (r.title && !f.title.value.trim()) {
    f.title.value = r.title;
    mark(f.title);
    found.push('Name');
  }
  if (found.length) setOcrStatus(`✓ Erkannt: ${found.join(', ')} – bitte kurz prüfen.`, 'ok');
  else setOcrStatus('Auf dem Foto wurde nichts Eindeutiges erkannt – bitte von Hand ausfüllen.');
}

async function saveEntry(ev) {
  ev.preventDefault();
  const f = $('#entryForm');
  const e = form.entry;
  e.cat = f.cat.value;
  e.date = f.date.value;
  e.amount = parseMoney(f.amount.value);
  e.title = f.title.value.trim();
  e.fuel = e.cat === 'kfz' ? f.fuel.value : '';
  e.detail = e.cat === 'kfz' ? '' : f.detail.value.trim();
  e.occasion = e.cat === 'bewirtung' ? f.occasion.value.trim() : '';
  e.persons = e.cat === 'bewirtung' ? f.persons.value.trim() : '';
  e.place = e.cat === 'bewirtung' ? f.place.value.trim() : '';
  e.note = f.note.value.trim();

  const bad = [];
  if (!e.date) bad.push(f.date);
  if (!(e.amount > 0)) bad.push(f.amount);
  if (!e.title) bad.push(f.title);
  f.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
  if (bad.length) {
    bad.forEach((el) => el.closest('.field').classList.add('invalid'));
    toast('Bitte Datum, Betrag und Bezeichnung ausfüllen.');
    bad[0].focus();
    return;
  }

  e.receipts = [
    ...e.receipts.filter((r) => !form.removed.includes(r.id)),
    ...form.newFiles.map(({ id, type, name }) => ({ id, type, name })),
  ];
  e.updated = Date.now();
  try {
    await db.saveEntry(e, form.newFiles, form.removed);
  } catch (err) {
    console.error(err);
    alert('Speichern fehlgeschlagen. Ist der Speicher voll?\n\n' + err.message);
    return;
  }
  const i = state.entries.findIndex((x) => x.id === e.id);
  if (i >= 0) state.entries[i] = e;
  else state.entries.push(e);
  state.month = e.date.slice(0, 7);
  closeEntry();
  render();
  toast('Gesichert');
}

function closeEntry() {
  form.ocrToken++;
  revokeFormUrls();
  $('#entryDlg').close();
}

async function deleteCurrent() {
  if (!confirm('Diese Ausgabe inkl. Belegen löschen?')) return;
  const stored = state.entries.find((x) => x.id === form.entry.id);
  if (stored) await db.deleteEntry(stored);
  state.entries = state.entries.filter((x) => x.id !== form.entry.id);
  closeEntry();
  render();
  toast('Gelöscht');
}

/* ---------- Einstellungen ---------- */

let pendingLogo; // undefined = unverändert, null = entfernen, Blob = neu
function openSettings(firstRun = false) {
  const f = $('#settingsForm');
  for (const k of ['name', 'bank', 'iban', 'recipients']) f[k].value = state.settings[k] || '';
  f.ocr.checked = state.settings.ocr !== false;
  pendingLogo = undefined;
  renderLogoPreview(state.logo);
  $('#firstRunNote').hidden = !firstRun;
  $('#versionInfo').textContent = `Spesen SI · Version ${APP_VERSION}`;
  $('#settingsDlg').showModal();
}

function renderLogoPreview(blob) {
  const img = $('#logoPreview');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  if (blob) {
    img.dataset.url = URL.createObjectURL(blob);
    img.src = img.dataset.url;
  }
  img.hidden = !blob;
  $('#logoNone').hidden = !!blob;
}

async function saveSettings(ev) {
  ev.preventDefault();
  const f = $('#settingsForm');
  state.settings = {
    ...state.settings,
    name: f.name.value.trim(),
    bank: f.bank.value.trim(),
    iban: fmtIban(f.iban.value),
    recipients: f.recipients.value.trim(),
    ocr: f.ocr.checked,
  };
  await db.set('settings', state.settings);
  if (pendingLogo !== undefined) {
    state.logo = pendingLogo;
    if (pendingLogo) await db.set('logo', pendingLogo);
    else await db.del('logo');
    renderBrand();
  }
  $('#settingsDlg').close();
  toast('Einstellungen gesichert');
}

/* ---------- Datensicherung ---------- */

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

async function exportBackup() {
  const files = await db.allFiles();
  const data = {
    app: 'spesen-si',
    version: 1,
    exported: new Date().toISOString(),
    settings: state.settings,
    logo: state.logo ? await blobToDataUrl(state.logo) : null,
    entries: state.entries,
    files: await Promise.all(files.map(async (f) => ({ id: f.id, type: f.type, name: f.name, data: await blobToDataUrl(f.blob) }))),
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  await deliverFile(blob, `Spesen-SI-Sicherung_${todayIso()}.json`, 'Spesen SI – Datensicherung');
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'spesen-si') throw new Error('Das ist keine Spesen-SI-Sicherung.');
    if (!confirm(`Sicherung vom ${fmtDate(data.exported.slice(0, 10))} laden?\n${data.entries.length} Ausgaben werden ergänzt bzw. überschrieben.`)) return;
    const files = await Promise.all(
      data.files.map(async (f) => ({ id: f.id, type: f.type, name: f.name, blob: await (await fetch(f.data)).blob() })),
    );
    await tx(['entries', 'files'], 'readwrite', (t) => {
      files.forEach((f) => t.objectStore('files').put(f));
      data.entries.forEach((e) => t.objectStore('entries').put(e));
    });
    state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    await db.set('settings', state.settings);
    if (data.logo) {
      state.logo = await (await fetch(data.logo)).blob();
      await db.set('logo', state.logo);
    }
    state.entries = await db.allEntries();
    $('#settingsDlg').close();
    renderBrand();
    render();
    toast('Sicherung geladen');
  } catch (err) {
    console.error(err);
    alert('Sicherung konnte nicht geladen werden.\n\n' + err.message);
  }
}

/* ---------- PDF-Bericht ---------- */

// Die Standardschrift im PDF kennt nur westeuropäische Zeichen (inkl. ä ö ü ß €).
const WIN_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);
const clean = (s) =>
  Array.from(String(s ?? '').replace(/[\r\n\t]+/g, ' '))
    .map((ch) => {
      const c = ch.codePointAt(0);
      return (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WIN_EXTRA.has(ch) ? ch : '?';
    })
    .join('');

function fit(text, font, size, maxW) {
  if (font.widthOfTextAtSize(text, size) <= maxW) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > maxW) t = t.slice(0, -1);
  return t + '…';
}

async function buildReport(month) {
  const s = state.settings;
  const list = entriesOfMonth(month);
  const t = totals(list);
  const ordered = CATS.flatMap((c) => list.filter((e) => e.cat === c.id));

  // Belegnummern vergeben (B1, B2, …) – nur für Ausgaben mit Beleg
  const nr = new Map();
  let n = 0;
  ordered.forEach((e) => e.receipts?.length && nr.set(e.id, `B${++n}`));

  const pdf = await PDFDocument.create();
  pdf.setTitle(`Spesenabrechnung ${monthName(month)} – ${s.name}`);
  pdf.setAuthor(s.name || '');
  pdf.setCreator('Spesen SI');
  pdf.setProducer('Spesen SI');
  const F = await pdf.embedFont(StandardFonts.Helvetica);
  const B = await pdf.embedFont(StandardFonts.HelveticaBold);

  const W = 595.28, H = 841.89, M = 42;
  const INK = rgb(0.11, 0.11, 0.13);
  const MUTED = rgb(0.42, 0.42, 0.46);
  const LINE = rgb(0.8, 0.8, 0.83);
  const BAND = rgb(0.93, 0.93, 0.95);
  const DARK = rgb(0.17, 0.17, 0.19);
  const ACC = rgb(0.04, 0.4, 0.8);
  const WHITE = rgb(1, 1, 1);

  const ownPages = [];
  let page, y;
  const newPage = () => {
    page = pdf.addPage([W, H]);
    ownPages.push(page);
    y = H - M;
  };
  const T = (str, x, yy, { size = 9, font = F, color = INK, align = 'left', max } = {}) => {
    let txt = clean(str);
    if (max) txt = fit(txt, font, size, max);
    const w = font.widthOfTextAtSize(txt, size);
    const xx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    page.drawText(txt, { x: xx, y: yy, size, font, color });
  };
  const hline = (yy, color = LINE, th = 0.6) => page.drawLine({ start: { x: M, y: yy }, end: { x: W - M, y: yy }, thickness: th, color });

  // Spalten
  const C = { nr: M + 4, date: M + 34, c2: M + 98, c3: M + 268, amt: W - M - 4 };
  const W2 = C.c3 - C.c2 - 8, W3 = C.amt - 70 - C.c3;
  let currentHead = null; // für Seitenumbruch

  const colHead = (h2, h3) => {
    currentHead = [h2, h3];
    y -= 14;
    T('Beleg', C.nr, y, { size: 7.5, font: B, color: MUTED });
    T('Datum', C.date, y, { size: 7.5, font: B, color: MUTED });
    T(h2, C.c2, y, { size: 7.5, font: B, color: MUTED });
    T(h3, C.c3, y, { size: 7.5, font: B, color: MUTED });
    T('Betrag', C.amt, y, { size: 7.5, font: B, color: MUTED, align: 'right' });
    y -= 5;
    hline(y);
  };
  const need = (h) => {
    if (y - h < M + 40) {
      newPage();
      if (currentHead) colHead(...currentHead);
    }
  };
  const band = (label, value, { fill = DARK, color = WHITE, size = 10.5, h = 20 } = {}) => {
    need(h + 8);
    y -= h + 6;
    page.drawRectangle({ x: M, y, width: W - 2 * M, height: h, color: fill });
    T(label, M + 8, y + (h - size) / 2 + 2, { size, font: B, color });
    if (value != null) T(value, W - M - 8, y + (h - size) / 2 + 2, { size, font: B, color, align: 'right' });
  };
  const row = (e) => {
    const extra = e.cat === 'bewirtung' && (e.occasion || e.persons || e.place);
    const h = extra ? 27 : 15;
    need(h + 2);
    y -= 12;
    T(nr.get(e.id) || '–', C.nr, y, { color: nr.has(e.id) ? ACC : MUTED, font: nr.has(e.id) ? B : F });
    T(fmtDate(e.date), C.date, y);
    T(e.title, C.c2, y, { max: W2 });
    T(e.cat === 'kfz' ? e.fuel : e.detail, C.c3, y, { max: W3 });
    T(fmtMoney(e.amount), C.amt, y, { align: 'right' });
    if (extra) {
      y -= 11;
      const info = [e.occasion && `Anlass: ${e.occasion}`, e.persons && `Personen: ${e.persons}`, e.place && `Ort: ${e.place}`].filter(Boolean).join('  ·  ');
      T(info, C.c2, y, { size: 7.5, color: MUTED, max: C.amt - C.c2 });
    }
    y -= 3;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.3, color: LINE });
  };
  const sumLine = (label, cents) => {
    need(20);
    y -= 14;
    T(label, C.c3, y, { font: B, size: 9 });
    T(fmtMoney(cents), C.amt, y, { font: B, size: 9, align: 'right' });
    y -= 4;
  };

  /* --- Seite 1: Kopf --- */
  newPage();
  const topY = H - M;
  if (state.logo) {
    try {
      const logo = await pdf.embedPng(await state.logo.arrayBuffer());
      const sc = Math.min(190 / logo.width, 46 / logo.height);
      page.drawImage(logo, { x: M, y: topY - logo.height * sc, width: logo.width * sc, height: logo.height * sc });
    } catch (err) {
      console.warn('Logo', err);
      T(s.company.toUpperCase(), M, topY - 16, { size: 14, font: B });
    }
  } else {
    T(s.company.toUpperCase(), M, topY - 16, { size: 14, font: B });
  }
  // Kasten rechts: Name / Bank / IBAN
  const bw = 210, bh = 56, bx = W - M - bw, by = topY - bh;
  page.drawRectangle({ x: bx, y: by, width: bw, height: bh, borderColor: INK, borderWidth: 0.8 });
  T(`Name: ${s.name || '—'}`, bx + 8, by + bh - 16, { size: 10.5, font: B, max: bw - 16 });
  T(`Bank: ${s.bank || '—'}`, bx + 8, by + bh - 31, { size: 8.5, max: bw - 16 });
  T(`IBAN: ${s.iban || '—'}`, bx + 8, by + bh - 44, { size: 8.5, max: bw - 16 });

  y = by - 34;
  T('Spesenabrechnung', M, y, { size: 22, font: B });
  y -= 18;
  T(`Monat: ${monthName(month)}`, M, y, { size: 11, color: MUTED });
  T(`Erstellt am ${fmtDate(todayIso())}`, W - M, y, { size: 9, color: MUTED, align: 'right' });
  y -= 6;

  /* --- Position I --- */
  band('Position I · Kraftfahrzeugkosten');
  colHead('Tankstelle', 'Kraftstoff');
  const kfz = list.filter((e) => e.cat === 'kfz');
  if (!kfz.length) {
    y -= 13;
    T('Keine Einträge', C.c2, y, { color: MUTED, size: 8.5 });
    y -= 3;
  }
  kfz.forEach(row);
  currentHead = null;
  band('Summe Position I', fmtMoney(t.I), { fill: BAND, color: INK, size: 10 });

  /* --- Position II --- */
  y -= 10;
  band('Position II · Sonstige Kosten');
  ['praesente', 'sonstiges', 'bewirtung'].forEach((id, i) => {
    need(50);
    y -= 18;
    T(`${i + 1}. ${CAT[id].label}`, M + 4, y, { size: 10, font: B });
    colHead('Bezeichnung', 'Geschäft o. ä.');
    const items = list.filter((e) => e.cat === id);
    if (!items.length) {
      y -= 13;
      T('Keine Einträge', C.c2, y, { color: MUTED, size: 8.5 });
      y -= 3;
    }
    items.forEach(row);
    currentHead = null;
    sumLine(`Summe ${CAT[id].label}`, t.byCat[id]);
  });
  band('Summe Position II', fmtMoney(t.II), { fill: BAND, color: INK, size: 10 });

  y -= 8;
  band('Gesamt Position I + II', fmtMoney(t.total), { fill: ACC, size: 12.5, h: 26 });

  /* --- Unterschrift --- */
  need(80);
  y -= 60;
  page.drawLine({ start: { x: M, y }, end: { x: M + 200, y }, thickness: 0.6, color: INK });
  page.drawLine({ start: { x: W - M - 200, y }, end: { x: W - M, y }, thickness: 0.6, color: INK });
  T('Ort, Datum', M, y - 11, { size: 8, color: MUTED });
  T('Unterschrift', W - M - 200, y - 11, { size: 8, color: MUTED });

  /* --- Anlagen: Belege --- */
  const problems = [];
  for (const e of ordered) {
    const label = `${nr.get(e.id)} · ${fmtDate(e.date)} · ${CAT[e.cat].label} · ${e.title} · ${fmtMoney(e.amount)}`;
    const recs = e.receipts || [];
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const lab = recs.length > 1 ? `${label}  (${i + 1}/${recs.length})` : label;
      const stored = await db.getFile(r.id);
      try {
        if (!stored) throw new Error('Datei fehlt');
        const bytes = await stored.blob.arrayBuffer();
        if (r.type === 'application/pdf') {
          const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
          const pages = await pdf.copyPages(src, src.getPageIndices());
          pages.forEach((p) => {
            pdf.addPage(p);
            const { width, height } = p.getSize();
            const txt = fit(clean(`Beleg ${lab}`), B, 8, width - 40);
            const tw = B.widthOfTextAtSize(txt, 8);
            p.drawRectangle({ x: width - tw - 22, y: height - 22, width: tw + 12, height: 15, color: WHITE, borderColor: ACC, borderWidth: 0.8, opacity: 0.92 });
            p.drawText(txt, { x: width - tw - 16, y: height - 17.5, size: 8, font: B, color: ACC });
          });
        } else {
          const img = r.type === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
          newPage();
          T(`Beleg ${lab}`, M, H - M - 10, { size: 10.5, font: B, max: W - 2 * M });
          let top = H - M - 22;
          if (e.cat === 'bewirtung' && (e.occasion || e.persons)) {
            T([e.occasion && `Anlass: ${e.occasion}`, e.persons && `Personen: ${e.persons}`, e.place && `Ort: ${e.place}`].filter(Boolean).join('  ·  '), M, top - 2, { size: 8, color: MUTED, max: W - 2 * M });
            top -= 14;
          }
          const boxW = W - 2 * M, boxH = top - 8 - (M + 24);
          const sc = Math.min(boxW / img.width, boxH / img.height);
          const iw = img.width * sc, ih = img.height * sc;
          page.drawImage(img, { x: M + (boxW - iw) / 2, y: top - 8 - ih, width: iw, height: ih });
        }
      } catch (err) {
        console.error(err);
        problems.push(`${nr.get(e.id)} (${r.name || 'Datei'})`);
        newPage();
        T(`Beleg ${lab}`, M, H - M - 10, { size: 10.5, font: B, max: W - 2 * M });
        T('Dieser Beleg konnte nicht eingebettet werden.', M, H - M - 40, { size: 10, color: rgb(0.8, 0.2, 0.2) });
      }
    }
  }

  /* --- Fußzeile auf eigenen Seiten --- */
  const all = pdf.getPages();
  ownPages.forEach((p) => {
    const idx = all.indexOf(p) + 1;
    const txt = clean(`Spesenabrechnung ${monthName(month)} · ${s.name || ''} · Seite ${idx} von ${all.length}`);
    const tw = F.widthOfTextAtSize(txt, 7.5);
    p.drawText(txt, { x: (W - tw) / 2, y: 22, size: 7.5, font: F, color: MUTED });
  });

  const bytes = await pdf.save();
  return { bytes, count: list.length, receipts: n, total: t.total, problems };
}

/* ---------- Teilen / Herunterladen ---------- */

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

async function deliverFile(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  download(blob, filename);
}

const recipientList = () =>
  state.settings.recipients
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function mailTexts(month, total) {
  const name = state.settings.name || '';
  const subject = `Spesenabrechnung ${monthName(month)} – ${name}`.trim();
  const body = `Hallo zusammen,\n\nanbei meine Spesenabrechnung für ${monthName(month)} über ${fmtMoney(total)} inklusive aller Belege.\n\nViele Grüße\n${name}`;
  return { subject, body };
}

async function openReport() {
  const month = state.month;
  const list = entriesOfMonth(month);
  const body = $('#reportBody');
  if (!list.length) {
    toast(`Keine Ausgaben im ${monthName(month)}.`);
    return;
  }
  if (!state.settings.name) {
    toast('Bitte zuerst deinen Namen eintragen.');
    openSettings(true);
    return;
  }
  body.innerHTML = `<div class="spinner"></div><p class="center muted">PDF wird erstellt …</p>`;
  $('#reportDlg').showModal();

  let result;
  try {
    result = await buildReport(month);
  } catch (err) {
    console.error(err);
    body.innerHTML = `<div class="warnbox">Die PDF konnte nicht erstellt werden.<br><small>${esc(err.message)}</small></div>`;
    return;
  }
  const blob = new Blob([result.bytes], { type: 'application/pdf' });
  const safeName = (state.settings.name || 'Mitarbeiter').replace(/[^\wäöüÄÖÜß-]+/g, '_');
  const filename = `Spesenabrechnung_${monthName(month).replace(' ', '_')}_${safeName}.pdf`;
  const missing = list.filter((e) => !(e.receipts || []).length);
  const sizeMb = (blob.size / 1024 / 1024).toFixed(1);
  const { subject, body: mailBody } = mailTexts(month, result.total);
  const to = recipientList();

  body.innerHTML = `
    <div class="stat"><span class="muted">Monat</span><b>${esc(monthName(month))}</b></div>
    <div class="stat"><span class="muted">Ausgaben</span><b>${result.count}</b></div>
    <div class="stat"><span class="muted">Belege angehängt</span><b>${result.receipts}</b></div>
    <div class="stat"><span class="muted">Gesamtbetrag</span><b>${fmtMoney(result.total)}</b></div>
    <div class="stat"><span class="muted">Dateigröße</span><b>${sizeMb} MB</b></div>
    ${missing.length ? `<div class="warnbox"><b>${missing.length} Ausgabe(n) ohne Beleg:</b><br>${missing.map((e) => `${fmtDate(e.date)} · ${esc(e.title)} · ${fmtMoney(e.amount)}`).join('<br>')}</div>` : ''}
    ${result.problems.length ? `<div class="warnbox">Nicht eingebettet: ${esc(result.problems.join(', '))}</div>` : ''}
    ${blob.size > 20 * 1024 * 1024 ? '<div class="warnbox">Die Datei ist größer als 20 MB und könnte für E-Mail zu groß sein.</div>' : ''}

    <div class="stack">
      <button class="btn primary wide" id="rShare">PDF teilen / per Mail senden</button>
      <button class="btn wide" id="rOpen">PDF ansehen</button>
      <button class="btn wide" id="rDownload">PDF speichern</button>
      <button class="btn wide" id="rMail">E-Mail an Buchhaltung vorbereiten</button>
      <button class="btn wide" id="rCopy">Empfänger-Adressen kopieren</button>
    </div>

    <h3 class="sub">So geht's am iPhone</h3>
    <ol class="steps">
      <li>Tippe <b>„Empfänger-Adressen kopieren“</b>.</li>
      <li>Tippe <b>„PDF teilen“</b> und wähle <b>Mail</b>.</li>
      <li>Im Feld <b>An</b> lange tippen und <b>Einsetzen</b>.</li>
      <li>Senden.</li>
    </ol>
    <p class="muted small">Empfänger: ${esc(to.join(', ') || '— (in den Einstellungen eintragen)')}</p>`;

  $('#rShare').onclick = async () => {
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: subject, text: mailBody });
      } catch (err) {
        if (err.name !== 'AbortError') toast('Teilen nicht möglich – PDF wird gespeichert.'), download(blob, filename);
      }
    } else {
      download(blob, filename);
      toast('Teilen wird hier nicht unterstützt – PDF wurde gespeichert.');
    }
  };
  $('#rOpen').onclick = () => {
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank') || (location.href = url);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  };
  $('#rDownload').onclick = () => download(blob, filename);
  $('#rMail').onclick = () => {
    const href = `mailto:${to.join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(mailBody + '\n\n(PDF bitte anhängen)')}`;
    location.href = href;
  };
  $('#rCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(to.join(', '));
      toast('Adressen kopiert');
    } catch {
      prompt('Adressen kopieren:', to.join(', '));
    }
  };
}

/* ---------- Start ---------- */

async function init() {
  buildCatSeg();

  $('#prevMonth').onclick = () => ((state.month = shiftMonth(state.month, -1)), render());
  $('#nextMonth').onclick = () => ((state.month = shiftMonth(state.month, 1)), render());
  $('#btnAdd').onclick = () => openEntry(null);
  $('#btnSettings').onclick = () => openSettings(false);
  $('#btnReport').onclick = openReport;
  $('#list').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.entry');
    if (btn) openEntry(state.entries.find((e) => e.id === btn.dataset.id));
  });

  // Erfassen-Dialog
  $('#entryForm').addEventListener('submit', saveEntry);
  $('#entryForm').addEventListener('change', (ev) => {
    if (ev.target.name) form.touched.add(ev.target.name);
    if (ev.target.name === 'cat') applyCatVisibility();
  });
  $('#entryForm').addEventListener('input', (ev) => {
    if (!ev.target.name) return;
    form.touched.add(ev.target.name);
    ev.target.closest('.field')?.classList.remove('auto');
  });
  $('#entryForm').amount.addEventListener('blur', (ev) => {
    const c = parseMoney(ev.target.value);
    if (c > 0) ev.target.value = moneyInput(c);
  });
  $('#btnDelete').onclick = deleteCurrent;
  $('#fileCam').onchange = (ev) => (addFiles(ev.target.files), (ev.target.value = ''));
  $('#fileAny').onchange = (ev) => (addFiles(ev.target.files), (ev.target.value = ''));
  $('#receipts').addEventListener('click', (ev) => {
    const id = ev.target.dataset?.remove;
    if (!id) return;
    if (form.newFiles.some((f) => f.id === id)) form.newFiles = form.newFiles.filter((f) => f.id !== id);
    else form.removed.push(id);
    renderReceipts();
  });
  $('#entryDlg').addEventListener('cancel', revokeFormUrls);

  // Einstellungen
  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#logoFile').onchange = async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      pendingLogo = await convertImage(file, { max: 900, type: 'image/png' });
      renderLogoPreview(pendingLogo);
    } catch {
      toast('Logo konnte nicht gelesen werden.');
    }
  };
  $('#logoRemove').onclick = () => ((pendingLogo = null), renderLogoPreview(null));
  $('#btnBackup').onclick = exportBackup;
  $('#restoreFile').onchange = (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (f) importBackup(f);
  };

  // Schließen-Knöpfe
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => {
      const dlg = b.closest('dialog');
      if (dlg.id === 'entryDlg') (form.ocrToken++, revokeFormUrls());
      dlg.close();
    }),
  );

  // Daten laden
  const [entries, settings, logo] = await Promise.all([db.allEntries(), db.get('settings'), db.get('logo')]);
  state.entries = entries || [];
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  state.logo = logo || null;
  renderBrand();
  render();

  // Browser bitten, die Daten dauerhaft zu behalten
  navigator.storage?.persist?.().catch(() => {});

  if (!settings) openSettings(true);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW', err));
  }
}

init().catch((err) => {
  console.error(err);
  alert('Die App konnte nicht starten.\n\n' + err.message);
});
