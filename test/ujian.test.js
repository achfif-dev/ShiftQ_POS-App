import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_SISTEM_UJIAN, daftarSistem, kelasUntuk, sistemUntuk, periodeUntuk, labelPeriode, labelSistem,
  penempatanKitab, kitabCocok, cakupanKitab, ringkasPenempatan, penempatanYatim,
} from '../src/ujian.js';
import { DEFAULT_APP_CONFIG, sanitizeAppConfig, sanitizeSistemUjian, sanitizePenempatan } from '../src/appConfig.js';
import { bersihkanSoal } from '../src/backup.js';
import { validateInput, buildUserPrompt } from '../src/soalService.js';

const salin = (o) => JSON.parse(JSON.stringify(o));
const ARAB = 'بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ';

// Konfigurasi contoh: Tsanawiyah memakai semester (4 ujian), Ibtidaiyah catur wulan (3 ujian).
const cfgContoh = () => {
  const c = salin(DEFAULT_APP_CONFIG);
  c.tingkat.find((t) => t.nama === 'Ibtidaiyah').sistemUjian = 'caturwulan';
  const mu = c.kitab.find((k) => k.nama === "Fathul Mu'in");
  mu.tingkat = ['Tsanawiyah'];
  mu.penempatan = [
    { tingkat: 'Tsanawiyah', kelas: 'VII', periode: [{ kode: 'sem1-uts', cakupan: 'Thaharah' }, { kode: 'sem1-uas', cakupan: 'Shalat' }] },
    { tingkat: 'Tsanawiyah', kelas: 'VIII', periode: [] },
  ];
  return sanitizeAppConfig(c);
};

test('bawaan: semester 4 ujian (lengkap dengan tengah semester) dan catur wulan 3 ujian', () => {
  assert.deepEqual(DEFAULT_SISTEM_UJIAN.map((s) => [s.id, s.periode.length]), [['semester', 4], ['caturwulan', 3]]);
  const kode = DEFAULT_SISTEM_UJIAN.flatMap((s) => s.periode.map((p) => p.kode));
  assert.equal(new Set(kode).size, kode.length, 'kode periode harus unik di seluruh sistem');
  const sem = DEFAULT_SISTEM_UJIAN[0].periode.map((p) => p.label).join(' | ');
  assert.match(sem, /UTS Semester 1.*UAS Semester 1.*UTS Semester 2.*UAS Semester 2/);
});

test('konfigurasi lama (tanpa sistemUjian dan penempatan) tetap sah dan memakai bawaan', () => {
  const lama = { tingkat: [{ nama: 'Aliyah', kelas: ['X', 'XI'] }], mapel: [{ nama: 'Fiqih' }], kitab: [{ nama: "Fathul Mu'in", tingkat: ['Aliyah'] }] };
  const c = sanitizeAppConfig(lama);
  assert.equal(c.versi, 3);
  assert.equal(c.tingkat[0].sistemUjian, 'semester');
  assert.deepEqual(c.kitab[0].penempatan, []);
  assert.equal(daftarSistem(c).length, 2);
  // kitab tanpa penempatan berlaku untuk semua kelas dan periode di tingkatnya
  assert.equal(kitabCocok(c.kitab[0], { tingkat: 'Aliyah', kelas: 'XI', periode: 'sem2-uas' }), true);
});

