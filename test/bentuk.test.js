// Bentuk soal baru: pilihan ganda (bawaan), melanjutkan (pilihan), benar-salah, melanjutkan (isian), uraian.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BENTUK_IDS, bentukDari, bentukSah, punyaOpsi, bentukUntukTingkat, dianjurkan, kunciTeks, selaraskan, periksaSoal, adaPenanda,
} from '../src/bentuk.js';
import {
  generateSoal, validateInput, normalizeSoal, buildUserPrompt, systemPromptFor, SYSTEM_PROMPT, toolSoalFor, TOOL_SOAL, ApiError,
} from '../src/soalService.js';
import { telaahSoal, validateSoalDraft } from '../src/assistService.js';
import { cekButa } from '../src/cekButa.js';
import { bersihkanSoal } from '../src/backup.js';
import { bidangDariAI, bidangDariSoal } from '../src/kutipan.js';
import { buatKisi } from '../src/kisi.js';
import { __setFirebaseForTest } from '../src/platform.js';
import { invalidateAiConfig } from '../src/aiConfig.js';
import generateHandler from '../api/generate.js';

const TEKS = 'الْمِيَاهُ الَّتِي يَجُوزُ بِهَا التَّطْهِيرُ سَبْعُ مِيَاهٍ: مَاءُ السَّمَاءِ، وَمَاءُ الْبَحْرِ، وَمَاءُ النَّهْرِ';
const base = { teks: TEKS, nama: 'Fathul Qarib', tingkat: 'MA', level: 'L1', mapel: 'Fiqih' };
const fakeClient = (input, name = 'buat_soal') => {
  const calls = [];
  return { calls, messages: { create: async (req) => { calls.push(req); return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] }; } } };
};
const pg = { stimulus: '', pertanyaan: 'Air manakah yang sah untuk bersuci?', pilihan_a: 'Air kelapa', pilihan_b: 'Air laut', pilihan_c: 'Air teh', pilihan_d: 'Air mawar', pilihan_e: 'Air jeruk', kunci_jawaban: 'B', pembahasan: 'مَاءُ الْبَحْرِ termasuk tujuh air.', indikator_kisi_kisi: 'Peserta didik dapat menyebutkan air suci.' };

test('bentukDari/bentukSah: soal lama (tanpa bentuk) = pilihan ganda; nilai asing ditolak oleh bentukSah', () => {
  assert.equal(bentukDari({}), 'pilgan');
  assert.equal(bentukDari(undefined), 'pilgan');
  assert.equal(bentukDari({ bentuk: 'ISIAN' }), 'isian');
  assert.equal(bentukDari({ bentuk: 'ngawur' }), 'pilgan');
  assert.equal(bentukSah(''), 'pilgan');
  assert.equal(bentukSah(undefined), 'pilgan');
  assert.equal(bentukSah('uraian'), 'uraian');
  assert.equal(bentukSah('constructor'), null);
  assert.equal(bentukSah('__proto__'), null);
  assert.deepEqual(BENTUK_IDS, ['pilgan', 'lanjutan', 'benarsalah', 'isian', 'uraian']);
});

test('bentukUntukTingkat: saran per jenjang; tingkat buatan admin mendapat semua bentuk', () => {
  assert.equal(bentukUntukTingkat('Ibtidaiyah')[0], 'lanjutan');
  assert.ok(!bentukUntukTingkat('MI').includes('uraian'));
  assert.ok(bentukUntukTingkat('Aliyah (MA)').includes('uraian'));
  assert.deepEqual(bentukUntukTingkat('Kelas Khusus'), BENTUK_IDS);
  assert.equal(dianjurkan('MI', 'uraian'), false);
});

