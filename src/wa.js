import { db } from './db.js';

// WA_PROVIDER: "fonnte" | "waha" | "none" (default).
// Dengan "none", pesan tetap dicatat di menu Pesan dan admin bisa mengirimnya
// lewat tombol WhatsApp (wa.me) secara manual.
export const waProvider = (process.env.WA_PROVIDER || 'none').toLowerCase();

async function sendRaw(to, text) {
  if (waProvider === 'fonnte') {
    const fd = new FormData();
    fd.append('target', to);
    fd.append('message', text);
    fd.append('countryCode', '62');
    const r = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { Authorization: process.env.FONNTE_TOKEN || '' },
      body: fd,
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status === false) throw new Error(j.reason || j.detail || `HTTP ${r.status}`);
    return;
  }
  if (waProvider === 'waha') {
    const base = (process.env.WAHA_URL || '').replace(/\/$/, '');
    if (!base) throw new Error('WAHA_URL belum diisi');
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.WAHA_API_KEY) headers['X-Api-Key'] = process.env.WAHA_API_KEY;
    const r = await fetch(`${base}/api/sendText`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session: process.env.WAHA_SESSION || 'default',
        chatId: `${to}@c.us`,
        text,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
    return;
  }
  throw new Error('WA_PROVIDER belum diatur');
}

const setStatus = db.prepare('UPDATE messages SET status = ?, error = ?, sent_at = ? WHERE id = ?');

export async function deliver(id) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!m) return null;
  if (waProvider === 'none') {
    setStatus.run('skipped', 'WA_PROVIDER belum diatur: kirim manual lewat tombol WhatsApp', null, id);
  } else {
    try {
      await sendRaw(m.to_phone, m.body);
      setStatus.run('sent', '', new Date().toISOString(), id);
    } catch (e) {
      console.error('[wa] gagal kirim', id, e.message);
      setStatus.run('failed', String(e.message).slice(0, 300), null, id);
    }
  }
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

/** Catat pesan lalu kirim di latar belakang (tidak menahan respons HTTP). */
export function queueMessage({ to, body, kind, bookingId = null }) {
  if (!to) return null;
  const id = db
    .prepare('INSERT INTO messages(booking_id, to_phone, kind, body, status, created_at) VALUES(?,?,?,?,?,?)')
    .run(bookingId, to, kind, body, 'queued', new Date().toISOString()).lastInsertRowid;
  deliver(id).catch((e) => console.error('[wa]', e));
  return id;
}
