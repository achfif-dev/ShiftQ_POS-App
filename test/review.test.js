// Gerbang persetujuan di server (src/review.js, aksi "setujui" di api/assist.js) dan batas ukuran riwayat di firestore.rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sidikButa, sidikButaSoal, alasanPerluCatatan, catatButa, setujui, KOLEKSI_BUTA } from '../src/review.js';
import { periksaKutipan, bidangDariSoal } from '../src/kutipan.js';
import { BIDANG_RIWAYAT } from '../web/lib/riwayat.js';
import { __setFirebaseForTest } from '../src/platform.js';
import handler from '../api/assist.js';
import { fakeDb } from './_fakeDb.js';

const TEKS = 'الصلاة واجبة على كل مسلم بالغ عاقل ذكر أو أنثى';
const KUTIPAN_PALSU = 'قال النبي إن الصلاة تسقط عن المسافر دائما';
const soalAsli = (o = {}) => ({
  status: 'pending', authorUid: 'u_penyusun', teks: TEKS, nama: 'Safinatun Naja', bentuk: 'pilgan',
  stimulus: '', pertanyaan: 'Siapa yang wajib shalat?', opsi: { A: 'Muslim baligh berakal', B: 'Anak kecil', C: 'Orang gila', D: 'Orang pingsan', E: '' }, kunci: 'A',
  pembahasan: 'الصلاة واجبة على كل مسلم بالغ عاقل', ai: { dibuat: true, model: 'm', verifikasi: 'lolos', buta: 'sepakat' }, ...o,
});

test('sanity: kutipan palsu memang dinilai gagal, kutipan asli lolos', () => {
  assert.equal(periksaKutipan(bidangDariSoal(soalAsli()), TEKS).status, 'lolos');
  assert.equal(periksaKutipan(bidangDariSoal(soalAsli({ pembahasan: KUTIPAN_PALSU })), TEKS).status, 'gagal');
});

test('sidikButa: tahan spasi dan urutan kunci, berubah bila kunci/opsi/teks berubah', () => {
  const a = sidikButaSoal(soalAsli());
  assert.equal(a.length, 40);
  assert.equal(sidikButaSoal(soalAsli({ pertanyaan: '  Siapa   yang wajib shalat? ' })), a);
  assert.notEqual(sidikButaSoal(soalAsli({ kunci: 'B' })), a);
  assert.notEqual(sidikButaSoal(soalAsli({ opsi: { A: 'x', B: 'Anak kecil', C: 'Orang gila', D: 'Orang pingsan', E: '' } })), a);
  assert.notEqual(sidikButaSoal(soalAsli({ teks: TEKS + ' زيادة' })), a);
  // sidik dari isian uji (klien) sama dengan sidik dari dokumen tersimpan
  assert.equal(sidikButa({ teks: TEKS, bentuk: '', soal: { stimulus: '', pertanyaan: 'Siapa yang wajib shalat?', opsi: soalAsli().opsi, kunci: 'A' } }), a);
});

test('gerbang: klaim palsu "lolos" tidak menutupi kutipan yang sebenarnya gagal', () => {
  const q = soalAsli({ pembahasan: KUTIPAN_PALSU, ai: { dibuat: true, model: 'm', verifikasi: 'lolos', buta: 'sepakat' } });
  assert.deepEqual(alasanPerluCatatan(q, null), ['ada kutipan Arab yang tidak ada di teks kitab']);
});

test('gerbang: catatan server "beda" menang atas klaim "sepakat" atau kosong; "sepakat" server menang atas klaim "beda"', () => {
  assert.deepEqual(alasanPerluCatatan(soalAsli(), { status: 'beda' }), ['uji jawab buta berbeda dari kunci']);
  assert.deepEqual(alasanPerluCatatan(soalAsli({ ai: { dibuat: true, model: '', verifikasi: '', buta: '' } }), { status: 'beda' }), ['uji jawab buta berbeda dari kunci']);
  assert.deepEqual(alasanPerluCatatan(soalAsli({ ai: { dibuat: true, model: '', verifikasi: 'lolos', buta: 'beda' } }), { status: 'sepakat' }), []);
});

