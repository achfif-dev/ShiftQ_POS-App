// Tautan balik soal -> halaman kitab (web/lib/rujukan.js), pembaca (web/lib/pembaca.js), dan jalurnya lewat server, aturan Firestore, riwayat, dan backup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as R from '../web/lib/rujukan.js';
import * as P from '../web/lib/pembaca.js';
import { BIDANG_RIWAYAT } from '../web/lib/riwayat.js';
import { validasiKitab, JENIS_SUMBER } from '../src/kitabImpor.js';

const RULES = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../web/App.jsx', import.meta.url), 'utf8');

test('rujukanDariHalaman: satu halaman, rentang, dan masukan tak sah', () => {
  assert.deepEqual(R.rujukanDariHalaman('fathul-muin', [{ seq: 40 }]), { kitabId: 'fathul-muin', halId: 'p00040', halIdAkhir: '' });
  assert.deepEqual(R.rujukanDariHalaman('fathul-muin', [{ seq: 44 }, { seq: 40 }, { seq: 42 }]), { kitabId: 'fathul-muin', halId: 'p00040', halIdAkhir: 'p00044' });
  assert.deepEqual(R.rujukanDariHalaman('Salah ID', [{ seq: 1 }]), R.RUJUKAN_KOSONG);
  assert.deepEqual(R.rujukanDariHalaman('fathul-muin', []), R.RUJUKAN_KOSONG);
  assert.deepEqual(R.rujukanDariHalaman('fathul-muin', [{ seq: 0 }, { seq: 'x' }]), R.RUJUKAN_KOSONG);
});

test('rujukanSah dan bersihkanRujukan: setengah rujukan dibuang seluruhnya, akhir tidak boleh mendahului awal', () => {
  assert.equal(R.rujukanSah({ kitabId: 'a1', halId: 'p00005' }), true);
  assert.equal(R.rujukanSah({ kitabId: 'a1', halId: 'p00005', halIdAkhir: 'p00004' }), false);
  assert.equal(R.rujukanSah({ kitabId: 'a1', halId: '5' }), false);
  assert.equal(R.rujukanSah({ kitabId: '', halId: 'p00005' }), false);
  assert.equal(R.rujukanSah(null), false);
  assert.deepEqual(R.bersihkanRujukan({ kitabId: 'a1', halId: 'p00005', halIdAkhir: 'p00005' }), { kitabId: 'a1', halId: 'p00005', halIdAkhir: '' });
  assert.deepEqual(R.bersihkanRujukan({ kitabId: 'a1' }), R.RUJUKAN_KOSONG);
});

test('gabungRujukan: kitab sama melebar, kitab beda dilepas (satu tautan tidak bisa mewakili dua kitab)', () => {
  const a = { kitabId: 'k1', halId: 'p00010', halIdAkhir: '' };
  const b = { kitabId: 'k1', halId: 'p00012', halIdAkhir: 'p00013' };
  assert.deepEqual(R.gabungRujukan(a, b), { kitabId: 'k1', halId: 'p00010', halIdAkhir: 'p00013' });
  assert.deepEqual(R.gabungRujukan(R.RUJUKAN_KOSONG, b), b);
  assert.deepEqual(R.gabungRujukan(a, R.RUJUKAN_KOSONG), a);
  assert.deepEqual(R.gabungRujukan(a, { kitabId: 'k2', halId: 'p00001', halIdAkhir: '' }), R.RUJUKAN_KOSONG);
});

test('hashBaca dan bacaHash: pulang-pergi, hanya ASCII, dan masukan buruk menghasilkan null tanpa melempar', () => {
  const q = { kitabId: 'fathul-muin', halId: 'p00040', halIdAkhir: 'p00044' };
  assert.equal(R.hashBaca(q), '#baca/fathul-muin/40-44');
  assert.deepEqual(R.bacaHash('#baca/fathul-muin/40-44'), { kitabId: 'fathul-muin', dari: 40, sampai: 44 });
  assert.deepEqual(R.bacaHash('#baca/fathul-muin'), { kitabId: 'fathul-muin', dari: 1, sampai: 1 });
  assert.equal(R.hashBaca({ kitabId: 'x' }), '');
  for (const buruk of ['#baca/x/0', '#baca/x/9-3', '#baca/../etc', '#bank', '', null, undefined, '#baca/Fathul/4', '#baca/x/1-2-3']) assert.equal(R.bacaHash(buruk), null, String(buruk));
});