test('periksaSoal: syarat kirim berbeda per bentuk', () => {
  const o = { A: 'a', B: 'b', C: 'c', D: 'd', E: 'e' };
  assert.deepEqual(periksaSoal({ pertanyaan: 'x?', opsi: o, kunci: 'A', pembahasan: 'p' }), []); // soal lama
  assert.match(periksaSoal({ bentuk: 'lanjutan', pertanyaan: 'Musafir boleh qashar jika', opsi: o, kunci: 'A', pembahasan: 'p' }).join(), /titik-titik/);
  assert.deepEqual(periksaSoal({ bentuk: 'lanjutan', pertanyaan: 'Musafir boleh qashar jika .....', opsi: o, kunci: 'A', pembahasan: 'p' }), []);
  assert.match(periksaSoal({ bentuk: 'benarsalah', pertanyaan: 'Pernyataan', kunci: '', pembahasan: 'p' }).join(), /Benar atau Salah/);
  assert.deepEqual(periksaSoal({ bentuk: 'benarsalah', pertanyaan: 'Pernyataan', kunci: 'B', pembahasan: 'p' }), []);
  assert.match(periksaSoal({ bentuk: 'isian', pertanyaan: 'Syarat ada .....', jawaban: '', pembahasan: 'p' }).join(), /Jawaban isian/);
  assert.deepEqual(periksaSoal({ bentuk: 'isian', pertanyaan: 'Syarat ada .....', jawaban: 'lima', pembahasan: 'p' }), []);
  assert.match(periksaSoal({ bentuk: 'uraian', pertanyaan: 'Jelaskan!', jawaban: 'j', rubrik: '', pembahasan: 'p' }).join(), /penskoran/);
  assert.deepEqual(periksaSoal({ bentuk: 'uraian', pertanyaan: 'Jelaskan!', jawaban: 'j', rubrik: '1) x (skor 2)', pembahasan: 'p' }), []);
  assert.ok(adaPenanda('abc …') && adaPenanda('abc ___') && !adaPenanda('abc ..'));
});

test('selaraskan: opsi dan kunci mengikuti bentuk; pindah bentuk tidak membawa sisa bentuk lama', () => {
  const o = { A: 'a', B: 'b', C: 'c', D: 'd', E: 'e' };
  assert.deepEqual(selaraskan({ bentuk: 'isian', opsi: o, kunci: 'C', jawaban: 'lima', rubrik: 'x' }),
    { bentuk: 'isian', opsi: { A: '', B: '', C: '', D: '', E: '' }, kunci: '', jawaban: 'lima', rubrik: '' });
  const bs = selaraskan({ bentuk: 'benarsalah', opsi: o, kunci: 'C', jawaban: 'z' });
  assert.deepEqual(bs.opsi, { A: 'Benar', B: 'Salah', C: '', D: '', E: '' });
  assert.equal(bs.kunci, ''); assert.equal(bs.jawaban, '');
  assert.equal(selaraskan({ bentuk: 'benarsalah', kunci: 'B' }).kunci, 'B');
  assert.equal(selaraskan({ opsi: o, kunci: 'D' }).bentuk, 'pilgan');
});

test('kunciTeks: huruf, Benar/Salah, atau jawaban bertulis', () => {
  assert.equal(kunciTeks({ kunci: 'C' }), 'C');
  assert.equal(kunciTeks({ bentuk: 'benarsalah', kunci: 'A' }), 'Benar');
  assert.equal(kunciTeks({ bentuk: 'benarsalah', kunci: 'B' }), 'Salah');
  assert.equal(kunciTeks({ bentuk: 'isian', jawaban: ' lima ' }), 'lima');
  assert.equal(punyaOpsi('uraian'), false);
  assert.equal(punyaOpsi('benarsalah'), true);
});

test('validateInput: bentuk kosong = pilihan ganda; bentuk asing ditolak 400', () => {
  assert.equal(validateInput(base).bentuk, 'pilgan');
  assert.equal(validateInput({ ...base, bentuk: 'isian' }).bentuk, 'isian');
  assert.throws(() => validateInput({ ...base, bentuk: 'esai' }), (e) => e instanceof ApiError && e.status === 400);
});

