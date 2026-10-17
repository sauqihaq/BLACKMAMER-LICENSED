# Panel Kontrol Server — Indo Universe (versi Netlify)

Panel web buat ngatur game dari jauh: **kunci game**, **tendang semua pemain**, **matiin/nyalain fitur**.
Jalan di **Netlify** (Functions + Blobs), nggak perlu server sendiri.
Script di game: `ServerScriptService.RemoteControl` (sudah ada di place Indo Universe).

    Panel web  ->  Netlify Function (/api/*)  <-  script RemoteControl di tiap server game (nanya tiap 30 detik)
                        |
                  Netlify Blobs (nyimpen status kunci, fitur, server hidup, riwayat)

Perintah dari panel nyampe ke game dalam sekitar 30 detik. Kalau Netlify lagi down, **game tetap jalan** (fail-open).

## 1. Deploy ke Netlify

Cara paling gampang (lewat GitHub):

1. Upload isi folder ini ke repo GitHub baru (private).
2. Netlify -> **Add new site -> Import an existing project** -> pilih repo itu.
   Setting build kebaca otomatis dari `netlify.toml` (nggak perlu isi build command).
3. **Site configuration -> Environment variables**, tambah dua variabel:

   | Nama | Isi |
   |---|---|
   | `ADMIN_PASSWORD` | password login panel, min 10 karakter |
   | `GAME_KEY` | kunci rahasia antara Netlify dan game, min 24 karakter |

   Bikin `GAME_KEY` acak: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
4. **Deploy**. Kalau variabel baru diisi setelah deploy pertama, trigger deploy ulang.
5. Buka `https://NAMA-SITE.netlify.app`, login pakai `ADMIN_PASSWORD`.
   Kalau muncul "Server belum dikonfigurasi", berarti env var belum kebaca (cek ejaan, lalu deploy ulang).

Alternatif lewat CLI: `npm install`, `npx netlify-cli login`, `npx netlify-cli init`, set env var di dashboard,
lalu `npx netlify-cli deploy --prod`. **Jangan** drag-and-drop folder: function butuh `npm install` dan itu
nggak dijalankan di cara itu.

## 2. Sambungin ke game

Di Studio, buka `ServerScriptService.RemoteControl`, isi bagian `CONFIG`:

- `API_URL` = `https://NAMA-SITE.netlify.app` (tanpa `/` di akhir)
- `GAME_KEY` = sama persis dengan di Netlify
- `BYPASS_USERIDS` = UserId lo (biar lo tetap bisa masuk pas game dikunci)

Lalu Publish place. Beberapa detik setelah ada server yang jalan, server itu dan daftar fitur muncul di panel.
Buat ngetes pas Play di Studio, set `ENFORCE_IN_STUDIO = true` dan isi `BYPASS_USERIDS`, biar nggak nendang diri sendiri.

## 3. Pakai panel

- **Kunci game**: pilih sekarang atau dijadwal (1 menit sampai 1 jam). Kalau dijadwal, pemain lihat banner hitung mundur
  (pakai UI `ServerRestartNotice` yang sudah ada). Setelah habis, semua ditendang dan pemain baru ditolak.
- **Buka kunci game**: game normal lagi.
- **Tendang semua pemain**: sekali tendang di semua server, mereka boleh join lagi.
- **Fitur game**: toggle per fitur. Daftar fitur ada di `FEATURES` dalam script RemoteControl
  (tiap fitur = script/folder yang di-disable). Tes tiap fitur dulu, terutama Boxing, Pool, dan Uno karena
  pemain bisa nyangkut di tengah sesi.

Fitur pembelian (MonetizationHandler, donate/shop Robux) sengaja nggak dimasukin: mematikan handler
pembelian bikin pembelian pemain nggak keproses.

## Pemakaian & biaya

Tiap server game nembak Netlify sekali per 30 detik: satu server hidup 24 jam kira-kira 86 ribu request per bulan.
Makin banyak server (termasuk server VIP), makin banyak request. Netlify sekarang pakai sistem kredit
dan aturannya bisa berubah, jadi cek halaman **Usage** di dashboard Netlify setelah beberapa hari.
Kalau mepet, naikin `POLL_INTERVAL` di script (misal 60), konsekuensinya perintah nyampe lebih lambat.
Panel sendiri cuma refresh tiap 10 detik selama tab-nya kebuka.

## Catatan jujur

- **Ini bukan proteksi mutlak.** Siapa pun yang punya akses edit ke place bisa buka script itu dan hapus.
  Pengaman yang lebih kuat: tahan publish versi final / transfer kepemilikan sampai lunas.
- Kunci jarak jauh yang disembunyiin dari client bisa jadi masalah hukum, etika, dan reputasi kalau ketahuan.
  Paling aman dicantumkan di kontrak (misal sebagai "kunci lisensi sampai pelunasan") dan dihapus setelah lunas.
  Gue bukan pengacara, jadi konsultasi dulu kalau nilai proyeknya besar.
- Siapa pun yang tahu `GAME_KEY` cuma bisa baca status dan lapor server palsu, nggak bisa ngatur apa-apa.
  Kontrol penuh tetap butuh `ADMIN_PASSWORD`. Ganti keduanya kalau bocor.
- Tes otomatis logika backend ada di `tests/` (`npm test`, nggak butuh Netlify).
