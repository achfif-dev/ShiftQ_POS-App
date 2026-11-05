// Alur peninjauan bertahap: aturan murni (web/lib/alurSoal.js) dan penegakannya di server (src/review.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalisasiAlur, jumlahTahap, tahapSoal, tahapDitugaskan, bolehTinjau, masukAntrean, langkahSetelah, catatTinjauan, labelTahap, ALUR_BAWAAN } from '../web/lib/alurSoal.js';
import { setujui, mintaRevisi } from '../src/review.js';
import { fakeDb } from './_fakeDb.js';

const TS = { serverTimestamp: () => 'TS' };
const TEKS = 'الصلاة واجبة على كل مسلم بالغ عاقل ذكر أو أنثى';
const soal = (o = {}) => ({
  status: 'pending', authorUid: 'u_penyusun', mapel: 'Fiqih', teks: TEKS, nama: 'Safinatun Naja', bentuk: 'pilgan', stimulus: '',
  pertanyaan: 'Siapa yang wajib shalat?', opsi: { A: 'Muslim baligh berakal', B: 'Anak kecil', C: 'Orang gila', D: 'Orang pingsan', E: '' }, kunci: 'A',
  pembahasan: 'الصلاة واجبة على كل مسلم بالغ عاقل', ai: { dibuat: true, model: 'm', verifikasi: 'lolos', buta: 'sepakat' }, ...o,
});
const ALUR3 = normalisasiAlur({ aktif: true, standar: 1, perMapel: { Fiqih: 3, Nahwu: 2 } });
const e = (uid, tahapEditor) => ({ uid, role: 'editor', tahapEditor });
const ed = { e1: e('e1', [1]), e2: e('e2', [2]), e3: e('e3', [3]), semua: e('semua', [1, 2, 3]), baru: e('baru', []) };
const arg = (id, p, extra = {}) => ({ id, uid: p.uid, nama: p.uid, role: p.role, tahapEditor: p.tahapEditor, alur: ALUR3, ...extra });

test('normalisasiAlur: masukan rusak jatuh ke bawaan; tahap dibatasi 1..3', () => {
  assert.deepEqual(normalisasiAlur(null), { aktif: false, standar: 1, perMapel: {} });
  assert.deepEqual(normalisasiAlur({ aktif: 'ya', standar: 9, perMapel: { Fiqih: 4, Nahwu: '2', '': 3, Sharaf: 0 } }), { aktif: false, standar: 1, perMapel: { Nahwu: 2 } });
  assert.deepEqual(normalisasiAlur({ aktif: true, standar: 2.9, perMapel: [] }), { aktif: true, standar: 2, perMapel: {} });
  assert.equal(ALUR_BAWAAN.aktif, false);
});

test('jumlahTahap: nonaktif = 1; aktif memakai tahap khusus mapel, selain itu standar', () => {
  assert.equal(jumlahTahap(normalisasiAlur({ aktif: false, standar: 3, perMapel: { Fiqih: 3 } }), 'Fiqih'), 1);
  assert.equal(jumlahTahap(ALUR3, 'Fiqih'), 3);
  assert.equal(jumlahTahap(ALUR3, 'Nahwu'), 2);
  assert.equal(jumlahTahap(ALUR3, 'Tauhid'), 1);
  assert.equal(jumlahTahap(ALUR3, 'constructor'), 1);
});

test('tahapSoal: kosong = 1; tahap tersimpan dipangkas bila jumlah tahap mapel dikurangi', () => {
  assert.equal(tahapSoal(soal(), ALUR3), 1);
  assert.equal(tahapSoal(soal({ tahap: 3 }), ALUR3), 3);
  assert.equal(tahapSoal(soal({ tahap: 3, mapel: 'Nahwu' }), ALUR3), 2);
  assert.equal(tahapSoal(soal({ tahap: 3 }), ALUR_BAWAAN), 1);
  assert.deepEqual(tahapDitugaskan({ tahapEditor: [3, 1, 1, 7, 'x', 2.8] }), [1, 2, 3]);
});