test('pilgan: prompt dan skema TIDAK berubah dari sebelum fitur bentuk; keluaran tanpa field baru', async () => {
  assert.equal(systemPromptFor('pilgan'), SYSTEM_PROMPT);
  assert.equal(systemPromptFor(undefined), SYSTEM_PROMPT);
  assert.equal(toolSoalFor('pilgan'), TOOL_SOAL);
  const c = fakeClient(pg);
  const r = await generateSoal(base, { client: c, random: () => 0.5 });
  assert.deepEqual(Object.keys(r).sort(), ['indikator_kisi_kisi', 'kunci_jawaban', 'pembahasan', 'pertanyaan', 'pilihan_a', 'pilihan_b', 'pilihan_c', 'pilihan_d', 'pilihan_e', 'stimulus']);
  assert.doesNotMatch(c.calls[0].messages[0].content, /Bentuk soal/);
  assert.match(c.calls[0].messages[0].content, /Letakkan jawaban benar di opsi C/);
});

test('lanjutan: kalimat menggantung berpenanda titik-titik, tetap lima opsi', async () => {
  const c = fakeClient({ ...pg, pertanyaan: 'Seorang musafir boleh mengqashar shalat apabila .....', pilihan_a: 'tinggal di rumahnya', pilihan_b: 'menempuh jarak dua marhalah', pilihan_c: 'sedang bermukim', pilihan_d: 'bepergian dekat', pilihan_e: 'berada di kampungnya' });
  const r = await generateSoal({ ...base, bentuk: 'lanjutan' }, { client: c, random: () => 0 });
  assert.equal(r.bentuk, 'lanjutan'); assert.equal(r.kunci_jawaban, 'B');
  const req = c.calls[0];
  assert.match(req.system, /MELANJUTKAN \(PILIHAN GANDA\)/);
  assert.equal(req.tools[0], TOOL_SOAL); // skema lima opsi
  assert.match(req.messages[0].content, /Bentuk soal: Melanjutkan \(pilihan\)/);
  // AI lupa titik-titik -> ditolak agar tidak lolos sebagai kalimat tanya biasa
  await assert.rejects(generateSoal({ ...base, bentuk: 'lanjutan' }, { client: fakeClient(pg) }), (e) => e.code === 'AI_BAD_OUTPUT' && /titik/.test(e.message));
});

test('benarsalah: target A/B diacak, opsi dipaksa Benar/Salah, kunci hanya A atau B', async () => {
  const bs = { stimulus: '', pertanyaan: 'Air laut termasuk air yang sah untuk bersuci.', kunci_jawaban: 'A', pembahasan: 'مَاءُ الْبَحْرِ termasuk.', indikator_kisi_kisi: 'Peserta didik dapat menilai pernyataan.' };
  const c1 = fakeClient(bs);
  const r = await generateSoal({ ...base, bentuk: 'benarsalah' }, { client: c1, random: () => 0.1 });
  assert.deepEqual([r.pilihan_a, r.pilihan_b, r.pilihan_c, r.pilihan_d, r.pilihan_e], ['Benar', 'Salah', '', '', '']);
  assert.equal(r.bentuk, 'benarsalah');
  assert.match(c1.calls[0].messages[0].content, /pernyataan yang BENAR/);
  assert.deepEqual(c1.calls[0].tools[0].input_schema.properties.kunci_jawaban.enum, ['A', 'B']);
  assert.ok(!('pilihan_a' in c1.calls[0].tools[0].input_schema.properties));
  const c2 = fakeClient({ ...bs, kunci_jawaban: 'B' });
  await generateSoal({ ...base, bentuk: 'benarsalah' }, { client: c2, random: () => 0.9 });
  assert.match(c2.calls[0].messages[0].content, /pernyataan yang SALAH/);
  await assert.rejects(generateSoal({ ...base, bentuk: 'benarsalah' }, { client: fakeClient({ ...bs, kunci_jawaban: 'C' }) }), (e) => e.code === 'AI_BAD_OUTPUT');
});