test('kitabCocok: Fathul Mu\'in hanya di Tsanawiyah kelas VII (dua ujian) dan VIII (semua); kelas IX dan tingkat lain tidak', () => {
  const c = cfgContoh(); const k = c.kitab.find((x) => x.nama === "Fathul Mu'in");
  assert.equal(kitabCocok(k, { tingkat: 'Tsanawiyah' }), true, 'tanpa kelas: tetap ditawarkan');
  assert.equal(kitabCocok(k, { tingkat: 'Tsanawiyah', kelas: 'VII' }), true);
  assert.equal(kitabCocok(k, { tingkat: 'Tsanawiyah', kelas: 'VII', periode: 'sem1-uts' }), true);
  assert.equal(kitabCocok(k, { tingkat: 'Tsanawiyah', kelas: 'VII', periode: 'sem2-uas' }), false, 'VII hanya dua ujian pertama');
  assert.equal(kitabCocok(k, { tingkat: 'Tsanawiyah', kelas: 'VIII', periode: 'sem2-uas' }), true, 'periode kosong = semua periode kelas itu');
  assert.equal(kitabCocok(k, { tingkat: 'Tsanawiyah', kelas: 'IX' }), false);
  assert.equal(kitabCocok(k, { tingkat: 'Aliyah' }), false);
  assert.equal(kitabCocok(k, {}), true, 'tanpa tingkat: tidak menyaring');
});

test('cakupan, label, dan ringkasan penempatan', () => {
  const c = cfgContoh(); const k = c.kitab.find((x) => x.nama === "Fathul Mu'in");
  assert.equal(cakupanKitab(k, 'Tsanawiyah', 'VII', 'sem1-uas'), 'Shalat');
  assert.equal(cakupanKitab(k, 'Tsanawiyah', 'VIII', 'sem1-uas'), '');
  assert.equal(labelSistem(c, 'Ibtidaiyah'), 'Catur Wulan');
  assert.deepEqual(periodeUntuk(c, 'Ibtidaiyah').map((p) => p.kode), ['cw1', 'cw2', 'cw3']);
  assert.deepEqual(kelasUntuk(c, 'Tsanawiyah'), ['VII', 'VIII', 'IX']);
  assert.equal(sistemUntuk(c, 'Tsanawiyah').id, 'semester');
  const r = ringkasPenempatan(c, k);
  assert.equal(r.length, 1);
  assert.match(r[0], /Kelas VII: UTS Semester 1 \(Ganjil\), UAS Semester 1 \(Ganjil\)/);
  assert.match(r[0], /Kelas VIII: semua periode/);
  assert.equal(penempatanKitab(k, 'Tsanawiyah').length, 2);
  assert.deepEqual(penempatanYatim(c, k), []);
});

test('nama sistem dan nama ujian bisa diubah tanpa memutus kode yang dipakai soal', () => {
  const c = cfgContoh();
  assert.equal(labelPeriode(c, 'Tsanawiyah', 'sem1-uts'), 'UTS Semester 1 (Ganjil)');
  const baru = salin(c);
  baru.sistemUjian[0].label = 'Penilaian Semesteran';
  baru.sistemUjian[0].periode[0].label = 'Ujian Tengah Semester Ganjil';
  const c2 = sanitizeAppConfig(baru);
  assert.equal(labelPeriode(c2, 'Tsanawiyah', 'sem1-uts'), 'Ujian Tengah Semester Ganjil');
  assert.equal(labelSistem(c2, 'Tsanawiyah'), 'Penilaian Semesteran');
  // pemetaan kitab yang memakai kode lama tetap utuh
  assert.equal(c2.kitab.find((k) => k.nama === "Fathul Mu'in").penempatan[0].periode[0].kode, 'sem1-uts');
  // kode yang sudah dihapus dari sistem: label kembali ke kodenya, tidak melempar
  assert.equal(labelPeriode(c2, 'Tsanawiyah', 'hilang-9'), 'hilang-9');
  assert.equal(labelPeriode(c2, 'Tsanawiyah', ''), '');
});