test('pembaca: pengaturan buruk jatuh ke bawaan; kursor selalu di dalam kitab; entri aktif menurut urutan', () => {
  const b = P.bersihkanPengaturan({ ukuran: 99, lebar: 'aneh', lembar: 7, bagian: 'x', terakhir: { 'k-1': 5, 'JELEK': 3, 'k-2': -1, 'k-3': 1.5 } });
  assert.deepEqual(b, { ukuran: 3, lebar: 'lebar', lembar: 1, bagian: 'semua', terakhir: { 'k-1': 5 } });
  assert.equal(P.UKURAN_HURUF[b.ukuran], 32, 'bawaan besar untuk layar lebar');
  assert.equal(P.kursorSah(0, 10), 1); assert.equal(P.kursorSah(99, 10), 10); assert.equal(P.kursorSah(10, 10, 2), 9); assert.equal(P.kursorSah(NaN, 10), 1);
  const entri = [{ judul: 'أ', seq: 1 }, { judul: 'ب', seq: 10 }, { judul: 'ج', seq: 20 }];
  assert.equal(P.entriAktif(entri, 0), -1); assert.equal(P.entriAktif(entri, 10), 1); assert.equal(P.entriAktif(entri, 500), 2);
  const gudang = new Map(); const st = { getItem: (k) => gudang.get(k) ?? null, setItem: (k, v) => gudang.set(k, v) };
  assert.equal(P.simpanPengaturanBaca({ ukuran: 5 }, st), true); assert.equal(P.pengaturanBaca(st).ukuran, 5);
  assert.equal(P.simpanPengaturanBaca({}, { setItem() { throw new Error('penuh'); } }), false);
});

test('pembaca: saringEntri mengabaikan harakat; teksSalinan memuat rujukan satu baris', () => {
  const entri = [{ judul: 'بَابُ الطَّهَارَةِ', seq: 1 }, { judul: 'كتاب الصلاة', seq: 5 }];
  assert.deepEqual(P.saringEntri(entri, 'الطهارة').map((x) => x.i), [0]);
  assert.equal(P.saringEntri(entri, '').length, 2);
  const t = P.teksSalinan({ judulLatin: "Fathul Mu'in" }, [{ hal: 40, teks: 'نص', batasMatn: null }, { hal: 41, teks: 'آخر', batasMatn: null }]);
  assert.match(t, /— Fathul Mu'in, hal\. 40–41$/);
  assert.equal(P.teksSalinan(null, []), '');
});

test('server: jenis sumber baru diterima, halamanVirtual lolos validasi, jenis tak dikenal tetap ditolak', () => {
  const dasar = { judul: 'ك', judulLatin: 'Kitab', jumlahHalaman: 3, jumlahJuz: 1, bentukMatn: 'tanpa-pemisah', hakCipta: {}, sumber: {} };
  for (const j of ['pdf', 'epub', 'html', 'json', 'teks-virtual', 'syamilah-txt']) assert.ok(JENIS_SUMBER.includes(j), j);
  const v = validasiKitab({ ...dasar, halamanVirtual: true, sumber: { jenis: 'pdf' } });
  assert.equal(v.halamanVirtual, true); assert.equal(v.sumber.jenis, 'pdf');
  assert.equal(validasiKitab(dasar).halamanVirtual, false);
  assert.throws(() => validasiKitab({ ...dasar, sumber: { jenis: 'exe' } }), /Jenis sumber/);
});

test('aturan Firestore dan riwayat: tiga bidang tautan diizinkan, dibatasi ukurannya, dan disalin ke riwayat', () => {
  for (const k of ['kitabId', 'halId', 'halIdAkhir']) {
    assert.ok(BIDANG_RIWAYAT.includes(k), `${k} belum ada di BIDANG_RIWAYAT`);
    assert.ok(RULES.split(`'${k}'`).length >= 4, `${k} harus muncul di opsiKeys, snapshotOk, dan aturan admin`);
  }
  assert.match(RULES, /teksMax\(s, 'kitabId', 60\)/);
  assert.match(RULES, /teksMax\(s, 'halId', 6\) && teksMax\(s, 'halIdAkhir', 6\)/);
});

test('aturan Firestore: isi tautan divalidasi bentuknya pada simpan (bukan hanya nama kuncinya)', () => {
  const soal = RULES.slice(RULES.indexOf('match /soal/{id}'), RULES.indexOf('match /kamusPegon/{id}'));
  assert.match(soal, /x\.kitabId\.matches\('\^\[a-z0-9\]\[a-z0-9-\]\{1,59\}\$'\)/);
  assert.match(soal, /x\.halId\.matches\('\^p\[0-9\]\{5\}\$'\)/);
  assert.match(soal, /x\.halIdAkhir == '' \|\| x\.halIdAkhir\.matches/);
  assert.match(soal, /'halId' in x\) \|\| 'kitabId' in x/, 'halId tanpa kitabId ditolak');
  // pola di aturan sama dengan pola di kode klien
  assert.equal(R.RE_KITAB_ID.source, '^[a-z0-9][a-z0-9-]{1,59}$'); assert.equal(R.RE_HAL_ID.source, '^p\\d{5}$');
});

test('App.jsx: form membawa tautan, rujukan kosong tidak dikirim, kartu punya tautan, tab Baca Kitab terpasang', () => {
  assert.match(APP, /'rubrik', 'kitabId', 'halId', 'halIdAkhir'\];/);
  assert.match(APP, /'rubrik', 'kitabId', 'halId', 'halIdAkhir'\]\) if \(!c\[k\] && !\(k in lama\)\) delete c\[k\]/);
  assert.equal((APP.match(/<TautKitab q=\{q\} \/>/g) || []).length, 3);
  assert.match(APP, /tab === 'baca' && <PembacaKitab/);
  assert.match(APP, /bacaHash\(window\.location\.hash\)\) return 'baca'/);
});