test('bolehTinjau: tahap, penyusun sendiri, admin, tahap ganda, dan mapel satu tahap', () => {
  assert.equal(bolehTinjau(ed.e1, soal(), ALUR3).ok, true);
  assert.equal(bolehTinjau(ed.e2, soal(), ALUR3).kode, 'BUKAN_TAHAPMU');
  assert.equal(bolehTinjau(ed.baru, soal(), ALUR3).kode, 'BUKAN_TAHAPMU');
  assert.equal(bolehTinjau(ed.e2, soal({ tahap: 2 }), ALUR3).ok, true);
  assert.equal(bolehTinjau({ uid: 'u_penyusun', role: 'editor', tahapEditor: [1] }, soal(), ALUR3).kode, 'REVIEW_SENDIRI');
  assert.equal(bolehTinjau({ uid: 'a', role: 'admin' }, soal({ tahap: 3 }), ALUR3).ok, true);
  assert.equal(bolehTinjau({ uid: 'p', role: 'penyusun' }, soal(), ALUR3).kode, 'FORBIDDEN_ROLE');
  assert.equal(bolehTinjau(ed.e1, soal({ status: 'approved' }), ALUR3).kode, 'STATUS_BERUBAH');
  // editor "semua" yang sudah meninjau tahap 1 tidak boleh meninjau tahap 2 pada soal yang sama
  const jejak = [{ tahap: 1, uid: 'semua', hasil: 'revisi' }];
  assert.equal(bolehTinjau(ed.semua, soal({ tahap: 2, tinjauan: jejak }), ALUR3).kode, 'TAHAP_GANDA');
  assert.equal(bolehTinjau(ed.e2, soal({ tahap: 2, tinjauan: jejak }), ALUR3).ok, true);
  // mapel satu tahap: editor mana pun, ditugaskan atau tidak (perilaku lama)
  assert.equal(bolehTinjau(ed.baru, soal({ mapel: 'Tauhid' }), ALUR3).ok, true);
  assert.equal(bolehTinjau(ed.baru, soal(), ALUR_BAWAAN).ok, true);
});

test('masukAntrean: editor hanya melihat soal tahapnya; admin dan mapel satu tahap terlihat semua', () => {
  assert.equal(masukAntrean(ed.e1, soal(), ALUR3), true);
  assert.equal(masukAntrean(ed.e2, soal(), ALUR3), false);
  assert.equal(masukAntrean(ed.e2, soal({ tahap: 2 }), ALUR3), true);
  assert.equal(masukAntrean({ role: 'admin' }, soal({ tahap: 3 }), ALUR3), true);
  assert.equal(masukAntrean(ed.baru, soal({ mapel: 'Tauhid' }), ALUR3), true);
  assert.equal(masukAntrean({ role: 'penyusun' }, soal(), ALUR3), false);
});

test('langkahSetelah: revisi langsung ke tahap berikut, tahap terakhir kembali ke tahap terakhir; lolos terakhir = approved', () => {
  assert.deepEqual(langkahSetelah(soal(), ALUR3, 'revisi'), { status: 'revision', tahap: 2 });
  assert.deepEqual(langkahSetelah(soal({ tahap: 2 }), ALUR3, 'revisi'), { status: 'revision', tahap: 3 });
  assert.deepEqual(langkahSetelah(soal({ tahap: 3 }), ALUR3, 'revisi'), { status: 'revision', tahap: 3 });
  assert.deepEqual(langkahSetelah(soal(), ALUR3, 'lolos'), { status: 'pending', tahap: 2 });
  assert.deepEqual(langkahSetelah(soal({ tahap: 3 }), ALUR3, 'lolos'), { status: 'approved', tahap: 3 });
  assert.deepEqual(langkahSetelah(soal(), ALUR_BAWAAN, 'lolos'), { status: 'approved', tahap: 1 });
  assert.throws(() => langkahSetelah(soal(), ALUR3, 'x'));
});

test('catatTinjauan dan labelTahap', () => {
  let j = []; for (let i = 0; i < 25; i++) j = catatTinjauan(j, { tahap: 1, uid: 'u' + i, nama: 'n', hasil: 'revisi', at: i });
  assert.equal(j.length, 20); assert.equal(j[19].uid, 'u24');
  assert.equal(labelTahap(soal({ tahap: 2 }), ALUR3), 'Menunggu editor 2 dari 3');
  assert.equal(labelTahap(soal({ status: 'revision', tinjauan: [{ tahap: 1, hasil: 'revisi' }] }), ALUR3), 'Revisi dari editor 1 dari 3');
  assert.equal(labelTahap(soal({ mapel: 'Tauhid' }), ALUR3), '');
  assert.equal(labelTahap(soal(), ALUR_BAWAAN), '');
});

