import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  FOLDER, serialisasiSoal, buatBackup, periksaBackup, namaBerkas, kandidatArsip, potong, buatDrive, DriveError,
} from '../src/drive.js';
import { bersihkanSoal, pulihkanSoal, infoBackup, MAKS_PER_PEMULIHAN } from '../src/backup.js';
import { __setFirebaseForTest } from '../src/platform.js';
import backupHandler from '../api/backup.js';

const salin = (o) => JSON.parse(JSON.stringify(o));
const SOAL = () => ({
  id: 'abc123XYZ', tingkat: 'Aliyah', mapel: 'Fiqih', level: 'L2', nama: 'Fathul Qarib', juz: '1', hal: '12',
  teks: 'بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ', stimulus: '', pertanyaan: 'Apa hukum ...?', indikator: '', sumberUrl: 'https://shamela.ws/book/823',
  opsi: { A: 'a', B: 'b', C: 'c', D: 'd', E: '' }, kunci: 'B', pembahasan: 'karena ...',
  ai: { dibuat: true, model: 'gemini', verifikasi: 'lolos', buta: 'sepakat' }, status: 'approved', catatan: '',
  authorUid: 'u-penyusun', authorName: 'Ust. Ahmad', createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-02-03T04:05:06.000Z',
  reviewerUid: 'u-editor', reviewerName: 'Ust. Budi', reviewedAt: '2026-02-03T04:05:06.000Z',
});

/* ------------------------------------------------------------ web/lib/drive.js */

