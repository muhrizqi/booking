import { db } from './db.js';
import { addDays, diffDays, HttpError } from './util.js';

// Cara harga ditentukan untuk SETIAP MALAM menginap (tanggal check-in sampai sehari sebelum check-out):
//   1. Jika malam itu masuk dalam aturan harga khusus, pakai harga aturan itu.
//      Jika beberapa aturan tumpang tindih, yang rentang tanggalnya paling sempit menang
//      (misalnya "Malam Tahun Baru" mengalahkan "Libur Natal dan Tahun Baru"); bila sama sempit, yang dibuat terakhir.
//   2. Jika bukan, dan harinya termasuk hari akhir pekan, pakai harga akhir pekan (bila diisi).
//   3. Jika bukan, pakai harga hari biasa.

export const BASE_LABEL = 'Hari biasa';
export const WEEKEND_LABEL = 'Akhir pekan';

export function parseWeekendDays(value) {
  const set = new Set();
  for (const x of String(value ?? '').split(/[\s,;]+/)) {
    const n = Number(x);
    if (x !== '' && Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
  }
  return set;
}

export const dayOfWeek = (date) => new Date(date + 'T00:00:00Z').getUTCDay();

/** Aturan yang menyentuh malam-malam dari `from` sampai sebelum `to`. */
export function loadRules(unitId, from, to) {
  return db
    .prepare('SELECT * FROM rate_rules WHERE unit_id = ? AND start_date < ? AND end_date >= ? ORDER BY id')
    .all(unitId, to, from);
}

export function priceForNight(unit, date, rules, weekend) {
  let best = null;
  for (const r of rules) {
    if (r.start_date > date || r.end_date < date) continue;
    if (!best) { best = r; continue; }
    const spanR = diffDays(r.start_date, r.end_date);
    const spanB = diffDays(best.start_date, best.end_date);
    if (spanR < spanB || (spanR === spanB && r.id > best.id)) best = r;
  }
  if (best) return { price: best.price, label: best.name, rule: best };
  if (weekend.has(dayOfWeek(date)) && unit.weekend_price > 0) return { price: unit.weekend_price, label: WEEKEND_LABEL };
  return { price: unit.price, label: BASE_LABEL };
}

/** Harga tiap malam dari `from` sampai sebelum `to`. */
export function nightlyPrices(unit, from, to, s, rules = loadRules(unit.id, from, to)) {
  const weekend = parseWeekendDays(s.weekend_days);
  const out = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push({ date: d, ...priceForNight(unit, d, rules, weekend) });
  return out;
}

/** Hitungan lengkap untuk satu masa menginap. */
export function quote(unit, from, to, guests, s) {
  const nights = diffDays(from, to);
  const per = nightlyPrices(unit, from, to, s);
  const base = per.reduce((sum, n) => sum + n.price, 0);
  const extraGuests = Math.max(0, guests - unit.base_capacity);
  const extra = extraGuests * unit.extra_fee * nights;
  const total = base + extra;
  const dp = Math.min(total, Math.ceil((total * Number(s.dp_percent || 0)) / 100 / 1000) * 1000);
  let minNights = 1;
  const lines = [];
  for (const n of per) {
    if (n.rule && n.rule.min_nights > minNights) minNights = n.rule.min_nights;
    const prev = lines.find((l) => l.label === n.label && l.price === n.price);
    if (prev) prev.nights++;
    else lines.push({ label: n.label, price: n.price, nights: 1 });
  }
  return { nights, base, extra, extraGuests, total, dp, minNights, lines };
}

export function assertMinNights(q) {
  if (q.nights < q.minNights)
    throw new HttpError(400, `Untuk tanggal ini, minimal menginap ${q.minNights} malam. Pilih check-out yang lebih lama.`);
}

/** Peta tanggal ke harga per malam, untuk label di kalender. */
export function priceMap(unit, from, to, s) {
  const out = {};
  for (const n of nightlyPrices(unit, from, to, s)) out[n.date] = n.price;
  return out;
}
