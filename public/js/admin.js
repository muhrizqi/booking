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
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
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
    if (name === 'kalender') { renderCal(); renderDay(); renderBlocks(); }
    if (name === 'pemasar') loadMarketers();
    if (name === 'harga') loadPricing();
    if (name === 'pengaturan') loadSettings();
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
    return el('article', { class: 'card', 'data-id': String(b.id) },
      el('div', { class: 'card-top' },
        el('span', { class: 'code', text: b.code }),
        el('span', {}, el('span', { class: `chip ${b.status}`, text: STATUS_LABEL[b.status] }), b.expired ? el('span', { class: 'badge', text: 'lewat batas tahan' }) : null, b.source === 'manual' ? el('span', { class: 'badge', text: 'manual' }) : null)
      ),
      el('p', { class: 'who', text: b.name }),
      b.marketer_name ? el('p', { class: 'meta' }, 'Pemasar: ', el('strong', { text: b.marketer_name })) : null,
      el('p', { class: 'meta' }, b.phone ? el('a', { href: `https://wa.me/${b.phone}`, target: '_blank', rel: 'noopener', text: `+${b.phone}` }) : 'Tanpa nomor', ` , masuk ${when(b.created_at)}`),
      el('p', { class: 'money' }, `${fmt(b.check_in)} sampai ${fmt(b.check_out)}`, el('br'), `${b.nights} malam, ${b.guests} orang`, el('br'), `Total ${rupiah(b.total)}`, b.dp_amount ? `, DP ${rupiah(b.dp_amount)}` : ''),
      b.note ? el('p', { class: 'note', text: b.note }) : null,
      b.reject_reason ? el('p', { class: 'note', text: `Keterangan: ${b.reject_reason}` }) : null,
      btns
    );
  }

  async function decide(b, action) {
    let body = {};
    if (action === 'approve') {
      if (!confirm(`Terima booking ${b.code} atas nama ${b.name}?\n\nPastikan DP ${rupiah(b.dp_amount)} sudah masuk. Penyewa akan menerima WhatsApp berisi aturan check-in dan check-out.`)) return;
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

  $('#block-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/blocks', 'POST', { start: $('#b-start').value, end: $('#b-end').value, note: $('#b-note').value });
      e.target.reset();
      await loadBookings(); renderCal(); renderDay(); renderBlocks();
      toast('Tanggal diblokir.');
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
  const SETTING_IDS = ['admin_wa', 'wa_provider', 'waha_url', 'waha_session', 'payment_info', 'dp_percent', 'pending_hours', 'checkin_time', 'checkout_time', 'rules', 'property_name', 'address', 'confirm_to'];
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

  // ---------- Pemasar ----------
  async function loadMarketers() {
    const { marketers } = await api('/marketers');
    S.marketers = marketers;
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
        el('p', { class: 'money', text: `${m.bookings} booking, ${m.approved} diterima` }),
        el('div', { class: 'mk-link' }, linkInput, el('button', { type: 'button', class: 'btn line', text: 'Salin', onclick: () => copyText(m.link, linkInput) })),
        el('div', { class: 'btns' },
          el('button', { type: 'button', class: 'btn line', text: 'Ubah', onclick: async () => {
            const name = prompt('Nama pemasar:', m.name);
            if (name === null) return;
            const phone = prompt('Nomor WhatsApp (boleh dikosongkan):', m.phone ? `0${m.phone.replace(/^62/, '')}` : '');
            if (phone === null) return;
            try { await api(`/marketers/${m.id}`, 'PUT', { name, phone }); toast('Data pemasar disimpan.'); await loadMarketers(); await loadBookings(); } catch (e) { toast(e.message, true); }
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
      await api('/marketers', 'POST', { name: $('#mk-name').value, phone: $('#mk-phone').value, note: $('#mk-note').value });
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
  const KIND = { admin_new: 'Booking baru ke admin', guest_approved: 'Diterima ke penyewa', guest_rejected: 'Ditolak ke penyewa', guest_cancelled: 'Dibatalkan ke penyewa', marketer_approved: 'Diterima ke pemasar', marketer_rejected: 'Ditolak ke pemasar', marketer_cancelled: 'Dibatalkan ke pemasar' };
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
      const b = new URLSearchParams(location.search).get('b');
      if (b) { S.filter = 'all'; S.highlight = b; history.replaceState(null, '', location.pathname); }
      setTab('booking');
      fetch('/api/config').then((r) => r.json()).then((c) => { $('#bar-name').textContent = c.name; }).catch(() => {});
    } catch { /* api() sudah menampilkan login bila 401 */ }
  }
  start();
})();
