// Alur peninjauan soal bertahap (1 sampai 3 editor). Fungsi murni: dipakai server (src/review.js) dan klien (web/App.jsx).
//
// Model data pada dokumen soal (ditulis HANYA oleh server, bukan oleh klien):
//   tahap    : tahap editor berikutnya yang berhak meninjau. Kosong = tahap 1. Dibatasi jumlah tahap mapel saat ini.
//   tinjauan : jejak keputusan editor [{ tahap, uid, nama, hasil: 'revisi' | 'lolos' | 'setuju', at, catatan? }], maksimal 20 terakhir.
//
// Alur: penyusun -> editor 1 -> (revisi ke penyusun) -> editor 2 -> (revisi) -> editor 3 -> (revisi) -> editor 3 menyetujui -> Approved.
// Setelah revisi, soal langsung ke editor berikutnya. Khusus revisi di tahap TERAKHIR, soal kembali ke editor terakhir untuk disetujui:
// Approved harus berupa tindakan editor (dan lewat gerbang kutipan di server), bukan efek samping penyusun mengirim ulang.
export const MAKS_TAHAP = 3;
export const ALUR_BAWAAN = Object.freeze({ aktif: false, standar: 1, perMapel: Object.freeze({}) });

const tahapBersih = (v, cadangan = 1) => { const n = Math.trunc(Number(v)); return n >= 1 && n <= MAKS_TAHAP ? n : cadangan; };

/** Bentuk aman dari masukan apa pun (dokumen rusak, kiriman klien): { aktif, standar 1..3, perMapel { namaMapel: 1..3 } }. */
export function normalisasiAlur(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const src = r.perMapel && typeof r.perMapel === 'object' && !Array.isArray(r.perMapel) ? r.perMapel : {};
  const peta = new Map();
  for (const [k, v] of Object.entries(src).slice(0, 80)) {
    const nama = String(k).trim().slice(0, 60); const t = tahapBersih(v, 0);
    if (nama && t && !peta.has(nama)) peta.set(nama, t);
  }
  return { aktif: r.aktif === true, standar: tahapBersih(r.standar, 1), perMapel: Object.fromEntries(peta) };
}

/** Jumlah tahap editor untuk satu mapel. Alur nonaktif = 1 (satu editor mana pun, seperti sebelumnya). */
export function jumlahTahap(alur, mapel) {
  if (!alur || alur.aktif !== true) return 1;
  const khusus = alur.perMapel && typeof alur.perMapel === 'object' && Object.hasOwn(alur.perMapel, mapel) ? alur.perMapel[mapel] : alur.standar;
  return tahapBersih(khusus, 1);
}

/** Tahap yang sedang menunggu (1..jumlahTahap). Tahap tersimpan yang melebihi jumlah tahap sekarang dipangkas. */
export const tahapSoal = (q, alur) => Math.min(tahapBersih(q && q.tahap, 1), jumlahTahap(alur, q && q.mapel));

/** Tahap yang ditugaskan admin kepada seorang editor (dari profil pengguna), terurut dan unik. */
export const tahapDitugaskan = (profil) => [...new Set((Array.isArray(profil && profil.tahapEditor) ? profil.tahapEditor : []).map((x) => Math.trunc(Number(x))).filter((x) => x >= 1 && x <= MAKS_TAHAP))].sort();

/** Apakah soal pending ini perlu tampil di antrean editor tersebut (tidak memeriksa penyusun sendiri; itu ditunjukkan di kartu). */
export function masukAntrean(p, q, alur) {
  if (!p || (p.role !== 'editor' && p.role !== 'admin')) return false;
  if (p.role === 'admin' || jumlahTahap(alur, q && q.mapel) === 1) return true;
  return tahapDitugaskan(p).includes(tahapSoal(q, alur));
}

/**
 * Izin meninjau (menyetujui/meloloskan atau meminta revisi). Dipakai server sebagai penentu dan klien untuk menampilkan tombol.
 * Mengembalikan { ok, kode, alasan, tahap, total }.
 */
export function bolehTinjau(p, q, alur) {
  if (!q || q.status !== 'pending') return { ok: false, kode: 'STATUS_BERUBAH', alasan: 'Soal ini tidak lagi berstatus Pending.' };
  if (!p || (p.role !== 'editor' && p.role !== 'admin')) return { ok: false, kode: 'FORBIDDEN_ROLE', alasan: 'Hanya editor atau admin yang boleh meninjau.' };
  const total = jumlahTahap(alur, q.mapel); const tahap = tahapSoal(q, alur); const ctx = { tahap, total };
  if (p.role === 'admin') return { ok: true, ...ctx };
  if (q.authorUid === p.uid) return { ok: false, kode: 'REVIEW_SENDIRI', alasan: 'Editor tidak boleh menyetujui soal buatannya sendiri.', ...ctx };
  if (total === 1) return { ok: true, ...ctx };
  if (!tahapDitugaskan(p).includes(tahap)) return { ok: false, kode: 'BUKAN_TAHAPMU', alasan: `Soal ini menunggu editor tahap ${tahap}. Anda tidak ditugaskan di tahap itu.`, ...ctx };
  const lain = (Array.isArray(q.tinjauan) ? q.tinjauan : []).some((x) => x && x.uid === p.uid && x.tahap !== tahap);
  if (lain) return { ok: false, kode: 'TAHAP_GANDA', alasan: 'Anda sudah meninjau soal ini di tahap lain. Setiap tahap harus dikerjakan editor yang berbeda.', ...ctx };
  return { ok: true, ...ctx };
}

/** Status dan tahap sesudah keputusan. 'revisi': ke penyusun, lalu tahap berikutnya (tahap terakhir: kembali ke tahap terakhir). 'lolos': tahap berikutnya, atau Approved bila sudah tahap terakhir. */
export function langkahSetelah(q, alur, keputusan) {
  const total = jumlahTahap(alur, q && q.mapel); const t = tahapSoal(q, alur);
  if (keputusan === 'revisi') return { status: 'revision', tahap: Math.min(t + 1, total) };
  if (keputusan === 'lolos') return t < total ? { status: 'pending', tahap: t + 1 } : { status: 'approved', tahap: t };
  throw new Error('Keputusan tinjauan tidak dikenal.');
}

/** Tambahkan satu catatan ke jejak tinjauan (maks. 20 terakhir). Mengembalikan larik baru. */
export function catatTinjauan(lama, { tahap, uid, nama, hasil, at, catatan }) {
  const dasar = (Array.isArray(lama) ? lama : []).filter((x) => x && typeof x === 'object');
  const e = { tahap, uid: String(uid || ''), nama: String(nama || '').slice(0, 120), hasil, at: Number.isFinite(at) ? at : 0 };
  if (catatan) e.catatan = String(catatan).slice(0, 300);
  return [...dasar, e].slice(-20);
}

/** Teks penanda tahap untuk kartu soal. Kosong bila soal tidak memakai alur bertingkat. */
export function labelTahap(q, alur) {
  const total = jumlahTahap(alur, q && q.mapel);
  if (total <= 1 || !q) return '';
  if (q.status === 'pending') return `Menunggu editor ${tahapSoal(q, alur)} dari ${total}`;
  if (q.status === 'revision') {
    const r = (Array.isArray(q.tinjauan) ? q.tinjauan : []).filter((x) => x && x.hasil === 'revisi').pop();
    return r ? `Revisi dari editor ${r.tahap} dari ${total}` : '';
  }
  return '';
}