test('sistem ujian buatan admin: periode urut, bisa 3 atau 4 (sampai 6), kode unik, tanpa nama ditolak', () => {
  const s = sanitizeSistemUjian([{ id: 'triwulan', label: 'Triwulan', periode: [{ kode: 'tw1', label: 'Ujian 1' }, { kode: 'tw2', label: 'Ujian 2' }, { kode: 'tw3', label: 'Ujian 3' }] }]);
  assert.deepEqual(s[0].periode.map((p) => p.kode), ['tw1', 'tw2', 'tw3']);
  assert.deepEqual(sanitizeSistemUjian([]), DEFAULT_SISTEM_UJIAN);
  assert.deepEqual(sanitizeSistemUjian(undefined), DEFAULT_SISTEM_UJIAN);
  const p = (extra) => ({ id: 'a', label: 'A', periode: [{ kode: 'a1', label: 'Satu' }], ...extra });
  assert.throws(() => sanitizeSistemUjian([p({ label: '  ' })]), /belum diberi nama/);
  assert.throws(() => sanitizeSistemUjian([p({ periode: [] })]), /minimal punya satu periode/);
  assert.throws(() => sanitizeSistemUjian([p({ periode: Array.from({ length: 7 }, (_, i) => ({ kode: 'k' + i, label: 'x' })) })]), /maksimal 6 periode/);
  assert.throws(() => sanitizeSistemUjian([p({ periode: [{ kode: 'a1', label: 'A' }, { kode: 'a1', label: 'B' }] })]), /dipakai dua kali/);
  assert.throws(() => sanitizeSistemUjian([p(), { ...p(), id: 'b', label: 'B' }]), /dipakai dua kali/, 'kode periode harus unik juga antar sistem');
  assert.throws(() => sanitizeSistemUjian([p(), p({ periode: [{ kode: 'z1', label: 'Z' }] })]), /tercatat dua kali/);
  assert.throws(() => sanitizeSistemUjian([p({ id: 'Ada Spasi!' })]), /tidak valid/);
  assert.throws(() => sanitizeSistemUjian([p({ periode: [{ kode: 'a1', label: '' }] })]), /tanpa nama/);
  assert.throws(() => sanitizeSistemUjian(Array.from({ length: 5 }, (_, i) => ({ id: 's' + i, label: 'S', periode: [{ kode: 'p' + i, label: 'P' }] }))), /maksimal 4/);
});

test('tingkat yang menunjuk sistem ujian yang tidak ada ditolak dengan pesan jelas', () => {
  const c = salin(DEFAULT_APP_CONFIG); c.tingkat[0].sistemUjian = 'tidak-ada';
  assert.throws(() => sanitizeAppConfig(c), /memakai sistem ujian "tidak-ada" yang tidak ada/);
});

test('penempatan: rujukan basi dibuang, duplikat digabung, urutan mengikuti konfigurasi, cakupan dipotong', () => {
  const c = salin(DEFAULT_APP_CONFIG);
  const k = c.kitab.find((x) => x.nama === "Fathul Mu'in"); k.tingkat = ['Tsanawiyah', 'Aliyah'];
  k.penempatan = [
    { tingkat: 'Tsanawiyah', kelas: 'IX', periode: [{ kode: 'sem2-uas', cakupan: 'x'.repeat(500) }, { kode: 'sem1-uts' }, { kode: 'sem1-uts' }] },
    { tingkat: 'Tsanawiyah', kelas: 'VII', periode: ['sem1-uas'] },
    { tingkat: 'Tsanawiyah', kelas: 'VII', periode: [{ kode: 'sem2-uts' }] }, // duplikat kelas: yang pertama menang
    { tingkat: 'Tsanawiyah', kelas: 'XII', periode: [] },                      // kelas bukan milik tingkat
    { tingkat: 'Ibtidaiyah', kelas: 'I', periode: [] },                       // tingkat tidak dipakai kitab ini
    { tingkat: 'Tsanawiyah', kelas: 'VIII', periode: [{ kode: 'cw1' }] },     // kode dari sistem lain
    { tingkat: 'Aliyah', kelas: 'X', periode: [{ kode: 'sem1-uts', cakupan: '<b>Bab 1</b>' }] },
    null, 'bukan objek',
  ];
  const out = sanitizeAppConfig(c).kitab.find((x) => x.nama === "Fathul Mu'in").penempatan;
  assert.deepEqual(out.map((p) => `${p.tingkat}/${p.kelas}`), ['Tsanawiyah/VII', 'Tsanawiyah/VIII', 'Tsanawiyah/IX', 'Aliyah/X']);
  assert.deepEqual(out[0].periode, [{ kode: 'sem1-uas', cakupan: '' }]);
  assert.deepEqual(out[1].periode, [], 'kode asing dibuang, kelas tetap (jadi semua periode)');
  assert.deepEqual(out[2].periode.map((x) => x.kode), ['sem1-uts', 'sem2-uas'], 'diurutkan sesuai urutan ujian, tanpa kode ganda');
  assert.equal(out[2].periode[1].cakupan.length, 120);
  assert.doesNotMatch(out[3].periode[0].cakupan, /[<>]/, 'tanda < > dibuang (cleanLine), jadi tidak bisa membawa tag');
});

