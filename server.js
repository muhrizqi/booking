import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, dbInfo, getSettings, setSetting, listUnits, getUnit, tx } from './src/db.js';
import { queueMessage, deliver, getWaProvider, sendRaw, wahaStatus } from './src/wa.js';
import {
  HttpError, allow, todayStr, isDate, addDays, diffDays, normalizePhone, makeCode, rupiah,
} from './src/util.js';
import { quote, assertMinNights, priceMap, nightlyPrices, parseWeekendDays } from './src/pricing.js';
import { saveBackup, listBackups, validName, backupDir, restoreFrom, inspectBackup, autoBackup } from './src/backup.js';
import fs from 'node:fs';
import { adminNewBookingMsg, guestToAdminMsg, guestMsg, commissionDigestMsg, ruleLines, mapsUrl } from './src/messages.js';

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

const nowIso = () => new Date().toISOString();
/** Booking pending masih menahan tanggal: dalam batas pending_hours, atau diperpanjang admin (hold_until). */
const isHeld = (b, s) => b.created_at > pendingCutoff(s) || (b.hold_until || '') > nowIso();
const pendingCutoff = (s) => new Date(Date.now() - Number(s.pending_hours || 24) * 3600e3).toISOString();

/** Rentang yang menghalangi: booking disetujui, booking menunggu yang belum kedaluwarsa, dan blokir admin. */
function conflicts(unitId, from, to, s, { pending = true, excludeId = null } = {}) {
  const bookings = db
    .prepare(
      `SELECT id, check_in, check_out, status, marketer_name FROM bookings
       WHERE unit_id = ? AND check_in < ? AND check_out > ? AND id != ?
         AND (status = 'approved' OR (? = 1 AND status = 'pending' AND (created_at > ? OR COALESCE(hold_until,'') > ?)))`
    )
    .all(unitId, to, from, excludeId ?? -1, pending ? 1 : 0, pendingCutoff(s), nowIso());
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

const showPrices = (s) => s.show_prices !== '0';
const dpFor = (total, s) => Math.min(total, Math.ceil((total * Number(s.dp_percent || 0)) / 100 / 1000) * 1000);

/** Harga total yang diisi manual (saat harga disembunyikan). */
function manualTotal(v) {
  const n = Number(v);
  if (v === '' || v == null || !Number.isInteger(n) || n < 1 || n > 100_000_000)
    throw new HttpError(400, 'Isi harga total yang disepakati (Rp), berupa angka bulat.');
  return n;
}

/**
 * Cari pemasar dari id atau kode tautan pribadi. Wajib diisi bila harga disembunyikan dan sudah ada pemasar aktif.
 * Mengembalikan { id, name } atau null.
 */
function resolveMarketer(b, s, { required = true } = {}) {
  let row = null;
  if (b.marketer_code) row = db.prepare('SELECT * FROM marketers WHERE code = ? AND active = 1').get(String(b.marketer_code).toLowerCase());
  else if (b.marketer_id) row = db.prepare('SELECT * FROM marketers WHERE id = ? AND active = 1').get(Number(b.marketer_id));
  if ((b.marketer_code || b.marketer_id) && !row) throw new HttpError(400, 'Pemasar tidak ditemukan atau sudah dinonaktifkan.');
  if (!row && required && !showPrices(s) && db.prepare('SELECT 1 FROM marketers WHERE active = 1').get())
    throw new HttpError(400, 'Pilih pemasar.');
  return row ? { id: row.id, name: row.name } : null;
}

function insertBooking({ unit, name, phone, check_in, check_out, nights, guests, note, total, dp, status, source, marketer = null }) {
  for (let i = 0; i < 5; i++) {
    const code = makeCode();
    if (db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code)) continue;
    const r = db
      .prepare(
        `INSERT INTO bookings(code, unit_id, name, phone, check_in, check_out, nights, guests, note,
                              total, dp_amount, status, source, created_at, decided_at, marketer_id, marketer_name)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        code, unit.id, name, phone, check_in, check_out, nights, guests, note, total, dp, status, source,
        new Date().toISOString(), status === 'approved' ? new Date().toISOString() : null,
        marketer?.id ?? null, marketer?.name ?? ''
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
    marketer: b.marketer_name || '',
    check_in: b.check_in,
    check_out: b.check_out,
    nights: b.nights,
    guests: b.guests,
    total: b.total,
    dp_amount: b.dp_amount,
    reject_reason: b.reject_reason || '',
    expired: b.status === 'pending' && !isHeld(b, s),
    payment_info: withPayment && b.status === 'pending' ? s.payment_info : undefined,
  };
}

/** Penerima WA konfirmasi: [{ to, asMarketer }]. Bawaan: pemasar saja; 'both' = pemasar dan tamu. Tanpa nomor pemasar, jatuh ke tamu. */
function confirmTargets(b, s) {
  const mk = b.marketer_id ? db.prepare('SELECT phone FROM marketers WHERE id = ?').get(b.marketer_id) : null;
  const mkPhone = mk?.phone ? normalizePhone(mk.phone) : null;
  const out = [];
  if (mkPhone) out.push({ to: mkPhone, asMarketer: true });
  if ((s.confirm_to === 'both' || !mkPhone) && b.phone && b.phone !== mkPhone) out.push({ to: b.phone, asMarketer: false });
  return out;
}

// ---------- Komisi pemasar & tindak lanjut ----------
const commissionPct = (s) => Math.max(0, Math.min(100, Number(s.commission_percent ?? 10) || 0));
const commissionOf = (b, s) => Math.round((b.total * commissionPct(s)) / 100);

/**
 * Komisi dibayar setelah tamu selesai menginap (hari check-out tiba), karena booking bisa dibatalkan sebelum itu.
 * due = siap dibayar, waiting = tamu belum selesai menginap, paid = sudah dibayar.
 */
function commissionState(s) {
  const today = todayStr();
  const rows = commissionPct(s) > 0
    ? db.prepare(`SELECT * FROM bookings WHERE status = 'approved' AND marketer_id IS NOT NULL ORDER BY check_out, id`).all()
    : [];
  const out = { due: [], waiting: [], paid: [] };
  for (const b of rows) {
    const item = { ...b, amount: b.commission_paid_amount ?? commissionOf(b, s) };
    if (b.commission_paid_at) out.paid.push(item);
    else if (b.check_out <= today) out.due.push(item);
    else out.waiting.push(item);
  }
  return out;
}

function inboxData(s) {
  const today = todayStr();
  const cutoff = pendingCutoff(s);
  const pending = db.prepare(`SELECT * FROM bookings WHERE status = 'pending' AND (created_at > ? OR COALESCE(hold_until,'') > ?) ORDER BY id`).all(cutoff, nowIso());
  const soon = db
    .prepare(`SELECT * FROM bookings WHERE status = 'approved' AND check_in >= ? AND check_in <= ? ORDER BY check_in, id`)
    .all(today, addDays(today, 1));
  const c = commissionState(s);
  return {
    pending, soon, commission_due: c.due, commission_waiting: c.waiting,
    commission_percent: commissionPct(s),
    count: pending.length + c.due.length,
  };
}

/** Kirim ringkasan komisi jatuh tempo ke admin sekali sehari (mulai pukul 08.00 WIB). */
function commissionDigest() {
  try {
    const s = getSettings();
    const today = todayStr();
    if (s.last_commission_digest === today) return;
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    if (hour < 8) return;
    const due = commissionState(s).due;
    if (!due.length) return;
    const base = (process.env.BASE_URL || s.base_url_seen || '').replace(/\/$/, '');
    const banks = Object.fromEntries(db.prepare('SELECT id, bank_name, bank_account, bank_holder FROM marketers').all().map((m) => [m.id, m]));
    const body = commissionDigestMsg(due.map((x) => ({ ...x, marketer_name: x.marketer_name || '-', bank: banks[x.marketer_id]?.bank_account ? banks[x.marketer_id] : null })), s, base ? `${base}${ADMIN_PATH}?tab=tindak` : '');
    for (const to of adminPhones(s)) queueMessage({ to, kind: 'admin_commission', body });
    setSetting('last_commission_digest', today);
  } catch (e) { console.error('[komisi]', e); }
}

const paidOf = (id) => db.prepare('SELECT COALESCE(SUM(amount),0) n FROM payments WHERE booking_id = ?').get(id).n;

function adminBooking(b, s, base, unitsById) {
  const kind = { pending: 'reminder', approved: 'approved', rejected: 'rejected', cancelled: 'cancelled' }[b.status];
  const t = confirmTargets(b, s)[0];
  const text = t ? guestMsg(kind, b, s, base, b.reject_reason, t.asMarketer) : '';
  return {
    ...b,
    commission: b.marketer_id && commissionPct(s) > 0 ? b.commission_paid_amount ?? commissionOf(b, s) : null,
    commission_percent: commissionPct(s),
    paid: paidOf(b.id),
    refunded: db.prepare('SELECT COALESCE(-SUM(amount),0) n FROM payments WHERE booking_id = ? AND amount < 0').get(b.id).n,
    hold_until_eff: b.status === 'pending' ? [new Date(new Date(b.created_at).getTime() + Number(s.pending_hours || 24) * 3600e3).toISOString(), b.hold_until || ''].sort().pop() : null,
    unit_name: unitsById[b.unit_id]?.name || '-',
    expired: b.status === 'pending' && !isHeld(b, s),
    wa_url: t ? `https://wa.me/${t.to}?text=${encodeURIComponent(text)}` : null,
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
  const showP = showPrices(s);
  res.json({
    show_prices: showP,
    // Pemasar hanya ditampilkan di mode tanpa harga (mode untuk pemasar).
    marketers: showP ? [] : db.prepare('SELECT id, name FROM marketers WHERE active = 1 ORDER BY name COLLATE NOCASE').all(),
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
        id, name, description, base_capacity, max_capacity,
        // Saat harga disembunyikan, angka harga tidak boleh keluar dari server.
        ...(showP ? { price, weekend_price, extra_fee } : {}),
      })),
  });
});

