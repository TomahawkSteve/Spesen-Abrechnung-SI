// Belegerkennung direkt auf dem Gerät (Tesseract.js) – kostenlos, ohne Server.
// Die Erkennungsdateien (~5 MB) werden beim ersten Mal geladen und danach zwischengespeichert.

const base = new URL('vendor/tesseract/', location.href).href;
let workerPromise = null;
let progressCb = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { default: Tesseract } = await import('./vendor/tesseract/tesseract.esm.min.js');
      return Tesseract.createWorker('deu', 1, {
        workerPath: base + 'worker.min.js',
        corePath: base,
        langPath: base + 'lang',
        logger: (m) => progressCb?.(m),
      });
    })();
    workerPromise.catch(() => (workerPromise = null));
  }
  return workerPromise;
}

/** Liest den Text eines Belegfotos. onProgress bekommt Werte von 0 bis 1. */
export async function readReceipt(blob, onProgress) {
  progressCb = (m) => {
    if (m.status === 'recognizing text') onProgress?.(0.3 + 0.7 * m.progress);
    else if (typeof m.progress === 'number') onProgress?.(0.3 * m.progress);
  };
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(await prepare(blob));
    return parseReceipt(data.text || '');
  } finally {
    progressCb = null;
  }
}

/** Graustufen + mehr Kontrast hilft bei blassen Kassenzetteln. */
async function prepare(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d');
    ctx.filter = 'grayscale(1) contrast(1.4)';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  } catch {
    return blob;
  }
}

/* ---------- Text auswerten ---------- */

const AMOUNT_RE = /(\d{1,3}(?:[.\s]\d{3})*|\d+)\s?[,.]\s?(\d{2})(?!\d)/g;
const toCents = (int, dec) => Number(int.replace(/[.\s]/g, '')) * 100 + Number(dec);

function amountsIn(line) {
  const out = [];
  for (const m of line.matchAll(AMOUNT_RE)) {
    const c = toCents(m[1], m[2]);
    if (c > 0 && c < 1000000) out.push(c);
  }
  return out;
}

// Zahlungszeilen enthalten bei Karte meist den Betrag inkl. Trinkgeld.
const PAY_RE = /karten?zahlung|kartenumsatz|\bec[\s-]?(karte|mobile|cash)?\b|girocard|visa|master\s?card|maestro|amex|apple\s?pay|google\s?pay|zahlung|bezahlt|zu zahlen/i;
const TOTAL_RE = /gesamt|summe|\btotal\b|endbetrag|betrag|\bbar\b|brutto/i;
const SKIP_RE = /netto|mwst|ust|steuer|trinkgeld|rückgeld|rueckgeld|gegeben|zwischensumme|rabatt|pfand/i;

export function findAmount(lines) {
  const cands = [];
  lines.forEach((line, i) => {
    if (SKIP_RE.test(line)) return;
    const score = PAY_RE.test(line) ? 3 : TOTAL_RE.test(line) ? 2 : 0;
    if (!score) return;
    let nums = amountsIn(line);
    if (!nums.length && lines[i + 1] && !SKIP_RE.test(lines[i + 1])) nums = amountsIn(lines[i + 1]);
    nums.forEach((c) => cands.push({ c, score }));
  });
  if (cands.length) {
    const best = Math.max(...cands.map((x) => x.score));
    return Math.max(...cands.filter((x) => x.score === best).map((x) => x.c));
  }
  // Notlösung: größter Betrag mit Euro-Zeichen oder "EUR"
  const euro = lines.filter((l) => /€|eur/i.test(l) && !SKIP_RE.test(l)).flatMap(amountsIn);
  return euro.length ? Math.max(...euro) : null;
}

export function findDate(text) {
  const now = new Date();
  const minYear = now.getFullYear() - 2;
  const re = /(\d{1,2})\s?[.\/-]\s?(\d{1,2})\s?[.\/-]\s?(\d{4}|\d{2})(?!\d)/g;
  for (const m of text.matchAll(re)) {
    const d = Number(m[1]), mo = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    if (d < 1 || d > 31 || mo < 1 || mo > 12 || y < minYear) continue;
    const dt = new Date(y, mo - 1, d);
    if (dt.getMonth() !== mo - 1 || dt - now > 86400000) continue;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

const NOT_NAME_RE = /rechnung|beleg|quittung|kopie|kassenbon|bon\b|datum|tisch|steuer|\bust\b|\btel\b|telefon|www|http|@|str\.|straße|strasse|filiale|willkommen|herzlich/i;

export function findMerchant(lines) {
  for (const raw of lines.slice(0, 8)) {
    const line = raw.replace(/[^\p{L}\d&'´`\-\s.]/gu, ' ').replace(/\s+/g, ' ').trim();
    const letters = (line.match(/\p{L}/gu) || []).length;
    if (letters < 3 || letters < line.length * 0.6 || NOT_NAME_RE.test(line)) continue;
    // "GMBH", "Restaurant" usw. entfernen, damit nur der Name bleibt
    const name = line.replace(/\b(gmbh|ug|kg|ohg|e\.?\s?k\.?|restaurant|ristorante|gaststätte)\b/gi, '').replace(/\s+/g, ' ').trim();
    const pick = name.length >= 3 ? name : line;
    return pick.length > 40 ? pick.slice(0, 40).trim() : pick;
  }
  return null;
}

const KFZ_RE = /tankstelle|\baral\b|\bshell\b|\besso\b|\bjet\b|totalenergies|\bagip\b|\beni\b|\bavia\b|\bhem\b|\bstar\b|raiffeisen.*tank|kwh|ladevorgang|ladestrom|ladesäule|ionity|enbw|ewe go|charging|diesel|super\s?(e5|e10|plus)?|benzin|\be10\b|\be5\b|kraftstoff|zapfsäule|säule\s?\d/i;
const BEW_RE = /restaurant|ristorante|gaststätte|gasthaus|gasthof|bistro|café|cafe|pizzeria|trattoria|osteria|bewirtung|speisen|getränke|tisch\s?#?\d|bedienung|trinkgeld|\bkellner|imbiss|grill|brasserie|steakhouse|sushi|burger|kantine/i;

export function guessCategory(text) {
  if (KFZ_RE.test(text)) {
    const fuel = /kwh|lade|ionity|enbw|charging/i.test(text) ? 'Strom' : /diesel/i.test(text) ? 'Diesel' : /super|benzin|e10|e5/i.test(text) ? 'Benzin' : null;
    return { cat: 'kfz', fuel };
  }
  if (BEW_RE.test(text)) return { cat: 'bewirtung' };
  return { cat: 'sonstiges' };
}

export function parseReceipt(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return {
    text,
    date: findDate(text),
    amount: findAmount(lines),
    title: findMerchant(lines),
    ...(guessCategory(text) || {}),
  };
}
