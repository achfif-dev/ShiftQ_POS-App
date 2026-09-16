# Setup Sistem Lisensi Anti-Bajakan (WAJIB sebelum jual ke pelanggan pertama)

Fitur ini membuat aplikasi hanya bisa dipakai oleh device yang sudah diaktivasi dengan kode
lisensi yang KAMU (developer/penjual) terbitkan sendiri per pelanggan — tanpa perlu kamu login
atau setting manual ke HP pelanggan sama sekali (self-service penuh dari sisi pelanggan).

Butuh **satu proyek Firebase** (Blaze plan — pay as you go, tapi pemakaian Cloud Functions
untuk skala ini biasanya masuk free tier / sangat murah) yang KAMU kelola sendiri, dipakai
bersama oleh SEMUA pelanggan yang membeli aplikasi ini (bukan satu proyek per pelanggan).

## 1. Buat/pakai proyek Firebase

Kalau belum punya, ikuti langkah 1-2 di `FIREBASE_SETUP.md` dulu (buat proyek, daftarkan app
Android, download `google-services.json`, taruh di folder `app/`).

Upgrade proyek ke **Blaze plan** (Firebase Console > klik nama proyek > Upgrade) — Cloud
Functions tidak bisa jalan di plan gratis (Spark). Blaze tetap punya free tier bulanan yang
sangat cukup untuk ribuan aktivasi/bulan.

## 2. Generate keypair RSA (sekali saja)

```bash
cd functions
npm install
node scripts/generate-license-keypair.js
```

Ini membuat 2 file di root repo:
- `license_private_key.pem` — **RAHASIA**, jangan pernah commit (sudah di `.gitignore`).
- `license_public_key_base64.txt` — aman dibagikan, akan ditempel ke kode app.

## 3. Pasang public key ke app

Buka `app/src/main/java/com/example/posapp/data/license/LicenseCrypto.kt`, cari baris:

```kotlin
private const val LICENSE_PUBLIC_KEY_BASE64 = "PASTE_PUBLIC_KEY_BASE64_DI_SINI_SETELAH_GENERATE"
```

Ganti isi string-nya dengan isi file `license_public_key_base64.txt` (satu baris, tanpa
header/footer `-----BEGIN...-----`).

## 4. Pasang private key sebagai secret Cloud Functions

```bash
firebase functions:secrets:set LICENSE_PRIVATE_KEY
```

Saat diminta, tempel ISI file `license_private_key.pem` apa adanya (termasuk baris
`-----BEGIN PRIVATE KEY-----` dan `-----END PRIVATE KEY-----`), lalu Enter/Ctrl+D.

## 5. Deploy Cloud Functions

```bash
cd functions
npm install
firebase deploy --only functions,firestore:rules
```

Ini mendeploy `activateLicense`, `revalidateLicense`, `saveGatewayCredentials`,
`createQrisCharge`, `midtransNotification`, sekaligus memasang `firestore.rules` (yang
mengunci koleksi `licenses`/`gateway_credentials` supaya tidak bisa dibaca langsung dari HP
mana pun).

## 6. Terbitkan lisensi setiap ada pelanggan baru

Download service account key sekali: Firebase Console > Project Settings > Service Accounts >
**Generate new private key**, simpan sebagai `functions/service-account.json` (sudah otomatis
di-`.gitignore`, JANGAN commit — ini kredensial admin penuh).

Setiap ada pelanggan baru membeli aplikasi:

```bash
cd functions
node scripts/issue-license.js --customer "Toko Sinar Jaya" --plan standard --devices 1
```

Akan tercetak kode lisensi seperti `POS-A1B2-C3D4-E5F6`. Kirim kode ini + file APK ke
pelanggan (WhatsApp/email) — pelanggan tinggal buka aplikasi, tempel kode di layar Aktivasi,
selesai. Kamu tidak perlu menyentuh HP pelanggan sama sekali.

Perintah lain yang tersedia:
```bash
# Pelanggan ganti HP — lepas device lama dari lisensi supaya bisa aktivasi ulang di HP baru
node scripts/issue-license.js --key POS-A1B2-C3D4-E5F6 --release-device <deviceId>

# Pelanggan berhenti berlangganan / menunggak — nonaktifkan lisensinya
node scripts/issue-license.js --deactivate POS-A1B2-C3D4-E5F6
```
(`deviceId` bisa dilihat di Firestore Console > koleksi `licenses` > dokumen lisensi terkait >
field `devices`, kalau perlu melepas device tertentu.)

## Cara kerja singkat (untuk konteks debugging)

- Aktivasi PERTAMA wajib online (device memanggil Cloud Function `activateLicense`, dapat
  sertifikat yang ditandatangani RSA-2048 — lihat `LicenseCrypto.kt`).
- Setelahnya app **100% bisa offline SELAMANYA** — status dihitung lokal dari sertifikat
  tersimpan. Lisensi ini SEKALI BAYAR (bukan langganan): sertifikat TIDAK PERNAH kedaluwarsa
  berdasarkan waktu, tidak ada token yang perlu "diperpanjang" (lihat bagian "Model Lisensi" di
  `README.md`).
- `LicenseSyncWorker` sesekali memanggil `checkLicenseStatus` SECARA OPORTUNISTIK tiap ada
  internet (setiap 12 jam dicek) — BUKAN untuk memperpanjang apa pun, HANYA untuk mendeteksi
  kalau penjual menonaktifkan lisensi ini (refund/chargeback/bajakan). Gagal (offline dsb.)
  TIDAK PERNAH mengunci apa pun — fail-open.
- Kalau device tidak pernah online lagi setelah aktivasi, lisensi TETAP AKTIF selamanya di
  device itu — trade-off yang sengaja diambil demi filosofi offline-first app ini. TIDAK ADA
  batas hari offline yang memaksa revalidasi (versi dokumen ini sebelumnya menyebut "30+14
  hari" dari desain langganan lama yang sudah tidak dipakai lagi — lihat riwayat bug di
  `README.md`).

## Build APK generik (tanpa perlu build khusus per pelanggan)

Karena identitas pelanggan ada di kode lisensi (bukan di dalam APK), kamu **cukup build SATU
APK** untuk semua pelanggan (lewat GitHub Actions yang sudah ada, atau Android Studio). Setiap
pelanggan mengaktifkan APK yang sama dengan kode lisensi masing-masing — tidak perlu build
ulang atau kustomisasi APK per pelanggan.
