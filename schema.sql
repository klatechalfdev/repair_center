-- REPAIR CENTER - skema PostgreSQL (dijalankan di logical DB "repair_center")

CREATE TABLE IF NOT EXISTS cabang (
  kode text PRIMARY KEY,
  nama text NOT NULL,
  aktif boolean DEFAULT true,
  maps_url text DEFAULT '',
  review_url text DEFAULT '',
  phone text DEFAULT ''
);

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text,
  pin text,
  nama text,
  cabang text,
  cabang_nama text,
  role text DEFAULT 'staff'
);

CREATE TABLE IF NOT EXISTS teknisi (
  id serial PRIMARY KEY,
  cabang text,
  nama text,
  hp text,
  bagi_hasil numeric DEFAULT 0,       -- persen (%) untuk tipe_bayar='bagihasil'
  tipe_bayar text DEFAULT 'bagihasil', -- 'gaji' | 'bagihasil'
  gaji numeric DEFAULT 0               -- nominal gaji tetap untuk tipe_bayar='gaji'
);

CREATE TABLE IF NOT EXISTS tiket (
  id text PRIMARY KEY,
  tanggal timestamptz DEFAULT now(),
  nama text,
  tipe text,
  teknisi text,
  status text DEFAULT 'Baru',
  total numeric DEFAULT 0,
  no_hp text,
  keluhan text,
  password text,
  kelengkapan text,
  garansi text,
  biaya_jasa numeric DEFAULT 0,
  biaya_sparepart numeric DEFAULT 0,
  garansi_end date,
  cabang text
);

CREATE TABLE IF NOT EXISTS ticket_photos (
  id serial PRIMARY KEY,
  ticket_id text,
  object_key text NOT NULL,
  url text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS keuangan (
  id serial PRIMARY KEY,
  tanggal timestamptz DEFAULT now(),
  item text,
  jenis text DEFAULT 'PENGELUARAN',
  deskripsi text,
  total numeric DEFAULT 0,
  foto_key text DEFAULT '',
  foto_url text DEFAULT '',
  cabang text
);

CREATE TABLE IF NOT EXISTS qc (
  ticket_id text PRIMARY KEY,
  tanggal timestamptz DEFAULT now(),
  cam_depan boolean DEFAULT false,
  cam_belakang boolean DEFAULT false,
  speaker boolean DEFAULT false,
  mic boolean DEFAULT false,
  wifi boolean DEFAULT false,
  charger boolean DEFAULT false,
  tombol boolean DEFAULT false,
  kelengkapan boolean DEFAULT false,
  catatan text DEFAULT '',
  cabang text DEFAULT '',
  by_user text DEFAULT ''
);
