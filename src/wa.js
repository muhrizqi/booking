import { db, getSettings } from './db.js';

// Pengaturan WhatsApp disimpan di database (menu Pengaturan di panel admin).
// Nilai awalnya diambil dari environment variable WA_PROVIDER, WAHA_URL, WAHA_API_KEY,
// WAHA_SESSION, dan FONNTE_TOKEN saat database pertama kali dibuat.

export function getWaProvider() {
  const p = String(getSettings().wa_provider || 'none').toLowerCase();
  return p === 'waha' || p === 'fonnte' ? p : 'none';
}

function wahaCfg(s = getSettings()) {
  const url = String(s.waha_url || '').trim().replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (s.waha_api_key) headers['X-Api-Key'] = s.waha_api_key;
  return { url, headers, session: String(s.waha_session || 'default').trim() || 'default' };
}

/** Kirim langsung. Melempar Error berisi alasan dalam bahasa Indonesia bila gagal. */
export async function sendRaw(to, text) {
  const s = getSettings();
  const provider = getWaProvider();

  if (provider === 'fonnte') {
    if (!s.fonnte_token) throw new Error('Token Fonnte belum diisi.');
    const fd = new FormData();
    fd.append('target', to);
    fd.append('message', text);
    fd.append('countryCode', '62');
    const r = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { Authorization: s.fonnte_token },
      body: fd,
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status === false) throw new Error(j.reason || j.detail || `Fonnte menjawab HTTP ${r.status}`);
    return;
  }

  if (provider === 'waha') {
    const c = wahaCfg(s);
    if (!c.url) throw new Error('Alamat WAHA belum diisi.');
    let r;
    try {
      r = await fetch(`${c.url}/api/sendText`, {
        method: 'POST',
        headers: c.headers,
        body: JSON.stringify({ session: c.session, chatId: `${to}@c.us`, text }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new Error(`Tidak bisa menghubungi WAHA di ${c.url} (${e.cause?.code || e.message}).`);
    }
    if (r.status === 401 || r.status === 403) throw new Error('API key WAHA ditolak.');
    if (!r.ok) throw new Error(`WAHA menjawab HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return;
  }

  throw new Error('Penyedia WhatsApp belum dipilih.');
}

/** Status sesi WAHA: status, nomor akun yang terhubung, dan nama. */
export async function wahaStatus() {
  const c = wahaCfg();
  if (!c.url) throw new Error('Alamat WAHA belum diisi.');
  let r;
  try {
    r = await fetch(`${c.url}/api/sessions/${encodeURIComponent(c.session)}`, {
      headers: c.headers,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new Error(`Tidak bisa menghubungi WAHA di ${c.url} (${e.cause?.code || e.message}).`);
  }
  if (r.status === 401 || r.status === 403) throw new Error('API key WAHA ditolak.');
  if (r.status === 404) throw new Error(`Sesi "${c.session}" tidak ditemukan di WAHA. Periksa nama sesi.`);
  if (!r.ok) throw new Error(`WAHA menjawab HTTP ${r.status}.`);
  const j = await r.json().catch(() => ({}));
  const id = j.me?.id ? String(j.me.id).split('@')[0].split(':')[0] : null;
  return { status: j.status || 'UNKNOWN', number: id, name: j.me?.pushName || '' };
}

const setStatus = db.prepare('UPDATE messages SET status = ?, error = ?, sent_at = ? WHERE id = ?');

export async function deliver(id) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!m) return null;
  if (getWaProvider() === 'none') {
    setStatus.run('skipped', 'Penyedia WhatsApp belum diatur: kirim manual lewat tombol WhatsApp', null, id);
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
