import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getSettings, setSetting, listUnits, getUnit, tx } from './src/db.js';
import { queueMessage, deliver, getWaProvider, sendRaw, wahaStatus } from './src/wa.js';
import {
  HttpError, allow, todayStr, isDate, addDays, diffDays, normalizePhone, makeCode,
} from './src/util.js';
import { quote, assertMinNights, priceMap, nightlyPrices, parseWeekendDays } from './src/pricing.js';
import { adminNewBookingMsg, guestToAdminMsg, guestMsg, ruleLines, mapsUrl } from './src/messages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PATH = '/' + (process.env.ADMIN_PATH || 'admin').replace(/^\/+|\/+$/g, '');
const MAX_NIGHTS = 30;
const MAX_AHEAD_DAYS = 540;

// ---------- Admin password & sesi ----------
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
  console.warn('==================================================================');
  console.warn(' ADMIN_PASSWORD belum diatur. Sementara dipakai password acak:');
  console.warn(`   ${ADMIN_PASSWORD}`);
  console.warn(' Atur ADMIN_PASSWORD di environment agar tidak berubah tiap restart.');
  console.warn('==================================================================');
}
const SECRET =
  process.env.SESSION_SECRET || crypto.createHash('sha256').update('gh-session:' + ADMIN_PASSWORD).digest('hex');
const SESSION_MS = 30 * 24 * 3600e3;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