test('server: alur penuh 3 tahap dengan revisi di setiap tahap, hingga Approved oleh editor 3', async () => {
  const db = fakeDb({ 'soal/s1': soal() });
  const ambil = () => db.data['soal/s1'];
  // editor 1 minta revisi -> penyusun -> menunggu editor 2
  await mintaRevisi(db, TS, arg('s1', ed.e1, { catatan: 'perbaiki kunci' }));
  assert.equal(ambil().status, 'revision'); assert.equal(ambil().tahap, 2);
  db.data['soal/s1'].status = 'pending'; // penyusun mengirim ulang (aturan klien; tidak menyentuh tahap)
  await assert.rejects(() => setujui(db, TS, arg('s1', ed.e1)), (x) => x.code === 'BUKAN_TAHAPMU');
  await mintaRevisi(db, TS, arg('s1', ed.e2, { catatan: 'pembahasan kurang' }));
  assert.equal(ambil().tahap, 3);
  db.data['soal/s1'].status = 'pending';
  await mintaRevisi(db, TS, arg('s1', ed.e3, { catatan: 'kutipan' }));
  assert.equal(ambil().status, 'revision'); assert.equal(ambil().tahap, 3); // tahap terakhir: kembali ke editor 3
  db.data['soal/s1'].status = 'pending';
  const r = await setujui(db, TS, arg('s1', ed.e3));
  assert.equal(r.ok, true); assert.equal(ambil().status, 'approved');
  assert.deepEqual(ambil().tinjauan.map((x) => [x.tahap, x.hasil]), [[1, 'revisi'], [2, 'revisi'], [3, 'revisi'], [3, 'setuju']]);
});

test('server: "setujui" sebelum tahap terakhir hanya meloloskan ke tahap berikut (tetap Pending), tanpa gerbang sumber', async () => {
  const db = fakeDb({ 'soal/s1': soal() });
  const r = await setujui(db, TS, arg('s1', ed.e1, { ambilSumber: () => { throw new Error('tidak boleh dipanggil'); } }));
  assert.deepEqual([r.lanjut, r.tahap, r.total], [true, 2, 3]);
  assert.equal(db.data['soal/s1'].status, 'pending'); assert.equal(db.data['soal/s1'].tahap, 2);
  const r2 = await setujui(db, TS, arg('s1', ed.e2)); assert.equal(r2.tahap, 3);
  // editor yang sudah meninjau tahap 1 tidak boleh ikut meninjau tahap 3, walau ditugaskan di semua tahap
  const db2 = fakeDb({ 'soal/s1': soal() });
  await setujui(db2, TS, arg('s1', ed.semua));
  await assert.rejects(() => setujui(db2, TS, arg('s1', ed.semua)), (x) => x.code === 'TAHAP_GANDA');
  const sisa = await setujui(db2, TS, arg('s1', ed.e2)); assert.equal(sisa.tahap, 3);
  assert.equal((await setujui(db2, TS, arg('s1', ed.e3))).ok, true);
  assert.equal(db2.data['soal/s1'].status, 'approved');
});

test('server: persetujuan akhir tetap melewati gerbang kutipan (override butuh catatan)', async () => {
  const db = fakeDb({ 'soal/s1': soal({ tahap: 3, pembahasan: 'قال النبي إن الصلاة تسقط عن المسافر دائما', ai: { dibuat: true, model: 'm', verifikasi: 'lolos', buta: 'sepakat' } }) });
  await assert.rejects(() => setujui(db, TS, arg('s1', ed.e3)), (x) => x.code === 'ALASAN_WAJIB');
  assert.equal(db.data['soal/s1'].status, 'pending');
});

test('server: mintaRevisi wajib catatan; bukan pending ditolak; penyusun sendiri ditolak; alur nonaktif tidak menulis tahap', async () => {
  const db = fakeDb({ 'soal/s1': soal(), 'soal/s2': soal({ status: 'draft' }), 'soal/s3': soal({ mapel: 'Tauhid' }) });
  await assert.rejects(() => mintaRevisi(db, TS, arg('s1', ed.e1, { catatan: '  ' })), (x) => x.code === 'CATATAN_WAJIB');
  await assert.rejects(() => mintaRevisi(db, TS, arg('s2', ed.e1, { catatan: 'x' })), (x) => x.code === 'STATUS_BERUBAH');
  await assert.rejects(() => mintaRevisi(db, TS, arg('s1', { uid: 'u_penyusun', role: 'editor', tahapEditor: [1] }, { catatan: 'x' })), (x) => x.code === 'REVIEW_SENDIRI');
  await assert.rejects(() => mintaRevisi(db, TS, arg('nope', ed.e1, { catatan: 'x' })), (x) => x.code === 'SOAL_NOT_FOUND');
  await assert.rejects(() => mintaRevisi(db, TS, arg('s1', { uid: 'p', role: 'penyusun' }, { catatan: 'x' })), (x) => x.code === 'FORBIDDEN_ROLE');
  await mintaRevisi(db, TS, arg('s3', ed.baru, { catatan: 'ok' })); // mapel satu tahap: perilaku lama
  assert.equal(db.data['soal/s3'].status, 'revision'); assert.ok(!('tahap' in db.data['soal/s3'])); assert.ok(!('tinjauan' in db.data['soal/s3']));
});