// Data pemasar dari tautan pribadi (/?p=kode).
app.get('/api/marketer/:code', (req, res) => {
  if (!allow('mk:' + req.ip, 60, 60e3)) throw new HttpError(429, 'Terlalu banyak permintaan.');
  const row = db.prepare('SELECT id, name FROM marketers WHERE code = ? AND active = 1').get(String(req.params.code).toLowerCase());
  if (!row) throw new HttpError(404, 'Tautan pemasar tidak dikenal.');
  res.json({ marketer: row });
});

// Hitungan harga per malam untuk satu masa menginap (dipakai rincian di form booking).
app.get('/api/quote', (req, res) => {
  if (!allow('quote:' + req.ip, 120, 60e3)) throw new HttpError(429, 'Terlalu banyak permintaan.');
  const s = getSettings();
  const unit = getUnit(Number(req.query.unit) || listUnits()[0]?.id);
  if (!unit || !unit.active) throw new HttpError(400, 'Unit tidak ditemukan.');
  const guests = Math.max(1, Math.min(unit.max_capacity, Math.floor(Number(req.query.guests)) || unit.base_capacity));
  const { nights } = validateStay({ check_in: req.query.from, check_out: req.query.to, guests }, unit, s);
  const q = quote(unit, req.query.from, req.query.to, guests, s);
  // Saat harga disembunyikan, hanya syarat minimal menginap yang dikirim.
  res.json({ quote: showPrices(s) ? q : { nights: q.nights, minNights: q.minNights }, nights });
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
  if (showPrices(s)) return res.json({ unit_id: unitId, nights: out, prices: unit ? priceMap(unit, from, to, s) : {} });

  // Mode tanpa harga: tampilkan nama pemasar pada malam yang sudah terboking (yang sudah diterima menang atas yang menunggu).
  const names = {};
  for (const b of c.bookings) {
    if (!b.marketer_name) continue;
    let d = b.check_in < from ? from : b.check_in;
    const stop = b.check_out > to ? to : b.check_out;
    for (; d < stop; d = addDays(d, 1)) if (!names[d] || b.status === 'approved') names[d] = b.marketer_name;
  }
  res.json({ unit_id: unitId, nights: out, names });
});