const sign = (exp) => {
  const p = String(exp);
  return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
};
function verify(tok) {
  if (!tok) return false;
  const [p, sig] = tok.split('.');
  if (!p || !sig) return false;
  const exp = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return false;
  return Number(p) > Date.now();
}
function getCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// ---------- Helper domain ----------
const baseUrl = (req) => (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

/** Daftar nomor admin (628xx) dari pengaturan: satu nomor per baris. */
const adminPhones = (s) =>
  String(s.admin_wa || '')
    .split(/[\n,;]+/)
    .map((x) => normalizePhone(x))
    .filter(Boolean);

const pendingCutoff = (s) => new Date(Date.now() - Number(s.pending_hours || 24) * 3600e3).toISOString();

/** Rentang yang menghalangi: booking disetujui, booking menunggu yang belum kedaluwarsa, dan blokir admin. */
function conflicts(unitId, from, to, s, { pending = true, excludeId = null } = {}) {
  const bookings = db
    .prepare(
      `SELECT id, check_in, check_out, status FROM bookings
       WHERE unit_id = ? AND check_in < ? AND check_out > ? AND id != ?
         AND (status = 'approved' OR (? = 1 AND status = 'pending' AND created_at > ?))`
    )
    .all(unitId, to, from, excludeId ?? -1, pending ? 1 : 0, pendingCutoff(s));
  const blocks = db
    .prepare('SELECT id, start_date, end_date FROM blocks WHERE unit_id = ? AND start_date < ? AND end_date > ?')
    .all(unitId, to, from);
  return { bookings, blocks, any: bookings.length + blocks.length > 0 };
}

function validateStay(b, unit, s) {
  const today = todayStr();
  if (!isDate(b.check_in) || !isDate(b.check_out)) throw new HttpError(400, 'Tanggal tidak valid.');
  if (b.check_in < today) throw new HttpError(400, 'Tanggal check-in sudah lewat.');
  if (b.check_out <= b.check_in) throw new HttpError(400, 'Check-out harus setelah check-in.');
  const nights = diffDays(b.check_in, b.check_out);
  if (nights > MAX_NIGHTS) throw new HttpError(400, `Maksimal menginap ${MAX_NIGHTS} malam per booking.`);
  if (diffDays(today, b.check_in) > MAX_AHEAD_DAYS) throw new HttpError(400, 'Tanggal terlalu jauh ke depan.');
  const guests = Number(b.guests);
  if (!Number.isInteger(guests) || guests < 1) throw new HttpError(400, 'Jumlah tamu tidak valid.');
  if (guests > unit.max_capacity) throw new HttpError(400, `Maksimal ${unit.max_capacity} orang.`);
  return { nights, guests };
}

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function insertBooking({ unit, name, phone, check_in, check_out, nights, guests, note, total, dp, status, source }) {
  for (let i = 0; i < 5; i++) {
    const code = makeCode();
    if (db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code)) continue;
    const r = db
      .prepare(
        `INSERT INTO bookings(code, unit_id, name, phone, check_in, check_out, nights, guests, note,
                              total, dp_amount, status, source, created_at, decided_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        code, unit.id, name, phone, check_in, check_out, nights, guests, note, total, dp, status, source,
        new Date().toISOString(), status === 'approved' ? new Date().toISOString() : null
      );
    return db.prepare('SELECT * FROM bookings WHERE id = ?').get(r.lastInsertRowid);
  }
  throw new HttpError(500, 'Gagal membuat kode booking, coba lagi.');
}

const getBooking = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);

function publicBooking(b, s, { withPayment = false } = {}) {
  return {
    code: b.code,
    status: b.status,
    name: b.name.split(' ')[0],
    check_in: b.check_in,
    check_out: b.check_out,
    nights: b.nights,
    guests: b.guests,
    total: b.total,
    dp_amount: b.dp_amount,
    reject_reason: b.reject_reason || '',
    expired: b.status === 'pending' && b.created_at < pendingCutoff(s),
    payment_info: withPayment && b.status === 'pending' ? s.payment_info : undefined,
  };
}

function adminBooking(b, s, base, unitsById) {
  const kind = { pending: 'reminder', approved: 'approved', rejected: 'rejected', cancelled: 'cancelled' }[b.status];
  const text = b.phone ? guestMsg(kind, b, s, base, b.reject_reason) : '';
  return {
    ...b,
    unit_name: unitsById[b.unit_id]?.name || '-',
    expired: b.status === 'pending' && b.created_at < pendingCutoff(s),
    wa_url: b.phone ? `https://wa.me/${b.phone}?text=${encodeURIComponent(text)}` : null,
  };
}

// ---------- App ----------
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  next();
});
app.use(express.json({ limit: '20kb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ----- Publik -----
app.get('/api/config', (req, res) => {
  const s = getSettings();
  res.json({
    today: todayStr(),
    name: s.property_name,
    admin_wa: adminPhones(s)[0] || null,
    checkin_time: s.checkin_time,
    checkout_time: s.checkout_time,
    dp_percent: Number(s.dp_percent),
    rules: ruleLines(s),
    address: s.address,
    maps_url: mapsUrl(s),
    max_nights: MAX_NIGHTS,
    pending_hours: Number(s.pending_hours),
    units: listUnits()
      .filter((u) => u.active)
      .map(({ id, name, description, price, weekend_price, base_capacity, max_capacity, extra_fee }) => ({
        id, name, description, price, weekend_price, base_capacity, max_capacity, extra_fee,
      })),
  });
});

// Hitungan harga per malam untuk satu masa menginap (dipakai rincian di form booking).
app.get('/api/quote', (req, res) => {
  if (!allow('quote:' + req.ip, 120, 60e3)) throw new HttpError(429, 'Terlalu banyak permintaan.');
  const s = getSettings();
  const unit = getUnit(Number(req.query.unit) || listUnits()[0]?.id);
  if (!unit || !unit.active) throw new HttpError(400, 'Unit tidak ditemukan.');
  const guests = Math.max(1, Math.min(unit.max_capacity, Math.floor(Number(req.query.guests)) || unit.base_capacity));
  const { nights } = validateStay({ check_in: req.query.from, check_out: req.query.to, guests }, unit, s);
  res.json({ quote: quote(unit, req.query.from, req.query.to, guests, s), nights });
});

app.get('/api/availability', (req, res) => {
  const s = getSettings();
  const unitId = Number(req.query.unit) || listUnits()[0]?.id;
  const today = todayStr();
  let from = isDate(req.query.from) ? req.query.from : today;
  let to = isDate(req.query.to) ? req.query.to : addDays(from, 365);
  if (diffDays(from, to) > 400) to = addDays(from, 400);
  const out = {};
  const mark = (start, end, status) => {
    let d = start < from ? from : start;
    const stop = end > to ? to : end;
    while (d < stop) {
      if (status !== 'pending' || !out[d]) out[d] = status;
      d = addDays(d, 1);
    }
  };
  const c = conflicts(unitId, from, to, s);
  for (const b of c.bookings) mark(b.check_in, b.check_out, b.status === 'approved' ? 'booked' : 'pending');
  for (const k of c.blocks) mark(k.start_date, k.end_date, 'blocked');
  const unit = getUnit(unitId);
  res.json({ unit_id: unitId, nights: out, prices: unit ? priceMap(unit, from, to, s) : {} });
});

app.post('/api/bookings', (req, res) => {
  if (!allow('book:' + req.ip, 6, 3600e3)) throw new HttpError(429, 'Terlalu banyak permintaan. Coba lagi nanti.');
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // honeypot untuk bot
  const s = getSettings();
  const unit = getUnit(Number(b.unit_id) || listUnits()[0]?.id);
  if (!unit || !unit.active) throw new HttpError(400, 'Unit tidak ditemukan.');
  const name = clean(b.name, 80);
  if (name.length < 2) throw new HttpError(400, 'Nama wajib diisi.');
  const phone = normalizePhone(b.phone);
  if (!phone) throw new HttpError(400, 'Nomor WhatsApp tidak valid. Contoh: 08123456789.');
  const { nights, guests } = validateStay(b, unit, s);
  const note = clean(b.note, 300);
  const q = quote(unit, b.check_in, b.check_out, guests, s);
  assertMinNights(q);
  const { total, dp } = q;

  const booking = tx(() => {
    const open = db
      .prepare(`SELECT COUNT(*) n FROM bookings WHERE phone = ? AND status = 'pending' AND created_at > ?`)
      .get(phone, pendingCutoff(s)).n;
    if (open >= 3) throw new HttpError(429, 'Masih ada 3 booking menunggu konfirmasi untuk nomor ini.');
    if (conflicts(unit.id, b.check_in, b.check_out, s).any)
      throw new HttpError(409, 'Maaf, sebagian tanggal itu baru saja terisi. Pilih tanggal lain.');
    return insertBooking({
      unit, name, phone, check_in: b.check_in, check_out: b.check_out, nights, guests, note,
      total, dp, status: 'pending', source: 'web',
    });
  });

  const base = baseUrl(req);
  const adminList = adminPhones(s);
  const adminPhone = adminList[0] || null;
  for (const to of adminList) {
    queueMessage({
      to,
      kind: 'admin_new',
      bookingId: booking.id,
      body: adminNewBookingMsg(booking, s, `${base}${ADMIN_PATH}?b=${booking.id}`),
    });
  }
  res.status(201).json({
    booking: publicBooking(booking, s, { withPayment: true }),
    wa_admin_url: adminPhone
      ? `https://wa.me/${adminPhone}?text=${encodeURIComponent(guestToAdminMsg(booking, s))}`
      : null,
  });
});

app.get('/api/status/:code', (req, res) => {
  if (!allow('status:' + req.ip, 30, 60e3)) throw new HttpError(429, 'Terlalu banyak permintaan.');
  const s = getSettings();
  const b = db.prepare('SELECT * FROM bookings WHERE code = ?').get(String(req.params.code).toUpperCase());
  if (!b) throw new HttpError(404, 'Kode booking tidak ditemukan.');
  const adminPhone = adminPhones(s)[0] || null;
  res.json({
    booking: publicBooking(b, s, { withPayment: true }),
    wa_admin_url: adminPhone ? `https://wa.me/${adminPhone}?text=${encodeURIComponent(guestToAdminMsg(b, s))}` : null,
  });
});

// ----- Admin -----
app.get(ADMIN_PATH, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

app.post('/api/admin/login', (req, res) => {
  if (!allow('login:' + req.ip, 10, 15 * 60e3)) throw new HttpError(429, 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.');
  const given = sha(req.body?.password ?? '');
  if (!crypto.timingSafeEqual(given, sha(ADMIN_PASSWORD))) throw new HttpError(401, 'Password salah.');
  const secure = req.secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `gh_admin=${encodeURIComponent(sign(Date.now() + SESSION_MS))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`
  );
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'gh_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

const admin = express.Router();
admin.use((req, res, next) => {
  if (!verify(getCookie(req, 'gh_admin'))) throw new HttpError(401, 'Silakan masuk dulu.');
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET') {
    try {
      if (new URL(origin).host !== req.get('host')) throw new Error();
    } catch {
      throw new HttpError(403, 'Permintaan ditolak.');
    }
  }
  res.set('Cache-Control', 'no-store');
  next();
});

admin.get('/session', (req, res) => res.json({ ok: true, wa_provider: getWaProvider() }));

admin.get('/bookings', (req, res) => {
  const s = getSettings();
  const base = baseUrl(req);
  const unitsById = Object.fromEntries(listUnits().map((u) => [u.id, u]));
  const rows = db.prepare('SELECT * FROM bookings ORDER BY id DESC LIMIT 500').all();
  res.json({ bookings: rows.map((b) => adminBooking(b, s, base, unitsById)) });
});

admin.post('/bookings', (req, res) => {
  const s = getSettings();
  const b = req.body || {};
  const unit = getUnit(Number(b.unit_id) || listUnits()[0]?.id);
  if (!unit) throw new HttpError(400, 'Unit tidak ditemukan.');
  const name = clean(b.name, 80);
  if (name.length < 2) throw new HttpError(400, 'Nama wajib diisi.');
  const phone = b.phone ? normalizePhone(b.phone) : null;
  if (b.phone && !phone) throw new HttpError(400, 'Nomor WhatsApp tidak valid.');
  const { nights, guests } = validateStay(b, unit, s);
  const calc = quote(unit, b.check_in, b.check_out, guests, s);
  const total = Number.isFinite(Number(b.total)) && b.total !== '' && b.total != null ? Math.max(0, Math.round(Number(b.total))) : calc.total;
  const booking = tx(() => {
    if (conflicts(unit.id, b.check_in, b.check_out, s).any)
      throw new HttpError(409, 'Tanggal bentrok dengan booking atau blokir lain.');
    return insertBooking({
      unit, name, phone, check_in: b.check_in, check_out: b.check_out, nights, guests,
      note: clean(b.note, 300), total, dp: 0, status: 'approved', source: 'manual',
    });
  });
  res.status(201).json({ booking });
});

function decide(req, res, from, to, kind) {
  const s = getSettings();
  const b = getBooking(Number(req.params.id));
  if (!b) throw new HttpError(404, 'Booking tidak ditemukan.');
  if (!from.includes(b.status)) throw new HttpError(409, 'Booking ini sudah diproses.');
  const reason = clean(req.body?.reason, 200);
  if (to === 'approved' && conflicts(b.unit_id, b.check_in, b.check_out, s, { pending: false, excludeId: b.id }).any)
    throw new HttpError(409, 'Tanggal ini sudah terisi atau diblokir. Booking tidak bisa diterima.');
  db.prepare('UPDATE bookings SET status = ?, reject_reason = ?, decided_at = ? WHERE id = ?').run(
    to, to === 'approved' ? '' : reason, new Date().toISOString(), b.id
  );
  const updated = getBooking(b.id);
  const base = baseUrl(req);
  if (updated.phone) {
    queueMessage({
      to: updated.phone,
      kind: 'guest_' + kind,
      bookingId: updated.id,
      body: guestMsg(kind, updated, s, base, reason),
    });
  }
  const unitsById = Object.fromEntries(listUnits().map((u) => [u.id, u]));
  res.json({ booking: adminBooking(updated, s, base, unitsById), wa_provider: getWaProvider() });
}
admin.post('/bookings/:id/approve', (req, res) => decide(req, res, ['pending'], 'approved', 'approved'));
admin.post('/bookings/:id/reject', (req, res) => decide(req, res, ['pending'], 'rejected', 'rejected'));
admin.post('/bookings/:id/cancel', (req, res) => decide(req, res, ['approved', 'pending'], 'cancelled', 'cancelled'));

admin.get('/blocks', (req, res) => {
  const rows = db.prepare('SELECT * FROM blocks WHERE end_date > ? ORDER BY start_date').all(todayStr());
  res.json({ blocks: rows.map((k) => ({ ...k, last_night: addDays(k.end_date, -1) })) });
});

admin.post('/blocks', (req, res) => {
  const s = getSettings();
  const b = req.body || {};
  const unit = getUnit(Number(b.unit_id) || listUnits()[0]?.id);
  if (!unit) throw new HttpError(400, 'Unit tidak ditemukan.');
  if (!isDate(b.start) || !isDate(b.end) || b.end < b.start) throw new HttpError(400, 'Tanggal tidak valid.');
  if (diffDays(b.start, b.end) > 366) throw new HttpError(400, 'Rentang blokir terlalu panjang.');
  const endExclusive = addDays(b.end, 1);
  const c = conflicts(unit.id, b.start, endExclusive, s, { pending: false });
  if (c.bookings.length) throw new HttpError(409, 'Ada booking yang sudah diterima pada tanggal itu. Batalkan dulu bookingnya.');
  const r = db
    .prepare('INSERT INTO blocks(unit_id, start_date, end_date, note, created_at) VALUES(?,?,?,?,?)')
    .run(unit.id, b.start, endExclusive, clean(b.note, 120), new Date().toISOString());
  res.status(201).json({ id: r.lastInsertRowid });
});

admin.delete('/blocks/:id', (req, res) => {
  db.prepare('DELETE FROM blocks WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

const SECRET_KEYS = ['waha_api_key', 'fonnte_token'];

const SETTING_RULES = {
  property_name: { max: 80 },
  admin_wa: { phones: true },
  wa_provider: { oneOf: ['none', 'waha', 'fonnte'] },
  waha_url: { max: 200, url: true },
  waha_session: { max: 80 },
  waha_api_key: { max: 300, secret: true },
  fonnte_token: { max: 300, secret: true },
  checkin_time: { max: 10 },
  checkout_time: { max: 10 },
  dp_percent: { int: [0, 100] },
  pending_hours: { int: [1, 720] },
  address: { max: 200 },
  payment_info: { max: 600, multiline: true },
  rules: { max: 3000, multiline: true },
};

admin.get('/settings', (req, res) => {
  const s = getSettings();
  const out = {};
  const secrets = {};
  for (const k of Object.keys(SETTING_RULES)) {
    if (SECRET_KEYS.includes(k)) {
      // Rahasia tidak pernah dikirim ke browser; hanya penanda sudah diisi dan 4 karakter terakhir.
      out[k] = '';
      secrets[k] = s[k] ? { set: true, hint: s[k].slice(-4) } : { set: false, hint: '' };
    } else out[k] = s[k];
  }
  res.json({ settings: out, secrets, units: listUnits(), wa_provider: getWaProvider() });
});

admin.put('/settings', (req, res) => {
  const { settings = {}, units = [] } = req.body || {};
  const apply = [];
  for (const [k, rule] of Object.entries(SETTING_RULES)) {
    if (!(k in settings)) continue;
    let v = settings[k];
    if (rule.secret) {
      v = String(v ?? '').trim();
      if (!v) continue; // kosong = pertahankan nilai yang sudah tersimpan
      if (v.length > rule.max) throw new HttpError(400, 'Nilai terlalu panjang.');
      apply.push([k, v]);
      continue;
    }
    if (rule.int) {
      v = Number(v);
      if (!Number.isInteger(v) || v < rule.int[0] || v > rule.int[1])
        throw new HttpError(400, `Nilai "${k}" harus angka ${rule.int[0]} sampai ${rule.int[1]}.`);
    } else if (rule.phones) {
      const parts = String(v ?? '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
      const nums = parts.map((x) => normalizePhone(x));
      if (!parts.length) throw new HttpError(400, 'Isi minimal satu nomor WhatsApp admin.');
      if (nums.some((n) => !n)) throw new HttpError(400, `Nomor WhatsApp admin tidak valid: ${parts[nums.findIndex((n) => !n)]}`);
      if (nums.length > 5) throw new HttpError(400, 'Maksimal 5 nomor admin.');
      v = [...new Set(nums)].join('\n');
    } else if (rule.oneOf) {
      v = String(v ?? '').toLowerCase();
      if (!rule.oneOf.includes(v)) throw new HttpError(400, 'Penyedia WhatsApp tidak dikenal.');
    } else if (rule.url) {
      v = String(v ?? '').trim().replace(/\/+$/, '');
      if (v && !/^https?:\/\/[^\s/]+(:\d+)?(\/\S*)?$/i.test(v)) throw new HttpError(400, 'Alamat WAHA harus diawali http:// atau https://.');
    } else if (rule.multiline) {
      v = String(v ?? '').replace(/\r/g, '').split('\n').map((l) => l.trim()).join('\n').trim().slice(0, rule.max);
    } else {
      v = clean(v, rule.max);
    }
    if (['property_name', 'checkin_time', 'checkout_time'].includes(k) && !v) throw new HttpError(400, `"${k}" tidak boleh kosong.`);
    apply.push([k, v]);
  }
  const unitUpdates = [];
  for (const u of units) {
    const row = getUnit(Number(u.id));
    if (!row) continue;
    const base = Number(u.base_capacity), max = Number(u.max_capacity);
    if (![base, max].every((n) => Number.isInteger(n) && n >= 0) || base < 1 || max < base || max > 100)
      throw new HttpError(400, 'Kapasitas unit tidak valid.');
    const name = clean(u.name, 80);
    if (!name) throw new HttpError(400, 'Nama unit tidak boleh kosong.');
    unitUpdates.push([name, String(u.description ?? '').replace(/\r/g, '').trim().slice(0, 1500), base, max, row.id]);
  }
  tx(() => {
    for (const [k, v] of apply) setSetting(k, v);
    for (const args of unitUpdates)
      db.prepare('UPDATE units SET name = ?, description = ?, base_capacity = ?, max_capacity = ? WHERE id = ?').run(...args);
  });
  res.json({ ok: true });
});

// ----- Harga -----
const rupiahInt = (v, label, { min = 0, max = 100_000_000 } = {}) => {
  const n = Number(v);
  if (v === '' || v == null || !Number.isInteger(n) || n < min || n > max)
    throw new HttpError(400, `${label} harus berupa angka bulat (rupiah) antara ${min} dan ${max.toLocaleString('id-ID')}.`);
  return n;
};

admin.get('/pricing', (req, res) => {
  const s = getSettings();
  const today = todayStr();
  const units = listUnits();
  const unit = units[0];
  const to = addDays(today, 28);
  res.json({
    units: units.map(({ id, name, price, weekend_price, extra_fee }) => ({ id, name, price, weekend_price, extra_fee })),
    weekend_days: [...parseWeekendDays(s.weekend_days)].sort(),
    rules: db
      .prepare('SELECT * FROM rate_rules WHERE end_date >= ? ORDER BY start_date, id')
      .all(today),
    preview: unit ? nightlyPrices(unit, today, to, s).map(({ date, price, label }) => ({ date, price, label })) : [],
  });
});

admin.put('/pricing', (req, res) => {
  const { units = [], weekend_days: days } = req.body || {};
  const updates = [];
  for (const u of units) {
    const row = getUnit(Number(u.id));
    if (!row) continue;
    updates.push([
      rupiahInt(u.price, 'Harga hari biasa', { min: 1 }),
      rupiahInt(u.weekend_price === '' ? 0 : u.weekend_price, 'Harga akhir pekan'),
      rupiahInt(u.extra_fee === '' ? 0 : u.extra_fee, 'Biaya tamu tambahan'),
      row.id,
    ]);
  }
  let weekend = null;
  if (days !== undefined) {
    const list = [...new Set((Array.isArray(days) ? days : []).map(Number))];
    if (list.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) throw new HttpError(400, 'Hari akhir pekan tidak valid.');
    weekend = list.sort().join(',');
  }
  tx(() => {
    for (const a of updates) db.prepare('UPDATE units SET price = ?, weekend_price = ?, extra_fee = ? WHERE id = ?').run(...a);
    if (weekend !== null) setSetting('weekend_days', weekend);
  });
  res.json({ ok: true });
});

admin.post('/rates', (req, res) => {
  const b = req.body || {};
  const unit = getUnit(Number(b.unit_id) || listUnits()[0]?.id);
  if (!unit) throw new HttpError(400, 'Unit tidak ditemukan.');
  const name = clean(b.name, 60);
  if (!name) throw new HttpError(400, 'Nama aturan wajib diisi, misalnya "Tahun Baru".');
  if (!isDate(b.start) || !isDate(b.end) || b.end < b.start) throw new HttpError(400, 'Tanggal tidak valid.');
  if (diffDays(b.start, b.end) > 366) throw new HttpError(400, 'Rentang tanggal terlalu panjang.');
  const price = rupiahInt(b.price, 'Harga', { min: 1 });
  const minNights = rupiahInt(b.min_nights === '' || b.min_nights == null ? 1 : b.min_nights, 'Minimal malam', { min: 1, max: 30 });
  const r = db
    .prepare('INSERT INTO rate_rules(unit_id, name, start_date, end_date, price, min_nights, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(unit.id, name, b.start, b.end, price, minNights, new Date().toISOString());
  res.status(201).json({ id: r.lastInsertRowid });
});

admin.delete('/rates/:id', (req, res) => {
  db.prepare('DELETE FROM rate_rules WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// Cek koneksi ke penyedia WhatsApp yang tersimpan (tanpa mengirim pesan).
admin.get('/wa/status', async (req, res, next) => {
  try {
    const provider = getWaProvider();
    const s = getSettings();
    if (provider === 'none') return res.json({ provider, ok: false, message: 'Penyedia WhatsApp belum dipilih.' });
    if (provider === 'fonnte')
      return res.json({ provider, ok: !!s.fonnte_token, message: s.fonnte_token ? 'Token Fonnte sudah diisi. Gunakan kirim pesan uji untuk memastikan.' : 'Token Fonnte belum diisi.' });
    try {
      const st = await wahaStatus();
      const clash = adminPhones(s).filter((p) => p === st.number);
      const working = st.status === 'WORKING';
      res.json({
        provider, ok: working, status: st.status, number: st.number, name: st.name,
        message: working ? 'WAHA terhubung dan sesi berjalan.' : `Sesi WAHA berstatus ${st.status}. Pesan hanya terkirim bila statusnya WORKING.`,
        warning: clash.length ? `Nomor ${clash.join(', ')} sama dengan akun pengirim WAHA. Pesan ke nomor sendiri tidak muncul sebagai notifikasi. Gunakan nomor admin yang berbeda.` : '',
      });
    } catch (e) {
      res.json({ provider, ok: false, message: e.message });
    }
  } catch (e) {
    next(e);
  }
});

// Kirim pesan uji ke semua nomor admin.
admin.post('/wa/test', async (req, res, next) => {
  try {
    if (!allow('watest', 10, 10 * 60e3)) throw new HttpError(429, 'Terlalu sering mencoba. Tunggu beberapa menit.');
    const s = getSettings();
    const phones = adminPhones(s);
    if (!phones.length) throw new HttpError(400, 'Belum ada nomor admin.');
    const text = `Tes dari aplikasi ${s.property_name}: koneksi WhatsApp berfungsi. Pemberitahuan booking baru akan dikirim ke nomor ini.`;
    const results = [];
    for (const to of phones) {
      try {
        await sendRaw(to, text);
        results.push({ phone: to, ok: true });
      } catch (e) {
        results.push({ phone: to, ok: false, error: e.message });
      }
    }
    res.json({ results });
  } catch (e) {
    next(e);
  }
});

admin.get('/messages', (req, res) => {
  const rows = db
    .prepare(
      `SELECT m.id, m.booking_id, m.to_phone, m.kind, m.body, m.status, m.error, m.created_at, m.sent_at, b.code
       FROM messages m LEFT JOIN bookings b ON b.id = m.booking_id ORDER BY m.id DESC LIMIT 60`
    )
    .all();
  res.json({ messages: rows, wa_provider: getWaProvider() });
});

admin.post('/messages/:id/retry', async (req, res, next) => {
  try {
    const m = await deliver(Number(req.params.id));
    if (!m) throw new HttpError(404, 'Pesan tidak ditemukan.');
    res.json({ message: m });
  } catch (e) {
    next(e);
  }
});

app.use('/api/admin', admin);
app.use('/api', (req, res) => res.status(404).json({ error: 'Tidak ditemukan.' }));

app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Data tidak valid.' });
  console.error(err);
  res.status(500).json({ error: 'Terjadi kesalahan di server.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Guest house app berjalan di port ${PORT} (admin: ${ADMIN_PATH}, WA: ${getWaProvider()})`);
});