test('isian: tanpa opsi, jawaban wajib, titik-titik wajib, stimulus tidak diwajibkan walau L2', async () => {
  const isian = { stimulus: '', pertanyaan: 'Air yang sah untuk bersuci ada ..... macam.', jawaban: 'tujuh', pembahasan: 'سَبْعُ مِيَاهٍ', indikator_kisi_kisi: 'Peserta didik dapat menyebutkan jumlah air suci.' };
  const c = fakeClient(isian);
  const r = await generateSoal({ ...base, bentuk: 'isian', level: 'L2' }, { client: c });
  assert.equal(r.bentuk, 'isian'); assert.equal(r.jawaban, 'tujuh'); assert.equal(r.kunci_jawaban, ''); assert.equal(r.pilihan_a, ''); assert.equal(r.rubrik, '');
  const req = c.calls[0];
  assert.match(req.system, /MELANJUTKAN \(ISIAN\)/);
  assert.ok(req.tools[0].input_schema.required.includes('jawaban'));
  assert.ok(!('pilihan_a' in req.tools[0].input_schema.properties));
  assert.doesNotMatch(req.messages[0].content, /Letakkan jawaban benar/);
  await assert.rejects(generateSoal({ ...base, bentuk: 'isian' }, { client: fakeClient({ ...isian, jawaban: ' ' }) }), (e) => e.code === 'AI_BAD_OUTPUT' && /jawaban/.test(e.message));
  await assert.rejects(generateSoal({ ...base, bentuk: 'isian' }, { client: fakeClient({ ...isian, pertanyaan: 'Berapa macam air suci?' }) }), (e) => e.code === 'AI_BAD_OUTPUT');
});

test('uraian: jawaban model dan rubrik wajib; L2/L3 tetap wajib stimulus', async () => {
  const ur = { stimulus: 'Santri bepergian jauh.', pertanyaan: 'Jelaskan syarat qashar!', jawaban: 'Jarak dua marhalah dan bukan maksiat.', rubrik: '1) jarak (skor 2); 2) bukan maksiat (skor 2); Skor maksimal 4', pembahasan: 'p', indikator_kisi_kisi: 'Peserta didik dapat menjelaskan syarat qashar.' };
  const r = await generateSoal({ ...base, bentuk: 'uraian', level: 'L2' }, { client: fakeClient(ur) });
  assert.equal(r.bentuk, 'uraian'); assert.match(r.rubrik, /Skor maksimal/);
  await assert.rejects(generateSoal({ ...base, bentuk: 'uraian' }, { client: fakeClient({ ...ur, rubrik: '' }) }), (e) => /penskoran/.test(e.message));
  await assert.rejects(generateSoal({ ...base, bentuk: 'uraian', level: 'L3' }, { client: fakeClient({ ...ur, stimulus: '' }) }), (e) => /stimulus/.test(e.message));
});

test('normalizeSoal tanpa argumen bentuk = perilaku lama', () => {
  assert.equal(normalizeSoal(pg, 'L1').kunci_jawaban, 'B');
  assert.throws(() => normalizeSoal({ ...pg, pilihan_a: pg.pilihan_b }, 'L1'), /kembar/);
});

test('telaah isian: skema perbaikan tanpa opsi, naskah dikirim lengkap, hasil bertipe isian', async () => {
  const perbaikan = { stimulus: '', pertanyaan: 'Air suci ada ..... macam.', jawaban: 'tujuh', pembahasan: 'p', indikator_kisi_kisi: 'Peserta didik dapat menyebutkan.' };
  const c = fakeClient({ verdict: 'layak', temuan: [], perbaikan, ringkasan_perubahan: 'Tidak ada perubahan.' }, 'hasil_telaah');
  const r = await telaahSoal({ ...base, bentuk: 'isian', soal: { pertanyaan: 'Air suci ada ..... macam.', jawaban: 'tujuh', pembahasan: 'p' } }, { client: c });
  assert.equal(r.perbaikan.bentuk, 'isian'); assert.equal(r.perbaikan.jawaban, 'tujuh'); assert.equal(r.perbaikan.pilihan_a, '');
  const req = c.calls[0];
  assert.match(req.system, /MELANJUTKAN \(ISIAN\)/);
  assert.ok(!('pilihan_a' in req.tools[0].input_schema.properties.perbaikan.properties));
  assert.match(req.messages[0].content, /"jawaban": "tujuh"/);
  await assert.rejects(telaahSoal({ ...base, bentuk: 'isian', soal: { pertanyaan: 'Air suci ada ..... macam.' } }, { client: c }), (e) => e.code === 'SOAL_KOSONG');
});

