import { fmtLong, rupiah } from './util.js';

export const ruleLines = (s) =>
  String(s.rules || '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

export const mapsUrl = (s) => `https://www.google.com/maps?q=${s.lat},${s.lng}`;

const stayDetail = (b, s) =>
  [
    `Kode booking: *${b.code}*`,
    `Check-in: ${fmtLong(b.check_in)}, mulai pukul ${s.checkin_time} WIB`,
    `Check-out: ${fmtLong(b.check_out)}, paling lambat pukul ${s.checkout_time} WIB`,
    `${b.nights} malam, ${b.guests} orang`,
    `Total: ${rupiah(b.total)}`,
  ].join('\n');

/** Pesan untuk admin saat ada booking baru. */
export function adminNewBookingMsg(b, s, adminUrl) {
  return [
    `*Booking baru* ${b.code}`,
    '',
    `Nama: ${b.name}`,
    b.marketer_name ? `Pemasar: ${b.marketer_name}` : null,
    `WhatsApp: wa.me/${b.phone}`,
    `Check-in: ${fmtLong(b.check_in)}`,
    `Check-out: ${fmtLong(b.check_out)}`,
    `${b.nights} malam, ${b.guests} orang`,
    `Total: ${rupiah(b.total)}`,
    `DP (${s.dp_percent}%): ${rupiah(b.dp_amount)}`,
    b.note ? `Catatan: ${b.note}` : null,
    '',
    'Cek DP lalu terima atau tolak di:',
    adminUrl,
  ]
    .filter((x) => x !== null)
    .join('\n');
}

/** Pesan dari calon penyewa ke admin (dipakai tombol wa.me di halaman publik). */
export function guestToAdminMsg(b, s) {
  return [
    `Assalamu'alaikum, saya ${b.marketer_name ? `${b.marketer_name} (pemasar), atas nama tamu ${b.name}` : b.name}.`,
    `Saya sudah booking ${s.property_name} dengan kode ${b.code}:`,
    `${fmtLong(b.check_in)} sampai ${fmtLong(b.check_out)} (${b.nights} malam, ${b.guests} orang).`,
    `Total ${rupiah(b.total)}, DP ${rupiah(b.dp_amount)}. Mohon dicek, terima kasih.`,
  ].join('\n');
}

/** Pesan untuk penyewa. kind: reminder | approved | rejected | cancelled */
export function guestMsg(kind, b, s, base, reason = '', asMarketer = false) {
  const sapa = asMarketer
    ? `Assalamu'alaikum ${b.marketer_name},\n(Konfirmasi untuk tamu Anda: ${b.name})`
    : `Assalamu'alaikum ${b.name},`;
  const cek = `Cek status booking: ${base}/#cek=${b.code}`;
  if (kind === 'approved') {
    const rules = [
      `Check-in mulai pukul ${s.checkin_time} WIB, check-out paling lambat pukul ${s.checkout_time} WIB.`,
      ...ruleLines(s),
    ].map((r, i) => `${i + 1}. ${r}`);
    return [
      sapa,
      '',
      'Alhamdulillah, booking Anda sudah *dikonfirmasi*. DP sudah kami terima.',
      '',
      stayDetail(b, s),
      '',
      '*Peraturan menginap*',
      ...rules,
      '',
      `Lokasi: ${mapsUrl(s)}`,
      cek,
      '',
      'Jazakumullah khairan. Kami tunggu kedatangannya.',
      `*${s.property_name}*`,
    ].join('\n');
  }
  if (kind === 'rejected') {
    return [
      sapa,
      '',
      `Mohon maaf, booking ${b.code} belum dapat kami konfirmasi.`,
      reason ? `Alasan: ${reason}` : null,
      '',
      'Silakan hubungi admin atau pilih tanggal lain di halaman booking.',
      `*${s.property_name}*`,
    ]
      .filter((x) => x !== null)
      .join('\n');
  }
  if (kind === 'cancelled') {
    return [
      sapa,
      '',
      `Booking ${b.code} (${fmtLong(b.check_in)} sampai ${fmtLong(b.check_out)}) telah dibatalkan.`,
      reason ? `Keterangan: ${reason}` : null,
      '',
      `*${s.property_name}*`,
    ]
      .filter((x) => x !== null)
      .join('\n');
  }
  // reminder DP
  return [
    sapa,
    '',
    `Kami menunggu DP untuk booking ${b.code}.`,
    '',
    stayDetail(b, s),
    `DP (${s.dp_percent}%): ${rupiah(b.dp_amount)}`,
    '',
    s.payment_info,
    '',
    'Setelah transfer, mohon kirim bukti pembayaran ke nomor ini.',
    cek,
  ].join('\n');
}

/** Pengingat harian ke admin: komisi pemasar yang sudah boleh dibayar. items: [{ marketer_name, code, name, check_out, amount }] */
export function commissionDigestMsg(items, s, url) {
  const total = items.reduce((a, x) => a + x.amount, 0);
  return [
    `*Pengingat komisi pemasar* (${s.property_name})`,
    '',
    `${items.length} komisi siap dibayar karena tamu sudah selesai menginap:`,
    ...items.map((x) => `- ${x.marketer_name}: ${rupiah(x.amount)} (${x.code}, tamu ${x.name}, check-out ${fmtLong(x.check_out)})\n  ${x.bank ? `Rekening: ${x.bank.bank_name} ${x.bank.bank_account}${x.bank.bank_holder ? ` a.n. ${x.bank.bank_holder}` : ''}` : 'Rekening belum diisi'}`),
    '',
    `Total: ${rupiah(total)}`,
    url ? `\nTandai sudah dibayar di:\n${url}` : null,
  ]
    .filter((x) => x !== null)
    .join('\n');
}