test('serialisasiSoal: Timestamp Firestore menjadi teks ISO, bidang lain utuh', () => {
  const ts = (iso) => ({ toDate: () => new Date(iso) });
  const o = serialisasiSoal('x1', { pertanyaan: 'q', createdAt: ts('2026-01-01T00:00:00.000Z'), updatedAt: ts('2026-01-02T00:00:00.000Z') });
  assert.deepEqual(o, { id: 'x1', pertanyaan: 'q', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' });
  assert.equal(JSON.parse(JSON.stringify(o)).updatedAt, '2026-01-02T00:00:00.000Z');
});

test('buatBackup dan periksaBackup: bentuk, hitungan, dan penolakan berkas asing', () => {
  const cfg = { versi: 2, tingkat: [], mapel: [], kitab: [{ nama: 'A' }, { nama: 'B' }] };
  const b = buatBackup({ soal: [SOAL()], config: cfg, kustom: true, oleh: 'a@b.c', now: new Date('2026-10-22T01:00:00Z') });
  assert.deepEqual(b.jumlah, { soal: 1, kitab: 2 });
  const p = periksaBackup(JSON.parse(JSON.stringify(b)));
  assert.equal(p.soal.length, 1); assert.equal(p.jumlahKitab, 2); assert.equal(p.oleh, 'a@b.c');
  assert.throws(() => periksaBackup({ format: 'lain', versi: 1, soal: [] }), /bukan cadangan LABSOUMA/);
  assert.throws(() => periksaBackup({ ...b, versi: 99 }), /Versi cadangan 99/);
  assert.throws(() => periksaBackup({ ...b, soal: 'x' }), /daftar soal/);
  assert.throws(() => periksaBackup(null), /bukan cadangan/);
  assert.equal(periksaBackup({ ...b, konfigurasi: 'rusak' }).konfigurasi, null);
});

test('namaBerkas, potong, dan kandidatArsip (hanya Disetujui dan cukup lama)', () => {
  assert.equal(namaBerkas(new Date(2026, 9, 2, 8, 5)), 'labsouma-backup-2026-10-02-0805.json');
  assert.deepEqual(potong([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  const now = Date.parse('2026-10-22T00:00:00Z');
  const hari = (n) => new Date(now - n * 86_400_000).toISOString();
  const daftar = [
    { id: 'tua-ok', status: 'approved', updatedAt: hari(200) },
    { id: 'baru', status: 'approved', updatedAt: hari(10) },
    { id: 'tua-draft', status: 'draft', updatedAt: hari(400) },
    { id: 'tua-pending', status: 'pending', updatedAt: hari(400) },
    { id: 'tua-revisi', status: 'revision', updatedAt: hari(400) },
    { id: 'tanpa-tanggal', status: 'approved', updatedAt: null },
    { id: 'tanggal-rusak', status: 'approved', updatedAt: 'bukan tanggal' },
  ];
  assert.deepEqual(kandidatArsip(daftar, { hari: 180, now }).map((q) => q.id), ['tua-ok']);
  assert.deepEqual(kandidatArsip(daftar, { hari: 5, now }).map((q) => q.id), ['tua-ok', 'baru']);
});

function fakeDrive({ files = [], galat = null } = {}) {
  const log = [];
  const f = async (url, init = {}) => {
    log.push({ url, init });
    const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (galat) return res(galat.status, galat.body);
    const u = new URL(url);
    if (u.pathname === '/drive/v3/files' && (!init.method || init.method === 'GET')) {
      if (u.searchParams.get('q').includes('in parents')) return res(200, { files: [{ id: 'f1', name: 'labsouma-backup-x.json' }] });
      return res(200, { files });
    }
    if (u.pathname === '/drive/v3/files' && init.method === 'POST') return res(200, { id: 'folder-baru' });
    if (u.pathname === '/upload/drive/v3/files') return res(200, { id: 'file-1', name: 'x.json', webViewLink: 'https://drive.google.com/file/d/file-1/view' });
    if (u.pathname.startsWith('/drive/v3/files/') && u.searchParams.get('alt') === 'media') return res(200, 'ISI-BERKAS');
    return res(404, { error: { message: 'x' } });
  };
  return { f, log };
}

test('Drive: folder dipakai ulang bila ada, dibuat bila tidak; token dikirim sebagai Bearer', async () => {
  let d = fakeDrive({ files: [{ id: 'folder-lama', name: FOLDER }] });
  let drive = buatDrive({ ambilToken: async () => 'TKN', fetchImpl: d.f });
  assert.equal(await drive.siapkanFolder(), 'folder-lama');
  assert.equal(d.log[0].init.headers.Authorization, 'Bearer TKN');
  assert.match(decodeURIComponent(d.log[0].url), /name='LABSOUMA Backup' and trashed=false/);
  assert.equal(d.log.length, 1);

  d = fakeDrive({ files: [] });
  drive = buatDrive({ ambilToken: async () => 'TKN', fetchImpl: d.f });
  assert.equal(await drive.siapkanFolder(), 'folder-baru');
  const post = d.log[1];
  assert.equal(post.init.method, 'POST');
  assert.deepEqual(JSON.parse(post.init.body), { name: FOLDER, mimeType: 'application/vnd.google-apps.folder' });
});

test('Drive: unggah multipart membawa metadata (folder induk) dan isi UTF-8 apa adanya; unduh dan daftar', async () => {
  const d = fakeDrive();
  const drive = buatDrive({ ambilToken: async () => 'TKN', fetchImpl: d.f });
  const isi = JSON.stringify({ teks: 'بِسْمِ اللَّهِ', catatan: 'baris\nbaru "kutip" \\ garis' });
  const r = await drive.unggah('folder-1', 'a.json', isi);
  assert.equal(r.id, 'file-1');
  const { url, init } = d.log[0];
  assert.match(url, /uploadType=multipart/);
  const batas = /boundary=(.+)$/.exec(init.headers['Content-Type'])[1];
  const bagian = init.body.split(`--${batas}`);
  assert.deepEqual(JSON.parse(bagian[1].split('\r\n\r\n')[1].trim()), { name: 'a.json', parents: ['folder-1'], mimeType: 'application/json' });
  assert.equal(bagian[2].split('\r\n\r\n')[1].replace(/\r\n$/, ''), isi);
  assert.equal(await drive.unduh('file-1'), 'ISI-BERKAS');
  assert.match(d.log[1].url, /files\/file-1\?alt=media$/);
  assert.deepEqual((await drive.daftar('folder-1')).map((x) => x.id), ['f1']);
  assert.match(decodeURIComponent(d.log[2].url), /'folder-1' in parents and trashed=false/);
});

test('Drive: galat dipetakan ke pesan yang bisa ditindaklanjuti', async () => {
  const coba = async (status, body) => {
    const d = fakeDrive({ galat: { status, body: JSON.stringify(body) } });
    try { await buatDrive({ ambilToken: async () => 't', fetchImpl: d.f }).unduh('x'); } catch (e) { return e; }
    return null;
  };
  let e = await coba(401, { error: { message: 'Invalid Credentials' } });
  assert.ok(e instanceof DriveError); assert.equal(e.code, 'DRIVE_TOKEN');
  e = await coba(403, { error: { message: 'Google Drive API has not been used in project 123 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } });
  assert.equal(e.code, 'DRIVE_API_OFF'); assert.match(e.message, /README/);
  e = await coba(403, { error: { message: 'The user storage quota has been exceeded.', errors: [{ reason: 'storageQuotaExceeded' }] } });
  assert.equal(e.code, 'DRIVE_PENUH');
  e = await coba(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } });
  assert.equal(e.code, 'DRIVE_RATE');
  e = await coba(403, { error: { message: 'insufficientPermissions' } });
  assert.equal(e.code, 'DRIVE_DITOLAK');
  assert.equal((await coba(404, {})).code, 'DRIVE_TIDAK_ADA');
  assert.equal((await coba(500, 'bukan json')).code, 'DRIVE_ERROR');
});

/* ------------------------------------------------------------ src/backup.js */

test('bersihkanSoal: soal sah lolos, tanggal menjadi Date, bidang asing dan kunci berbahaya dibuang', () => {
  const raw = { ...SOAL(), asing: 'x', __proto__x: 1, isAdmin: true };
  const { id, data } = bersihkanSoal(raw);
  assert.equal(id, 'abc123XYZ');
  assert.ok(data.createdAt instanceof Date && data.updatedAt instanceof Date && data.reviewedAt instanceof Date);
  assert.equal(data.createdAt.toISOString(), '2026-01-02T03:04:05.000Z');
  assert.equal('asing' in data, false); assert.equal('isAdmin' in data, false); assert.equal('id' in data, false);
  assert.deepEqual(Object.keys(data.opsi), ['A', 'B', 'C', 'D', 'E']);
  // Tanpa peninjau: tidak ada reviewer*
  const tanpa = bersihkanSoal({ ...SOAL(), status: 'draft', reviewerUid: '', reviewerName: '', reviewedAt: null }).data;
  assert.equal('reviewerUid' in tanpa, false); assert.equal('reviewedAt' in tanpa, false);
});

test('bersihkanSoal: menolak entri yang akan ditolak aturan Firestore', () => {
  const tolak = (ubah, pola) => { const s = SOAL(); ubah(s); assert.throws(() => bersihkanSoal(s), (e) => e.status === 422 && e.code === 'BACKUP_INVALID' && pola.test(e.message)); };
  tolak((s) => { s.id = '../x'; }, /ID soal/);
  tolak((s) => { s.id = 5; }, /ID soal/);
  tolak((s) => { s.level = 'L9'; }, /Level/);
  tolak((s) => { s.status = 'approved ; drop'; }, /Status/);
  tolak((s) => { s.kunci = 'Z'; }, /Kunci/);
  tolak((s) => { s.sumberUrl = 'http://x.com'; }, /https/);
  tolak((s) => { s.sumberUrl = 'javascript:alert(1)'; }, /https/);
  tolak((s) => { s.teks = 'x'.repeat(8001); }, /Teks kitab terlalu panjang/);
  tolak((s) => { s.opsi.A = 'x'.repeat(1001); }, /Opsi A/);
  tolak((s) => { s.opsi = [1]; }, /Opsi/);
  tolak((s) => { s.pertanyaan = 123; }, /Pertanyaan harus berupa teks/);
  tolak((s) => { s.ai.verifikasi = 'mungkin'; }, /Jejak AI/);
  tolak((s) => { s.authorUid = ''; }, /penyusun/);
  tolak((s) => { s.createdAt = 'kemarin sore'; }, /tanggal/);
  tolak((s) => { s.tingkat = ''; }, /Tingkat/);
  assert.throws(() => bersihkanSoal(null), /Entri soal/);
  assert.throws(() => bersihkanSoal([]), /Entri soal/);
});

test('bersihkanSoal: hasilnya hanya berisi kunci yang diizinkan aturan Firestore untuk admin (tidak melenceng dari firestore.rules)', () => {
  const rules = fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  // Daftar kunci admin boleh disambung .concat([...]) (kunci jejak alur editor bertingkat: tahap, tinjauan).
  const blok = /isAdmin\(\)\s*&& d\(\)\.keys\(\)\.hasOnly\(\[([^\]]+)\](?:\.concat\(\[([^\]]+)\]\))?\)/.exec(rules);
  assert.ok(blok, 'pola aturan admin tidak ditemukan; sesuaikan tes ini bila aturan diubah');
  const boleh = new Set([...(blok[1] + ',' + (blok[2] || '')).matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]));
  const { data } = bersihkanSoal(SOAL());
  for (const k of Object.keys(data)) assert.ok(boleh.has(k), `kunci ${k} tidak diizinkan aturan Firestore`);
});

function fakeFirebase({ users = {}, tokens = {}, soal = {} } = {}) {
  const data = Object.fromEntries(Object.entries(users).map(([k, v]) => [`users/${k}`, v]));
  const koleksi = salin(soal); const tulis = [];
  const ref = (path) => ({ path, get: async () => ({ exists: path in data, data: () => data[path] }) });
  const soalRef = (id) => ({ id, path: 'soal/' + id });
  const db = {
    doc: ref,
    collection: (c) => { assert.equal(c, 'soal'); return { doc: soalRef }; },
    getAll: async (...refs) => refs.map((r) => ({ exists: r.id in koleksi })),
    batch: () => { const q = []; return { set: (r, v) => q.push([r.id, v]), commit: async () => { for (const [id, v] of q) { koleksi[id] = v; tulis.push(id); } } }; },
  };
  return { koleksi, tulis, auth: { verifyIdToken: async (t) => { if (!tokens[t]) throw new Error('bad'); return tokens[t]; } }, FieldValue: {}, db };
}

test('pulihkanSoal: mode lewati tidak menyentuh soal yang sudah ada; mode timpa menggantinya; entri buruk dilaporkan tanpa menggagalkan sisanya', async () => {
  const fb = fakeFirebase({ soal: { ada: { pertanyaan: 'LAMA' } } });
  __setFirebaseForTest(fb);
  try {
    const a = { ...SOAL(), id: 'ada', pertanyaan: 'BARU' }; const b = { ...SOAL(), id: 'baru1' }; const c = { ...SOAL(), id: 'rusak', level: 'X' };
    let r = await pulihkanSoal({}, { soal: [a, b, c] });
    assert.deepEqual([r.ditulis, r.dilewati, r.ditolak.length], [1, 1, 1]);
    assert.equal(r.ditolak[0].id, 'rusak'); assert.match(r.ditolak[0].alasan, /Level/);
    assert.equal(fb.koleksi.ada.pertanyaan, 'LAMA'); assert.ok(fb.koleksi.baru1);
    assert.deepEqual(fb.tulis, ['baru1']);

    r = await pulihkanSoal({}, { mode: 'timpa', soal: [a] });
    assert.deepEqual([r.ditulis, r.dilewati], [1, 0]);
    assert.equal(fb.koleksi.ada.pertanyaan, 'BARU');

    r = await pulihkanSoal({}, { soal: [{ ...b }, { ...b }] });   // id ganda dalam satu permintaan
    assert.equal(r.ditolak.length, 1); assert.match(r.ditolak[0].alasan, /dua kali/);

    r = await pulihkanSoal({}, { soal: [c] });                   // semuanya buruk: tidak menyentuh database
    assert.deepEqual([r.ditulis, r.dilewati, r.ditolak.length], [0, 0, 1]);

    await assert.rejects(pulihkanSoal({}, { soal: [] }), { code: 'BACKUP_INVALID' });
    await assert.rejects(pulihkanSoal({}, {}), { code: 'BACKUP_INVALID' });
    await assert.rejects(pulihkanSoal({}, { soal: Array.from({ length: MAKS_PER_PEMULIHAN + 1 }, (_, i) => ({ ...SOAL(), id: 'x' + i })) }), /Maksimal 100/);
  } finally { __setFirebaseForTest(null); }
});

test('api/backup: info untuk editor dan admin, pulihkan hanya admin, aksi lain ditolak', async () => {
  const fb = fakeFirebase({
    users: { adm: { role: 'admin' }, edi: { role: 'editor' }, pen: { role: 'penyusun' } },
    tokens: { adm: { uid: 'adm' }, edi: { uid: 'edi' }, pen: { uid: 'pen' } },
  });
  __setFirebaseForTest(fb); process.env.GOOGLE_DRIVE_CLIENT_ID = '  123.apps.googleusercontent.com ';
  try {
    const rq = (token, body) => ({ method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body });
    const mk = () => ({ h: {}, setHeader(k, v) { this.h[k] = v; }, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } });
    let res = mk(); await backupHandler(rq(null, { aksi: 'info' }), res); assert.equal(res.code, 401);
    res = mk(); await backupHandler(rq('pen', { aksi: 'info' }), res); assert.equal(res.code, 403);
    res = mk(); await backupHandler(rq('edi', { aksi: 'info' }), res); assert.equal(res.code, 200);
    assert.equal(res.body.driveClientId, '123.apps.googleusercontent.com'); assert.equal(res.body.folder, FOLDER);
    res = mk(); await backupHandler(rq('adm', { aksi: 'info' }), res); assert.equal(res.code, 200);
    res = mk(); await backupHandler(rq('edi', { aksi: 'pulihkan', soal: [SOAL()] }), res); assert.equal(res.code, 403);
    assert.deepEqual(fb.tulis, []);
    res = mk(); await backupHandler(rq('adm', { aksi: 'pulihkan', soal: [SOAL()] }), res); assert.equal(res.code, 200);
    assert.deepEqual(res.body, { ditulis: 1, dilewati: 0, ditolak: [] });
    res = mk(); await backupHandler(rq('adm', { aksi: 'pulihkan', soal: [] }), res); assert.equal(res.code, 422);
    res = mk(); await backupHandler(rq('adm', { aksi: 'hapus' }), res); assert.equal(res.code, 400);
    delete process.env.GOOGLE_DRIVE_CLIENT_ID; assert.equal(infoBackup().driveClientId, '');
  } finally { delete process.env.GOOGLE_DRIVE_CLIENT_ID; __setFirebaseForTest(null); }
});
