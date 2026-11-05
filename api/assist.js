// POST /api/assist: tanya-jawab bersumber atas perpustakaan (tanyakitab), pemeriksaan soal terhadap halaman rujukan (periksarujukan, gratis), terjemah teks, baca foto kitab (fotokitab), analisis teks, telaah dan perbaikan soal, uji jawab buta, saran bab penting, serta bantuan AI Pegon.
import { route, authenticateAuthor, authenticateReviewer, enforceAi, enforceRate, withRefund, aiPool, firestoreAdmin, num } from '../src/platform.js';
import { setujui, mintaRevisi, catatButa } from '../src/review.js';
import { bacaAlur } from '../src/alurEditor.js';
import { bentukSah } from '../src/bentuk.js';
import { parseList } from '../src/access.js';
import { DEFAULT_HOSTS } from '../src/kitabFetch.js';
import { loadAiConfig } from '../src/aiConfig.js';
import { muatTingkatKustom } from '../src/appConfig.js';
import { ApiError, validateInput, getModel } from '../src/soalService.js';
import { terjemahTeks, analisisTeks, telaahSoal, validateTeks } from '../src/assistService.js';
import { cekButa } from '../src/cekButa.js';
import { sarankanBab, validateBab } from '../src/babService.js';
import { perkuatPegon, fotoPegon, validatePegon, validateFoto } from '../src/pegonService.js';
import { fotoKitab } from '../src/fotoKitab.js';
import { generatePaket, validatePaket } from '../src/paketService.js';
import { periksaKutipan, bidangDariAI, bidangDariSoal } from '../src/kutipan.js';
import { periksaSikap } from '../src/sikap.js';
import { denganKitab, peringatanOtoritas } from '../src/otoritas.js';
import { tanyaKitab, validasiTanya } from '../src/telaahKitab.js';
import { periksaRujukan } from '../src/periksaRujukan.js';

const ASSIST = {
  terjemah: terjemahTeks,
  analisis: analisisTeks,
  telaah: telaahSoal,
  cekbuta: (body) => { const v = validateInput(body); return cekButa(body.soal, v.teks, { tingkat: body.tingkat, bentuk: v.bentuk }); },
  pegon: perkuatPegon,
  pegonfoto: fotoPegon,
  fotokitab: fotoKitab, // OCR teks Arab dari foto halaman kitab fisik
  paket: generatePaket, // satu segmen teks -> beberapa butir naskah IMDA (tanpa narasi, 3 opsi, kutipan kitab terverifikasi)
  tanyakitab: tanyaKitab, // tanya-jawab bersumber atas perpustakaan: dua panggilan AI, kutipan diverifikasi kode (src/telaahKitab.js)
  bab: sarankanBab, // saran bab penting untuk diujikan (haluan Aswaja); daftar isi opsional, bukan teks Arab wajib
};

