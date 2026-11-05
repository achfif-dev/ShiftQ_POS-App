// Penghubung server: Firebase Admin (login + Firestore), pembungkus rute, batas pemakaian.
// firebase-admin dimuat saat dibutuhkan agar modul ini tetap bisa diuji tanpa paketnya.
import { ApiError, toApiError } from './soalService.js';
import { tahapDitugaskan } from './alurSoal.js';
import { STAFF, AUTHORS, parseList, initialRole, domainAllowed, rateDecision, shouldPromote, refundable, refundState } from './access.js';

export const num = (name, def) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : def; };
export const aiLimits = () => ({ perMinute: num('LIMIT_PER_MINUTE', 5), perDay: num('LIMIT_PER_DAY', 60) });
// Plafon pemakaian AI untuk SELURUH madrasah per hari (menjaga kuota gratis penyedia dan biaya). Bukan per pengguna.
export const GLOBAL_AI_ID = 'global_ai';
export const globalAiLimits = () => ({ perMinute: 1_000_000, perDay: num('LIMIT_GLOBAL_PER_DAY', 1000) });
// Peran Ustadz: batas dan kolam harian TERPISAH dari tim penyusun, supaya pemakaian ustadz tidak menghabiskan kuota tim.
export const GLOBAL_USTADZ_ID = 'global_ai_ustadz';
export const ustadzLimits = () => ({ perMinute: num('LIMIT_USTADZ_PER_MINUTE', 3), perDay: num('LIMIT_USTADZ_PER_DAY', 15) });
export const globalUstadzLimits = () => ({ perMinute: 1_000_000, perDay: num('LIMIT_USTADZ_GLOBAL_PER_DAY', 300) });
export const kitabUstadzLimits = () => ({ perMinute: num('LIMIT_USTADZ_KITAB_PER_MINUTE', 5), perDay: num('LIMIT_USTADZ_KITAB_PER_DAY', 50) });
/** Kolam plafon harian AI untuk satu peran: id dokumen rate/{id}, batas, dan batas per pengguna. */
export const aiPool = (role) => (role === 'ustadz'
  ? { id: GLOBAL_USTADZ_ID, global: globalUstadzLimits(), user: ustadzLimits(), pesan: 'Kuota AI harian untuk ustadz sudah habis. Coba lagi besok, atau minta admin menaikkan LIMIT_USTADZ_GLOBAL_PER_DAY.' }
  : { id: GLOBAL_AI_ID, global: globalAiLimits(), user: aiLimits(), pesan: 'Kuota AI harian seluruh madrasah sudah habis. Coba lagi besok, atau minta admin menaikkan LIMIT_GLOBAL_PER_DAY.' });
export const kitabLimitsFor = (role) => (role === 'ustadz' ? kitabUstadzLimits() : kitabLimits());
export const kitabLimits = () => ({ perMinute: num('LIMIT_KITAB_PER_MINUTE', 10), perDay: num('LIMIT_KITAB_PER_DAY', 200) });

/* ------------------------------------------------------------- Firebase Admin */
let fb = null;
export const __setFirebaseForTest = (x) => { fb = x; };

function serviceAccount() {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) throw new ApiError(500, 'SERVER_NOT_CONFIGURED', 'Server belum dikonfigurasi: FIREBASE_SERVICE_ACCOUNT belum diisi.');
  try {
    return JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new ApiError(500, 'SERVER_NOT_CONFIGURED', 'FIREBASE_SERVICE_ACCOUNT bukan JSON atau base64 yang valid.');
  }
}

async function firebase() {
  if (fb) return fb;
  const [{ initializeApp, cert, getApps }, { getAuth }, { getFirestore, FieldValue }] = await Promise.all([
    import('firebase-admin/app'), import('firebase-admin/auth'), import('firebase-admin/firestore'),
  ]);
  const app = getApps()[0] || initializeApp({ credential: cert(serviceAccount()) });
  fb = { auth: getAuth(app), db: getFirestore(app), FieldValue };
  return fb;
}

/** Akses Firebase Admin untuk modul lain (mis. src/aiConfig.js). */
export const firestoreAdmin = () => firebase();

/* ------------------------------------------------------------- Autentikasi */
const AUTH_MSG = 'Sesi berakhir. Masuk lagi dengan akun Google Anda.';

