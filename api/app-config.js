// POST /api/app-config: konfigurasi aplikasi (tingkat, mata pelajaran, katalog kitab).
// aksi "baca": semua pengguna aktif (menyertakan pengaturan alur editor). aksi "simpan", "reset", dan "alursimpan": khusus admin.
import { route, authenticateAuthor, authenticateAdmin } from '../src/platform.js';
import { ApiError } from '../src/soalService.js';
import { bacaAplikasi, simpanApp, resetApp } from '../src/appConfig.js';
import { bacaAlur, simpanAlur } from '../src/alurEditor.js';

export default route(async (req) => {
  const aksi = req.body && req.body.aksi;
  const u = aksi === 'baca' ? await authenticateAuthor(req) : await authenticateAdmin(req);
  if (aksi === 'baca') return { ...(await bacaAplikasi()), alur: await bacaAlur() };
  if (aksi === 'alursimpan') return { alur: await simpanAlur(u, req.body) };
  if (aksi === 'simpan') return simpanApp(u, req.body);
  if (aksi === 'reset') return resetApp();
  throw new ApiError(400, 'BAD_REQUEST', 'Aksi harus baca, simpan, reset, atau alursimpan.');
});
