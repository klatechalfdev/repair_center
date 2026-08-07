# REPAIR CENTER

Sistem ticketing servis HP multi-cabang. Migrasi dari Google Apps Script (Google Sheets + Drive) ke **Node.js + Express + PostgreSQL + Object Storage (S3/MinIO)**, dijalankan sebagai **Quick App** di nrapken.

## Fitur
- Login (email + PIN), role admin/staff, multi-cabang
- Tiket: input, daftar (filter bulan/status/cabang/cari), detail & edit, ubah status inline
- Upload foto nota (ke object storage)
- Keuangan (pengeluaran) per cabang
- Quality Control (checklist) + cetak nota QC (thermal 80mm)
- Cetak nota pelanggan & teknisi (80mm)
- Dashboard (statistik status, omset harian, grafik)
- Export Excel
- Notifikasi WhatsApp (wa.me link)

## Arsitektur
- `server.js` — Express. Endpoint tunggal `POST /api/rpc` yang meng-emulasi `google.script.run`.
  Frontend lama nyaris tak berubah karena ada shim `google.script.run` -> `fetch('/api/rpc')` di `index.html`.
- `public/index.html` — UI (frontend asli Apps Script + shim).
- Auth: token HMAC stateless. Server memverifikasi token dari DB; argumen `auth` dari client diabaikan untuk otorisasi.

## Environment variables (runtime)
DB di-inject otomatis saat database di-attach ke Quick App:
- `DATABASE_URL` (atau `DB_HOST`,`DB_PORT`,`DB_USERNAME`,`DB_PASSWORD`,`DB_DATABASE`)

Object storage (set manual dari kredensial bucket):
- `S3_ENDPOINT` — mis. `https://s3.nrapken.dev:8443`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `S3_BUCKET` — nama fisik bucket (minio_bucket)
- `S3_PUBLIC_URL` — base URL publik bucket
- `S3_REGION` — default `us-east-1`

Lain-lain:
- `SESSION_SECRET` — kunci HMAC untuk token login (WAJIB di-set di produksi)
- `TZ` — default `Asia/Jakarta`

## Skema database
Lihat `schema.sql`. Tabel: `cabang`, `users`, `teknisi`, `tiket`, `ticket_photos`, `keuangan`, `qc`.

## Jalankan lokal
```
npm install
# set env DATABASE_URL & S3_* dulu
npm start
```