export async function authenticate(req) {
  const m = /^Bearer (.+)$/.exec(req.headers?.authorization || '');
  if (!m) throw new ApiError(401, 'AUTH_REQUIRED', AUTH_MSG);
  const { auth } = await firebase();
  try {
    return await auth.verifyIdToken(m[1]);
  } catch {
    throw new ApiError(401, 'AUTH_REQUIRED', AUTH_MSG);
  }
}

/** Login valid DAN peran aktif (penyusun, editor, admin). */
export async function authenticateStaff(req) {
  const u = await authenticate(req);
  const { db } = await firebase();
  const snap = await db.doc(`users/${u.uid}`).get();
  if (!snap.exists || !STAFF.includes(snap.data().role)) {
    throw new ApiError(403, 'FORBIDDEN_ROLE', 'Akun Anda belum disetujui admin untuk memakai fitur ini.');
  }
  return u;
}

/** Login valid DAN peran pemakai alat AI (penyusun, editor, admin, ustadz). Mengembalikan token + `role`. */
export async function authenticateAuthor(req) {
  const u = await authenticate(req);
  const { db } = await firebase();
  const snap = await db.doc(`users/${u.uid}`).get();
  const role = snap.exists ? snap.data().role : null;
  if (!AUTHORS.includes(role)) {
    throw new ApiError(403, 'FORBIDDEN_ROLE', 'Akun Anda belum disetujui admin untuk memakai fitur ini.');
  }
  return { ...u, role };
}

/** Login valid DAN peran admin. */
export async function authenticateAdmin(req) {
  const u = await authenticate(req);
  const { db } = await firebase();
  const snap = await db.doc(`users/${u.uid}`).get();
  if (!snap.exists || snap.data().role !== 'admin') {
    throw new ApiError(403, 'FORBIDDEN_ROLE', 'Fitur ini hanya untuk admin.');
  }
  return u;
}

/** Login valid DAN peran editor atau admin (peninjau). */
export async function authenticateReviewer(req) {
  const u = await authenticate(req);
  const { db } = await firebase();
  const snap = await db.doc(`users/${u.uid}`).get();
  if (!snap.exists || !['editor', 'admin'].includes(snap.data().role)) {
    throw new ApiError(403, 'FORBIDDEN_ROLE', 'Fitur ini hanya untuk editor dan admin.');
  }
  return { ...u, role: snap.data().role, tahapEditor: tahapDitugaskan(snap.data()) };
}

/** Membuat/menyegarkan dokumen users/{uid}. Admin pertama berasal dari ADMIN_EMAILS. */
export async function ensureProfile(u) {
  if (!u.email || !u.email_verified) throw new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Email akun Google Anda belum terverifikasi.');
  const domain = process.env.ALLOWED_EMAIL_DOMAIN || '';
  if (!domainAllowed(u.email, domain)) {
    throw new ApiError(403, 'DOMAIN_NOT_ALLOWED', `Hanya akun dengan email @${domain.replace(/^@/, '')} yang boleh masuk.`);
  }
  const wanted = initialRole(u.email, u.email_verified, parseList(process.env.ADMIN_EMAILS));
  const { db, FieldValue } = await firebase();
  const ref = db.doc(`users/${u.uid}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const profile = { email: u.email, name: u.name || u.email, photoURL: u.picture || '', lastLoginAt: FieldValue.serverTimestamp() };
    if (!snap.exists) tx.set(ref, { ...profile, role: wanted, createdAt: FieldValue.serverTimestamp() });
    else tx.update(ref, shouldPromote(snap.data().role, wanted) ? { ...profile, role: 'admin' } : profile);
  });
}

/** Batas per pengguna di semua instance (Firestore: rate/{docId}). */
export async function enforceRate(docId, limits, { pesanHarian } = {}) {
  const { db } = await firebase();
  const ref = db.doc(`rate/${docId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = rateDecision(snap.data(), Date.now(), limits);
    if (!d.ok) {
      const msg = d.code === 'RATE_LIMIT_DAILY'
        ? (pesanHarian || 'Kuota harian Anda untuk fitur ini habis. Coba lagi besok.')
        : `Terlalu banyak permintaan. Coba lagi dalam ${d.retryAfter} detik.`;
      throw new ApiError(429, d.code, msg, { retryAfter: d.retryAfter });
    }
    tx.set(ref, d.state);
  });
}