test('telaah pilgan tetap memakai skema lima opsi', async () => {
  const c = fakeClient({ verdict: 'layak', temuan: [], perbaikan: pg, ringkasan_perubahan: 'x' }, 'hasil_telaah');
  const r = await telaahSoal({ ...base, soal: { pertanyaan: 'Air manakah?', opsi: { A: 'a', B: 'b', C: 'c' }, kunci: 'B' } }, { client: c });
  assert.equal(r.perbaikan.kunci_jawaban, 'B');
  assert.ok('pilihan_e' in c.calls[0].tools[0].input_schema.properties.perbaikan.properties);
  assert.doesNotMatch(c.calls[0].messages[0].content, /Bentuk soal/);
});

test('validateSoalDraft: benar-salah memaksa opsi Benar/Salah dan membuang C-E', () => {
  const d = validateSoalDraft({ pertanyaan: 'P', opsi: { A: 'x', B: 'y', C: 'z' }, kunci: 'C' }, 'benarsalah');
  assert.deepEqual(d.opsi, { A: 'Benar', B: 'Salah', C: '', D: '', E: '' }); assert.equal(d.kunci, '');
});

test('cekButa: ditolak untuk isian/uraian (tak ada opsi), jalan untuk benar-salah', async () => {
  await assert.rejects(cekButa({ pertanyaan: 'x ..... y', jawaban: 'z' }, TEKS, { bentuk: 'isian', client: fakeClient({}) }), (e) => e.code === 'BENTUK_TANPA_OPSI' && e.status === 422);
  const c = fakeClient({ jawaban: 'A', alasan: 'sesuai teks' }, 'jawab_soal');
  const r = await cekButa({ pertanyaan: 'Air laut sah untuk bersuci.', opsi: { A: 'Benar', B: 'Salah' }, kunci: 'A' }, TEKS, { bentuk: 'benarsalah', client: c });
  assert.equal(r.status, 'sepakat');
});

test('backup: bentuk, jawaban, rubrik divalidasi; pilihan ganda tidak menambah field (soal lama sama persis)', () => {
  const dasar = { id: 'abc123', tingkat: 'MA', mapel: 'Fiqih', level: 'L1', status: 'draft', kunci: '', opsi: {}, authorUid: 'u1', authorName: 'A', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ai: { dibuat: false, model: '', verifikasi: '', buta: '' } };
  const lama = bersihkanSoal({ ...dasar, pertanyaan: 'x' }).data;
  assert.ok(!('bentuk' in lama) && !('jawaban' in lama) && !('rubrik' in lama));
  const isian = bersihkanSoal({ ...dasar, bentuk: 'isian', pertanyaan: 'a .....', jawaban: 'lima' }).data;
  assert.equal(isian.bentuk, 'isian'); assert.equal(isian.jawaban, 'lima');
  assert.throws(() => bersihkanSoal({ ...dasar, bentuk: 'esai' }), (e) => e.status === 422);
  assert.throws(() => bersihkanSoal({ ...dasar, bentuk: 'uraian', rubrik: 'r'.repeat(2001) }), (e) => e.status === 422);
});

