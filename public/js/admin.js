(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  const DOW_MON = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
  const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const rupiah = (n) => 'Rp' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const parse = (s) => new Date(s + 'T00:00:00Z');
  const fmt = (s) => { const d = parse(s); return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const when = (iso) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const shortName = (n) => { const w = String(n).trim().split(/\s+/)[0]; return w.length > 7 ? w.slice(0, 6) + '…' : w; };
  const todayWIB = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null) n.append(kid);
    return n;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = isError ? 'error' : '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.textContent = ''; }, 5500);
  }

  async function api(path, method = 'GET', body) {
    const res = await fetch('/api/admin' + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { showLogin(); throw new Error(data.error || 'Silakan masuk dulu.'); }
    if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan.');
    return data;
  }

  const S = {
    bookings: [], blocks: [], settings: null, units: [], waProvider: 'none',
    filter: 'pending', tab: 'booking', month: null, day: null, highlight: null,
  };

  // ---------- Login ----------
  function showLogin() { $('#app').hidden = true; $('#login').hidden = false; }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Gagal masuk.');
      $('#pw').value = '';
      start();
    } catch (err) { toast(err.message, true); }
  });
  $('#logout').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    showLogin();
  });

  // ---------- Tab ----------
  function setTab(name) {
    S.tab = name;
    $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('main > section').forEach((s) => { s.hidden = s.id !== 'tab-' + name; });
    if (name === 'booking') renderBookings();
    if (name === 'tindak') loadInbox();
    if (name === 'keuangan') loadReport();
    if (name === 'kalender') { renderCal(); renderDay(); renderBlocks(); }
    if (name === 'pemasar') loadMarketers();
    if (name === 'harga') loadPricing();
    if (name === 'pengaturan') { loadSettings(); loadBackups(); }
    if (name === 'pesan') loadMessages();
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // ---------- Booking ----------
  const STATUS_LABEL = { pending: 'Menunggu', approved: 'Diterima', rejected: 'Ditolak', cancelled: 'Dibatalkan' };
  const FILTERS = [
    ['pending', 'Menunggu'], ['approved', 'Diterima'], ['closed', 'Ditolak atau batal'], ['all', 'Semua'],
  ];
  const inFilter = (b, f) => f === 'all' || (f === 'closed' ? ['rejected', 'cancelled'].includes(b.status) : b.status === f);

  async function loadBookings() {
    const [{ bookings }, { blocks }] = await Promise.all([api('/bookings'), api('/blocks')]);
    S.bookings = bookings;
    S.blocks = blocks;
    const n = bookings.filter((b) => b.status === 'pending').length;
    const badge = $('#n-pending');
    badge.hidden = n === 0;
    badge.textContent = String(n);
    loadInbox().catch(() => {});
  }

  function renderBookings() {
    $('#filters').replaceChildren(...FILTERS.map(([key, label]) => {
      const n = S.bookings.filter((b) => inFilter(b, key)).length;
      return el('button', { type: 'button', 'aria-pressed': String(S.filter === key), text: `${label} (${n})`, onclick: () => { S.filter = key; renderBookings(); } });
    }));
    const rows = S.bookings.filter((b) => inFilter(b, S.filter));
    const list = $('#list');
    if (!rows.length) {
      list.replaceChildren(el('p', { class: 'empty', text: S.filter === 'pending' ? 'Tidak ada booking yang menunggu. Semua sudah diproses.' : 'Belum ada booking di daftar ini.' }));
      return;
    }
    list.replaceChildren(...rows.map(bookingCard));
    if (S.highlight) {
      const card = $(`[data-id="${S.highlight}"]`);
      if (card) { card.classList.add('flash'); card.scrollIntoView({ block: 'center' }); }
      S.highlight = null;
    }
  }

  function bookingCard(b) {
    const btns = el('div', { class: 'btns' });
    if (b.status === 'pending') {
      btns.append(
        el('button', { type: 'button', class: 'btn', text: 'Terima booking', onclick: () => decide(b, 'approve') }),
        el('button', { type: 'button', class: 'btn danger', text: 'Tolak', onclick: () => decide(b, 'reject') })
      );
      if (b.wa_url) btns.append(el('a', { class: 'btn line', href: b.wa_url, target: '_blank', rel: 'noopener', text: 'Ingatkan DP lewat WhatsApp' }));
    } else if (b.status === 'approved') {
      if (b.wa_url) btns.append(el('a', { class: 'btn line', href: b.wa_url, target: '_blank', rel: 'noopener', text: 'Kirim info lewat WhatsApp' }));
      btns.append(el('button', { type: 'button', class: 'btn danger', text: 'Batalkan', onclick: () => decide(b, 'cancel') }));
    } else if (b.wa_url) {
      btns.append(el('a', { class: 'btn line', href: b.wa_url, target: '_blank', rel: 'noopener', text: 'Buka WhatsApp' }));
    }
    if (b.status === 'pending' || b.status === 'approved' || b.paid > 0 || b.refunded > 0) btns.append(el('button', { type: 'button', class: 'btn line', text: b.status === 'pending' || b.status === 'approved' ? 'Catat pembayaran' : 'Uang masuk dan pengembalian', onclick: () => paymentsModal(b) }));
    if (b.status === 'pending') btns.append(el('button', { type: 'button', class: 'btn line', text: 'Perpanjang tahan', onclick: () => extendHold(b) }));
    if (b.status === 'pending' || b.status === 'approved') btns.append(el('button', { type: 'button', class: 'btn line', text: 'Ubah data', onclick: () => editModal(b) }));
    return el('article', { class: 'card', 'data-id': String(b.id) },
      el('div', { class: 'card-top' },
        el('span', { class: 'code', text: b.code }),
        el('span', {}, el('span', { class: `chip ${b.status}`, text: STATUS_LABEL[b.status] }), b.expired ? el('span', { class: 'badge', text: 'lewat batas tahan' }) : null, b.source === 'manual' ? el('span', { class: 'badge', text: 'manual' }) : null)
      ),
      el('p', { class: 'who', text: b.name }),
      b.marketer_name ? el('p', { class: 'meta' }, 'Pemasar: ', el('strong', { text: b.marketer_name })) : null,
      el('p', { class: 'meta' }, b.phone ? el('a', { href: `https://wa.me/${b.phone}`, target: '_blank', rel: 'noopener', text: `+${b.phone}` }) : 'Tanpa nomor', ` , masuk ${when(b.created_at)}`),
      el('p', { class: 'money' }, `${fmt(b.check_in)} sampai ${fmt(b.check_out)}`, el('br'), `${b.nights} malam, ${b.guests} orang`, el('br'), `Total ${rupiah(b.total)}`, b.dp_amount ? `, DP diminta ${rupiah(b.dp_amount)}` : '', b.status === 'pending' || b.status === 'approved' ? [el('br'), `Diterima ${rupiah(b.paid)}`, b.total - b.paid > 0 ? `, sisa ${rupiah(b.total - b.paid)}` : ', lunas'] : (b.paid > 0 || b.refunded > 0 ? [el('br'), `Uang masuk ${rupiah(b.paid + b.refunded)}, dikembalikan ${rupiah(b.refunded)}, ditahan ${rupiah(b.paid)}`] : '')),
      b.status === 'pending' && b.hold_until_eff ? el('p', { class: `hold${b.expired ? ' late' : ''}` , text: b.expired ? `Masa tunggu habis ${when(b.hold_until_eff)}. Tanggal sudah dilepas.` : `Tanggal ditahan sampai ${when(b.hold_until_eff)}` }) : null,
      commissionLine(b),
      b.note ? el('p', { class: 'note', text: b.note }) : null,
      b.reject_reason ? el('p', { class: 'note', text: `Keterangan: ${b.reject_reason}` }) : null,
      btns
    );
  }

  async function decide(b, action) {
    let body = {};
    if (action === 'approve') {
      if (!confirm(`Terima booking ${b.code} atas nama ${b.name}?\n\nPastikan DP sudah masuk. Bila belum ada pembayaran tercatat, DP ${rupiah(b.dp_amount)} dicatat sebagai uang masuk (jumlah lain: pakai Catat pembayaran lebih dulu). Penyewa akan menerima WhatsApp berisi aturan check-in dan check-out.`)) return;
    } else if (b.paid > 0) {
      refundModal(b, action);
      return;
    } else {
      const reason = prompt(action === 'reject' ? `Alasan menolak ${b.code} (boleh dikosongkan):` : `Keterangan pembatalan ${b.code} (boleh dikosongkan):`);
      if (reason === null) return;
      body = { reason };
    }
    try {
      const data = await api(`/bookings/${b.id}/${action}`, 'POST', body);
      await loadBookings();
      renderBookings();
      if (data.wa_provider === 'none' && b.phone) {
        toast('Berhasil. WhatsApp otomatis belum aktif, kirim pesannya lewat tombol WhatsApp di kartu booking.');
      } else {
        toast(action === 'approve' ? 'Booking diterima. Pesan WhatsApp dikirim ke penyewa.' : action === 'reject' ? 'Booking ditolak.' : 'Booking dibatalkan.');
      }
    } catch (err) { toast(err.message, true); await loadBookings().catch(() => {}); renderBookings(); }
  }

  // ---------- Kalender ----------
  function nightStatus() {
    const map = {};
    const put = (s, e, st, info) => {
      for (let d = s; d < e; d = new Date(parse(d).getTime() + 86400000).toISOString().slice(0, 10)) {
        (map[d] ||= []).push({ st, ...info });
      }
    };
    for (const b of S.bookings) {
      const by = b.marketer_name ? `, pemasar ${b.marketer_name}` : '';
      if (b.status === 'approved') put(b.check_in, b.check_out, 'booked', { text: `${b.name} (${b.code}), ${b.guests} orang${by}`, who: b.marketer_name });
      else if (b.status === 'pending' && !b.expired) put(b.check_in, b.check_out, 'pending', { text: `${b.name} (${b.code}) menunggu DP${by}`, who: b.marketer_name });
    }
    for (const k of S.blocks) put(k.start_date, k.end_date, 'blocked', { text: `Diblokir${k.note ? ': ' + k.note : ''}` });
    return map;
  }

  function renderCal() {
    if (!S.month) { const [y, m] = todayWIB().split('-').map(Number); S.month = { y, m: m - 1 }; }
    const { y, m } = S.month;
    $('#cal-title').textContent = `${MONTHS[m]} ${y}`;
    if (!$('#dow').children.length) $('#dow').replaceChildren(...DOW_MON.map((d) => el('div', { class: 'dow', text: d })));
    const map = nightStatus();
    const offset = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
    const count = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const today = todayWIB();
    const cells = [];
    for (let i = 0; i < offset; i++) cells.push(el('div', { class: 'day void' }));
    for (let day = 1; day <= count; day++) {
      const d = ymd(y, m, day);
      const items = map[d] || [];
      const st = items.find((i) => i.st === 'booked') ? 'booked' : items.find((i) => i.st === 'blocked') ? 'blocked' : items.length ? 'pending' : '';
      const cls = ['day'];
      if (st) cls.push(st);
      if (d < today) cls.push('past');
      if (d === today) cls.push('today');
      if (d === S.day) cls.push('sel-start');
      const who = (items.find((i) => i.st === 'booked' && i.who) || items.find((i) => i.st === 'pending' && i.who))?.who;
      cells.push(el('button', { type: 'button', class: cls.join(' ') + (who ? ' named' : ''), 'aria-label': fmt(d), onclick: () => { S.day = d; renderCal(); renderDay(); } },
        el('span', { text: String(day) }),
        who ? el('small', { class: 'who', text: shortName(who) }) : null));
    }
    $('#cal').replaceChildren(...cells);
  }

  function renderDay() {
    const box = $('#day-detail');
    if (!S.day) { box.textContent = 'Ketuk tanggal untuk melihat isinya.'; return; }
    const items = nightStatus()[S.day] || [];
    box.replaceChildren(
      el('strong', { text: `Malam ${fmt(S.day)}` }),
      items.length ? el('ul', {}, items.map((i) => el('li', { text: i.text }))) : el('p', { class: 'catatan', text: 'Kosong.' })
    );
  }

  $('#prev').addEventListener('click', () => { S.month = S.month.m === 0 ? { y: S.month.y - 1, m: 11 } : { y: S.month.y, m: S.month.m - 1 }; renderCal(); });
  $('#next').addEventListener('click', () => { S.month = S.month.m === 11 ? { y: S.month.y + 1, m: 0 } : { y: S.month.y, m: S.month.m + 1 }; renderCal(); });

  $('#copy-cleaning-wa').addEventListener('click', async () => {
    const today = todayWIB();
    const ci = S.settings?.checkin_time || '13.00';
    const co = S.settings?.checkout_time || '11.00';
    const bedOnlyCap = 7; // Kapasitas ranjang tetap tanpa extra bed (Kamar 1:2, Kamar 2:2, Kamar 3:2, Kamar 4:1)
    const upcoming = S.bookings
      .filter((b) => b.status === 'approved' && b.check_out >= today)
      .sort((a, b) => a.check_in.localeCompare(b.check_in));

    if (!upcoming.length) {
      toast('Belum ada jadwal booking aktif mendatang.', true);
      return;
    }

    const lines = [
      `Assalamu'alaikum. Berikut jadwal persiapan & pembersihan *${S.settings?.property_name || 'Guest House'}*:`,
      '',
    ];
    upcoming.forEach((b, idx) => {
      const totalExtra = Math.max(0, b.guests - bedOnlyCap);
      const inRoomExtra = Math.min(3, totalExtra);
      const hallExtra = Math.max(0, totalExtra - 3);

      let extraText = 'Tidak perlu extra bed (kapasitas ranjang normal maksimal 7 orang)';
      if (totalExtra > 0) {
        const parts = [];
        if (inRoomExtra > 0) parts.push(`${inRoomExtra} extra bed di dalam kamar`);
        if (hallExtra > 0) parts.push(`${hallExtra} extra bed di ruang pertemuan`);
        extraText = `Siapkan total *${totalExtra} extra bed* (${parts.join(' + ')})`;
      }

      lines.push(
        `*${idx + 1}. Tamu: ${b.name} (${b.guests} Orang)*`,
        `• *Siap sebelum tamu masuk:* ${fmt(b.check_in)} (tamu check-in pkl ${ci} WIB)`,
        `• *Extra bed:* ${extraText}`,
        `• *Bersihkan setelah pulang:* ${fmt(b.check_out)} mulai pkl ${co} WIB`,
        ''
      );
    });
    lines.push('Terima kasih.');

    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Jadwal kebersihan disalin! Silakan paste ke WhatsApp.');
    } catch {
      openModal('Salin Jadwal Kebersihan (WA)', el('textarea', { rows: 12, text }));
    }
  });

  function renderBlocks() {
    const box = $('#blocks');
    if (!S.blocks.length) { box.replaceChildren(); return; }
    box.replaceChildren(...S.blocks.map((k) => el('div', { class: 'card' },
      el('div', { class: 'card-top' },
        el('span', {}, el('strong', { text: k.start_date === k.last_night ? fmt(k.start_date) : `${fmt(k.start_date)} sampai ${fmt(k.last_night)}` }), k.note ? el('span', { class: 'meta', text: `, ${k.note}` }) : null),
        el('button', { type: 'button', class: 'btn danger', text: 'Buka blokir', onclick: async () => {
          if (!confirm('Buka kembali tanggal ini untuk disewa?')) return;
          try { await api(`/blocks/${k.id}`, 'DELETE'); await loadBookings(); renderCal(); renderDay(); renderBlocks(); toast('Blokir dibuka.'); } catch (e) { toast(e.message, true); }
        } })
      )
    )));
  }

  function blockPreview() {
    const st = $('#b-start').value, en = $('#b-end').value, p = $('#b-preview');
    if (!st || !en) { p.textContent = 'Pilih tanggal. "Sampai tanggal" ikut diblokir.'; return; }
    if (en < st) { p.textContent = 'Tanggal "sampai" harus sama atau setelah tanggal "dari".'; return; }
    const n = Math.round((parse(en) - parse(st)) / 86400000) + 1;
    p.textContent = `Akan memblokir ${fmt(st)} sampai ${fmt(en)} (${n} malam).`;
  }
  $('#b-start').addEventListener('change', () => {
    if (!$('#b-end').value || $('#b-end').value < $('#b-start').value) $('#b-end').value = $('#b-start').value;
    blockPreview();
  });
  $('#b-end').addEventListener('change', blockPreview);
  $('#b-start').min = $('#b-end').min = todayWIB();

  $('#block-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const st = $('#b-start').value, en = $('#b-end').value;
    try {
      await api('/blocks', 'POST', { start: st, end: en, note: $('#b-note').value });
      e.target.reset();
      blockPreview();
      // Pindahkan kalender ke bulan yang baru diblokir supaya hasilnya langsung terlihat.
      const [y, m] = st.split('-').map(Number);
      S.month = { y, m: m - 1 };
      await loadBookings(); renderCal(); renderDay(); renderBlocks();
      toast(`Diblokir: ${fmt(st)} sampai ${fmt(en)}.`);
    } catch (err) { toast(err.message, true); }
  });

  $('#manual-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/bookings', 'POST', {
        name: $('#m-name').value, phone: $('#m-phone').value, check_in: $('#m-in').value, check_out: $('#m-out').value,
        guests: Number($('#m-guests').value), total: $('#m-total').value, note: $('#m-note').value,
        marketer_id: $('#m-marketer').value || undefined,
      });
      e.target.reset();
      $('#m-guests').value = 2;
      await loadBookings(); renderCal(); renderDay();
      toast('Booking manual disimpan.');
    } catch (err) { toast(err.message, true); }
  });

  // ---------- Pengaturan ----------
  const SETTING_IDS = ['admin_wa', 'wa_provider', 'waha_url', 'waha_session', 'payment_info', 'dp_percent', 'pending_hours', 'checkin_time', 'checkout_time', 'rules', 'property_name', 'address', 'confirm_to', 'commission_percent'];
  const SECRET_IDS = ['waha_api_key', 'fonnte_token'];

  function waStateText() {
    return S.waProvider === 'none'
      ? 'Pengiriman WhatsApp otomatis belum aktif. Pesan tetap dicatat, dan Anda bisa mengirimnya lewat tombol WhatsApp. Atur penyedia di menu Pengaturan.'
      : `Pengiriman WhatsApp otomatis aktif lewat ${S.waProvider.toUpperCase()}.`;
  }

  function showWaFields() {
    const p = $('#s-wa_provider').value;
    $('#wa-waha').hidden = p !== 'waha';
    $('#wa-fonnte').hidden = p !== 'fonnte';
    $('#wa-check').disabled = p === 'none';
    $('#wa-test').disabled = p === 'none';
  }
  $('#s-wa_provider').addEventListener('change', showWaFields);

  function waResult(text, kind) {
    const r = $('#wa-result');
    r.textContent = text;
    r.className = 'catatan' + (kind ? ' ' + kind : '');
  }

  $('#wa-check').addEventListener('click', async () => {
    waResult('Memeriksa...');
    try {
      const d = await api('/wa/status');
      waResult(d.message + (d.number ? `\nAkun pengirim: +${d.number}${d.name ? ' (' + d.name + ')' : ''}` : '') + (d.warning ? `\n${d.warning}` : ''), d.ok && !d.warning ? 'ok' : 'bad');
    } catch (e) { waResult(e.message, 'bad'); }
  });

  $('#wa-test').addEventListener('click', async () => {
    waResult('Mengirim pesan uji...');
    try {
      const d = await api('/wa/test', 'POST', {});
      const lines = d.results.map((r) => (r.ok ? `+${r.phone}: terkirim` : `+${r.phone}: gagal, ${r.error}`));
      waResult(lines.join('\n'), d.results.every((r) => r.ok) ? 'ok' : 'bad');
    } catch (e) { waResult(e.message, 'bad'); }
  });

  function unitBlock(u) {
    const f = (key, label, type = 'text', extra = {}) => el('div', { class: 'field' }, el('label', { for: `u${u.id}-${key}`, text: label }), el('input', { id: `u${u.id}-${key}`, type, value: u[key], ...extra }));
    return el('div', { class: 'unit-block', 'data-unit': String(u.id) },
      f('name', 'Nama unit'),
      el('p', { class: 'catatan', text: 'Harga diatur di menu Harga.' }),
      el('div', { class: 'two' }, f('base_capacity', 'Kapasitas normal (orang)', 'number', { min: 1 }), f('max_capacity', 'Kapasitas maksimal (orang)', 'number', { min: 1 })),
      el('div', { class: 'field' }, el('label', { for: `u${u.id}-description`, text: 'Isi rumah' }), el('textarea', { id: `u${u.id}-description`, rows: 10, text: u.description }), el('small', { text: 'Satu baris satu item. Baris yang diawali "# " menjadi judul lantai.' }))
    );
  }

  async function loadSettings() {
    try {
      const data = await api('/settings');
      S.settings = data.settings; S.units = data.units; S.waProvider = data.wa_provider;
      for (const k of SETTING_IDS) $('#s-' + k).value = data.settings[k] ?? '';
      $('#s-show_prices').checked = data.settings.show_prices !== '0';
      for (const k of SECRET_IDS) {
        $('#s-' + k).value = '';
        const sec = data.secrets?.[k];
        $('#h-' + k).textContent = sec?.set ? `Sudah tersimpan (berakhir ...${sec.hint}). Kosongkan jika tidak ingin mengubah.` : 'Belum diisi.';
      }
      showWaFields();
      $('#units').replaceChildren(...data.units.map(unitBlock));
      $('#bar-name').textContent = data.settings.property_name;
    } catch (e) { toast(e.message, true); }
  }

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const settings = {};
    for (const k of SETTING_IDS) settings[k] = $('#s-' + k).value;
    settings.show_prices = $('#s-show_prices').checked;
    for (const k of SECRET_IDS) if ($('#s-' + k).value.trim()) settings[k] = $('#s-' + k).value.trim();
    const units = $$('.unit-block').map((blk) => {
      const id = Number(blk.dataset.unit);
      const g = (k) => $(`#u${id}-${k}`).value;
      return { id, name: g('name'), base_capacity: g('base_capacity'), max_capacity: g('max_capacity'), description: g('description') };
    });
    try {
      await api('/settings', 'PUT', { settings, units });
      toast('Pengaturan disimpan.');
      loadSettings();
    } catch (err) { toast(err.message, true); }
  });

  // ---------- Tindak lanjut ----------
  function commissionLine(b) {
    if (b.commission == null || b.status !== 'approved') return null;
    const pct = `Komisi ${b.marketer_name} (${b.commission_percent}%): ${rupiah(b.commission)}`;
    if (b.commission_paid_at) return el('p', { class: 'komisi paid', text: `${pct}, dibayar ${when(b.commission_paid_at)}` });
    return el('p', { class: 'komisi', text: b.check_out <= todayWIB() ? `${pct}, siap dibayar` : `${pct}, dibayar setelah tamu check-out ${fmt(b.check_out)}` });
  }

  function commissionWaMsg(b) {
    return `Assalamu'alaikum ${b.marketer_name}, komisi booking ${b.code} (tamu ${b.name}, ${fmt(b.check_in)} sampai ${fmt(b.check_out)}) sebesar ${rupiah(b.amount)} sudah kami kirim. Jazakumullah khairan.`;
  }

  function inboxGroup(title, hint, cards, emptyText) {
    return el('div', { class: 'inbox-group' },
      el('h2', { text: title }),
      hint ? el('p', { class: 'catatan', text: hint }) : null,
      cards.length ? cards : el('p', { class: 'empty', text: emptyText })
    );
  }

  function inboxCard(b, kind) {
    const top = el('div', { class: 'card-top' }, el('span', { class: 'code', text: b.code }), el('span', { class: 'meta', text: `${fmt(b.check_in)} sampai ${fmt(b.check_out)}` }));
    if (kind === 'due' || kind === 'waiting') {
      const btns = el('div', { class: 'btns' });
      if (kind === 'due') {
        btns.append(el('button', { type: 'button', class: 'btn', text: 'Sudah dibayar', onclick: async () => {
          if (!confirm(`Tandai komisi ${b.marketer_name} sebesar ${rupiah(b.amount)} sudah dibayar?`)) return;
          try { await api(`/bookings/${b.id}/commission-paid`, 'POST'); toast('Komisi ditandai sudah dibayar.'); await loadBookings(); await loadInbox(); } catch (e) { toast(e.message, true); }
        } }));
        if (b.marketer_phone) btns.append(el('a', { class: 'btn line', href: `https://wa.me/${b.marketer_phone}?text=${encodeURIComponent(commissionWaMsg(b))}`, target: '_blank', rel: 'noopener', text: 'Kabari pemasar lewat WhatsApp' }));
      }
      return el('article', { class: `card ${kind === 'due' ? 'due' : 'quiet'}` }, top,
        el('p', { class: 'who', text: `${b.marketer_name}: ${rupiah(b.amount)}` }),
        el('p', { class: 'meta', text: `Tamu ${b.name}, total ${rupiah(b.total)}, komisi ${b.commission_percent}%${b.marketer_phone ? `, WA +${b.marketer_phone}` : ', pemasar belum punya nomor WA'}` }),
        kind === 'due' ? el('p', { class: 'meta rek' }, b.bank ? [`Transfer ke ${b.bank.name} `, el('strong', { text: b.bank.account }), b.bank.holder ? ` a.n. ${b.bank.holder}` : '', ' '] : 'Rekening pemasar belum diisi (isi di tab Pemasar).', b.bank ? el('button', { type: 'button', class: 'btn line mini', text: 'Salin no. rekening', onclick: () => navigator.clipboard?.writeText(b.bank.account.replace(/\D/g, '')).then(() => toast('Nomor rekening disalin.')).catch(() => toast(`Nomor rekening: ${b.bank.account}`)) }) : null) : null,
        btns);
    }
    const btns = el('div', { class: 'btns' }, el('button', { type: 'button', class: 'btn', text: kind === 'pending' ? 'Buka dan proses' : 'Lihat booking', onclick: () => { S.filter = kind === 'pending' ? 'pending' : 'approved'; S.highlight = String(b.id); setTab('booking'); } }));
    return el('article', { class: 'card' }, top,
      el('p', { class: 'who', text: b.name }),
      el('p', { class: 'meta', text: `${b.nights} malam, ${b.guests} orang, total ${rupiah(b.total)}${b.marketer_name ? `, pemasar ${b.marketer_name}` : ''}` }),
      btns);
  }

  function renderInbox() {
    const d = S.inbox;
    if (!d) return;
    $('#inbox').replaceChildren(
      inboxGroup('Komisi siap dibayar', `Tamu sudah selesai menginap. Komisi ${d.commission_percent}% dari total.`, d.commission_due.map((b) => inboxCard(b, 'due')), 'Tidak ada komisi yang perlu dibayar.'),
      inboxGroup('Booking menunggu konfirmasi', 'Cek DP lalu terima atau tolak.', d.pending.map((b) => inboxCard(b, 'pending')), 'Tidak ada booking yang menunggu.'),
      inboxGroup('Tamu check-in hari ini dan besok', null, d.soon.map((b) => inboxCard(b, 'soon')), 'Tidak ada tamu yang akan check-in.'),
      d.commission_waiting.length ? inboxGroup('Komisi menunggu tamu selesai menginap', 'Belum bisa dibayar karena tamu belum check-out dan booking masih bisa dibatalkan.', d.commission_waiting.map((b) => inboxCard(b, 'waiting')), '') : null
    );
  }

  async function loadInbox() {
    const d = await api('/inbox');
    S.inbox = d;
    const badge = $('#n-inbox');
    badge.hidden = d.count === 0;
    badge.textContent = String(d.count);
    document.title = (d.count ? `(${d.count}) ` : '') + (document.title || '').replace(/^\(\d+\)\s*/, '');
    if (S.tab === 'tindak') renderInbox();
  }

  // ---------- Jendela (edit, pembayaran) ----------
  function openModal(title, ...nodes) {
    $('#modal-title').textContent = title;
    $('#modal-body').replaceChildren(...nodes);
    $('#modal').hidden = false;
  }
  function closeModal() { $('#modal').hidden = true; $('#modal-body').replaceChildren(); }
  $('#modal-x').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

  const field = (id, label, input, hint) => el('div', { class: 'field' }, el('label', { for: id, text: label }), input, hint ? el('small', { text: hint }) : null);
  const digits = (v) => String(v ?? '').replace(/\D/g, '');

  function editModal(b) {
    const inp = (id, props) => el('input', { id, ...props });
    const mk = el('select', { id: 'ed-marketer' }, el('option', { value: '', text: 'Tanpa pemasar' }),
      ...S.marketers.filter((m) => m.active || m.id === b.marketer_id).map((m) => el('option', { value: String(m.id), text: m.name + (m.active ? '' : ' (nonaktif)') })));
    mk.value = b.marketer_id ? String(b.marketer_id) : '';
    const f = {
      name: inp('ed-name', { value: b.name, maxlength: 80, required: true }),
      phone: inp('ed-phone', { value: b.phone ? `0${b.phone.replace(/^62/, '')}` : '', type: 'tel', inputmode: 'tel' }),
      guests: inp('ed-guests', { value: String(b.guests), type: 'number', min: 1 }),
      total: inp('ed-total', { value: String(b.total), inputmode: 'numeric' }),
      dp: inp('ed-dp', { value: String(b.dp_amount), inputmode: 'numeric' }),
      note: el('textarea', { id: 'ed-note', rows: 3, maxlength: 300, text: b.note }),
    };
    const form = el('form', {},
      el('p', { class: 'catatan', text: `${b.code}, ${fmt(b.check_in)} sampai ${fmt(b.check_out)}. Tanggal tidak bisa diubah di sini. Batalkan lalu buat booking baru bila tanggalnya berubah.` }),
      field('ed-name', 'Nama', f.name), field('ed-phone', 'WhatsApp', f.phone),
      el('div', { class: 'two' }, field('ed-guests', 'Jumlah tamu', f.guests), field('ed-marketer', 'Pemasar', mk)),
      el('div', { class: 'two' }, field('ed-total', 'Total (Rp)', f.total), field('ed-dp', 'DP yang diminta (Rp)', f.dp)),
      field('ed-note', 'Catatan', f.note),
      el('button', { class: 'btn', type: 'submit', text: 'Simpan perubahan' })
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/bookings/${b.id}`, 'PATCH', { name: f.name.value, phone: f.phone.value, guests: f.guests.value, total: digits(f.total.value), dp_amount: digits(f.dp.value), note: f.note.value, marketer_id: mk.value });
        closeModal(); toast('Data booking disimpan.');
        await loadBookings(); renderBookings();
      } catch (err) { toast(err.message, true); }
    });
    openModal('Ubah data booking', form);
  }

  function refundModal(b, action) {
    const verb = action === 'reject' ? 'Tolak' : 'Batalkan';
    const amount = el('input', { id: 'rf-amount', inputmode: 'numeric', value: '0' });
    const reason = el('input', { id: 'rf-reason', maxlength: 200, placeholder: 'Boleh dikosongkan' });
    const keep = el('p', { class: 'meta' });
    const upd = () => { const n = Number(digits(amount.value)) || 0; keep.textContent = n > b.paid ? 'Melebihi uang yang diterima.' : n === b.paid ? 'Semua uang dikembalikan, tidak ada DP yang ditahan.' : n === 0 ? `Tidak ada pengembalian. ${rupiah(b.paid)} ditahan sebagai pemasukan (DP hangus).` : `${rupiah(n)} dikembalikan, ${rupiah(b.paid - n)} ditahan sebagai pemasukan.`; };
    amount.addEventListener('input', upd); upd();
    const quick = el('div', { class: 'btns-row' },
      el('button', { type: 'button', class: 'btn line mini', text: 'Tidak dikembalikan', onclick: () => { amount.value = '0'; upd(); } }),
      el('button', { type: 'button', class: 'btn line mini', text: 'Kembalikan semua', onclick: () => { amount.value = String(b.paid); upd(); } }),
      el('button', { type: 'button', class: 'btn line mini', text: 'Kembalikan separuh', onclick: () => { amount.value = String(Math.floor(b.paid / 2)); upd(); } }));
    const form = el('form', {},
      el('p', { class: 'catatan', text: `${b.code} atas nama ${b.name}. Uang yang sudah diterima: ${rupiah(b.paid)}.` }),
      field('rf-amount', 'Dikembalikan ke customer (Rp)', amount, 'Isi 0 bila DP tidak dikembalikan. Jumlah ini dicatat sebagai uang keluar.'),
      quick, keep,
      field('rf-reason', action === 'reject' ? 'Alasan menolak' : 'Keterangan pembatalan', reason, 'Ikut dikirim ke customer lewat WhatsApp.'),
      el('button', { class: `btn ${action === 'reject' ? 'danger' : ''}`, type: 'submit', text: `${verb} booking` })
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const n = Number(digits(amount.value)) || 0;
      if (n > b.paid) { toast('Pengembalian melebihi uang yang diterima.', true); return; }
      try {
        const data = await api(`/bookings/${b.id}/${action}`, 'POST', { reason: reason.value, refund: String(n) });
        closeModal();
        await loadBookings(); renderBookings();
        toast(data.wa_provider === 'none' && b.phone ? 'Berhasil. WhatsApp otomatis belum aktif, kirim pesannya lewat tombol WhatsApp di kartu booking.' : `Booking ${action === 'reject' ? 'ditolak' : 'dibatalkan'}${n ? `, pengembalian ${rupiah(n)} dicatat` : ''}.`);
      } catch (err) { toast(err.message, true); }
    });
    openModal(`${verb} booking yang sudah dibayar`, form);
  }

  async function paymentsModal(b) {
    let d;
    try { d = await api(`/bookings/${b.id}/payments`); } catch (err) { toast(err.message, true); return; }
    const sisa = Math.max(0, d.total - d.paid);
    const amount = el('input', { id: 'pay-amount', inputmode: 'numeric', placeholder: 'Jumlah (Rp)', value: sisa ? String(sisa) : '' });
    const date = el('input', { id: 'pay-date', type: 'date', value: todayWIB() });
    const note = el('input', { id: 'pay-note', maxlength: 120, placeholder: 'Misalnya: transfer BSI, pelunasan' });
    const list = d.payments.length
      ? el('ul', { class: 'pay-list' }, d.payments.map((p) => el('li', {},
          el('span', {}, `${fmt(p.paid_at)}: `, el('strong', { text: p.amount < 0 ? `Keluar ${rupiah(-p.amount)}` : rupiah(p.amount) }), p.note ? ` (${p.note})` : ''),
          el('span', { class: 'btns-row' },
            el('button', { type: 'button', class: 'btn line mini', text: 'Edit', onclick: () => {
              editCashEntryModal({
                source: 'payment',
                ref_id: p.id,
                title: p.amount < 0 ? 'Edit Pengembalian Dana' : 'Edit Pembayaran Masuk',
                amount: Math.abs(p.amount),
                date: p.paid_at,
                note: p.note,
                onSaved: () => paymentsModal(b),
              });
            } }),
            el('button', { type: 'button', class: 'btn danger mini', text: 'Hapus', onclick: async () => {
              if (!confirm(`Hapus catatan pembayaran ${rupiah(p.amount)}?`)) return;
              try { await api(`/payments/${p.id}`, 'DELETE'); await loadBookings(); renderBookings(); paymentsModal(b); } catch (err) { toast(err.message, true); }
            } })
          ))))
      : el('p', { class: 'empty', text: 'Belum ada pembayaran tercatat.' });
    const form = el('form', {},
      el('h3', { text: 'Tambah pembayaran' }),
      field('pay-amount', 'Jumlah diterima (Rp)', amount, 'Terisi otomatis dengan sisa tagihan. Ubah bila customer membayar sebagian atau DP lebih dari yang diminta.'),
      el('div', { class: 'two' }, field('pay-date', 'Tanggal', date), field('pay-note', 'Catatan', note)),
      el('button', { class: 'btn', type: 'submit', text: 'Simpan pembayaran' })
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/bookings/${b.id}/payments`, 'POST', { amount: digits(amount.value), paid_at: date.value, note: note.value });
        toast('Pembayaran dicatat.');
        await loadBookings(); renderBookings(); paymentsModal(b);
      } catch (err) { toast(err.message, true); }
    });
    const rfAmount = el('input', { id: 'rfp-amount', inputmode: 'numeric', placeholder: 'Jumlah (Rp)', value: d.paid > 0 ? String(d.paid) : '' });
    const rfNote = el('input', { id: 'rfp-note', maxlength: 120, placeholder: 'Misalnya: transfer balik ke BSI' });
    const rfForm = el('form', {},
      el('h3', { text: 'Catat pengembalian dana' }),
      field('rfp-amount', 'Jumlah dikembalikan (Rp)', rfAmount, 'Uang keluar ke customer. Tidak bisa melebihi uang yang diterima.'),
      field('rfp-note', 'Catatan', rfNote),
      el('button', { class: 'btn line', type: 'submit', text: 'Simpan pengembalian' })
    );
    rfForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/bookings/${b.id}/refunds`, 'POST', { amount: digits(rfAmount.value), note: rfNote.value });
        toast('Pengembalian dicatat.');
        await loadBookings(); renderBookings(); paymentsModal(b);
      } catch (err) { toast(err.message, true); }
    });
    const open_ = b.status === 'pending' || b.status === 'approved';
    openModal(`Pembayaran ${b.code}`,
      el('p', { class: 'meta', text: `${b.name}${b.marketer_name ? `, pemasar ${b.marketer_name}` : ''}` }),
      el('div', { class: 'pay-sum' }, el('span', { text: `Total ${rupiah(d.total)}` }), el('span', { text: `DP diminta ${rupiah(d.dp_amount)}` }),
        el('strong', { text: `Tercatat ${rupiah(d.paid)}` }), open_ ? el('span', { text: sisa ? `Sisa ${rupiah(sisa)}` : 'Lunas' }) : null),
      list, open_ ? form : null, d.paid > 0 ? rfForm : null);
  }

  async function extendHold(b) {
    const v = prompt(`Perpanjang masa tunggu ${b.code} berapa jam? (24 = 1 hari, 72 = 3 hari)\nDihitung dari batas saat ini: ${when(b.hold_until_eff)}.`, '24');
    if (v === null) return;
    try {
      const r = await api(`/bookings/${b.id}/extend`, 'POST', { hours: v });
      toast(`Tanggal ditahan sampai ${when(r.hold_until)}.`);
      await loadBookings(); renderBookings();
    } catch (err) { toast(err.message, true); }
  }

  // ---------- Keuangan & Pembukuan Kas ----------
  const monthLabel = (m) => (m === 'all' ? 'Semua waktu' : new Date(m + '-01T00:00:00Z').toLocaleString('id-ID', { timeZone: 'UTC', month: 'long', year: 'numeric' }));

  function editCashEntryModal({ source, ref_id, title, amount, date, note, onSaved }) {
    const inpAmount = el('input', { id: 'ce-amount', inputmode: 'numeric', value: String(amount), required: true });
    const inpDate = el('input', { id: 'ce-date', type: 'date', value: date, required: true });
    const inpNote = el('input', { id: 'ce-note', maxlength: 160, value: note || '' });
    const form = el('form', {},
      field('ce-amount', 'Nominal (Rp)', inpAmount),
      field('ce-date', 'Tanggal transaksi', inpDate),
      field('ce-note', 'Keterangan / Catatan', inpNote),
      el('button', { class: 'btn', type: 'submit', text: 'Simpan perubahan' })
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const endpoint = source === 'payment' ? `/payments/${ref_id}` : `/expenses/${ref_id}`;
        await api(endpoint, 'PATCH', {
          amount: digits(inpAmount.value),
          ...(source === 'payment' ? { paid_at: inpDate.value } : { spent_at: inpDate.value }),
          note: inpNote.value,
        });
        closeModal();
        toast('Data keuangan berhasil diperbarui.');
        await loadBookings();
        if (S.tab === 'booking') renderBookings();
        if (S.tab === 'keuangan') await loadReport();
        if (onSaved) onSaved();
      } catch (err) { toast(err.message, true); }
    });
    openModal(title, form);
  }

  async function loadReport() {
    try {
      const month = $('#rp-month').value || todayWIB().slice(0, 7);
      const [r, cb] = await Promise.all([
        api(`/report?month=${month}`),
        api(`/cashbook?month=${month}`),
      ]);
      const sel = $('#rp-month');
      const opts = ['all', ...new Set([todayWIB().slice(0, 7), ...r.months])].sort((x, y) => (x === 'all' ? -1 : y === 'all' ? 1 : y.localeCompare(x)));
      sel.replaceChildren(...opts.map((m) => el('option', { value: m, text: monthLabel(m) })));
      sel.value = r.month;
      renderCashbook(cb);
      renderReport(r);
      loadExpenses().catch(() => {});
    } catch (err) { toast(err.message, true); }
  }
  $('#rp-month').addEventListener('change', loadReport);

  function renderCashbook(cb) {
    const row = (k, v, strong) => [el('dt', { text: k }), el('dd', { class: strong ? 'strong' : '', text: v })];
    $('#cashbook-summary').replaceChildren(
      el('article', { class: 'card rp-card' },
        el('h3', { text: 'Saldo Kas Riil Saat Ini' }),
        el('dl', { class: 'rp-grid' },
          row('Saldo Kas Riil (Keseluruhan)', rupiah(cb.current_balance), true),
          row('Total Uang Masuk (Semua waktu)', rupiah(cb.total_in_all)),
          row('Total Uang Keluar (Semua waktu)', rupiah(cb.total_out_all)),
          cb.month !== 'all' ? [
            row(`Masuk (${monthLabel(cb.month)})`, rupiah(cb.period_in)),
            row(`Keluar (${monthLabel(cb.month)})`, rupiah(cb.period_out)),
            row(`Selisih Kas (${monthLabel(cb.month)})`, rupiah(cb.period_net), true),
          ] : ''
        )
      )
    );

    const list = $('#cashbook-list');
    if (!cb.entries.length) {
      list.replaceChildren(el('p', { class: 'empty', text: 'Belum ada mutasi kas pada periode ini.' }));
      return;
    }
    list.replaceChildren(...cb.entries.map((item) => {
      const isIn = item.type === 'in';
      const btns = el('div', { class: 'btns' });
      if (item.editable) {
        btns.append(el('button', {
          type: 'button', class: 'btn line mini', text: 'Edit nominal / tanggal',
          onclick: () => editCashEntryModal({
            source: item.source,
            ref_id: item.ref_id,
            title: item.title,
            amount: item.amount,
            date: item.date,
            note: item.subtitle,
          }),
        }));
      }
      if (item.source === 'payment') {
        btns.append(el('button', {
          type: 'button', class: 'btn danger mini', text: 'Hapus',
          onclick: async () => {
            if (!confirm(`Hapus catatan transaksi ${item.title} sebesar ${rupiah(item.amount)}?`)) return;
            try { await api(`/payments/${item.ref_id}`, 'DELETE'); toast('Transaksi pembayaran dihapus.'); await loadBookings(); await loadReport(); }
            catch (err) { toast(err.message, true); }
          },
        }));
      } else if (item.source === 'cash_income') {
        btns.append(el('button', {
          type: 'button', class: 'btn danger mini', text: 'Hapus',
          onclick: async () => {
            if (!confirm(`Hapus pemasukan kas ${rupiah(item.amount)}?`)) return;
            try { await api(`/cash-incomes/${item.ref_id}`, 'DELETE'); toast('Pemasukan kas dihapus.'); await loadReport(); }
            catch (err) { toast(err.message, true); }
          },
        }));
      } else if (item.source === 'expense') {
        btns.append(el('button', {
          type: 'button', class: 'btn danger mini', text: 'Hapus',
          onclick: async () => {
            if (!confirm(`Hapus pengeluaran ${rupiah(item.amount)}?`)) return;
            try { await api(`/expenses/${item.ref_id}`, 'DELETE'); toast('Pengeluaran dihapus.'); await loadReport(); }
            catch (err) { toast(err.message, true); }
          },
        }));
      }

      return el('article', { class: 'card' },
        el('div', { class: 'card-top' },
          el('span', {},
            el('span', { class: `chip ${isIn ? 'approved' : 'cancelled'}`, text: isIn ? '+ MASUK' : '- KELUAR' }),
            ' ',
            el('strong', { text: rupiah(item.amount) })
          ),
          el('span', { class: 'meta', text: fmt(item.date) })
        ),
        el('p', { class: 'who', text: item.title }),
        item.subtitle ? el('p', { class: 'meta', text: item.subtitle }) : null,
        el('p', { class: 'meta', text: `Saldo kas setelah transaksi: ${rupiah(item.balance)}` }),
        btns.children.length ? btns : null
      );
    }));
  }

  function renderReport(r) {
    const row = (k, v, strong) => [el('dt', { text: k }), el('dd', { class: strong ? 'strong' : '', text: v })];
    const t = r.totals;
    const card = (title, g, extra) => el('article', { class: 'card rp-card' }, el('h3', { text: title }),
      el('dl', { class: 'rp-grid' },
        row('Booking diterima', `${g.bookings} (${g.nights} malam)`), row('Nilai booking', rupiah(g.value), true),
        row('Uang diterima', rupiah(g.received)), row('Belum dibayar', rupiah(g.outstanding)),
        g.forfeited ? [row('DP hangus (booking batal)', rupiah(g.forfeited)), row('Total pemasukan', rupiah(g.received + g.forfeited), true)] : '',
        r.commission_percent > 0 && g.commission != null ? [row(`Komisi ${r.commission_percent}%`, rupiah(g.commission)), row('Komisi sudah dibayar', rupiah(g.commission_paid)), row('Setelah komisi', rupiah(g.net), true)] : '',
        g.share ? row('Bagian DP hangus untuk pemasar', rupiah(g.share)) : '',
        g.other_expenses ? row('Pengeluaran lain', rupiah(g.other_expenses)) : '',
        g.share || g.other_expenses || g.forfeited ? row('Perkiraan bersih', rupiah(g.income_net), true) : ''),
      extra);
    const rows = r.rows;
    $('#report').replaceChildren(
      card(`Total ${monthLabel(r.month)}`, t),
      el('h3', { text: 'Per pemasar', style: 'margin-top:1rem' }),
      ...(rows.length ? rows.map((g) => card(g.name, g)) : [el('p', { class: 'empty', text: 'Belum ada booking diterima pada periode ini.' })])
    );
  }

  // ---------- Form Pemasukan Kas & Pengeluaran ----------
  let forfeitedList = [];

  function syncExForm() {
    const share = $('#ex-kind').value === 'marketer_share';
    $('#ex-booking-field').hidden = !share;
    $('#ex-note').placeholder = share ? 'Boleh dikosongkan' : 'Wajib diisi, misalnya: laundry sprei, token listrik';
    const sel = $('#ex-booking');
    const b = forfeitedList.find((x) => String(x.id) === sel.value);
    $('#ex-hint').textContent = b ? `${b.marketer_name}: DP hangus ${rupiah(b.kept)}, sudah dibagikan ${rupiah(b.shared)}, sisa ${rupiah(b.kept - b.shared)}.` : 'Belum ada booking batal dengan DP hangus yang punya pemasar.';
  }

  async function loadExpenses() {
    const { bookings } = await api('/forfeited');
    forfeitedList = bookings.filter((b) => b.kept - b.shared > 0);
    const sel = $('#ex-booking');
    const prev = sel.value;
    sel.replaceChildren(...forfeitedList.map((b) => el('option', { value: String(b.id), text: `${b.code}, ${b.name} (pemasar ${b.marketer_name}), sisa ${rupiah(b.kept - b.shared)}` })));
    if (forfeitedList.some((b) => String(b.id) === prev)) sel.value = prev;
    if (!$('#ex-date').value) $('#ex-date').value = todayWIB();
    if (!$('#ci-date').value) $('#ci-date').value = todayWIB();
    syncExForm();
  }

  $('#cash-in-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/cash-incomes', 'POST', {
        amount: digits($('#ci-amount').value),
        received_at: $('#ci-date').value || todayWIB(),
        note: $('#ci-note').value,
      });
      $('#ci-amount').value = '';
      $('#ci-note').value = '';
      toast('Pemasukan kas dicatat.');
      await loadReport();
    } catch (err) { toast(err.message, true); }
  });

  $('#ex-kind').addEventListener('change', syncExForm);
  $('#ex-booking').addEventListener('change', syncExForm);
  $('#ex-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const share = $('#ex-kind').value === 'marketer_share';
    try {
      await api('/expenses', 'POST', { kind: $('#ex-kind').value, booking_id: share ? $('#ex-booking').value : undefined, amount: digits($('#ex-amount').value), spent_at: $('#ex-date').value, note: $('#ex-note').value });
      $('#ex-amount').value = ''; $('#ex-note').value = '';
      toast('Pengeluaran kas dicatat.');
      await loadReport();
    } catch (err) { toast(err.message, true); }
  });

  // ---------- Cadangan ----------
  const sizeLabel = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  async function afterRestore(r) {
    toast(`Data dipulihkan (${r.bookings} booking). Data sebelumnya disimpan sebagai ${r.safety}. Memuat ulang...`);
    setTimeout(() => location.reload(), 1500);
  }
  async function confirmRestore(what) {
    const t = prompt(`Pulihkan data dari ${what}?\n\nSemua data sekarang akan diganti. Data sekarang disimpan dulu sebagai cadangan "sebelum-restore".\n\nKetik PULIHKAN untuk melanjutkan:`);
    return t !== null && t.trim().toUpperCase() === 'PULIHKAN';
  }

  async function loadBackups() {
    try {
      const { backups } = await api('/backups');
      const box = $('#bk-list');
      if (!backups.length) { box.replaceChildren(el('p', { class: 'empty', text: 'Belum ada cadangan di server.' })); return; }
      box.replaceChildren(...backups.map((b) => el('article', { class: 'card' },
        el('div', { class: 'card-top' }, el('strong', { text: b.name }), el('span', { class: 'chip', text: b.kind })),
        el('p', { class: 'meta', text: `${when(b.modified)}, ${sizeLabel(b.size)}` }),
        el('div', { class: 'btns' },
          el('a', { class: 'btn line mini', href: `/api/admin/backups/${encodeURIComponent(b.name)}`, download: b.name, text: 'Unduh' }),
          el('button', { type: 'button', class: 'btn danger mini', text: 'Pulihkan', onclick: async () => {
            if (!(await confirmRestore(b.name))) return;
            try { afterRestore(await api(`/backups/${encodeURIComponent(b.name)}/restore`, 'POST')); } catch (e) { toast(e.message, true); }
          } }),
          el('button', { type: 'button', class: 'btn line mini', text: 'Hapus', onclick: async () => {
            if (!confirm(`Hapus ${b.name} dari server?`)) return;
            try { await api(`/backups/${encodeURIComponent(b.name)}`, 'DELETE'); loadBackups(); } catch (e) { toast(e.message, true); }
          } })
        ))));
    } catch (e) { toast(e.message, true); }
  }

  $('#bk-download').addEventListener('click', () => setTimeout(loadBackups, 1500));
  $('#bk-restore').addEventListener('click', async () => {
    const f = $('#bk-file').files[0];
    if (!f) { toast('Pilih file cadangan (.db) dulu.', true); return; }
    const post = (path) => fetch('/api/admin' + path, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Gagal.'); return d; });
    try {
      const info = await post('/restore?check=1');
      if (!(await confirmRestore(`${f.name} (${info.bookings} booking, ${info.marketers} pemasar)`))) return;
      afterRestore(await post('/restore'));
    } catch (e) { toast(e.message, true); }
  });

  // ---------- Pemasar ----------
  async function loadMarketers() {
    const { marketers, commission_percent } = await api('/marketers');
    S.marketers = marketers;
    S.commissionPct = commission_percent;
    // Pilihan pemasar di form booking manual (hanya yang aktif).
    $('#m-marketer').replaceChildren(el('option', { value: '', text: 'Tanpa pemasar' }),
      ...marketers.filter((m) => m.active).map((m) => el('option', { value: String(m.id), text: m.name })));
    renderMarketers();
  }

  async function copyText(text, input) {
    try { await navigator.clipboard.writeText(text); toast('Tautan disalin.'); }
    catch { input.select(); toast('Tekan dan tahan untuk menyalin tautan.'); }
  }

  function renderMarketers() {
    const box = $('#mk-list');
    if (!S.marketers.length) { box.replaceChildren(el('p', { class: 'empty', text: 'Belum ada pemasar. Tambahkan nama pemasar di atas.' })); return; }
    box.replaceChildren(...S.marketers.map((m) => {
      const linkInput = el('input', { class: 'mk-input', readonly: true, value: m.link, 'aria-label': `Tautan ${m.name}` });
      return el('article', { class: 'card' },
        el('div', { class: 'card-top' },
          el('strong', { text: m.name }),
          el('span', {}, m.active ? el('span', { class: 'chip approved', text: 'Aktif' }) : el('span', { class: 'chip cancelled', text: 'Nonaktif' }))
        ),
        el('p', { class: 'meta', text: [m.phone ? `+${m.phone}` : 'Tanpa nomor', m.note].filter(Boolean).join(', ') }),
        el('p', { class: 'meta' }, m.bank_account ? [`${m.bank_name} `, el('strong', { text: m.bank_account }), m.bank_holder ? ` a.n. ${m.bank_holder}` : ''] : 'Rekening belum diisi'),
        el('p', { class: 'money', text: `${m.bookings} booking, ${m.approved} diterima` }),
        S.commissionPct > 0 ? el('p', { class: 'mk-money' },
          el('span', { text: `Siap dibayar ${rupiah(m.commission_due)}` }),
          el('span', { text: `Menunggu check-out ${rupiah(m.commission_waiting)}` }),
          el('span', { text: `Sudah dibayar ${rupiah(m.commission_paid)}` })) : null,
        el('div', { class: 'mk-link' }, linkInput, el('button', { type: 'button', class: 'btn line', text: 'Salin', onclick: () => copyText(m.link, linkInput) })),
        el('div', { class: 'btns' },
          el('button', { type: 'button', class: 'btn line', text: 'Ubah', onclick: async () => {
            const name = prompt('Nama pemasar:', m.name);
            if (name === null) return;
            const phone = prompt('Nomor WhatsApp (boleh dikosongkan):', m.phone ? `0${m.phone.replace(/^62/, '')}` : '');
            if (phone === null) return;
            const bank_name = prompt('Nama bank (kosongkan bila tanpa rekening):', m.bank_name || '');
            if (bank_name === null) return;
            let bank_account = '', bank_holder = '';
            if (bank_name.trim()) {
              bank_account = prompt('Nomor rekening:', m.bank_account || '');
              if (bank_account === null) return;
              bank_holder = prompt('Atas nama rekening:', m.bank_holder || m.name);
              if (bank_holder === null) return;
            }
            try { await api(`/marketers/${m.id}`, 'PUT', { name, phone, bank_name, bank_account, bank_holder }); toast('Data pemasar disimpan.'); await loadMarketers(); await loadBookings(); } catch (e) { toast(e.message, true); }
          } }),
          el('button', { type: 'button', class: 'btn line', text: m.active ? 'Nonaktifkan' : 'Aktifkan', onclick: async () => {
            if (m.active && !confirm(`Nonaktifkan ${m.name}? Namanya hilang dari pilihan dan tautan pribadinya tidak berlaku. Riwayat booking tetap ada.`)) return;
            try { await api(`/marketers/${m.id}`, 'PUT', { active: !m.active }); await loadMarketers(); } catch (e) { toast(e.message, true); }
          } }),
          m.bookings === 0 ? el('button', { type: 'button', class: 'btn danger', text: 'Hapus', onclick: async () => {
            if (!confirm(`Hapus ${m.name}?`)) return;
            try { await api(`/marketers/${m.id}`, 'DELETE'); toast('Pemasar dihapus.'); await loadMarketers(); } catch (e) { toast(e.message, true); }
          } }) : null
        )
      );
    }));
  }

  $('#mk-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/marketers', 'POST', { name: $('#mk-name').value, phone: $('#mk-phone').value, note: $('#mk-note').value, bank_name: $('#mk-bank').value, bank_account: $('#mk-account').value, bank_holder: $('#mk-holder').value });
      e.target.reset();
      toast('Pemasar ditambahkan.');
      await loadMarketers();
    } catch (err) { toast(err.message, true); }
  });

  // ---------- Harga ----------
  const DOW_FULL = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const PRESETS = ['Tanggal merah', 'Libur sekolah', 'Libur Natal dan Tahun Baru', 'Malam Tahun Baru', 'Idul Fitri', 'Idul Adha'];

  async function loadPricing() {
    try {
      S.pricing = await api('/pricing');
      renderPricing();
    } catch (e) { toast(e.message, true); }
  }

  function renderPricing() {
    const d = S.pricing;
    $('#price-hidden-note').hidden = d.show_prices !== false;
    $('#price-units').replaceChildren(...d.units.map((u) => {
      const f = (key, label, hint) => el('div', { class: 'field' },
        el('label', { for: `p${u.id}-${key}`, text: label }),
        el('input', { id: `p${u.id}-${key}`, type: 'number', min: 0, step: 1000, inputmode: 'numeric', value: u[key] || '' }),
        hint ? el('small', { text: hint }) : null);
      return el('div', { class: 'unit-block', 'data-unit': String(u.id) },
        d.units.length > 1 ? el('h3', { text: u.name }) : null,
        el('div', { class: 'two' }, f('price', 'Harga hari biasa (Rp per malam)'), f('weekend_price', 'Harga akhir pekan (Rp per malam)', 'Kosongkan bila sama dengan hari biasa.')),
        f('extra_fee', 'Biaya tamu tambahan (Rp per orang per malam)', 'Berlaku untuk tamu di atas kapasitas normal. Isi 0 bila ditentukan manual oleh admin.')
      );
    }));
    $('#weekend-days').replaceChildren(...[1, 2, 3, 4, 5, 6, 0].map((n) => el('label', {},
      el('input', { type: 'checkbox', value: String(n), checked: d.weekend_days.includes(n) }), DOW_FULL[n])));
    $('#rate-presets').replaceChildren(...PRESETS.map((p) => el('button', { type: 'button', text: p, 'aria-pressed': 'false', onclick: () => { $('#r-name').value = p; $('#r-start').focus(); } })));

    const box = $('#rates');
    box.replaceChildren(...d.rules.map((r) => el('div', { class: 'card' },
      el('div', { class: 'card-top' },
        el('strong', { text: r.name }),
        el('button', { type: 'button', class: 'btn danger', text: 'Hapus', onclick: async () => {
          if (!confirm(`Hapus aturan "${r.name}"? Tanggalnya kembali memakai harga hari biasa atau akhir pekan.`)) return;
          try { await api(`/rates/${r.id}`, 'DELETE'); toast('Aturan dihapus.'); loadPricing(); } catch (e) { toast(e.message, true); }
        } })
      ),
      el('p', { class: 'meta', text: r.start_date === r.end_date ? `Malam ${fmt(r.start_date)}` : `Malam ${fmt(r.start_date)} sampai ${fmt(r.end_date)}` }),
      el('p', { class: 'money' }, el('strong', { text: `${rupiah(r.price)} per malam` }), r.min_nights > 1 ? `, minimal ${r.min_nights} malam` : '')
    )));
    if (!d.rules.length) box.replaceChildren(el('p', { class: 'empty', text: 'Belum ada harga khusus. Tambahkan untuk tanggal merah, Tahun Baru, atau hari raya.' }));

    const base = d.units[0]?.price;
    $('#price-preview').replaceChildren(...d.preview.map((p) => el('li', { class: p.price !== base ? 'diff' : '' },
      el('span', {}, fmt(p.date), el('small', { text: p.label })),
      el('span', { text: rupiah(p.price) }))));
  }

  $('#price-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const units = $$('#price-units .unit-block').map((blk) => {
      const id = Number(blk.dataset.unit);
      const g = (k) => $(`#p${id}-${k}`).value;
      return { id, price: g('price'), weekend_price: g('weekend_price'), extra_fee: g('extra_fee') };
    });
    const weekend_days = $$('#weekend-days input:checked').map((i) => Number(i.value));
    try {
      await api('/pricing', 'PUT', { units, weekend_days });
      toast('Harga dasar disimpan.');
      loadPricing();
    } catch (err) { toast(err.message, true); }
  });

  $('#rate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/rates', 'POST', {
        name: $('#r-name').value, start: $('#r-start').value, end: $('#r-end').value,
        price: $('#r-price').value, min_nights: $('#r-min').value,
      });
      e.target.reset();
      $('#r-min').value = 1;
      toast('Aturan harga ditambahkan.');
      loadPricing();
    } catch (err) { toast(err.message, true); }
  });

  // ---------- Pesan ----------
  const KIND = { admin_new: 'Booking baru ke admin', guest_approved: 'Diterima ke penyewa', guest_rejected: 'Ditolak ke penyewa', guest_cancelled: 'Dibatalkan ke penyewa', marketer_approved: 'Diterima ke pemasar', marketer_rejected: 'Ditolak ke pemasar', marketer_cancelled: 'Dibatalkan ke pemasar', admin_commission: 'Pengingat komisi ke admin' };
  const MSG_STATUS = { sent: 'Terkirim', failed: 'Gagal', skipped: 'Belum dikirim', queued: 'Mengirim' };

  async function loadMessages() {
    try {
      const { messages, wa_provider: wp } = await api('/messages');
      S.waProvider = wp;
      $('#wa-state2').textContent = waStateText();
      const box = $('#messages');
      if (!messages.length) { box.replaceChildren(el('p', { class: 'empty', text: 'Belum ada pesan.' })); return; }
      box.replaceChildren(...messages.map((m) => el('article', { class: 'card' },
        el('div', { class: 'card-top' },
          el('strong', { text: `${KIND[m.kind] || m.kind}${m.code ? ' ' + m.code : ''}` }),
          el('span', { class: `chip ${m.status}`, text: MSG_STATUS[m.status] || m.status })
        ),
        el('p', { class: 'meta', text: `+${m.to_phone}, ${when(m.created_at)}` }),
        m.error ? el('p', { class: 'meta', text: m.error }) : null,
        el('pre', { class: 'msg-body', text: m.body }),
        el('div', { class: 'btns' },
          m.status !== 'sent' && S.waProvider !== 'none' ? el('button', { type: 'button', class: 'btn', text: 'Kirim ulang', onclick: async () => {
            try { await api(`/messages/${m.id}/retry`, 'POST', {}); loadMessages(); } catch (e) { toast(e.message, true); }
          } }) : null,
          el('a', { class: 'btn line', href: `https://wa.me/${m.to_phone}?text=${encodeURIComponent(m.body)}`, target: '_blank', rel: 'noopener', text: 'Buka di WhatsApp' })
        )
      )));
    } catch (e) { toast(e.message, true); }
  }

  // ---------- Mulai ----------
  async function start() {
    try {
      const sess = await api('/session');
      S.waProvider = sess.wa_provider;
      const warn = $('#storage-warn');
      warn.hidden = sess.storage?.persistent !== false;
      if (!warn.hidden) warn.textContent = `Peringatan: database (${sess.storage.file}) belum berada di Persistent Storage, jadi data booking hilang setiap redeploy. Samakan DATA_DIR dengan Destination Path volume di Coolify.`;
      $('#login').hidden = true;
      $('#app').hidden = false;
      await loadBookings();
      loadMarketers().catch(() => {});
      const want = new URLSearchParams(location.search).get('tab');
      const b = new URLSearchParams(location.search).get('b');
      if (b) { S.filter = 'all'; S.highlight = b; history.replaceState(null, '', location.pathname); }
      if (want) history.replaceState(null, '', location.pathname);
      setTab(want === 'tindak' ? 'tindak' : 'booking');
      setInterval(() => { if (!document.hidden) loadBookings().catch(() => {}); }, 60000);
      fetch('/api/config').then((r) => r.json()).then((c) => { $('#bar-name').textContent = c.name; }).catch(() => {});
    } catch { /* api() sudah menampilkan login bila 401 */ }
  }
  start();
})();
