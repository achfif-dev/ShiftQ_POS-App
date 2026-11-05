// Pengaturan alur editor bertahap (config/alur): aktif atau tidak, jumlah tahap standar, dan jumlah tahap per mata pelajaran (fan).
// Disimpan di dokumen terpisah dari config/app supaya simpan/reset/pulihkan konfigurasi utama tidak menimpanya.
import { firestoreAdmin } from './platform.js';
import { ApiError } from './soalService.js';
import { normalisasiAlur } from './alurSoal.js';

const DOC = 'config/alur';
const TTL_MS = 30_000;
let cache = null;
export const invalidateAlur = () => { cache = null; };

/**
 * Baca pengaturan alur. `ketat: true` (dipakai penegakan di server): bila gagal dibaca, TOLAK, jangan diam-diam
 * jatuh ke "alur nonaktif" karena itu akan melonggarkan pemeriksaan bertingkat. Tanpa `ketat` (tampilan klien): jatuh ke bawaan.
 */
export async function bacaAlur({ now = Date.now(), ketat = false } = {}) {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  try {
    const { db } = await firestoreAdmin();
    const s = await db.doc(DOC).get();
    const value = normalisasiAlur(s.exists ? s.data().alur : null);
    cache = { at: now, value };
    return value;
  } catch (e) {
    console.error('[alurEditor] gagal membaca config/alur:', String((e && (e.code || e.message)) || e));
    if (ketat) throw new ApiError(503, 'ALUR_TIDAK_TERBACA', 'Pengaturan alur editor tidak terbaca. Coba lagi sebentar.');
    return normalisasiAlur(null);
  }
}

export async function simpanAlur(user, body) {
  const alur = normalisasiAlur(body && body.alur);
  const { db } = await firestoreAdmin();
  await db.doc(DOC).set({ alur, updatedBy: (user && (user.email || user.uid)) || '', updatedAt: new Date().toISOString() });
  invalidateAlur();
  return alur;
}