test('gerbang: tanpa catatan server, klaim "beda" tetap dihormati (hanya memperketat); tanpa teks, klaim "gagal" dipakai', () => {
  assert.equal(alasanPerluCatatan(soalAsli({ ai: { dibuat: true, model: '', verifikasi: 'lolos', buta: 'beda' } }), null).length, 1);
  assert.equal(alasanPerluCatatan(soalAsli({ teks: '', ai: { dibuat: true, model: '', verifikasi: 'gagal', buta: '' } }), null).length, 1);
  assert.deepEqual(alasanPerluCatatan(soalAsli(), null), []);
});

test('catatButa: hanya sepakat/beda yang dicatat, kunci dokumen = sidik isi', async () => {
  const db = fakeDb(); const FV = { serverTimestamp: () => 'TS' };
  const arg = { teks: TEKS, bentuk: 'pilgan', soal: { pertanyaan: 'Siapa yang wajib shalat?', opsi: soalAsli().opsi, kunci: 'A' }, uid: 'u1', model: 'm' };
  assert.equal(await catatButa(db, FV, { ...arg, status: 'tanpa_kunci' }), false);
  assert.deepEqual(Object.keys(db.data), []);
  assert.equal(await catatButa(db, FV, { ...arg, status: 'beda' }), true);
  assert.equal(db.data[`${KOLEKSI_BUTA}/${sidikButaSoal(soalAsli())}`].status, 'beda');
  assert.equal(await catatButa({ doc: () => ({ set: async () => { throw new Error('x'); } }) }, FV, { ...arg, status: 'beda' }), false); // gagal menulis tidak melempar
});