test('penempatan ikut gugur bila tingkat dicabut dari kitab; sistem ujian tingkat diganti -> kode lama dibuang', () => {
  const c = cfgContoh();
  const k = c.kitab.find((x) => x.nama === "Fathul Mu'in"); k.tingkat = ['Aliyah'];
  assert.deepEqual(sanitizeAppConfig(c).kitab.find((x) => x.nama === "Fathul Mu'in").penempatan, []);
  const d = cfgContoh(); d.tingkat.find((t) => t.nama === 'Tsanawiyah').sistemUjian = 'caturwulan';
  const hasil = sanitizeAppConfig(d).kitab.find((x) => x.nama === "Fathul Mu'in").penempatan;
  assert.deepEqual(hasil.map((p) => [p.kelas, p.periode.length]), [['VII', 0], ['VIII', 0]], 'kelas tetap, kode semester tidak berlaku di catur wulan');
});

test('sanitize idempoten: hasil yang dibersihkan lalu dibersihkan lagi tidak berubah (dasar pemulihan cadangan)', () => {
  const a = cfgContoh();
  assert.deepEqual(sanitizeAppConfig(a), a);
  assert.deepEqual(sanitizeAppConfig(DEFAULT_APP_CONFIG), sanitizeAppConfig(sanitizeAppConfig(DEFAULT_APP_CONFIG)));
});

test('sanitizePenempatan: batas jumlah entri per kitab', () => {
  const t = [{ nama: 'X', kelas: Array.from({ length: 12 }, (_, i) => 'K' + i), sistemUjian: 'semester' }];
  const ok = sanitizePenempatan(t[0].kelas.map((kelas) => ({ tingkat: 'X', kelas, periode: [] })), ['X'], t, DEFAULT_SISTEM_UJIAN);
  assert.equal(ok.length, 12);
});

test('soal: kelas masuk metadata prompt AI; periode tidak perlu; kelas kosong tidak menambah baris', () => {
  const base = { teks: ARAB, tingkat: 'MTs', level: 'L1', nama: "Fathul Mu'in" };
  const i1 = validateInput({ ...base, kelas: ' VII ', periode: 'sem1-uts' });
  assert.equal(i1.kelas, 'VII');
  assert.match(buildUserPrompt(i1, 'A'), /Jenjang: Tsanawiyah \(MTs\)\nKelas: VII\nMata pelajaran/);
  const i2 = validateInput(base);
  assert.equal(i2.kelas, '');
  assert.doesNotMatch(buildUserPrompt(i2, 'A'), /Kelas:/);
  assert.equal(validateInput({ ...base, kelas: 'K'.repeat(99) }).kelas.length, 20);
});