export default route(async (req) => {
  // Persetujuan soal: bukan pemakaian AI (tanpa kuota AI), hanya editor/admin. Ada di sini agar jumlah fungsi Vercel tidak bertambah.
  if (req.body && (req.body.aksi === 'setujui' || req.body.aksi === 'revisi')) {
    const r = await authenticateReviewer(req);
    await enforceRate(`${r.uid}_review`, { perMinute: num('LIMIT_REVIEW_PER_MINUTE', 30), perDay: num('LIMIT_REVIEW_PER_DAY', 1000) });
    const { db, FieldValue } = await firestoreAdmin();
    const alur = await bacaAlur({ ketat: true }); // gagal baca = tolak (jangan melonggarkan pemeriksaan bertingkat)
    if (req.body.aksi === 'revisi') return mintaRevisi(db, FieldValue, { id: req.body.id, uid: r.uid, nama: r.name || r.email, role: r.role, catatan: req.body.catatan, alur, tahapEditor: r.tahapEditor });
    return setujui(db, FieldValue, { id: req.body.id, uid: r.uid, nama: r.name || r.email, role: r.role, catatan: req.body.catatan, alur, tahapEditor: r.tahapEditor,
      hosts: parseList(process.env.KITAB_ALLOWED_HOSTS).length ? parseList(process.env.KITAB_ALLOWED_HOSTS) : DEFAULT_HOSTS, sumberWajib: process.env.SUMBER_WAJIB === '1' });
  }
  const u = await authenticateAuthor(req);
  const aksi = req.body && req.body.aksi;
  if (aksi === 'periksarujukan') { // soal vs halaman rujukan di perpustakaan: gratis, tanpa AI dan tanpa kuota AI
    await enforceRate(`${u.uid}_periksa`, { perMinute: num('LIMIT_PERIKSA_PER_MINUTE', 20), perDay: num('LIMIT_PERIKSA_PER_DAY', 500) });
    return { aksi, hasil: await periksaRujukan(req.body) };
  }
  const run = Object.hasOwn(ASSIST, aksi) ? ASSIST[aksi] : null;
  if (!run) throw new ApiError(400, 'BAD_REQUEST', 'Aksi harus terjemah, analisis, telaah, cekbuta, paket, bab, tanyakitab, periksarujukan, pegon, pegonfoto, atau fotokitab.');
  // Paket Dauri (satu naskah utuh, banyak panggilan AI) hanya untuk tim penyusun; tab-nya juga tidak ada di aplikasi Ustadz. Ditolak sebelum validasi dan kuota.
  if (aksi === 'paket' && u.role === 'ustadz') throw new ApiError(403, 'FORBIDDEN_ROLE', 'Paket Dauri tidak tersedia untuk peran Ustadz.');
  await muatTingkatKustom(); // tingkat buatan admin ikut dikenali validasi
  // Otoritas kitab dibaca server dari perpustakaan lewat kitabId (hanya aksi yang memilih materi atau menyusun soal); `_kitab` kiriman klien selalu ditimpa.
  const PAKAI_KITAB = ['terjemah', 'analisis', 'telaah', 'paket', 'bab'];
  const body = PAKAI_KITAB.includes(aksi) ? await denganKitab(req.body) : req.body;
  let teks;
  if (aksi === 'pegon') validatePegon(body); // teks Latin, bukan Arab: jangan lewat validateTeks
  else if (aksi === 'pegonfoto' || aksi === 'fotokitab') validateFoto(body);
  else if (aksi === 'paket') validatePaket(body); // segmen <= 6.000 karakter, bentuk dan level tiap butir; tolak input cacat sebelum menghabiskan kuota
  else if (aksi === 'tanyakitab') validasiTanya(body); // pertanyaan 3-500 karakter, maks 4 kitab; tolak input cacat sebelum menghabiskan kuota
  else if (aksi === 'bab') validateBab(body); // nama kitab + daftar isi (Arab atau Latin); tolak input cacat sebelum menghabiskan kuota
  else if (aksi === 'telaah' || aksi === 'cekbuta') teks = validateInput(body).teks; else teks = validateTeks(body).teks;
  await loadAiConfig(); // pengaturan AI dari admin (kunci, model, penyedia); sebelum menghitung kuota
  await enforceAi(u.uid, u.role);
  const hasil = await withRefund(u.uid, () => run(body), [aiPool(u.role).id]); // gagal di sisi server/AI: kuota dikembalikan
  if (aksi === 'cekbuta') {
    // Catatan server atas hasil uji buta untuk isi yang persis sama: dipakai gerbang persetujuan (src/review.js), bukan klaim di dokumen soal.
    const { db, FieldValue } = await firestoreAdmin();
    await catatButa(db, FieldValue, { teks: req.body.teks, bentuk: bentukSah(req.body.bentuk) || 'pilgan', soal: req.body.soal, status: hasil.status, uid: u.uid, model: getModel() });
  }
  if (aksi === 'telaah') {
    // Gratis, tanpa AI: periksa kutipan pada naskah asli dan pada perbaikan dari AI.
    hasil.verifikasi_naskah = periksaKutipan(bidangDariSoal(req.body.soal), teks);
    hasil.verifikasi_perbaikan = periksaKutipan(bidangDariAI(hasil.perbaikan), teks);
    hasil.sikap_perbaikan = periksaSikap(bidangDariAI(hasil.perbaikan));
  }
  const peringatan = peringatanOtoritas(body._kitab);
  return { aksi, hasil, model: getModel(), ...(peringatan ? { peringatanOtoritas: peringatan } : {}) };
});