/** Kuota AI: batas per pengguna lalu plafon harian kolam peran (tim atau ustadz). Bila plafon penuh, hitungan pengguna dikembalikan. */
export async function enforceAi(uid, role) {
  const pool = aiPool(role);
  await enforceRate(uid, pool.user);
  try {
    await enforceRate(pool.id, pool.global, { pesanHarian: pool.pesan });
  } catch (e) { await refundRate(uid); throw e; }
}

/** Mengembalikan satu hitungan kuota (dipakai saat AI gagal di sisi server). Tidak pernah melempar galat. */
export async function refundRate(docId) {
  try {
    const { db } = await firebase();
    const ref = db.doc(`rate/${docId}`);
    await db.runTransaction(async (tx) => {
      const next = refundState((await tx.get(ref)).data(), Date.now());
      if (next) tx.set(ref, next);
    });
  } catch (e) { console.error('[rate] gagal mengembalikan kuota:', e?.code ?? e?.message); }
}

/** Jalankan `fn`; bila gagal karena masalah server/AI, kuota `docId` dikembalikan lalu galat dilempar ulang. */
export async function withRefund(docId, fn, extraIds = []) {
  try { return await fn(); } catch (e) {
    if (refundable(e)) { await refundRate(docId); for (const id of extraIds) await refundRate(id); }
    throw e;
  }
}

/* ------------------------------------------------------------------ Rute */
/** Galat Firebase/Firestore (kode gRPC atau pesan khas) -> pesan yang menunjuk penyebabnya. */
export function firebaseError(e) {
  const code = e?.code;
  const msg = String(e?.message || '');
  if (code === 5 || code === 'not-found' || /NOT_FOUND/.test(msg)) {
    return new ApiError(500, 'FIRESTORE_NOT_FOUND', 'Database Firestore belum dibuat atau berada di proyek lain. Buat Firestore di Firebase Console (Build > Firestore Database > Create database) dan pastikan kunci akun layanan berasal dari proyek yang sama.');
  }
  if (code === 7 || code === 'permission-denied' || /PERMISSION_DENIED|has not been used|is disabled/.test(msg)) {
    return new ApiError(500, 'FIRESTORE_PERMISSION', 'Akun layanan tidak diizinkan memakai Firestore. Aktifkan "Cloud Firestore API" di Google Cloud Console untuk proyek ini, lalu coba lagi.');
  }
  if (/app\/invalid-credential|invalid_grant|Failed to parse private key|Invalid PEM|DECODER/.test(msg + ' ' + code)) {
    return new ApiError(500, 'SERVER_CREDENTIAL', 'Kunci akun layanan (FIREBASE_SERVICE_ACCOUNT) tidak valid atau sudah dihapus. Buat kunci baru dan perbarui di Vercel.');
  }
  if (/Cannot find (package|module)/.test(msg)) {
    return new ApiError(500, 'SERVER_DEPENDENCY', 'Paket firebase-admin tidak terpasang di server. Pastikan package.json ikut ter-push dan deploy ulang.');
  }
  return null;
}

/** Galat polos tanpa status/nama SDK AI = masalah sisi server sendiri: tampilkan ringkasan agar mudah dilacak. */
export function serverError(e) {
  if (!e || typeof e !== 'object' || e.status || /^API/.test(String(e.name || ''))) return null;
  const msg = String(e.message || '').replace(/\s+/g, ' ').slice(0, 220);
  if (!msg) return null;
  return new ApiError(500, 'SERVER_ERROR', `Galat di server: ${msg}`);
}

export function sendError(res, e) {
  const err = e instanceof ApiError ? e : (firebaseError(e) || serverError(e) || toApiError(e));
  if (!(e instanceof ApiError)) console.error('[api] error tak terduga:', e?.code ?? e?.status, e?.message); // jangan bocorkan ke klien
  if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
  return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}) } });
}

/** Membungkus handler: metode, tanpa cache, galat seragam. `fn(req)` mengembalikan objek JSON. */
export const route = (fn, { method = 'POST' } = {}) => async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== method) { res.setHeader('Allow', method); throw new ApiError(405, 'METHOD_NOT_ALLOWED', `Gunakan metode ${method}.`); }
    return res.status(200).json(await fn(req));
  } catch (e) {
    return sendError(res, e);
  }
};