test('kutipan/sikap: jawaban dan rubrik ikut diperiksa hanya bila ada', () => {
  assert.ok(!('jawaban' in bidangDariAI(pg)));
  assert.equal(bidangDariAI({ jawaban: 'x', rubrik: 'y' }).jawaban, 'x');
  assert.equal(bidangDariSoal({ jawaban: 'x' }).jawaban, 'x');
  assert.ok(!('jawaban' in bidangDariSoal({ pertanyaan: 'p' })));
});

test('kisi-kisi: bentuk soal ikut tercatat per butir dan di ringkasan', () => {
  const k = buatKisi([{ bab: 'Thaharah', level: 'L1', indikator: 'Peserta didik dapat a', bentuk: 'isian' }, { bab: 'Thaharah', level: 'L2', indikator: 'Peserta didik dapat b' }]);
  assert.equal(k.kelompok[0].soal[0].bentuk, 'Melanjutkan (isian)');
  assert.equal(k.kelompok[0].soal[1].bentuk, 'Pilihan ganda');
  assert.deepEqual(k.meta.bentuk, ['Melanjutkan (isian)', 'Pilihan ganda']);
});

test('firestore.rules: bentuk, jawaban, rubrik opsional dan dibatasi; kunci wajib tidak berubah', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const soal = rules.slice(rules.indexOf('match /soal/{id}'), rules.indexOf('match /kamusPegon/{id}'));
  assert.match(soal, /x\.bentuk in \['pilgan', 'lanjutan', 'benarsalah', 'isian', 'uraian'\]/);
  assert.match(soal, /x\.jawaban\.size\(\) <= 2000/);
  assert.match(soal, /x\.rubrik\.size\(\) <= 2000/);
  assert.match(soal, /function opsiKeys\(\) \{ return \[[^\]]*'bentuk', 'jawaban', 'rubrik'(, 'kitabId', 'halId', 'halIdAkhir')?\]/);
});

// ---- handler: /api/generate membawa bentuk sampai ke respons ----
function fakeFirebase() {
  const store = { 'users/u1': { role: 'penyusun' } };
  const ref = (path) => ({ path, get: async () => ({ exists: path in store, data: () => store[path] }) });
  return { store, auth: { verifyIdToken: async (t) => { if (t !== 'tok') throw new Error('bad'); return { uid: 'u1' }; } }, FieldValue: {},
    db: { doc: ref, runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, v) => { store[r.path] = v; } }) } };
}
const mkRes = () => { const r = { h: {}, setHeader(k, v) { r.h[k] = v; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };

test('handler /api/generate: bentuk isian sampai ke respons; bentuk asing ditolak sebelum memakai kuota', async () => {
  const saved = { fetch: globalThis.fetch, k: process.env.GEMINI_API_KEY, p: process.env.AI_PROVIDER };
  const fb = fakeFirebase(); let dipanggil = 0;
  process.env.AI_PROVIDER = 'gemini'; process.env.GEMINI_API_KEY = 'kunci-' + Math.random();
  globalThis.fetch = async () => { dipanggil++; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'buat_soal', args: { stimulus: '', pertanyaan: 'Air suci ada ..... macam.', jawaban: 'tujuh', pembahasan: 'سَبْعُ مِيَاهٍ', indikator_kisi_kisi: 'Peserta didik dapat menyebutkan.' } } }] } }] }) }; };
  __setFirebaseForTest(fb); invalidateAiConfig();
  try {
    const res = mkRes();
    await generateHandler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { ...base, bentuk: 'isian' } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(res.body.soal.bentuk, 'isian'); assert.equal(res.body.soal.jawaban, 'tujuh');
    const bad = mkRes();
    await generateHandler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { ...base, bentuk: 'esai' } }, bad);
    assert.equal(bad.code, 400); assert.equal(dipanggil, 1);
    assert.equal(fb.store['rate/u1'].dayCount, 1); // yang ditolak tidak menghabiskan kuota
  } finally {
    globalThis.fetch = saved.fetch; __setFirebaseForTest(null); invalidateAiConfig();
    process.env.GEMINI_API_KEY = saved.k ?? ''; process.env.AI_PROVIDER = saved.p ?? '';
  }
});