test('cadangan: kelas dan periode ikut tersimpan bila ada, dan tidak muncul pada soal lama', () => {
  const soal = () => ({
    id: 'abc123', tingkat: 'Tsanawiyah', mapel: 'Fiqih', level: 'L1', nama: 'x', juz: '', hal: '', teks: '', stimulus: '', pertanyaan: 'q', indikator: '', sumberUrl: '',
    opsi: { A: 'a', B: 'b', C: 'c', D: 'd', E: 'e' }, kunci: 'A', pembahasan: '', ai: { dibuat: false, model: '', verifikasi: '', buta: '' }, status: 'draft', catatan: '',
    authorUid: 'u1', authorName: 'A', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal('kelas' in bersihkanSoal(soal()).data, false);
  assert.equal('periode' in bersihkanSoal(soal()).data, false);
  const { data } = bersihkanSoal({ ...soal(), kelas: 'VII', periode: 'sem1-uts' });
  assert.equal(data.kelas, 'VII'); assert.equal(data.periode, 'sem1-uts');
  assert.throws(() => bersihkanSoal({ ...soal(), kelas: 'K'.repeat(21) }), /Kelas terlalu panjang/);
  assert.throws(() => bersihkanSoal({ ...soal(), periode: 5 }), /Periode ujian harus berupa teks/);
});

test('firestore.rules: kelas dan periode OPSIONAL pada soal (klien dan soal lama tetap sah), batasnya sama dengan cadangan', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const soal = rules.slice(rules.indexOf('match /soal/{id}'), rules.indexOf('match /kamusPegon/{id}'));
  assert.match(soal, /function opsiKeys\(\) \{ return \['paket', 'dawr', 'cakupan', 'urut', 'kelas', 'periode', 'bab', 'bentuk', 'jawaban', 'rubrik', 'kitabId', 'halId', 'halIdAkhir'\]; \}/);
  assert.match(soal, /hasOnly\(createKeys\(\)\.concat\(opsiKeys\(\)\)\)/, 'create: boleh, bukan wajib');
  assert.match(soal, /hasAll\(createKeys\(\)\)/);
  assert.doesNotMatch(soal.slice(soal.indexOf('function createKeys'), soal.indexOf('function authorKeys')), /kelas|periode|bab|bentuk|jawaban|rubrik/, 'bukan bagian kunci wajib');
  assert.match(soal, /changed\(\)\.hasOnly\(authorKeys\(\)\.concat\(opsiKeys\(\)\)\)/, 'penyusun boleh mengisi kelas/periode saat mengubah');
  assert.match(soal, /'reviewerUid', 'reviewerName', 'reviewedAt', 'paket', 'dawr', 'cakupan', 'urut', 'kelas', 'periode', 'bab', 'bentuk', 'jawaban', 'rubrik', 'kitabId', 'halId', 'halIdAkhir'\]/, 'admin');
  assert.match(soal, /x\.kelas is string && x\.kelas\.size\(\) <= 20/);
  assert.match(soal, /x\.periode is string && x\.periode\.size\(\) <= 20/);
  assert.match(soal, /x\.bab is string && x\.bab\.size\(\) <= 120/, 'bab: batas sama dengan cadangan (120)');
  // peninjau (editor) tidak boleh mengubah kelas/periode: reviewKeys tidak memuatnya
  assert.doesNotMatch(soal.slice(soal.indexOf('function reviewKeys'), soal.indexOf('allow read')), /kelas|periode|bab|bentuk|jawaban|rubrik/);
});

test('konfigurasi yang terlalu besar ditolak dengan pesan jelas (batas dokumen Firestore)', () => {
  const c = salin(DEFAULT_APP_CONFIG);
  const kelas = Array.from({ length: 12 }, (_, i) => 'K' + (i + 1));
  c.tingkat[0].kelas = kelas;
  const semua = DEFAULT_SISTEM_UJIAN[0].periode.map((p) => ({ kode: p.kode, cakupan: 'c'.repeat(120) }));
  for (const k of c.kitab) { k.tingkat = ['Ibtidaiyah']; k.penempatan = kelas.map((kl) => ({ tingkat: 'Ibtidaiyah', kelas: kl, periode: semua })); }
  for (let i = 0; i < 150; i++) c.kitab.push({ ...salin(c.kitab[0]), nama: 'Kitab uji ' + i });
  assert.throws(() => sanitizeAppConfig(c), /Konfigurasi terlalu besar/);
});
