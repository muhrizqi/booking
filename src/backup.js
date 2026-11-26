import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, dbInfo, getSettings, setSetting } from './db.js';
import { todayStr } from './util.js';

export const backupDir = path.join(path.dirname(dbInfo.file), 'backups');
fs.mkdirSync(backupDir, { recursive: true });

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{2,80}\.db$/;
export const validName = (n) => NAME_RE.test(String(n)) && !String(n).includes('..');
const stamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).replace(/[: ]/g, (c) => (c === ' ' ? '_' : '-'));

/** Salinan konsisten dari database yang sedang berjalan (aman walau ada yang sedang menulis). */
export function snapshotTo(file) {
  if (fs.existsSync(file)) fs.rmSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

export function listBackups() {
  return fs.readdirSync(backupDir)
    .filter(validName)
    .map((name) => {
      const st = fs.statSync(path.join(backupDir, name));
      return { name, size: st.size, modified: st.mtime.toISOString(), kind: name.startsWith('auto-') ? 'otomatis' : name.startsWith('sebelum-restore-') ? 'sebelum restore' : 'manual' };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

function prune(prefix, keep) {
  const old = listBackups().filter((b) => b.name.startsWith(prefix)).slice(keep);
  for (const b of old) fs.rmSync(path.join(backupDir, b.name), { force: true });
}

export function saveBackup(prefix = 'manual-') {
  // Nama unik: jangan pernah menimpa cadangan yang sudah ada (bisa saja sedang dipulihkan).
  let name = `${prefix}${stamp()}.db`;
  for (let i = 2; fs.existsSync(path.join(backupDir, name)); i++) name = `${prefix}${stamp()}-${i}.db`;
  snapshotTo(path.join(backupDir, name));
  if (prefix === 'auto-') prune('auto-', 7);
  if (prefix === 'sebelum-restore-') prune('sebelum-restore-', 5);
  if (prefix === 'manual-') prune('manual-', 20);
  return name;
}

/** Cadangan otomatis sekali sehari, disimpan di folder data (ikut volume persisten). */
export function autoBackup() {
  try {
    if (getSettings().last_auto_backup === todayStr()) return;
    saveBackup('auto-');
    setSetting('last_auto_backup', todayStr());
  } catch (e) { console.error('[backup]', e); }
}

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;

/** Periksa file yang akan dipulihkan: harus database SQLite utuh milik aplikasi ini. */
export function inspectBackup(file) {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (head.toString('utf8', 0, 15) !== 'SQLite format 3') throw new Error('File ini bukan database cadangan aplikasi.');
  const t = new DatabaseSync(file, { readOnly: true });
  try {
    const ic = t.prepare('PRAGMA integrity_check').get();
    if (Object.values(ic)[0] !== 'ok') throw new Error('File cadangan rusak (pemeriksaan integritas gagal).');
    const tables = t.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const need of ['bookings', 'units', 'settings'])
      if (!tables.includes(need)) throw new Error(`File ini bukan cadangan aplikasi booking (tabel ${need} tidak ada).`);
    const count = (tbl) => (tables.includes(tbl) ? t.prepare(`SELECT COUNT(*) n FROM ${q(tbl)}`).get().n : 0);
    return { tables, bookings: count('bookings'), marketers: count('marketers'), payments: count('payments') };
  } finally { t.close(); }
}

/**
 * Pulihkan isi database dari file cadangan. Data sekarang disimpan dulu sebagai "sebelum-restore-*".
 * Tabel disalin per kolom yang sama, jadi cadangan dari versi aplikasi yang lebih lama tetap bisa dipulihkan.
 */
export function restoreFrom(file) {
  const info = inspectBackup(file);
  const safety = saveBackup('sebelum-restore-');
  db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS restore`);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      const mine = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
      for (const tbl of mine) {
        db.exec(`DELETE FROM main.${q(tbl)}`);
        if (!info.tables.includes(tbl)) continue;
        const a = db.prepare(`PRAGMA main.table_info(${q(tbl)})`).all().map((c) => c.name);
        const b = new Set(db.prepare(`PRAGMA restore.table_info(${q(tbl)})`).all().map((c) => c.name));
        const cols = a.filter((c) => b.has(c)).map(q).join(', ');
        if (cols) db.exec(`INSERT INTO main.${q(tbl)} (${cols}) SELECT ${cols} FROM restore.${q(tbl)}`);
      }
      if (!info.tables.includes('payments'))
        db.exec(`INSERT INTO payments(booking_id, amount, paid_at, note, created_at)
                 SELECT id, dp_amount, substr(COALESCE(decided_at, created_at), 1, 10), 'DP (data sebelum fitur keuangan)', COALESCE(decided_at, created_at)
                 FROM bookings WHERE status = 'approved' AND dp_amount > 0`);
      const bad = db.prepare('PRAGMA foreign_key_check').all();
      if (bad.length) throw new Error('Data cadangan tidak konsisten (relasi antar tabel rusak).');
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* sudah selesai */ }
      throw e;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
    try { db.exec('DETACH DATABASE restore'); } catch { /* abaikan */ }
  }
  return { safety, bookings: info.bookings };
}
