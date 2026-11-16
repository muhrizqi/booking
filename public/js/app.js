(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  const DOW_MON = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
  const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  const rupiah = (n) => 'Rp' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const parse = (s) => new Date(s + 'T00:00:00Z');
  const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const diff = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
  const fmt = (s) => { const d = parse(s); return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

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
    toastTimer = setTimeout(() => { t.textContent = ''; }, 4500);
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan. Coba lagi.');
    return data;
  }

  const scrollTo = (sel) => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    $(sel).scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };

  const S = { cfg: null, unit: null, avail: {}, ci: null, co: null, guests: 2, month: null, minMonth: null, maxMonth: null };

  // ---------- Muat data ----------
  async function loadAvailability() {
    const { nights } = await api(`/api/availability?unit=${S.unit.id}&from=${S.cfg.today}&to=${addDays(S.cfg.today, 400)}`);
    S.avail = nights;
  }

  async function init() {
    S.cfg = await api('/api/config');
    S.unit = S.cfg.units[0];
    if (!S.unit) { toast('Belum ada unit yang bisa dipesan.', true); return; }
    const [ty, tm] = S.cfg.today.split('-').map(Number);
    S.month = { y: ty, m: tm - 1 };
    S.minMonth = ty * 12 + tm - 1;
    S.maxMonth = S.minMonth + 17;
    await loadAvailability();
    renderStatic();
    renderStrip();
    renderCal();
    renderHint();
    setupForm();
    setupStatus();
  }

  // ---------- Bagian statis ----------
  function renderStatic() {
    const { cfg, unit } = S;
    document.title = cfg.name;
    $('#h-name').textContent = cfg.name;
    $('#foot-name').textContent = cfg.name;
    $('#h-price').replaceChildren(
      el('strong', { text: rupiah(unit.price) }),
      ` per malam untuk ${unit.base_capacity} orang`
    );

    const rooms = $('#rooms');
    let list = null;
    for (const raw of unit.description.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('# ')) {
        rooms.append(el('h3', { class: 'floor', text: line.slice(2) }));
        list = el('ul', { class: 'rooms' });
        rooms.append(list);
      } else {
        if (!list) { list = el('ul', { class: 'rooms' }); rooms.append(list); }
        list.append(el('li', { text: line }));
      }
    }
    const extra = unit.max_capacity - unit.base_capacity;
    const extraFee = unit.extra_fee > 0
      ? `Biaya tambahan ${rupiah(unit.extra_fee)} per orang per malam.`
      : 'Biaya untuk tamu tambahan dikonfirmasi oleh admin.';
    if (extra > 0) {
      rooms.append(el('p', { class: 'kapasitas', text: `Kapasitas ${unit.base_capacity} orang. Bisa ditambah sampai ${extra} orang lagi dengan extra bed di luar kamar atau di ruang pertemuan. ${extraFee}` }));
    }

    $('#r-times').textContent = `Check-in mulai pukul ${cfg.checkin_time} WIB. Check-out paling lambat pukul ${cfg.checkout_time} WIB.`;
    $('#rules').replaceChildren(...cfg.rules.map((r) => el('li', { text: r })));
    $('#addr').textContent = cfg.address;
    $('#maps').href = cfg.maps_url;
    if (cfg.admin_wa) {
      $('#foot-wa').replaceChildren('Ada pertanyaan? Hubungi admin di ', el('a', { href: `https://wa.me/${cfg.admin_wa}`, text: 'WhatsApp' }), '.');
    }
  }

  // ---------- Strip 14 malam di hero ----------
  function renderStrip() {
    const wrap = $('#strip');
    wrap.replaceChildren();
    for (let i = 0; i < 14; i++) {
      const d = addDays(S.cfg.today, i);
      const st = S.avail[d] || 'free';
      const dt = parse(d);
      const label = { free: 'kosong', pending: 'menunggu konfirmasi', booked: 'terisi', blocked: 'tidak tersedia' }[st];
      const showMonth = i === 0 || dt.getUTCDate() === 1;
      wrap.append(
        el('button', {
          type: 'button', class: `tile ${st}`, disabled: st !== 'free',
          'aria-label': `${fmt(d)}, ${label}`,
          onclick: () => { startAt(d); scrollTo('#tanggal'); },
        }, el('small', { text: showMonth ? `${DAYS[dt.getUTCDay()]} ${MON[dt.getUTCMonth()]}` : DAYS[dt.getUTCDay()] }), el('b', { text: String(dt.getUTCDate()) }))
      );
    }
  }

  // ---------- Kalender ----------
  function maxOut(ci) {
    for (let i = 1; i <= S.cfg.max_nights; i++) {
      const d = addDays(ci, i);
      if (S.avail[d]) return d; // malam ini terisi; check-out boleh di hari ini
    }
    return addDays(ci, S.cfg.max_nights);
  }

  function renderCal() {
    const { y, m } = S.month;
    $('#cal-title').textContent = `${MONTHS[m]} ${y}`;
    const cur = y * 12 + m;
    $('#prev').disabled = cur <= S.minMonth;
    $('#next').disabled = cur >= S.maxMonth;
    if (!$('#dow').children.length) $('#dow').replaceChildren(...DOW_MON.map((d) => el('div', { class: 'dow', text: d })));

    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    const offset = (first + 6) % 7;
    const count = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const limit = S.ci && !S.co ? maxOut(S.ci) : null;
    const cells = [];
    for (let i = 0; i < offset; i++) cells.push(el('div', { class: 'day void' }));
    for (let day = 1; day <= count; day++) {
      const d = ymd(y, m, day);
      const st = S.avail[d];
      const past = d < S.cfg.today;
      const cls = ['day'];
      let label = fmt(d);
      if (past) { cls.push('past'); label += ', sudah lewat'; }
      else if (st) { cls.push(st); label += { pending: ', menunggu konfirmasi', booked: ', terisi', blocked: ', tidak tersedia' }[st]; }
      if (d === S.cfg.today) cls.push('today');
      if (S.ci && S.co) {
        if (d === S.ci) cls.push('sel-start');
        else if (d === S.co) cls.push('sel-end');
        else if (d > S.ci && d < S.co) cls.push('in-range');
      } else if (S.ci) {
        if (d === S.ci) cls.push('sel-start');
        else if (d > limit || d < S.ci) { if (!past && !st) cls.push('dim'); }
      }
      // Tanggal terisi hanya bisa dipilih sebagai check-out.
      const asCheckout = S.ci && !S.co && d > S.ci && d <= limit;
      const disabled = past || (st && !asCheckout);
      cells.push(el('button', {
        type: 'button', class: cls.join(' '), text: String(day), disabled, 'aria-label': label,
        'aria-pressed': d === S.ci || d === S.co ? 'true' : 'false',
        onclick: () => pick(d),
      }));
    }
    $('#cal').replaceChildren(...cells);
  }

  function startAt(d) {
    S.ci = d; S.co = null;
    const [y, m] = d.split('-').map(Number);
    S.month = { y, m: m - 1 };
    $('#pesan').hidden = true;
    renderCal(); renderHint();
  }

  function pick(d) {
    if (!S.ci || (S.ci && S.co)) {
      if (S.avail[d]) return;
      startAt(d);
      return;
    }
    if (d === S.ci) { S.ci = null; renderCal(); renderHint(); return; }
    if (d < S.ci) { if (!S.avail[d]) startAt(d); return; }
    if (d > maxOut(S.ci)) {
      toast('Ada malam yang sudah terisi di antara tanggal itu. Pilih check-out lebih awal.', true);
      return;
    }
    S.co = d;
    renderCal(); renderHint(); openForm();
  }

  function renderHint() {
    const h = $('#hint');
    if (!S.ci) h.textContent = 'Ketuk tanggal check-in.';
    else if (!S.co) h.textContent = `Check-in ${fmt(S.ci)}. Sekarang ketuk tanggal check-out.`;
    else h.textContent = `${diff(S.ci, S.co)} malam, ${fmt(S.ci)} sampai ${fmt(S.co)}. Ketuk tanggal lain untuk mengubah.`;
  }

  $('#prev').addEventListener('click', () => { S.month = S.month.m === 0 ? { y: S.month.y - 1, m: 11 } : { y: S.month.y, m: S.month.m - 1 }; renderCal(); });
  $('#next').addEventListener('click', () => { S.month = S.month.m === 11 ? { y: S.month.y + 1, m: 0 } : { y: S.month.y, m: S.month.m + 1 }; renderCal(); });

  // ---------- Form booking ----------
  function calc() {
    const nights = diff(S.ci, S.co);
    const u = S.unit;
    const extraGuests = Math.max(0, S.guests - u.base_capacity);
    const base = nights * u.price;
    const extra = extraGuests * u.extra_fee * nights;
    const total = base + extra;
    const dp = Math.min(total, Math.ceil((total * S.cfg.dp_percent) / 100 / 1000) * 1000);
    return { nights, extraGuests, base, extra, total, dp };
  }

  function renderBreakdown() {
    const c = calc();
    const rows = [el('div', {}, el('dt', { text: `${c.nights} malam x ${rupiah(S.unit.price)}` }), el('dd', { text: rupiah(c.base) }))];
    if (c.extraGuests > 0) {
      rows.push(el('div', {}, el('dt', { text: `${c.extraGuests} tamu tambahan` }), el('dd', { text: S.unit.extra_fee > 0 ? rupiah(c.extra) : 'ditentukan admin' })));
    }
    rows.push(el('div', { class: 'total' }, el('dt', { text: 'Total' }), el('dd', { text: rupiah(c.total) })));
    rows.push(el('div', {}, el('dt', { text: `DP ${S.cfg.dp_percent}%` }), el('dd', { text: rupiah(c.dp) })));
    $('#rincian').replaceChildren(...rows);
    $('#dp-note').textContent = c.extraGuests > 0 && S.unit.extra_fee === 0
      ? 'Total belum termasuk biaya tamu tambahan. Admin akan mengonfirmasi biayanya lewat WhatsApp.'
      : 'Booking dikonfirmasi setelah DP diterima admin.';
    $('#g-val').textContent = String(S.guests);
    $('#g-note').textContent = c.extraGuests > 0
      ? `${c.extraGuests} orang di atas kapasitas normal akan memakai extra bed di luar kamar atau di ruang pertemuan.`
      : `Kapasitas normal sampai ${S.unit.base_capacity} orang.`;
    $('#g-plus').disabled = S.guests >= S.unit.max_capacity;
    $('#g-minus').disabled = S.guests <= 1;
  }

  function openForm() {
    $('#pesan').hidden = false;
    $('#form').hidden = false;
    $('#done').hidden = true;
    $('#s-in').textContent = fmt(S.ci);
    $('#s-out').textContent = fmt(S.co);
    $('#s-in-t').textContent = S.cfg.checkin_time;
    $('#s-out-t').textContent = S.cfg.checkout_time;
    S.guests = Math.min(Math.max(S.guests, 1), S.unit.max_capacity);
    renderBreakdown();
    scrollTo('#pesan');
  }

  function setupForm() {
    $('#g-plus').addEventListener('click', () => { if (S.guests < S.unit.max_capacity) { S.guests++; renderBreakdown(); } });
    $('#g-minus').addEventListener('click', () => { if (S.guests > 1) { S.guests--; renderBreakdown(); } });
    try {
      $('#f-name').value = localStorage.getItem('gh_name') || '';
      $('#f-phone').value = localStorage.getItem('gh_phone') || '';
    } catch { /* penyimpanan dimatikan, abaikan */ }

    $('#form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#f-name').value.trim();
      const phone = $('#f-phone').value.trim();
      if (name.length < 2) { toast('Isi nama lengkap.', true); $('#f-name').focus(); return; }
      if (!/^[+\d][\d\s-]{8,18}$/.test(phone)) { toast('Nomor WhatsApp belum benar. Contoh: 08123456789', true); $('#f-phone').focus(); return; }
      const btn = $('#submit');
      btn.disabled = true;
      btn.textContent = 'Mengirim...';
      try {
        const data = await api('/api/bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            unit_id: S.unit.id, name, phone, check_in: S.ci, check_out: S.co, guests: S.guests,
            note: $('#f-note').value.trim(), website: $('[name=website]', e.target).value,
          }),
        });
        try {
          localStorage.setItem('gh_name', name); localStorage.setItem('gh_phone', phone);
          if (data.booking) localStorage.setItem('gh_code', data.booking.code);
        } catch { /* abaikan */ }
        if (data.booking) {
          $('#form').hidden = true;
          const done = $('#done');
          done.hidden = false;
          done.replaceChildren(
            el('h3', { text: 'Booking terkirim' }),
            bookingView(data.booking, data.wa_admin_url, true)
          );
          scrollTo('#pesan');
          await loadAvailability(); renderStrip();
          S.ci = S.co = null; renderCal(); renderHint();
        }
      } catch (err) {
        toast(err.message, true);
        if (/terisi|bentrok/i.test(err.message)) {
          await loadAvailability(); renderStrip();
          S.ci = S.co = null; $('#pesan').hidden = true; renderCal(); renderHint();
        }
      } finally {
        btn.disabled = false;
        btn.textContent = 'Kirim booking';
      }
    });
  }

  // ---------- Tampilan booking (hasil kirim & cek status) ----------
  const STATUS_TEXT = {
    pending: 'Menunggu DP dan konfirmasi admin',
    approved: 'Dikonfirmasi',
    rejected: 'Belum bisa dikonfirmasi',
    cancelled: 'Dibatalkan',
  };

  function bookingView(b, waUrl, fresh) {
    const wrap = el('div');
    wrap.append(
      el('p', { class: 'kode', text: b.code }),
      el('span', { class: `chip ${b.status}`, text: b.expired ? 'Batas waktu menunggu sudah lewat' : STATUS_TEXT[b.status] })
    );
    wrap.append(
      el('p', { style: 'margin-top:.8rem' },
        `${b.name}, ${b.nights} malam, ${b.guests} orang.`, el('br'),
        `Check-in ${fmt(b.check_in)}`, el('br'),
        `Check-out ${fmt(b.check_out)}`, el('br'),
        `Total ${rupiah(b.total)}`
      )
    );
    if (b.status === 'pending') {
      wrap.append(
        el('p', {}, el('strong', { text: `DP yang perlu dibayar: ${rupiah(b.dp_amount)}` })),
        b.payment_info ? el('div', { class: 'bayar', text: b.payment_info }) : null,
        el('p', { class: 'catatan', text: fresh
          ? `Admin sudah mendapat pemberitahuan. Setelah transfer, kirim bukti pembayaran ke admin. Tanggal ditahan ${S.cfg.pending_hours} jam menunggu DP.`
          : 'Setelah transfer, kirim bukti pembayaran ke admin agar booking dikonfirmasi.' })
      );
    }
    if (b.status === 'approved') {
      wrap.append(el('p', { class: 'catatan', text: `Check-in mulai pukul ${S.cfg.checkin_time} WIB, check-out paling lambat pukul ${S.cfg.checkout_time} WIB. Peraturan lengkap sudah dikirim ke WhatsApp Anda.` }));
    }
    if ((b.status === 'rejected' || b.status === 'cancelled') && b.reject_reason) {
      wrap.append(el('p', { class: 'catatan', text: `Keterangan: ${b.reject_reason}` }));
    }
    if (waUrl) {
      const label = b.status === 'pending' ? 'Kirim bukti DP ke admin lewat WhatsApp' : 'Hubungi admin lewat WhatsApp';
      wrap.append(el('div', { class: 'actions' }, el('a', { class: 'btn', href: waUrl, target: '_blank', rel: 'noopener', text: label })));
    }
    return wrap;
  }

  function setupStatus() {
    const input = $('#c-code');
    const box = $('#c-result');
    async function lookup(code) {
      code = code.trim().toUpperCase();
      if (!code) return;
      input.value = code;
      try {
        const data = await api(`/api/status/${encodeURIComponent(code)}`);
        box.hidden = false;
        box.replaceChildren(bookingView(data.booking, data.wa_admin_url, false));
      } catch (err) {
        box.hidden = false;
        box.replaceChildren(el('p', { text: err.message }));
      }
    }
    $('#cari').addEventListener('submit', (e) => { e.preventDefault(); lookup(input.value); });
    const m = location.hash.match(/^#cek=([A-Za-z0-9-]+)/);
    if (m) { lookup(m[1]); setTimeout(() => scrollTo('#status'), 200); }
    else {
      try { const saved = localStorage.getItem('gh_code'); if (saved) input.value = saved; } catch { /* abaikan */ }
    }
  }

  init().catch((err) => toast(err.message, true));
})();