app.post('/api/bookings', (req, res) => {
  const s = getSettings();
  const showP = showPrices(s);
  // Pemasar bisa membuat banyak booking dari satu jaringan, jadi batasnya lebih longgar di mode tanpa harga.
  if (!allow('book:' + req.ip, showP ? 6 : 30, 3600e3)) throw new HttpError(429, 'Terlalu banyak permintaan. Coba lagi nanti.');
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // honeypot untuk bot
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
  const marketer = resolveMarketer(b, s);
  // Harga ditentukan server bila ditampilkan; bila disembunyikan, harga total diisi manual oleh pemesan.
  const total = showP ? q.total : manualTotal(b.total);
  const dp = showP ? q.dp : dpFor(total, s);

  const booking = tx(() => {
    const open = db
      .prepare(`SELECT COUNT(*) n FROM bookings WHERE phone = ? AND status = 'pending' AND (created_at > ? OR COALESCE(hold_until,'') > ?)`)
      .get(phone, pendingCutoff(s), nowIso()).n;
    if (open >= 3) throw new HttpError(429, 'Masih ada 3 booking menunggu konfirmasi untuk nomor ini.');
    if (conflicts(unit.id, b.check_in, b.check_out, s).any)
      throw new HttpError(409, 'Maaf, sebagian tanggal itu baru saja terisi. Pilih tanggal lain.');
    return insertBooking({
      unit, name, phone, check_in: b.check_in, check_out: b.check_out, nights, guests, note,
      total, dp, status: 'pending', source: 'web', marketer,
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

admin.get('/session', (req, res) => {
  const seen = baseUrl(req);
  if (getSettings().base_url_seen !== seen) setSetting('base_url_seen', seen);
  res.json({ ok: true, wa_provider: getWaProvider(), storage: { persistent: dbInfo.persistent, file: dbInfo.file } });
});

admin.get('/inbox', (req, res) => {
  const s = getSettings();
  const base = baseUrl(req);
  const unitsById = Object.fromEntries(listUnits().map((u) => [u.id, u]));
  const mk = Object.fromEntries(db.prepare('SELECT id, phone, bank_name, bank_account, bank_holder FROM marketers').all().map((m) => [m.id, m]));
  const d = inboxData(s);
  const pack = (b) => ({ ...adminBooking(b, s, base, unitsById), amount: b.amount ?? commissionOf(b, s), marketer_phone: mk[b.marketer_id]?.phone || '', bank: mk[b.marketer_id]?.bank_account ? { name: mk[b.marketer_id].bank_name, account: mk[b.marketer_id].bank_account, holder: mk[b.marketer_id].bank_holder } : null });
  res.json({
    count: d.count,
    commission_percent: d.commission_percent,
    pending: d.pending.map(pack),
    soon: d.soon.map(pack),
    commission_due: d.commission_due.map(pack),
    commission_waiting: d.commission_waiting.map(pack),
  });
});

admin.post('/bookings/:id/commission-paid', (req, res) => {
  const s = getSettings();
  const b = getBooking(Number(req.params.id));
  if (!b || !b.marketer_id) throw new HttpError(404, 'Booking pemasar tidak ditemukan.');
  if (b.status !== 'approved') throw new HttpError(409, 'Komisi hanya untuk booking yang diterima.');
  if (b.check_out > todayStr()) throw new HttpError(409, 'Tamu belum selesai menginap. Komisi dibayar setelah check-out.');
  if (b.commission_paid_at) throw new HttpError(409, 'Komisi ini sudah ditandai dibayar.');
  db.prepare('UPDATE bookings SET commission_paid_at = ?, commission_paid_amount = ? WHERE id = ?').run(new Date().toISOString(), commissionOf(b, s), b.id);
  res.json({ ok: true });
});

admin.post('/bookings/:id/commission-unpaid', (req, res) => {
  db.prepare('UPDATE bookings SET commission_paid_at = NULL, commission_paid_amount = NULL WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Edit booking, pembayaran, perpanjang tahan, laporan keuangan ----------
const intIn = (v, min, max, label) => {
  const n = Number(String(v ?? '').replace(/[.\s]/g, ''));
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} harus angka bulat ${min} sampai ${max}.`);
  return n;
};

admin.patch('/bookings/:id', (req, res) => {
  const s = getSettings();
  const b = getBooking(Number(req.params.id));
  if (!b) throw new HttpError(404, 'Booking tidak ditemukan.');
  const x = req.body || {};
  const unit = getUnit(b.unit_id);
  const name = x.name !== undefined ? clean(x.name, 80) : b.name;
  if (name.length < 2) throw new HttpError(400, 'Nama wajib diisi.');
  let phone = b.phone;
  if (x.phone !== undefined) {
    const raw = String(x.phone ?? '').trim();
    phone = raw ? normalizePhone(raw) : null;
    if (raw && !phone) throw new HttpError(400, 'Nomor WhatsApp tidak valid.');
  }
  const guests = x.guests !== undefined ? intIn(x.guests, 1, unit.max_capacity, 'Jumlah tamu') : b.guests;
  const total = x.total !== undefined ? intIn(x.total, 0, 100_000_000, 'Total') : b.total;
  const dp = x.dp_amount !== undefined ? intIn(x.dp_amount, 0, 100_000_000, 'DP') : b.dp_amount;
  if (dp > total) throw new HttpError(400, 'DP tidak boleh lebih besar dari total.');
  const note = x.note !== undefined ? clean(x.note, 300) : b.note;
  let mId = b.marketer_id, mName = b.marketer_name;
  if (x.marketer_id !== undefined) {
    if (x.marketer_id === '' || x.marketer_id === null) { mId = null; mName = ''; }
    else {
      const m = db.prepare('SELECT id, name FROM marketers WHERE id = ?').get(Number(x.marketer_id));
      if (!m) throw new HttpError(400, 'Pemasar tidak ditemukan.');
      mId = m.id; mName = m.name;
    }
  }
  if (b.commission_paid_at && (mId !== b.marketer_id || total !== b.total))
    throw new HttpError(409, 'Komisi booking ini sudah ditandai dibayar, jadi pemasar dan total tidak bisa diubah.');
  db.prepare('UPDATE bookings SET name=?, phone=?, guests=?, total=?, dp_amount=?, note=?, marketer_id=?, marketer_name=? WHERE id=?')
    .run(name, phone, guests, total, dp, note, mId, mName, b.id);
  const unitsById = Object.fromEntries(listUnits().map((u) => [u.id, u]));
  res.json({ booking: adminBooking(getBooking(b.id), s, baseUrl(req), unitsById) });
});

admin.get('/bookings/:id/payments', (req, res) => {
  const b = getBooking(Number(req.params.id));
  if (!b) throw new HttpError(404, 'Booking tidak ditemukan.');
  const payments = db.prepare('SELECT id, amount, paid_at, note FROM payments WHERE booking_id = ? ORDER BY paid_at, id').all(b.id);
  res.json({ total: b.total, dp_amount: b.dp_amount, paid: payments.reduce((a, p) => a + p.amount, 0), payments });
});

admin.post('/bookings/:id/payments', (req, res) => {
  const b = getBooking(Number(req.params.id));
  if (!b) throw new HttpError(404, 'Booking tidak ditemukan.');
  const amount = intIn(req.body?.amount, 1, 100_000_000, 'Jumlah');
  const paid_at = req.body?.paid_at ? String(req.body.paid_at) : todayStr();
  if (!isDate(paid_at) || paid_at > addDays(todayStr(), 1)) throw new HttpError(400, 'Tanggal pembayaran tidak valid.');
  if (['pending', 'approved'].includes(b.status) && paidOf(b.id) + amount > b.total)
    throw new HttpError(400, `Jumlah melebihi total booking. Sisa yang belum dibayar ${rupiah(Math.max(0, b.total - paidOf(b.id)))}.`);
  const r = db.prepare('INSERT INTO payments(booking_id, amount, paid_at, note, created_at) VALUES(?,?,?,?,?)').run(b.id, amount, paid_at, clean(req.body?.note, 120), nowIso());
  res.status(201).json({ id: r.lastInsertRowid });
});

/** Catat pengembalian dana (uang keluar) untuk booking mana pun yang masih punya saldo diterima. */
admin.post('/bookings/:id/refunds', (req, res) => {
  const b = getBooking(Number(req.params.id));
  if (!b) throw new HttpError(404, 'Booking tidak ditemukan.');
  const amount = intIn(req.body?.amount, 1, 100_000_000, 'Jumlah');
  const net = paidOf(b.id);
  if (amount > net) throw new HttpError(400, `Pengembalian melebihi uang yang diterima (${rupiah(net)}).`);
  const paid_at = req.body?.paid_at ? String(req.body.paid_at) : todayStr();
  if (!isDate(paid_at) || paid_at > addDays(todayStr(), 1)) throw new HttpError(400, 'Tanggal tidak valid.');
  const r = db.prepare('INSERT INTO payments(booking_id, amount, paid_at, note, created_at) VALUES(?,?,?,?,?)')
    .run(b.id, -amount, paid_at, clean(req.body?.note, 120) || 'Pengembalian dana', nowIso());
  res.status(201).json({ id: r.lastInsertRowid });
});

admin.delete('/payments/:id', (req, res) => {
  db.prepare('DELETE FROM payments WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

/** Perpanjang masa tunggu DP: batas baru = (batas sekarang atau saat ini, mana yang lebih akhir) + jam yang diminta. */
admin.post('/bookings/:id/extend', (req, res) => {
  const s = getSettings();
  const hours = intIn(req.body?.hours ?? 24, 1, 720, 'Jumlah jam');
  const out = tx(() => {
    const b = getBooking(Number(req.params.id));
    if (!b) throw new HttpError(404, 'Booking tidak ditemukan.');
    if (b.status !== 'pending') throw new HttpError(409, 'Hanya booking yang menunggu yang bisa diperpanjang.');
    if (b.check_in < todayStr()) throw new HttpError(409, 'Tanggal check-in sudah lewat.');
    if (!isHeld(b, s) && conflicts(b.unit_id, b.check_in, b.check_out, s, { excludeId: b.id }).any)
      throw new HttpError(409, 'Masa tunggu sudah habis dan tanggalnya sekarang terisi booking lain.');
    const cur = [new Date(new Date(b.created_at).getTime() + Number(s.pending_hours || 24) * 3600e3).toISOString(), b.hold_until || '', nowIso()].sort().pop();
    const until = new Date(new Date(cur).getTime() + hours * 3600e3).toISOString();
    db.prepare('UPDATE bookings SET hold_until = ? WHERE id = ?').run(until, b.id);
    return until;
  });
  res.json({ hold_until: out });
});

/** Uang yang ditahan dari booking batal/ditolak (DP hangus) dan bagian pemasar yang sudah dikeluarkan. */
const keptOf = (id) => db.prepare('SELECT COALESCE(SUM(amount),0) n FROM payments WHERE booking_id = ?').get(id).n;
const sharedOf = (id) => db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM expenses WHERE booking_id = ? AND kind = 'marketer_share'`).get(id).n;

admin.get('/forfeited', (req, res) => {
  const rows = db.prepare(`SELECT id, code, name, check_in, marketer_id, marketer_name FROM bookings WHERE status IN ('cancelled','rejected') AND marketer_id IS NOT NULL ORDER BY id DESC`).all();
  res.json({
    bookings: rows.map((b) => ({ ...b, kept: keptOf(b.id), shared: sharedOf(b.id) })).filter((b) => b.kept > 0),
  });
});

admin.get('/expenses', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : 'all';
  const rows = db.prepare(
    `SELECT e.*, b.code AS booking_code, b.name AS booking_name FROM expenses e LEFT JOIN bookings b ON b.id = e.booking_id
     WHERE ${month === 'all' ? '1=1' : `substr(CASE WHEN e.booking_id IS NOT NULL THEN b.check_in ELSE e.spent_at END, 1, 7) = '${month}'`}
     ORDER BY e.spent_at DESC, e.id DESC LIMIT 300`
  ).all();
  res.json({ expenses: rows });
});

admin.post('/expenses', (req, res) => {
  const x = req.body || {};
  const kind = x.kind === 'marketer_share' ? 'marketer_share' : 'other';
  const amount = intIn(x.amount, 1, 100_000_000, 'Jumlah');
  const spent_at = x.spent_at ? String(x.spent_at) : todayStr();
  if (!isDate(spent_at) || spent_at > addDays(todayStr(), 1)) throw new HttpError(400, 'Tanggal tidak valid.');
  const note = clean(x.note, 160);
  let marketer = null, bookingId = null;
  if (kind === 'marketer_share') {
    const b = getBooking(Number(x.booking_id));
    if (!b || !['cancelled', 'rejected'].includes(b.status) || !b.marketer_id)
      throw new HttpError(400, 'Pilih booking batal yang punya pemasar.');
    const left = keptOf(b.id) - sharedOf(b.id);
    if (left <= 0) throw new HttpError(400, 'Booking ini tidak punya DP hangus tersisa untuk dibagi.');
    if (amount > left) throw new HttpError(400, `Bagian pemasar melebihi DP hangus yang tersisa (${rupiah(left)}).`);
    bookingId = b.id;
    marketer = { id: b.marketer_id, name: b.marketer_name };
  } else if (x.marketer_id) {
    const m = db.prepare('SELECT id, name FROM marketers WHERE id = ?').get(Number(x.marketer_id));
    if (!m) throw new HttpError(400, 'Pemasar tidak ditemukan.');
    marketer = m;
  }
  if (kind === 'other' && !note) throw new HttpError(400, 'Isi keterangan pengeluaran.');
  const r = db.prepare('INSERT INTO expenses(spent_at, amount, kind, marketer_id, marketer_name, booking_id, note, created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(spent_at, amount, kind, marketer?.id ?? null, marketer?.name ?? '', bookingId, note, nowIso());
  res.status(201).json({ id: r.lastInsertRowid });
});

admin.delete('/expenses/:id', (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

/** Laporan per pemasar. Dasar: booking diterima yang check-in-nya jatuh di bulan itu ("all" = semua). */
admin.get('/report', (req, res) => {
  const s = getSettings();
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : 'all';
  const months = db.prepare(`SELECT DISTINCT substr(check_in, 1, 7) m FROM bookings WHERE status = 'approved' ORDER BY m DESC`).all().map((r) => r.m);
  const inScope = (col) => (month === 'all' ? '1=1' : `substr(${col}, 1, 7) = '${month}'`);
  const rows = db.prepare(
    `SELECT b.*, COALESCE((SELECT SUM(amount) FROM payments p WHERE p.booking_id = b.id), 0) AS paid
     FROM bookings b WHERE b.status = 'approved' AND ${inScope('b.check_in')} ORDER BY b.check_in`
  ).all();
  const groups = new Map();
  for (const b of rows) {
    const key = b.marketer_id ?? 0;
    if (!groups.has(key)) groups.set(key, { marketer_id: b.marketer_id, name: b.marketer_id ? b.marketer_name : 'Tanpa pemasar', bookings: 0, nights: 0, value: 0, received: 0, commission: 0, commission_paid: 0 });
    const g = groups.get(key);
    g.bookings++; g.nights += b.nights; g.value += b.total; g.received += b.paid;
    if (b.marketer_id && commissionPct(s) > 0) {
      const c = b.commission_paid_amount ?? commissionOf(b, s);
      g.commission += c;
      if (b.commission_paid_at) g.commission_paid += c;
    }
  }
  const cashIn = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM payments WHERE ${inScope('paid_at')}`).get().n;
  // Booking batal atau ditolak: uang yang tetap ditahan (DP hangus) menjadi pemasukan; pengembalian dicatat terpisah.
  const dead = db.prepare(
    `SELECT b.marketer_id, b.marketer_name,
            COALESCE((SELECT SUM(amount) FROM payments p WHERE p.booking_id = b.id AND p.amount > 0), 0) AS got,
            COALESCE((SELECT -SUM(amount) FROM payments p WHERE p.booking_id = b.id AND p.amount < 0), 0) AS back
     FROM bookings b WHERE b.status IN ('cancelled','rejected') AND ${inScope('b.check_in')}`
  ).all();
  let forfeitedTotal = 0, refundedTotal = 0;
  for (const x of dead) {
    const kept = x.got - x.back;
    refundedTotal += x.back;
    if (kept <= 0) continue;
    forfeitedTotal += kept;
    const key = x.marketer_id ?? 0;
    if (!groups.has(key)) groups.set(key, { marketer_id: x.marketer_id, name: x.marketer_id ? x.marketer_name : 'Tanpa pemasar', bookings: 0, nights: 0, value: 0, received: 0, commission: 0, commission_paid: 0 });
    groups.get(key).forfeited = (groups.get(key).forfeited || 0) + kept;
  }
  // Pengeluaran: bagian pemasar yang terkait booking dihitung di bulan check-in booking itu, sisanya menurut tanggal bayar.
  const exps = db.prepare(
    `SELECT e.* FROM expenses e LEFT JOIN bookings b ON b.id = e.booking_id
     WHERE ${month === 'all' ? '1=1' : `substr(CASE WHEN e.booking_id IS NOT NULL THEN b.check_in ELSE e.spent_at END, 1, 7) = '${month}'`}`
  ).all();
  let otherExpenses = 0;
  for (const e of exps) {
    if (e.kind === 'marketer_share' && e.marketer_id) {
      const key = e.marketer_id;
      if (!groups.has(key)) groups.set(key, { marketer_id: e.marketer_id, name: e.marketer_name, bookings: 0, nights: 0, value: 0, received: 0, commission: 0, commission_paid: 0 });
      groups.get(key).share = (groups.get(key).share || 0) + e.amount;
    } else otherExpenses += e.amount;
  }
  const list = [...groups.values()].map((g) => {
    const share = g.share || 0, forfeited = g.forfeited || 0;
    return { ...g, forfeited, share, outstanding: g.value - g.received, net: g.value - g.commission, income_net: g.received + forfeited - g.commission - share };
  }).sort((a, b) => b.value - a.value);
  const sum = (k) => list.reduce((a, g) => a + g[k], 0);
  res.json({
    month, months, commission_percent: commissionPct(s), rows: list,
    totals: { bookings: sum('bookings'), nights: sum('nights'), value: sum('value'), received: sum('received'), outstanding: sum('outstanding'), commission: sum('commission'), commission_paid: sum('commission_paid'), net: sum('net'), forfeited: forfeitedTotal, share: sum('share'), other_expenses: otherExpenses, income_net: sum('income_net') - otherExpenses },
    cash_in: cashIn, refunded: refundedTotal,
  });
});

// ---------- Cadangan dan pemulihan database ----------
admin.get('/backup', (req, res, next) => {
  const name = saveBackup('manual-');
  res.download(path.join(backupDir, name), `guesthouse-${name.replace(/^manual-/, '')}`, (err) => { if (err) next(err); });
});

admin.get('/backups', (req, res) => res.json({ backups: listBackups(), persistent: dbInfo.persistent }));

admin.get('/backups/:name', (req, res, next) => {
  if (!validName(req.params.name)) throw new HttpError(404, 'File tidak ditemukan.');
  const file = path.join(backupDir, req.params.name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'File tidak ditemukan.');
  res.download(file, req.params.name, (err) => { if (err) next(err); });
});

admin.delete('/backups/:name', (req, res) => {
  if (!validName(req.params.name)) throw new HttpError(404, 'File tidak ditemukan.');
  fs.rmSync(path.join(backupDir, req.params.name), { force: true });
  res.json({ ok: true });
});

function doRestore(file) {
  try { return restoreFrom(file); }
  catch (e) { throw new HttpError(400, e.message || 'Pemulihan gagal.'); }
}

admin.post('/backups/:name/restore', (req, res) => {
  if (!validName(req.params.name)) throw new HttpError(404, 'File tidak ditemukan.');
  const file = path.join(backupDir, req.params.name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'File tidak ditemukan.');
  res.json(doRestore(file));
});

// Unggah file .db (isi file dikirim apa adanya).
admin.post('/restore', express.raw({ type: 'application/octet-stream', limit: '60mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'File cadangan kosong.');
  const tmp = path.join(backupDir, `.unggah-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, req.body);
  try {
    if (req.query.check) return res.json(inspectSafe(tmp));
    res.json(doRestore(tmp));
  } finally { fs.rmSync(tmp, { force: true }); }
});
function inspectSafe(f) { try { return inspectBackup(f); } catch (e) { throw new HttpError(400, e.message); } }

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
  const marketer = resolveMarketer(b, s, { required: false });
  const booking = tx(() => {
    if (conflicts(unit.id, b.check_in, b.check_out, s).any)
      throw new HttpError(409, 'Tanggal bentrok dengan booking atau blokir lain.');
    return insertBooking({
      unit, name, phone, check_in: b.check_in, check_out: b.check_out, nights, guests,
      note: clean(b.note, 300), total, dp: 0, status: 'approved', source: 'manual', marketer,
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
  // Pengembalian dana saat menolak atau membatalkan booking yang sudah dibayar (0 = tidak ada, DP ditahan).
  let refund = 0;
  if (to !== 'approved' && req.body?.refund !== undefined && req.body.refund !== '') {
    refund = intIn(req.body.refund, 0, 100_000_000, 'Jumlah pengembalian');
    if (refund > paidOf(b.id)) throw new HttpError(400, `Pengembalian melebihi uang yang diterima (${rupiah(paidOf(b.id))}).`);
  }
  tx(() => {
    db.prepare('UPDATE bookings SET status = ?, reject_reason = ?, decided_at = ? WHERE id = ?').run(
      to, to === 'approved' ? '' : reason, new Date().toISOString(), b.id
    );
    if (refund > 0)
      db.prepare('INSERT INTO payments(booking_id, amount, paid_at, note, created_at) VALUES(?,?,?,?,?)')
        .run(b.id, -refund, todayStr(), `Pengembalian dana (booking ${to === 'cancelled' ? 'dibatalkan' : 'ditolak'})`, nowIso());
  });
  if (to === 'approved' && b.dp_amount > 0 && !db.prepare('SELECT 1 FROM payments WHERE booking_id = ?').get(b.id))
    db.prepare('INSERT INTO payments(booking_id, amount, paid_at, note, created_at) VALUES(?,?,?,?,?)').run(b.id, b.dp_amount, todayStr(), 'DP (saat booking diterima)', nowIso());
  const updated = getBooking(b.id);
  updated.refund_amount = refund;
  const base = baseUrl(req);
  for (const t of confirmTargets(updated, s)) {
    queueMessage({
      to: t.to,
      kind: (t.asMarketer ? 'marketer_' : 'guest_') + kind,
      bookingId: updated.id,
      body: guestMsg(kind, updated, s, base, reason, t.asMarketer),
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
  if (b.end < todayStr()) throw new HttpError(400, 'Tanggal blokir sudah lewat. Periksa bulan dan tahunnya.');
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
  show_prices: { bool: true },
  confirm_to: { oneOf: ['marketer', 'both'] },
  commission_percent: { int: [0, 100] },
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
    } else if (rule.bool) {
      v = v === true || v === 1 || v === '1' || v === 'true' ? '1' : '0';
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

// ----- Pemasar -----
const newMarketerCode = () => {
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(4).toString('hex');
    if (!db.prepare('SELECT 1 FROM marketers WHERE code = ?').get(code)) return code;
  }
  throw new HttpError(500, 'Gagal membuat kode pemasar, coba lagi.');
};

admin.get('/marketers', (req, res) => {
  const base = baseUrl(req);
  const rows = db
    .prepare(
      `SELECT m.*, (SELECT COUNT(*) FROM bookings b WHERE b.marketer_id = m.id) AS bookings,
              (SELECT COUNT(*) FROM bookings b WHERE b.marketer_id = m.id AND b.status = 'approved') AS approved
       FROM marketers m ORDER BY m.active DESC, m.name COLLATE NOCASE`
    )
    .all();
  const st = getSettings();
  const cs = commissionState(st);
  const sum = (arr, id) => arr.filter((x) => x.marketer_id === id).reduce((a, x) => a + x.amount, 0);
  res.json({
    commission_percent: commissionPct(st),
    marketers: rows.map((m) => ({
      ...m, link: `${base}/?p=${m.code}`,
      commission_due: sum(cs.due, m.id), commission_waiting: sum(cs.waiting, m.id), commission_paid: sum(cs.paid, m.id),
    })),
  });
});

/** Rekening pemasar: bank, nomor (angka, spasi, strip), atas nama. Kosong semua = tanpa rekening. */
function bankFields(b, row = {}) {
  const pick = (k, max) => (b[k] !== undefined ? clean(b[k], max) : row[k] ?? '');
  const bank_name = pick('bank_name', 40);
  const bank_account = pick('bank_account', 30);
  const bank_holder = pick('bank_holder', 60);
  if (bank_account && !/^[0-9][0-9 .-]{3,28}[0-9]$/.test(bank_account))
    throw new HttpError(400, 'Nomor rekening hanya boleh berisi angka (spasi dan strip boleh), minimal 5 digit.');
  if (bank_account && !bank_name) throw new HttpError(400, 'Isi nama bank untuk nomor rekening itu.');
  return { bank_name, bank_account, bank_holder };
}

admin.post('/marketers', (req, res) => {
  const name = clean(req.body?.name, 60);
  if (name.length < 2) throw new HttpError(400, 'Nama pemasar wajib diisi.');
  const rawPhone = String(req.body?.phone ?? '').trim();
  const phone = rawPhone ? normalizePhone(rawPhone) : '';
  if (rawPhone && !phone) throw new HttpError(400, 'Nomor WhatsApp pemasar tidak valid.');
  const bk = bankFields(req.body || {});
  if (db.prepare('SELECT 1 FROM marketers WHERE name = ? COLLATE NOCASE').get(name)) throw new HttpError(409, 'Nama pemasar itu sudah ada.');
  const r = db
    .prepare('INSERT INTO marketers(name, phone, note, code, created_at, bank_name, bank_account, bank_holder) VALUES(?,?,?,?,?,?,?,?)')
    .run(name, phone, clean(req.body?.note, 200), newMarketerCode(), new Date().toISOString(), bk.bank_name, bk.bank_account, bk.bank_holder);
  res.status(201).json({ id: r.lastInsertRowid });
});

admin.put('/marketers/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM marketers WHERE id = ?').get(Number(req.params.id));
  if (!row) throw new HttpError(404, 'Pemasar tidak ditemukan.');
  const b = req.body || {};
  const name = b.name !== undefined ? clean(b.name, 60) : row.name;
  if (name.length < 2) throw new HttpError(400, 'Nama pemasar wajib diisi.');
  const dupe = db.prepare('SELECT id FROM marketers WHERE name = ? COLLATE NOCASE AND id != ?').get(name, row.id);
  if (dupe) throw new HttpError(409, 'Nama pemasar itu sudah ada.');
  let phone = row.phone;
  if (b.phone !== undefined) {
    const raw = String(b.phone ?? '').trim();
    phone = raw ? normalizePhone(raw) : '';
    if (raw && !phone) throw new HttpError(400, 'Nomor WhatsApp pemasar tidak valid.');
  }
  const active = b.active !== undefined ? (b.active ? 1 : 0) : row.active;
  const note = b.note !== undefined ? clean(b.note, 200) : row.note;
  const bk = bankFields(b, row);
  tx(() => {
    db.prepare('UPDATE marketers SET name = ?, phone = ?, note = ?, active = ?, bank_name = ?, bank_account = ?, bank_holder = ? WHERE id = ?').run(name, phone, note, active, bk.bank_name, bk.bank_account, bk.bank_holder, row.id);
    if (name !== row.name) db.prepare('UPDATE bookings SET marketer_name = ? WHERE marketer_id = ?').run(name, row.id);
  });
  res.json({ ok: true });
});

admin.delete('/marketers/:id', (req, res) => {
  const id = Number(req.params.id);
  if (db.prepare('SELECT 1 FROM bookings WHERE marketer_id = ?').get(id))
    throw new HttpError(409, 'Pemasar ini sudah punya booking, jadi tidak bisa dihapus. Nonaktifkan saja.');
  db.prepare('DELETE FROM marketers WHERE id = ?').run(id);
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
    show_prices: showPrices(s),
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

setInterval(() => { commissionDigest(); autoBackup(); }, 30 * 60 * 1000).unref();
setTimeout(autoBackup, 20 * 1000).unref();
setTimeout(commissionDigest, 15 * 1000).unref();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Guest house app berjalan di port ${PORT} (admin: ${ADMIN_PATH}, WA: ${getWaProvider()})`);
  console.log(`Database: ${dbInfo.file}`);
  if (!dbInfo.persistent) {
    console.warn('==================================================================');
    console.warn(' PERINGATAN: folder database BUKAN volume persisten.');
    console.warn(' Data booking akan HILANG setiap redeploy.');
    console.warn(` Samakan DATA_DIR dengan Destination Path volume di Coolify (sekarang: ${path.dirname(dbInfo.file)}).`);
    console.warn('==================================================================');
  }
});
