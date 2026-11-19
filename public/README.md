# Tanya UU Ketenagakerjaan

Tanya jawab ketenagakerjaan berdasarkan UU Nomor 27 Tahun 2026, dengan nomor pasal di setiap jawaban. Berjalan di Cloudflare Workers, dengan basis regulasi di D1.

> Informasi ini bersifat umum dan bukan nasihat hukum.

## Struktur

- `src/index.js`: Worker. Mencari pasal relevan di D1, memanggil model AI, membatasi pemakaian per IP, dan menyimpan jawaban di KV.
- `public/index.html`: antarmuka tanya jawab.
- `migrations/0001_init.sql`: skema tabel `regulasi`.
- `migrations/0002_seed.sql`: isi awal basis (dari indeks pasal UU 27/2026).
- `data/kb.json`: sumber isi basis dalam format JSON, untuk pembaruan berikutnya.
- `.github/workflows/deploy.yml`: deploy otomatis setiap push ke `main`.

## Penyiapan (sekali)

1. Buat database D1 dan KV di Cloudflare:
   ```
   npx wrangler d1 create tanya-hr
   npx wrangler kv namespace create KV
   ```
   Salin ID yang muncul ke `wrangler.toml` (ganti `GANTI_DENGAN_ID_*`).
2. Model default adalah Workers AI, jadi tidak perlu kunci API tambahan. Jika nanti ingin memakai penyedia lain, isi `LLM_BASE_URL` di `wrangler.toml` dan simpan kuncinya:
   ```
   npx wrangler secret put LLM_API_KEY
   ```
3. Di GitHub, tambahkan secret repo: `CLOUDFLARE_API_TOKEN` dan `CLOUDFLARE_ACCOUNT_ID`.
4. Jalankan lokal untuk uji:
   ```
   npm install
   npx wrangler d1 migrations apply tanya-hr --local
   npm run dev
   ```

## Ganti penyedia model

Ubah `LLM_BASE_URL`, `LLM_MODEL`, dan `LLM_API_KEY`. Endpoint harus kompatibel dengan format OpenAI chat completions. Model gratis berbeda kualitasnya untuk bahasa hukum Indonesia, jadi uji dulu dengan kumpulan pertanyaan sebelum rilis.

## Batasan saat ini

- Pencarian masih sederhana (kecocokan kata). Pengembangan berikutnya: pencarian per pasal dan teks UU lengkap.
- Verifikasi Turnstile belum dipasang. Tambahkan jika pemakaian publik meningkat.
- Pembaruan otomatis dari sumber resmi belum dibuat. Saat ini isi basis diperbarui lewat migrasi.
- Konten perlu ditinjau ahli hukum ketenagakerjaan sebelum dipublikasikan luas.

## Memperbarui isi basis

Ubah `data/kb.json`, lalu buat migrasi baru di `migrations/` dengan `INSERT` atau `UPDATE` sesuai perubahan. Jalankan `npx wrangler d1 migrations apply tanya-hr --remote`.
