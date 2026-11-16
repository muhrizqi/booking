import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(path.join(dir, 'guesthouse.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Skema sudah siap multi-unit: semua booking & blokir terikat ke unit_id.
db.exec(`
CREATE TABLE IF NOT EXISTS units (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  price         INTEGER NOT NULL DEFAULT 0,
  base_capacity INTEGER NOT NULL DEFAULT 1,
  max_capacity  INTEGER NOT NULL DEFAULT 1,
  extra_fee     INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  unit_id       INTEGER NOT NULL REFERENCES units(id),
  name          TEXT NOT NULL,
  phone         TEXT,
  check_in      TEXT NOT NULL,
  check_out     TEXT NOT NULL,
  nights        INTEGER NOT NULL,
  guests        INTEGER NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  total         INTEGER NOT NULL DEFAULT 0,
  dp_amount     INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',
  source        TEXT NOT NULL DEFAULT 'web',
  reject_reason TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_bookings_range ON bookings(unit_id, check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE TABLE IF NOT EXISTS blocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id    INTEGER NOT NULL REFERENCES units(id),
  start_date TEXT NOT NULL,
  end_date   TEXT NOT NULL,   -- eksklusif (tanggal setelah malam terakhir yang diblokir)
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER,
  to_phone   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued',
  error      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  sent_at    TEXT
);
`);

const DEFAULT_SETTINGS = {
  property_name: 'Guest House Masjid Jogokariyan',
  admin_wa: '081311351136',
  checkin_time: '14.00',
  checkout_time: '12.00',
  dp_percent: '50',
  pending_hours: '24',
  address: 'Selatan Masjid Jogokariyan, Kampung Jogokariyan, Mantrijeron, Yogyakarta',
  lat: '-7.824630',
  lng: '110.364288',
  payment_info: 'Transfer DP ke rekening:\n(isi nama bank, nomor rekening, dan atas nama di menu Pengaturan)',
  rules: [
    'Kapasitas normal 10 orang. Penambahan tamu (maksimal 5 orang, extra bed di ruang pertemuan) mohon dikonfirmasi ke admin sebelum datang.',
    'Jaga kebersihan, ketenangan, dan adab selama menginap, terutama pada waktu shalat dan malam hari.',
    'Dilarang merokok di dalam rumah.',
    'Kerusakan atau kehilangan fasilitas menjadi tanggung jawab penyewa.',
    'Sebelum pulang, pastikan AC, lampu, dan kran air sudah dimatikan serta sampah dibuang pada tempatnya.',
  ].join('\n'),
};

const insSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

if (!db.prepare('SELECT 1 FROM units LIMIT 1').get()) {
  db.prepare(
    'INSERT INTO units(name, description, price, base_capacity, max_capacity, extra_fee, sort) VALUES(?,?,?,?,?,?,1)'
  ).run(
    'Rumah Guest House',
    [
      '# Lantai 1',
      'Ruang tamu dan dapur',
      'Kamar 1: AC, kamar mandi dalam dengan air panas dan dingin, untuk 3 orang dengan extra bed',
      'Ruang pertemuan di bagian belakang, dengan 1 kamar mandi',
      '# Lantai 2',
      'Kamar 2: AC, untuk 3 orang dengan extra bed',
      'Kamar 3: AC, untuk 3 orang dengan extra bed',
      'Kamar 4: tanpa AC, untuk 1 orang',
      '1 kamar mandi dengan air panas dan dingin',
    ].join('\n'),
    750000,
    10,
    15,
    0
  );
}

export const getSettings = () =>
  Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));

export const setSetting = (k, v) =>
  db
    .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(k, String(v));

export const listUnits = () => db.prepare('SELECT * FROM units ORDER BY sort, id').all();
export const getUnit = (id) => db.prepare('SELECT * FROM units WHERE id = ?').get(id);

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