/* ---------------- handler /api/assist aksi "setujui" ---------------- */
const mkRes = () => { const r = { h: {}, setHeader(k, v) { r.h[k] = v; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const req = (tok, body) => ({ method: 'POST', headers: { authorization: 'Bearer ' + tok }, body });
import appConfigHandler from '../api/app-config.js';
import { invalidateAlur } from '../src/alurEditor.js';
function pasang(extra = {}) {
  invalidateAlur(); // pengaturan alur di-cache 30 dtk per proses; tiap tes memulai dari keadaan bersih
  const data = {
    'users/u_editor': { role: 'editor' }, 'users/u_admin': { role: 'admin' }, 'users/u_penyusun': { role: 'penyusun' }, 'users/u_penyusun2': { role: 'penyusun' },
    'soal/s1': soalAsli(), ...extra,
  };
  const db = fakeDb(data);
  __setFirebaseForTest({ db, FieldValue: { serverTimestamp: () => 'TS' }, auth: { verifyIdToken: async (t) => { if (!t.startsWith('tok_')) throw new Error('bad'); return { uid: t.replace('tok_', 'u_'), name: 'Nama ' + t } } } });
  return db;
}
const jalan = async (tok, body) => { const r = mkRes(); await handler(req(tok, body), r); return r; };

test('setujui: editor menyetujui soal bersih; status, reviewer, dan waktu ditulis server', async () => {
  const db = pasang();
  try {
    const r = await jalan('tok_editor', { aksi: 'setujui', id: 's1' });
    assert.equal(r.code, 200); assert.equal(r.body.ok, true);
    const q = db.data['soal/s1'];
    assert.equal(q.status, 'approved'); assert.equal(q.reviewerUid, 'u_editor'); assert.equal(q.reviewedAt, 'TS'); assert.equal(q.catatan, '');
    assert.equal(q.pertanyaan, 'Siapa yang wajib shalat?'); // isi lain tidak tersentuh
  } finally { __setFirebaseForTest(null); }
});

test('setujui: kutipan palsu dengan klaim "lolos" ditolak tanpa catatan, diterima dengan catatan', async () => {
  const db = pasang({ 'soal/s1': soalAsli({ pembahasan: KUTIPAN_PALSU }) });
  try {
    let r = await jalan('tok_editor', { aksi: 'setujui', id: 's1' });
    assert.equal(r.code, 422); assert.equal(r.body.error.code, 'ALASAN_WAJIB'); assert.match(r.body.error.message, /kutipan Arab/);
    assert.equal(db.data['soal/s1'].status, 'pending');
    r = await jalan('tok_editor', { aksi: 'setujui', id: 's1', catatan: '   ' });
    assert.equal(r.code, 422);
    r = await jalan('tok_editor', { aksi: 'setujui', id: 's1', catatan: '[Disetujui dengan catatan] dikutip dari halaman lain' });
    assert.equal(r.code, 200); assert.equal(r.body.dengan_catatan, true);
    assert.equal(db.data['soal/s1'].status, 'approved'); assert.match(db.data['soal/s1'].catatan, /halaman lain/);
  } finally { __setFirebaseForTest(null); }
});

test('setujui: catatan uji buta "beda" dari server mewajibkan alasan walau dokumen mengaku "sepakat"', async () => {
  const db = pasang({ [`${KOLEKSI_BUTA}/${sidikButaSoal(soalAsli())}`]: { status: 'beda', uid: 'u_penyusun' } });
  try {
    const r = await jalan('tok_admin', { aksi: 'setujui', id: 's1' });
    assert.equal(r.code, 422); assert.match(r.body.error.message, /uji jawab buta/);
    assert.equal(db.data['soal/s1'].status, 'pending');
  } finally { __setFirebaseForTest(null); }
});

test('setujui: hanya editor/admin; Pending saja; editor tidak boleh menyetujui soalnya sendiri, admin boleh', async () => {
  const db = pasang({ 'soal/s2': soalAsli({ authorUid: 'u_editor' }), 'soal/s3': soalAsli({ status: 'draft' }), 'soal/s4': soalAsli({ status: 'approved' }) });
  try {
    assert.equal((await jalan('tok_penyusun', { aksi: 'setujui', id: 's1' })).code, 403);
    assert.equal((await jalan('tok_penyusun2', { aksi: 'setujui', id: 's1' })).body.error.code, 'FORBIDDEN_ROLE');
    assert.equal((await jalan('tok_nobody', { aksi: 'setujui', id: 's1' })).code, 403); // tanpa profil
    assert.equal((await jalan('rusak', { aksi: 'setujui', id: 's1' })).code, 401); // token tidak sah
    assert.equal((await jalan('tok_editor', { aksi: 'setujui', id: 's2' })).body.error.code, 'REVIEW_SENDIRI');
    assert.equal((await jalan('tok_editor', { aksi: 'setujui', id: 's3' })).body.error.code, 'STATUS_BERUBAH');
    assert.equal((await jalan('tok_editor', { aksi: 'setujui', id: 's4' })).body.error.code, 'STATUS_BERUBAH');
    assert.equal((await jalan('tok_editor', { aksi: 'setujui', id: 'tidak-ada' })).code, 404);
    assert.equal((await jalan('tok_editor', { aksi: 'setujui', id: 'a/b' })).code, 400);
    assert.equal((await jalan('tok_editor', { aksi: 'setujui' })).code, 400);
    assert.equal((await jalan('tok_admin', { aksi: 'setujui', id: 's2' })).code, 200);
  } finally { __setFirebaseForTest(null); }
});

test('setujui langsung: catatan dipotong 1000 karakter', async () => {
  const db = fakeDb({ 'soal/s1': soalAsli({ pembahasan: KUTIPAN_PALSU }) });
  await setujui(db, { serverTimestamp: () => 'TS' }, { id: 's1', uid: 'u_editor', nama: 'E', role: 'editor', catatan: 'x'.repeat(1500) });
  assert.equal(db.data['soal/s1'].catatan.length, 1000);
});

/* ---------------- firestore.rules: penjaga penyimpangan ---------------- */
const RULES = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');

test('rules: klien tidak lagi bisa menyetujui, dan gerbang lama yang bisa dipalsukan sudah hilang', () => {
  assert.doesNotMatch(RULES, /perluAlasan/);
  // Meminta revisi juga lewat server sejak alur editor bertingkat: tidak ada lagi aturan klien yang menulis status revision.
  assert.doesNotMatch(RULES, /d\(\)\.status == 'revision'/);
  assert.match(RULES, /aksi "revisi"/);
  assert.match(RULES, /naik ke approved hanya lewat server/);
  assert.match(RULES, /match \/cekbutaHasil\/\{doc\}\s*\{\s*allow read, write: if false;/);
});

test('rules: daftar kunci snapshot riwayat sama dengan BIDANG_RIWAYAT dan ukuran tiap isian dibatasi', () => {
  const blok = RULES.slice(RULES.indexOf('function snapshotOk'), RULES.indexOf('// Jejak audit AI'));
  const kunci = [...blok.match(/s\.keys\(\)\.hasOnly\(\[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...kunci].sort(), [...BIDANG_RIWAYAT].sort());
  const dibatasi = new Set([...blok.matchAll(/teksMax\(s, '(\w+)'/g)].map((m) => m[1]));
  for (const k of BIDANG_RIWAYAT) if (!['opsi', 'ai', 'urut'].includes(k)) assert.ok(dibatasi.has(k), `bidang ${k} belum dibatasi ukurannya`);
  assert.match(blok, /s\.opsi\.keys\(\)\.hasOnly\(\['A', 'B', 'C', 'D', 'E'\]\)/);
  assert.match(RULES, /snapshotOk\(request\.resource\.data\.snapshot\)/);
});

/* ---------------- pencocokan teks dengan halaman sumber (src/sumber.js) ---------------- */
import { periksaSumber, bandingkanDenganSumber } from '../src/sumber.js';

const HALAMAN = 'الصلاة واجبة على كل مسلم بالغ عاقل ذكر أو أنثى\nوشروط الصلاة خمسة طهارة الحدثين وطهارة النجس والستر والاستقبال والوقت';
const KARANGAN = 'الزكاة تجب على كل غني في كل شهر مرتين بلا شرط\nويجوز تأخير الحج إلى آخر العمر بلا عذر أبدا';
const ambilHalaman = (teks, extra = {}) => async () => ({ teks, terpotong: false, ...extra });

test('sumber: teks asli cocok; kutipan beda harakat/tanda baca tetap cocok', async () => {
  assert.equal((await periksaSumber(soalAsli({ sumberUrl: 'https://shamela.ws/book/1/2' }), { ambil: ambilHalaman(HALAMAN) })).status, 'cocok');
  const b = bandingkanDenganSumber('الصَّلَاةُ وَاجِبَةٌ عَلَى كُلِّ مُسْلِمٍ بَالِغٍ عَاقِلٍ، ذَكَرٍ أَوْ أُنْثَى.', HALAMAN);
  assert.equal(b.rasio, 1);
});

test('sumber: teks karangan = tidak_cocok; gabungan halaman (separuh cocok) = sebagian, bukan tidak_cocok', async () => {
  const q = (teks) => soalAsli({ teks, sumberUrl: 'https://shamela.ws/book/1/2' });
  assert.equal((await periksaSumber(q(KARANGAN), { ambil: ambilHalaman(HALAMAN) })).status, 'tidak_cocok');
  const gabungan = (await periksaSumber(q(TEKS + '\n' + KARANGAN.split('\n')[0]), { ambil: ambilHalaman(HALAMAN) }));
  assert.equal(gabungan.status, 'sebagian'); assert.equal(gabungan.cocok, 1); assert.equal(gabungan.total, 2);
});

test('sumber: tanpa tautan, gagal diambil, halaman terpotong, atau tanpa teks tidak menyimpulkan "palsu"', async () => {
  assert.equal((await periksaSumber(soalAsli(), { ambil: ambilHalaman(HALAMAN) })).status, 'tanpa_sumber');
  assert.equal((await periksaSumber(soalAsli({ sumberUrl: 'https://x.test/' }), { ambil: async () => { throw new Error('403'); } })).status, 'tidak_terjangkau');
  assert.equal((await periksaSumber(soalAsli({ teks: KARANGAN, sumberUrl: 'https://shamela.ws/book/1/2' }), { ambil: ambilHalaman(HALAMAN, { terpotong: true }) })).status, 'tidak_terjangkau');
  assert.equal((await periksaSumber(soalAsli({ teks: '', sumberUrl: 'https://shamela.ws/book/1/2' }), { ambil: ambilHalaman(HALAMAN) })).status, 'tanpa_teks');
});

test('setujui: teks karangan dengan tautan sumber ditolak tanpa catatan; kutipan "lolos" karena kutipan memang ada di teks karangan itu', async () => {
  const q = soalAsli({ teks: KARANGAN, pembahasan: 'الزكاة تجب على كل غني في كل شهر مرتين', sumberUrl: 'https://shamela.ws/book/1/2' });
  const db = fakeDb({ 'soal/s1': q });
  assert.equal(alasanPerluCatatan(q, null).length, 0); // gerbang kutipan saja tidak menangkapnya
  const arg = { id: 's1', uid: 'u_editor', nama: 'E', role: 'editor', ambilSumber: ambilHalaman(HALAMAN) };
  await assert.rejects(() => setujui(db, { serverTimestamp: () => 'TS' }, arg), (e) => e.code === 'ALASAN_WAJIB' && /halaman sumber/.test(e.message));
  assert.equal(db.data['soal/s1'].status, 'pending');
  const r = await setujui(db, { serverTimestamp: () => 'TS' }, { ...arg, catatan: 'teks dari kitab cetak, bukan halaman ini' });
  assert.equal(r.sumber, 'tidak_cocok'); assert.equal(r.dengan_catatan, true); assert.equal(db.data['soal/s1'].status, 'approved');
});

test('setujui: teks asli dengan sumber cocok disetujui tanpa catatan dan hasilnya melapor sumber "cocok"', async () => {
  const db = fakeDb({ 'soal/s1': soalAsli({ sumberUrl: 'https://shamela.ws/book/1/2' }) });
  const r = await setujui(db, { serverTimestamp: () => 'TS' }, { id: 's1', uid: 'u_editor', nama: 'E', role: 'editor', ambilSumber: ambilHalaman(HALAMAN) });
  assert.equal(r.sumber, 'cocok'); assert.equal(r.dengan_catatan, false);
});

test('setujui: SUMBER_WAJIB mewajibkan alasan untuk soal tanpa tautan sumber; bawaan tidak', async () => {
  const arg = { id: 's1', uid: 'u_editor', nama: 'E', role: 'editor' };
  const FV = { serverTimestamp: () => 'TS' };
  await setujui(fakeDb({ 'soal/s1': soalAsli() }), FV, arg); // bawaan: lolos
  const db = fakeDb({ 'soal/s1': soalAsli() });
  await assert.rejects(() => setujui(db, FV, { ...arg, sumberWajib: true }), (e) => e.code === 'ALASAN_WAJIB');
  assert.equal((await setujui(db, FV, { ...arg, sumberWajib: true, catatan: 'dari foto kitab' })).sumber, 'tanpa_sumber');
});

test('setujui: teks atau sumber berubah selama pemeriksaan sumber = 409, tidak disetujui', async () => {
  const db = fakeDb({ 'soal/s1': soalAsli({ sumberUrl: 'https://shamela.ws/book/1/2' }) });
  const ambilSambilDiubah = async () => { db.data['soal/s1'].teks = KARANGAN; return { teks: HALAMAN, terpotong: false }; };
  await assert.rejects(() => setujui(db, { serverTimestamp: () => 'TS' }, { id: 's1', uid: 'u_editor', nama: 'E', role: 'editor', ambilSumber: ambilSambilDiubah }), (e) => e.code === 'SOAL_BERUBAH');
  assert.equal(db.data['soal/s1'].status, 'pending');
});

/* ---------------- alur editor bertahap lewat handler API (autentikasi, penugasan tahap, pengaturan admin) ---------------- */
const ALUR_DOK = { 'config/alur': { alur: { aktif: true, standar: 1, perMapel: { Fiqih: 3 } } } };
const EDITOR_DOK = { 'users/u_e1': { role: 'editor', tahapEditor: [1] }, 'users/u_e2': { role: 'editor', tahapEditor: [2] }, 'users/u_e3': { role: 'editor', tahapEditor: [3] } };

test('alur bertahap via API: tahap ditegakkan, revisi lewat server mencatat tahap berikut, meloloskan ke tahap berikut', async () => {
  const db = pasang({ ...ALUR_DOK, ...EDITOR_DOK, 'soal/s1': soalAsli({ mapel: 'Fiqih' }) });
  try {
    let r = await jalan('tok_e2', { aksi: 'revisi', id: 's1', catatan: 'x' });
    assert.equal(r.code, 403); assert.equal(r.body.error.code, 'BUKAN_TAHAPMU');
    r = await jalan('tok_e1', { aksi: 'revisi', id: 's1', catatan: '   ' });
    assert.equal(r.code, 422); assert.equal(r.body.error.code, 'CATATAN_WAJIB');
    r = await jalan('tok_e1', { aksi: 'revisi', id: 's1', catatan: 'perbaiki kunci' });
    assert.equal(r.code, 200);
    assert.deepEqual([db.data['soal/s1'].status, db.data['soal/s1'].tahap, db.data['soal/s1'].catatan], ['revision', 2, 'perbaiki kunci']);
    db.data['soal/s1'].status = 'pending'; // penyusun mengirim ulang
    r = await jalan('tok_e1', { aksi: 'setujui', id: 's1' });
    assert.equal(r.code, 403); assert.equal(r.body.error.code, 'BUKAN_TAHAPMU'); // editor 1 tidak bisa meninjau tahap 2
    r = await jalan('tok_e2', { aksi: 'setujui', id: 's1' });
    assert.equal(r.code, 200); assert.deepEqual([r.body.lanjut, r.body.tahap, r.body.total], [true, 3, 3]);
    assert.equal(db.data['soal/s1'].status, 'pending');
    r = await jalan('tok_e3', { aksi: 'setujui', id: 's1' });
    assert.equal(r.code, 200); assert.equal(db.data['soal/s1'].status, 'approved');
  } finally { __setFirebaseForTest(null); invalidateAlur(); }
});

test('alur bertahap via API: penyusun tidak bisa meminta revisi; mapel lain (satu tahap) tetap boleh editor mana pun', async () => {
  const db = pasang({ ...ALUR_DOK, ...EDITOR_DOK, 'soal/s1': soalAsli({ mapel: 'Fiqih' }), 'soal/s2': soalAsli({ mapel: 'Tauhid' }) });
  try {
    let r = await jalan('tok_penyusun2', { aksi: 'revisi', id: 's1', catatan: 'x' });
    assert.equal(r.code, 403);
    r = await jalan('tok_e3', { aksi: 'setujui', id: 's2' });
    assert.equal(r.code, 200); assert.equal(db.data['soal/s2'].status, 'approved');
    assert.ok(!('tahap' in db.data['soal/s2'])); // mapel satu tahap: tidak ada jejak tahap
  } finally { __setFirebaseForTest(null); invalidateAlur(); }
});

test('alur bertahap via API: pengaturan alur tidak terbaca = ditolak (503), bukan diam-diam melonggarkan pemeriksaan', async () => {
  const db = pasang({ ...ALUR_DOK, ...EDITOR_DOK, 'soal/s1': soalAsli({ mapel: 'Fiqih' }) });
  const asli = db.doc;
  db.doc = (p) => (p === 'config/alur' ? { get: async () => { throw new Error('firestore down'); } } : asli(p));
  try {
    const r = await jalan('tok_e3', { aksi: 'setujui', id: 's1' });
    assert.equal(r.code, 503); assert.equal(r.body.error.code, 'ALUR_TIDAK_TERBACA');
    assert.equal(db.data['soal/s1'].status, 'pending');
  } finally { __setFirebaseForTest(null); invalidateAlur(); }
});

test('app-config: admin menyimpan alur (dinormalkan), non-admin ditolak, semua pengguna aktif membacanya lewat "baca"', async () => {
  const db = pasang({ ...EDITOR_DOK });
  const panggil = async (tok, body) => { const r = mkRes(); await appConfigHandler(req(tok, body), r); return r; };
  try {
    let r = await panggil('tok_e1', { aksi: 'alursimpan', alur: { aktif: true } });
    assert.equal(r.code, 403);
    r = await panggil('tok_admin', { aksi: 'alursimpan', alur: { aktif: true, standar: 9, perMapel: { Fiqih: 3, Nahwu: 7 } } });
    assert.equal(r.code, 200); assert.deepEqual(r.body.alur, { aktif: true, standar: 1, perMapel: { Fiqih: 3 } });
    assert.deepEqual(db.data['config/alur'].alur, { aktif: true, standar: 1, perMapel: { Fiqih: 3 } });
    r = await panggil('tok_e1', { aksi: 'baca' });
    assert.equal(r.code, 200); assert.deepEqual(r.body.alur, { aktif: true, standar: 1, perMapel: { Fiqih: 3 } });
    assert.ok(r.body.config && Array.isArray(r.body.config.mapel)); // konfigurasi utama tetap ikut
  } finally { __setFirebaseForTest(null); invalidateAlur(); }
});

test('klien: revisi dan persetujuan lewat server; tidak ada lagi tulis status revision langsung dari klien', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../web/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /aksi: 'revisi', id, catatan: note/);
  assert.match(app, /aksi: 'alursimpan'/);
  assert.doesNotMatch(app, /col\.doc\(id\)\.update\(\{ status, catatan: note/);
});
