'use strict';
process.env.TZ = process.env.TZ || 'Asia/Jakarta';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const ExcelJS = require('exceljs');

/* =========================================================
 * CONFIG
 * =======================================================*/
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'repair-center-dev-secret-change-me';

// DB: nrapken injects DATABASE_URL on attach; fall back to discrete vars.
function buildPgConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
  };
}
const pool = new Pool(buildPgConfig());

// Object storage (MinIO / S3)
const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_PUBLIC_URL = (process.env.S3_PUBLIC_URL || '').replace(/\/+$/, '');
const s3 = new S3Client({
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || '',
    secretAccessKey: process.env.S3_SECRET_KEY || ''
  }
});
const S3_ENABLED = !!(S3_BUCKET && S3_PUBLIC_URL && process.env.S3_ENDPOINT && process.env.S3_ACCESS_KEY);

/* =========================================================
 * SMALL UTILS
 * =======================================================*/
function num(v) {
  const n = Number(String(v == null ? '' : v).replace(/[^\d.-]/g, ''));
  return isFinite(n) ? n : 0;
}
function fmtIDR(n) {
  n = Math.round(Number(n) || 0);
  return 'Rp. ' + n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x)) return '';
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}
function ym(d) { const s = ymd(d); return s ? s.slice(0, 7) : ''; }
function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x])); }

/* =========================================================
 * AUTH / TOKEN (stateless HMAC)
 * =======================================================*/
function signToken(userId) {
  const payload = Buffer.from(JSON.stringify({ id: userId, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function parseToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig !== expect) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch (e) { return null; }
}
function isAdminRole(role) { return /^(admin|manager|owner|super)$/i.test(String(role || '')); }

async function userFromToken(token) {
  const p = parseToken(token);
  if (!p || !p.id) return null;
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [p.id]);
  if (!rows.length) return null;
  const u = rows[0];
  const cabInfo = await getCabangInfo(u.cabang);
  return {
    id: u.id,
    email: u.email || '',
    nama: u.nama || u.email || 'User',
    cabang: u.cabang || '',
    cabangNama: u.cabang_nama || (cabInfo ? cabInfo.nama : u.cabang) || '',
    role: u.role || 'staff',
    isAdmin: isAdminRole(u.role),
    cabangMaps: cabInfo ? cabInfo.maps : ''
  };
}

/* =========================================================
 * CABANG
 * =======================================================*/
async function getCabangInfo(kodeAtauNama) {
  const want = norm(kodeAtauNama);
  if (!want) return null;
  const { rows } = await pool.query(
    'SELECT * FROM cabang WHERE aktif=true AND (lower(kode)=$1 OR lower(nama)=$1) LIMIT 1', [want]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { kode: r.kode || '', nama: r.nama || '', maps: r.maps_url || '', review: r.review_url || '', phone: r.phone || '' };
}
async function listCabang() {
  const { rows } = await pool.query('SELECT kode, nama FROM cabang WHERE aktif=true ORDER BY nama');
  return rows.map(r => ({ kode: r.kode || '', nama: r.nama || '' }));
}

/* =========================================================
 * AUTH LOGIN
 * =======================================================*/
async function authLogin(payload) {
  const email = (payload && payload.email || '').trim();
  const pin = (payload && payload.pin || '').trim();

  const conds = [];
  const args = [];
  if (email) { args.push(email.toLowerCase()); conds.push(`lower(email)=$${args.length}`); }
  if (pin) { args.push(pin); conds.push(`pin=$${args.length}`); }
  if (!conds.length) throw new Error('Isi email atau PIN.');

  const { rows } = await pool.query(`SELECT * FROM users WHERE ${conds.join(' AND ')}`, args);
  if (!rows.length) throw new Error('Email/PIN tidak cocok.');
  if (rows.length > 1) throw new Error('Data user ganda. Pastikan email/PIN unik.');

  const u = rows[0];
  const cabInfo = await getCabangInfo(u.cabang);
  return {
    email: u.email || email || '',
    nama: u.nama || email || 'User',
    cabang: u.cabang || 'CAB-1',
    cabangNama: u.cabang_nama || (cabInfo ? cabInfo.nama : u.cabang) || u.cabang,
    role: u.role || 'staff',
    isAdmin: isAdminRole(u.role),
    cabangMaps: cabInfo ? cabInfo.maps : '',
    token: signToken(u.id)
  };
}

/* =========================================================
 * TEKNISI
 * =======================================================*/
async function listTechnicians(auth) {
  let sql = 'SELECT cabang, nama, hp FROM teknisi';
  const args = [];
  if (!(auth && auth.isAdmin)) { args.push(norm(auth && auth.cabang)); sql += ` WHERE lower(cabang)=$1`; }
  sql += ' ORDER BY nama';
  const { rows } = await pool.query(sql, args);
  return rows.map(r => ({ cabang: r.cabang || '', nama: r.nama || '', hp: r.hp || '' }));
}
async function findTechnicianPhone(namaTeknisi) {
  if (!namaTeknisi) return '';
  const { rows } = await pool.query('SELECT hp FROM teknisi WHERE trim(nama)=trim($1) LIMIT 1', [String(namaTeknisi)]);
  return rows.length ? (rows[0].hp || '') : '';
}

/* =========================================================
 * PHOTOS (S3)
 * =======================================================*/
async function uploadPhoto(fileObj, prefix) {
  if (!S3_ENABLED) throw new Error('Object storage belum dikonfigurasi.');
  if (!fileObj || !fileObj.b64) return null;
  const bytes = Buffer.from(fileObj.b64, 'base64');
  const rawExt = String(fileObj.name || '').split('.').pop() || 'bin';
  const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const rand = crypto.randomBytes(5).toString('hex');
  const key = `${prefix}/${Date.now()}-${rand}.${ext}`;
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET, Key: key, Body: bytes,
    ContentType: fileObj.type || 'application/octet-stream'
  }));
  return { key, url: `${S3_PUBLIC_URL}/${key}` };
}
async function deletePhotoObject(key) {
  if (!S3_ENABLED || !key) return;
  try { await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key })); } catch (e) { /* ignore */ }
}

/* =========================================================
 * TIKET
 * =======================================================*/
function mapTicket(r) {
  return {
    id: r.id || '',
    tanggal: ymd(r.tanggal),
    nama: r.nama || '',
    noHp: r.no_hp || '',
    teknisi: r.teknisi || '',
    tipe: r.tipe || '',
    password: r.password || '',
    kelengkapan: r.kelengkapan || '',
    keluhan: r.keluhan || '',
    garansi: r.garansi || '',
    status: r.status || '',
    biayaJasa: num(r.biaya_jasa),
    biayaSparepart: num(r.biaya_sparepart),
    total: num(r.total),
    garansiBerakhir: r.garansi_end ? ymd(r.garansi_end) : '',
    cabang: r.cabang || ''
  };
}

function newTicketId() {
  const d = new Date();
  return 'TK' + `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function createTicket(payload, auth) {
  payload = payload || {};
  const bj = num(payload.biayaJasa || 0);
  const bs = num(payload.biayaSparepart || 0);
  const total = (payload.totalBiaya != null && payload.totalBiaya !== '') ? num(payload.totalBiaya) : (bj + bs);

  // Upload photos (jika ada)
  const photoUrls = [];
  if (Array.isArray(payload.fotos)) {
    for (const f of payload.fotos) { const up = await uploadPhoto(f, 'tickets'); if (up) photoUrls.push(up); }
  }
  if (payload.fotoSparepart && payload.fotoSparepart.b64) {
    const up = await uploadPhoto(payload.fotoSparepart, 'tickets'); if (up) photoUrls.push(up);
  }

  // Insert with unique-id retry
  let id = newTicketId();
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await pool.query(
        `INSERT INTO tiket (id,tanggal,nama,tipe,teknisi,status,total,no_hp,keluhan,password,kelengkapan,garansi,biaya_jasa,biaya_sparepart,garansi_end,cabang)
         VALUES ($1,now(),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, payload.namaPelanggan || '', payload.tipeHp || '', payload.teknisi || '', payload.status || 'Baru',
          total, payload.noHp || '', payload.keluhan || '', payload.password || '', payload.kelengkapan || '',
          payload.garansi || '', bj, bs, payload.garansiBerakhir || null, (auth && auth.cabang) || '']
      );
      break;
    } catch (e) {
      if (e && e.code === '23505') { id = newTicketId() + crypto.randomBytes(1).toString('hex'); continue; }
      throw e;
    }
  }

  for (const p of photoUrls) {
    await pool.query('INSERT INTO ticket_photos (ticket_id,object_key,url) VALUES ($1,$2,$3)', [id, p.key, p.url]);
  }
  return { ok: true, id };
}

async function getTicketRow(id) {
  const { rows } = await pool.query('SELECT * FROM tiket WHERE lower(id)=lower($1)', [String(id)]);
  return rows.length ? rows[0] : null;
}

async function getTicket(id, auth) {
  const r = await getTicketRow(id);
  if (!r) throw new Error('Tiket tidak ditemukan: ' + id);
  if (auth && !auth.isAdmin && auth.cabang && r.cabang && norm(r.cabang) !== norm(auth.cabang)) {
    throw new Error('Bukan tiket cabang ini.');
  }
  return mapTicket(r);
}

async function listTicketsWithCounts(limit, auth, filter) {
  filter = filter || {};
  const cabFilter = (auth && auth.isAdmin) ? norm(filter.cabang) : norm(auth && auth.cabang);

  const { rows } = await pool.query('SELECT * FROM tiket ORDER BY id DESC');

  const hasRange = !!(filter.dateFrom || filter.dateTo);
  const from = filter.dateFrom ? new Date(filter.dateFrom + 'T00:00:00') : null;
  const to = filter.dateTo ? new Date(filter.dateTo + 'T23:59:59') : null;
  const ymFilter = String(filter.month || '');
  const statusFilter = String(filter.status || 'ALL');
  const q = norm(filter.q || filter.search || '');

  const data = rows.filter(r => {
    if (cabFilter && norm(r.cabang) !== cabFilter) return false;
    const t = r.tanggal;
    if (hasRange) {
      if (!t) return false;
      const dd = new Date(t);
      if (from && dd < from) return false;
      if (to && dd > to) return false;
    } else if (ymFilter) {
      if (ym(t) !== ymFilter) return false;
    }
    if (q) {
      const hay = [r.id, r.nama, r.tipe, r.teknisi, r.status].join(' ').toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });

  const counts = { ALL: data.length };
  ['Baru', 'Inprogress', 'Selesai', 'Kembali', 'Diambil'].forEach(s => counts[s] = 0);
  data.forEach(r => { const st = String(r.status || ''); if (counts[st] == null) counts[st] = 0; counts[st]++; });

  let list = data
    .filter(r => statusFilter === 'ALL' ? true : String(r.status || '') === statusFilter)
    .map(r => ({
      id: r.id || '', tanggal: ymd(r.tanggal), nama: r.nama || '', tipe: r.tipe || '',
      teknisi: r.teknisi || '', status: r.status || '', total: num(r.total)
    }));
  list = list.slice(0, limit || 100);
  return { rows: list, counts };
}

async function updateTicketStatus(payload, auth) {
  const { id, status } = payload || {};
  if (!id) throw new Error('ID wajib.');
  const r = await getTicketRow(id);
  if (!r) throw new Error('Tiket tidak ditemukan');
  if (auth && !auth.isAdmin && auth.cabang && r.cabang && norm(r.cabang) !== norm(auth.cabang)) {
    throw new Error('Tidak boleh ubah tiket cabang lain.');
  }
  await pool.query('UPDATE tiket SET status=$1 WHERE id=$2', [status || '', r.id]);

  let notif = null;
  if (String(status) === 'Selesai' || String(status) === 'Diambil') {
    try { notif = await buildNotifMessage(r.id, String(status) === 'Diambil' ? 'diambil' : 'selesai'); }
    catch (e) { notif = null; }
  }
  return { ok: true, notif, needKerugianPrompt: String(status) === 'Kembali' };
}

async function updateTicket(payload, auth) {
  const { id } = payload || {};
  if (!id) throw new Error('ID tiket wajib.');
  const cur = await getTicketRow(id);
  if (!cur) throw new Error('Tiket tidak ditemukan: ' + id);
  if (auth && !auth.isAdmin && auth.cabang && cur.cabang && norm(cur.cabang) !== norm(auth.cabang)) {
    throw new Error('Tidak boleh ubah tiket cabang lain.');
  }

  const sets = [];
  const args = [];
  const put = (col, val) => { args.push(val); sets.push(`${col}=$${args.length}`); };

  if (payload.tanggal) put('tanggal', new Date(payload.tanggal));
  if (Object.prototype.hasOwnProperty.call(payload, 'namaPelanggan')) put('nama', payload.namaPelanggan);
  if (Object.prototype.hasOwnProperty.call(payload, 'noHp')) put('no_hp', payload.noHp);
  if (Object.prototype.hasOwnProperty.call(payload, 'teknisi')) put('teknisi', payload.teknisi);
  if (Object.prototype.hasOwnProperty.call(payload, 'tipeHp')) put('tipe', payload.tipeHp);
  if (Object.prototype.hasOwnProperty.call(payload, 'password')) put('password', payload.password);
  if (Object.prototype.hasOwnProperty.call(payload, 'kelengkapan')) put('kelengkapan', payload.kelengkapan);
  if (Object.prototype.hasOwnProperty.call(payload, 'keluhan')) put('keluhan', payload.keluhan);
  if (Object.prototype.hasOwnProperty.call(payload, 'garansi')) put('garansi', payload.garansi);
  if (Object.prototype.hasOwnProperty.call(payload, 'status')) put('status', payload.status);

  const hasBj = Object.prototype.hasOwnProperty.call(payload, 'biayaJasa');
  const hasBs = Object.prototype.hasOwnProperty.call(payload, 'biayaSparepart');
  const bj = hasBj ? num(payload.biayaJasa) : num(cur.biaya_jasa);
  const bs = hasBs ? num(payload.biayaSparepart) : num(cur.biaya_sparepart);
  if (hasBj) put('biaya_jasa', bj);
  if (hasBs) put('biaya_sparepart', bs);
  if (Object.prototype.hasOwnProperty.call(payload, 'totalBiaya')) put('total', num(payload.totalBiaya));
  else if (hasBj || hasBs) put('total', bj + bs);

  if (Object.prototype.hasOwnProperty.call(payload, 'garansiBerakhir')) {
    put('garansi_end', payload.garansiBerakhir ? new Date(payload.garansiBerakhir) : null);
  }

  if (sets.length) {
    args.push(cur.id);
    await pool.query(`UPDATE tiket SET ${sets.join(', ')} WHERE id=$${args.length}`, args);
  }

  // Foto tambahan
  if (Array.isArray(payload.fotos) && payload.fotos.length) {
    for (const f of payload.fotos) {
      const up = await uploadPhoto(f, 'tickets');
      if (up) await pool.query('INSERT INTO ticket_photos (ticket_id,object_key,url) VALUES ($1,$2,$3)', [cur.id, up.key, up.url]);
    }
  }
  return { ok: true };
}

async function getTicketImages(ticketId, maxCount) {
  const n = Math.max(1, Math.min(Number(maxCount || 3), 20));
  const { rows } = await pool.query('SELECT url FROM ticket_photos WHERE ticket_id=$1 ORDER BY id ASC LIMIT $2', [String(ticketId), n]);
  return rows.map(r => r.url);
}

async function addTicketPhotos(ticketId, fotos, auth) {
  if (!ticketId) throw new Error('ID tiket wajib.');
  if (!Array.isArray(fotos) || !fotos.length) throw new Error('Tidak ada file.');
  const cur = await getTicketRow(ticketId);
  if (!cur) throw new Error('Tiket tidak ditemukan.');
  if (auth && !auth.isAdmin && auth.cabang && cur.cabang && norm(cur.cabang) !== norm(auth.cabang)) {
    throw new Error('Tidak boleh ubah tiket cabang lain.');
  }
  const urls = [];
  for (const f of fotos) {
    const up = await uploadPhoto(f, 'tickets');
    if (up) { await pool.query('INSERT INTO ticket_photos (ticket_id,object_key,url) VALUES ($1,$2,$3)', [cur.id, up.key, up.url]); urls.push(up.url); }
  }
  return { ok: true, added: urls.length, urls };
}

async function deleteTicketPhoto(ticketId, photoUrl, auth) {
  if (!ticketId || !photoUrl) throw new Error('Parameter tidak lengkap.');
  const cur = await getTicketRow(ticketId);
  if (!cur) throw new Error('Tiket tidak ditemukan.');
  if (auth && !auth.isAdmin && auth.cabang && cur.cabang && norm(cur.cabang) !== norm(auth.cabang)) {
    throw new Error('Tidak boleh ubah tiket cabang lain.');
  }
  const { rows } = await pool.query('SELECT id, object_key FROM ticket_photos WHERE ticket_id=$1 AND url=$2', [cur.id, photoUrl]);
  for (const r of rows) { await deletePhotoObject(r.object_key); await pool.query('DELETE FROM ticket_photos WHERE id=$1', [r.id]); }
  return { ok: true, removed: rows.length };
}

/* =========================================================
 * KEUANGAN
 * =======================================================*/
async function addFinance(payload, auth) {
  payload = payload || {};
  let foto = null;
  if (payload.foto && payload.foto.b64) foto = await uploadPhoto(payload.foto, 'finance');
  await pool.query(
    `INSERT INTO keuangan (tanggal,item,jenis,deskripsi,total,foto_key,foto_url,cabang)
     VALUES ($1,$2,'PENGELUARAN',$3,$4,$5,$6,$7)`,
    [payload.tanggal ? new Date(payload.tanggal) : new Date(), payload.item || '', payload.deskripsi || '',
      num(payload.total || 0), foto ? foto.key : '', foto ? foto.url : '', (auth && auth.cabang) || '']
  );
  return { ok: true };
}

async function listFinance(limit, auth, filter) {
  const cabFilter = (auth && auth.isAdmin)
    ? norm(typeof filter === 'string' ? filter : (filter && filter.cabang))
    : norm(auth && auth.cabang);
  const args = [];
  let sql = 'SELECT id, tanggal, item, deskripsi, total FROM keuangan';
  if (cabFilter) { args.push(cabFilter); sql += ` WHERE lower(cabang)=$1`; }
  sql += ' ORDER BY id DESC';
  if (limit) { args.push(limit); sql += ` LIMIT $${args.length}`; }
  const { rows } = await pool.query(sql, args);
  return rows.map(r => ({
    rowNo: r.id, tanggal: ymd(r.tanggal), item: r.item || '', jenis: 'PENGELUARAN',
    deskripsi: r.deskripsi || '', total: num(r.total)
  }));
}

async function getFinance(rowNo, auth) {
  const { rows } = await pool.query('SELECT * FROM keuangan WHERE id=$1', [Number(rowNo)]);
  if (!rows.length) throw new Error('Transaksi tidak ditemukan.');
  const r = rows[0];
  if (auth && !auth.isAdmin && norm(r.cabang) !== norm(auth.cabang)) throw new Error('Bukan transaksi cabang ini.');
  return { rowNo: r.id, tanggal: ymd(r.tanggal), item: r.item || '', jenis: 'PENGELUARAN', deskripsi: r.deskripsi || '', total: num(r.total) };
}

async function updateFinance(payload, auth) {
  const rowNo = payload && payload.rowNo;
  if (!rowNo) throw new Error('rowNo wajib.');
  const { rows } = await pool.query('SELECT * FROM keuangan WHERE id=$1', [Number(rowNo)]);
  if (!rows.length) throw new Error('Transaksi tidak ditemukan.');
  const r = rows[0];
  if (auth && !auth.isAdmin && norm(r.cabang) !== norm(auth.cabang)) throw new Error('Tidak boleh ubah cabang lain.');

  const sets = []; const args = [];
  const put = (c, v) => { args.push(v); sets.push(`${c}=$${args.length}`); };
  if (payload.tanggal) put('tanggal', new Date(payload.tanggal));
  if (Object.prototype.hasOwnProperty.call(payload, 'item')) put('item', payload.item || '');
  if (Object.prototype.hasOwnProperty.call(payload, 'deskripsi')) put('deskripsi', payload.deskripsi || '');
  if (Object.prototype.hasOwnProperty.call(payload, 'total')) put('total', num(payload.total || 0));
  if (payload.foto && payload.foto.b64) { const up = await uploadPhoto(payload.foto, 'finance'); if (up) { put('foto_key', up.key); put('foto_url', up.url); } }
  if (sets.length) { args.push(Number(rowNo)); await pool.query(`UPDATE keuangan SET ${sets.join(', ')} WHERE id=$${args.length}`, args); }
  return { ok: true };
}

async function sumExpense(cabNorm, predicate) {
  const args = []; let sql = `SELECT tanggal, total FROM keuangan WHERE lower(jenis)='pengeluaran'`;
  if (cabNorm) { args.push(cabNorm); sql += ` AND lower(cabang)=$1`; }
  const { rows } = await pool.query(sql, args);
  return rows.reduce((acc, r) => predicate(r.tanggal) ? acc + num(r.total) : acc, 0);
}

/* =========================================================
 * DASHBOARD
 * =======================================================*/
async function getDashboard2(auth, filter) {
  filter = filter || {};
  const cabFilter = (auth && auth.isAdmin) ? norm(filter.cabang) : norm(auth && auth.cabang);

  const hasRange = !!(filter.dateFrom || filter.dateTo);
  const curYm = ym(new Date());
  const ymSel = String(filter.month || (hasRange ? '' : curYm));
  const from = hasRange ? new Date((filter.dateFrom || ymd(new Date())) + 'T00:00:00') : null;
  const to = hasRange ? new Date((filter.dateTo || ymd(new Date())) + 'T23:59:59') : null;

  const { rows } = await pool.query('SELECT * FROM tiket ORDER BY id ASC');
  const FINISHED = { 'Diambil': true };

  const data = rows.filter(r => {
    if (cabFilter && norm(r.cabang) !== cabFilter) return false;
    const t = r.tanggal; if (!t) return false;
    if (hasRange) { const dd = new Date(t); if (from && dd < from) return false; if (to && dd > to) return false; }
    else { if (ym(t) !== ymSel) return false; }
    return true;
  });

  const statusAgg = { Baru: 0, Inprogress: 0, Selesai: 0, Kembali: 0, Diambil: 0 };
  let totalOmset = 0, jasaRevenue = 0, biayaSparepart = 0;
  const dayOmsetMap = {};

  data.forEach(r => {
    const st = String(r.status || '');
    if (statusAgg[st] != null) statusAgg[st]++;
    const d = new Date(r.tanggal);
    const key = hasRange ? ymd(d) : String(d.getDate());
    if (FINISHED[st]) {
      const om = num(r.total), bj = num(r.biaya_jasa), bs = num(r.biaya_sparepart);
      totalOmset += om; jasaRevenue += bj; biayaSparepart += bs;
      dayOmsetMap[key] = (dayOmsetMap[key] || 0) + om;
    }
  });

  let labels = [];
  if (hasRange) {
    const tmp = new Date(from || new Date()); const end = new Date(to || from || new Date());
    while (tmp <= end) { labels.push(ymd(tmp)); tmp.setDate(tmp.getDate() + 1); }
  } else {
    const base = new Date(ymSel + '-01T00:00:00');
    const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    labels = Array.from({ length: lastDay }, (_, i) => String(i + 1));
  }
  const dayOmset = labels.map(k => dayOmsetMap[k] || 0);

  const recentTickets = data.filter(r => FINISHED[String(r.status || '')]).slice(-10).map(r => ({
    id: r.id || '', tanggal: ymd(r.tanggal), nama: r.nama || '', status: r.status || ''
  }));

  let totalExpense;
  if (hasRange) totalExpense = await sumExpense(cabFilter, t => { if (!t) return false; const d = new Date(t); return (!from || d >= from) && (!to || d <= to); });
  else totalExpense = await sumExpense(cabFilter, t => ym(t) === ymSel);

  const netRevenue = jasaRevenue - totalExpense;
  return { ym: ymSel, statusAgg, totalOmset, jasaRevenue, biayaSparepart, totalExpense, netRevenue, days: labels, dayOmset, recentTickets };
}

/* =========================================================
 * EXPORT EXCEL
 * =======================================================*/
async function exportTicketsExcel(auth, filter) {
  filter = filter || {};
  const cabFilter = (auth && auth.isAdmin) ? norm(filter.cabang) : norm(auth && auth.cabang);
  const { rows } = await pool.query('SELECT * FROM tiket ORDER BY id DESC');

  const hasRange = !!(filter.dateFrom || filter.dateTo);
  const from = hasRange ? new Date(filter.dateFrom + 'T00:00:00') : null;
  const to = hasRange ? new Date(filter.dateTo + 'T23:59:59') : null;
  const ymFilter = String(filter.month || '');
  const statusF = String(filter.status || 'ALL');
  const q = norm(filter.q || filter.search || '');

  const data = rows.filter(r => {
    if (cabFilter && norm(r.cabang) !== cabFilter) return false;
    const t = r.tanggal;
    if (hasRange) { if (!t) return false; const dd = new Date(t); if (from && dd < from) return false; if (to && dd > to) return false; }
    else if (ymFilter) { if (ym(t) !== ymFilter) return false; }
    if (statusF !== 'ALL' && String(r.status || '') !== statusF) return false;
    if (q) { const hay = [r.id, r.nama, r.tipe, r.teknisi].join(' ').toLowerCase(); if (hay.indexOf(q) === -1) return false; }
    return true;
  });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('DATA');
  ws.addRow(['ID', 'Tanggal', 'Nama', 'Tipe', 'Teknisi', 'Status', 'Biaya Jasa', 'Biaya Sparepart', 'Total', 'Cabang']);
  ws.getRow(1).font = { bold: true };
  data.forEach(r => ws.addRow([
    r.id || '', ymd(r.tanggal), r.nama || '', r.tipe || '', r.teknisi || '', r.status || '',
    num(r.biaya_jasa), num(r.biaya_sparepart), num(r.total), r.cabang || ''
  ]));
  ws.columns.forEach(c => { let m = 10; c.eachCell(cell => { m = Math.max(m, String(cell.value == null ? '' : cell.value).length + 2); }); c.width = Math.min(m, 40); });

  const tag = hasRange ? (ymd(from || new Date()) + '_' + ymd(to || from || new Date())) : (ymFilter || 'ALL');
  const buf = await wb.xlsx.writeBuffer();
  return { b64: Buffer.from(buf).toString('base64'), filename: `TIKET_${tag}_${Date.now()}.xlsx` };
}

/* =========================================================
 * WHATSAPP NOTIF
 * =======================================================*/
function toWaPhone(nohp) {
  let s = String(nohp || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('62')) return s;
  if (s.startsWith('0')) return '62' + s.slice(1);
  return s;
}
async function buildNotifMessage(ticketId, kind) {
  const t = await getTicket(ticketId, null);
  const cab = (await getCabangInfo(t.cabang)) || { kode: '', nama: '', maps: '', review: '', phone: '' };
  const nama = t.nama || '', tipe = t.tipe || '', desk = t.keluhan || '', total = fmtIDR(t.total || 0), teknisi = t.teknisi || '';
  const hpCust = toWaPhone(t.noHp || '');
  const hpTek = toWaPhone(await findTechnicianPhone(teknisi));
  const mapsLine = cab.maps ? ('Lokasi cabang: ' + cab.maps + '\n') : '';
  const reviewLine = cab.review ? ('Ulasan: ' + cab.review + '\n') : '';
  const statusLine = (String(kind).toLowerCase() === 'diambil') ? 'telah Diambil.' : 'telah Selesai.';

  const teks =
`Halo ${nama || 'Pelanggan'},
kami informasikan bahwa servis HP Anda *(${tipe})* dengan deskripsi ${desk} ${statusLine}
*Total biaya: ${total}*
${mapsLine}${reviewLine}Terima kasih atas kepercayaan Anda.
Jika ada pertanyaan, silakan hubungi teknisi kami, ${teknisi}${hpTek ? `, di https://wa.me/${hpTek}` : ''}

Terima kasih.`;

  const waUrl = hpCust ? ('https://wa.me/' + hpCust + '?text=' + encodeURIComponent(teks)) : '';
  return { ok: true, text: teks, waUrl, customerPhone: hpCust, technicianPhone: hpTek, maps: cab.maps, review: cab.review };
}

/* =========================================================
 * QC
 * =======================================================*/
function isTrue(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v || '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'ya' || s === 'y' || s === 'on' || s === 'checked';
}
function normKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function flattenToMap(input, out) {
  out = out || {};
  if (input == null) return out;
  if (Array.isArray(input)) {
    for (const it of input) {
      if (it && typeof it === 'object' && ('name' in it || 'key' in it)) out[normKey(it.name || it.key)] = (it.value != null) ? it.value : it.val;
      else if (it && typeof it === 'object') flattenToMap(it, out);
    }
    return out;
  }
  if (typeof input === 'object') {
    for (const k in input) {
      if (!Object.prototype.hasOwnProperty.call(input, k)) continue;
      const v = input[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) flattenToMap(v, out);
      else out[normKey(k)] = v;
    }
  }
  return out;
}
function getAny(map, aliases) { for (const a of aliases) { const nk = normKey(a); if (Object.prototype.hasOwnProperty.call(map, nk)) return map[nk]; } return null; }
function qcFlags(qc) {
  const m = flattenToMap(qc, {});
  return {
    CamDepan: isTrue(getAny(m, ['CamDepan', 'kameraDepan', 'kamera depan'])),
    CamBelakang: isTrue(getAny(m, ['CamBelakang', 'kameraBelakang', 'kamera belakang'])),
    Speaker: isTrue(getAny(m, ['Speaker'])),
    Mic: isTrue(getAny(m, ['Mic', 'microphone'])),
    Wifi: isTrue(getAny(m, ['Wifi', 'WiFi'])),
    Charger: isTrue(getAny(m, ['Charger', 'konektorCharger', 'portCharger', 'connector'])),
    Tombol: isTrue(getAny(m, ['Tombol', 'buttons', 'btn'])),
    Kelengkapan: isTrue(getAny(m, ['Kelengkapan', 'kelengkapanAwal', 'kelengkapanVerified', 'kelengkapanok'])),
    Catatan: String(getAny(m, ['Catatan', 'notes', 'note']) || '')
  };
}
async function getQC(ticketId) {
  const { rows } = await pool.query('SELECT * FROM qc WHERE ticket_id=$1', [String(ticketId)]);
  if (!rows.length) {
    return { id: ticketId, tanggal: ymd(new Date()), CamDepan: false, CamBelakang: false, Speaker: false, Mic: false, Wifi: false, Charger: false, Tombol: false, Kelengkapan: false, Catatan: '', cabang: '', by: '' };
  }
  const r = rows[0];
  return {
    id: r.ticket_id, tanggal: ymd(r.tanggal || new Date()),
    CamDepan: !!r.cam_depan, CamBelakang: !!r.cam_belakang, Speaker: !!r.speaker, Mic: !!r.mic,
    Wifi: !!r.wifi, Charger: !!r.charger, Tombol: !!r.tombol, Kelengkapan: !!r.kelengkapan,
    Catatan: r.catatan || '', cabang: r.cabang || '', by: r.by_user || ''
  };
}
async function saveQC(ticketId, qc, auth) {
  if (!ticketId) throw new Error('ID tiket wajib.');
  const f = qcFlags(qc);
  const missing = [];
  if (!f.CamDepan) missing.push('Kamera Depan');
  if (!f.CamBelakang) missing.push('Kamera Belakang');
  if (!f.Speaker) missing.push('Speaker');
  if (!f.Mic) missing.push('Microphone');
  if (!f.Wifi) missing.push('WiFi');
  if (!f.Charger) missing.push('Konektor Charger');
  if (!f.Tombol) missing.push('Tombol-tombol');
  if (!f.Kelengkapan) missing.push('Kelengkapan awal');
  if (missing.length) throw new Error('Lengkapi semua checklist QC terlebih dahulu. Kurang: ' + missing.join(', '));

  const when = (qc && qc.tanggal) ? new Date(qc.tanggal) : new Date();
  const by = (auth && (auth.nama || auth.email)) || '';
  const cab = (auth && auth.cabang) || '';
  await pool.query(
    `INSERT INTO qc (ticket_id,tanggal,cam_depan,cam_belakang,speaker,mic,wifi,charger,tombol,kelengkapan,catatan,cabang,by_user)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (ticket_id) DO UPDATE SET
       tanggal=EXCLUDED.tanggal, cam_depan=EXCLUDED.cam_depan, cam_belakang=EXCLUDED.cam_belakang,
       speaker=EXCLUDED.speaker, mic=EXCLUDED.mic, wifi=EXCLUDED.wifi, charger=EXCLUDED.charger,
       tombol=EXCLUDED.tombol, kelengkapan=EXCLUDED.kelengkapan, catatan=EXCLUDED.catatan,
       cabang=EXCLUDED.cabang, by_user=EXCLUDED.by_user`,
    [String(ticketId), when, f.CamDepan, f.CamBelakang, f.Speaker, f.Mic, f.Wifi, f.Charger, f.Tombol, f.Kelengkapan, f.Catatan, cab, by]
  );
  return { ok: true };
}

/* =========================================================
 * PRINT HTML (80mm thermal)
 * =======================================================*/
const PRINT_STYLE = `
 @page{size:80mm auto; margin:0}
  html,body{margin:0;padding:0;background:#fff;color:#000;width:80mm}
  .wrap{width:80mm;margin:0 auto}
  .paper{padding:0 10mm 8mm;font-family:Arial,sans-serif;}
  h1{font-size:13pt;text-align:center;margin:4px 0 2px;font-weight:700}
  .brand{font-size:10pt;text-align:center;color:#333;margin-bottom:6px}
  .nota{font-size:10.5pt;text-align:center;font-weight:700;margin:6px 0 8px}
  .kv{display:flex;justify-content:space-between;gap:8px;font-size:9.5pt;margin:3px 0}
  .kv span:last-child{text-align:right}
  hr{border:0;border-top:1px dashed #666;margin:8px 0}
  .small{font-size:9pt;color:#444;line-height:1.35}
  .tot{font-weight:700}
  .muted{color:#666}
  .ttd{margin-top:30px;text-align:center}
  .ttd .line{margin:40px auto 6px; border-top:1px solid #000; width:70%}
  .ttd .label{font-size:9pt}
  .stamp{margin-top:8px;font-size:10pt;font-weight:700;text-align:center}
  @media print{ -webkit-print-color-adjust:exact; print-color-adjust:exact }`;
const PRINT_SCRIPT = `<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},200);setTimeout(function(){window.close();},900);});</script>`;

async function generateTicketHTML(ticketId, kind) {
  const t = await getTicket(ticketId, null);
  const cab = (await getCabangInfo(t.cabang)) || { kode: '', nama: '', maps: '', review: '', phone: '' };
  const isTeknisi = String(kind || '').toLowerCase() === 'teknisi';
  const title = isTeknisi ? 'NOTA UNTUK TEKNISI' : 'NOTA UNTUK PELANGGAN';
  const garansiLine = !t.garansi ? '-' : (t.garansiBerakhir ? `${esc(t.garansi)} s/d ${esc(t.garansiBerakhir)}` : esc(t.garansi));
  const biayaHtml = isTeknisi
    ? `<hr/><div class="kv"><span>Total</span><span class="tot">${fmtIDR(t.total || 0)}</span></div><div class="kv"><span>Garansi</span><span>${garansiLine}</span></div>`
    : `<hr/><div class="kv"><span>Garansi</span><span>${garansiLine}</span></div>`;
  const passHtml = (isTeknisi && t.password) ? `<div class="small" style="margin-top:6px"><b>Password</b><br>${esc(t.password)}</div>` : '';
  const ttdLabel = isTeknisi ? 'Tanda Tangan Pelanggan' : 'Tanda Tangan Teknisi';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(title)} - ${esc(ticketId)}</title><style>${PRINT_STYLE}</style></head><body>
  <div class="wrap"><div class="paper">
    <h1>REPAIR CENTER</h1>
    <div class="nota">${esc(title)}</div>
    <div class="kv"><span>ID Tiket</span><span>${esc(ticketId)}</span></div>
    <div class="kv"><span>Tanggal</span><span>${esc(t.tanggal || '')}</span></div>
    <div class="kv"><span>Nama</span><span>${esc(t.nama || '-')}</span></div>
    <div class="kv"><span>HP</span><span>${esc(t.tipe || '-')}</span></div>
    <div class="kv"><span>Teknisi</span><span>${esc(t.teknisi || '-')}</span></div>
    <div class="kv"><span>Status</span><span>${esc(t.status || '-')}</span></div>
    <div class="kv"><span>Cabang</span><span>${esc(cab.nama || t.cabang || '-')}</span></div>
    <div class="kv"><span>Telp Cabang</span><span>${esc(cab.phone || '-')}</span></div>
    <hr/>
    <div class="small"><b>Keluhan</b><br>${esc(t.keluhan || '-')}</div>
    <div class="small" style="margin-top:6px"><b>Kelengkapan</b><br>${esc(t.kelengkapan || '-')}</div>
    ${passHtml}
    ${biayaHtml}
    <hr/>
    <div class="small muted">Harap simpan tiket ini untuk klaim garansi. Barang yang ditinggal selama 30 hari setelah pemberitahuan selesai dan tidak diambil jika hilang/rusak bukan tanggung jawab kami.</div>
    <div class="ttd"><div class="line"></div><div class="label">${esc(ttdLabel)}</div></div>
    <div class="small" style="text-align:center;margin-top:8px">Terima kasih \u{1F64F}</div>
  </div></div>${PRINT_SCRIPT}</body></html>`;
}

async function generateQCPrintHTML(ticketId) {
  const qc = await getQC(ticketId);
  const t = await getTicket(ticketId, null);
  const cab = (await getCabangInfo(t.cabang)) || { kode: '', nama: '', maps: '', review: '', phone: '' };
  const missing = [];
  if (!qc.CamDepan) missing.push('Kamera Depan');
  if (!qc.CamBelakang) missing.push('Kamera Belakang');
  if (!qc.Speaker) missing.push('Speaker');
  if (!qc.Mic) missing.push('Microphone');
  if (!qc.Wifi) missing.push('WiFi');
  if (!qc.Charger) missing.push('Konektor Charger');
  if (!qc.Tombol) missing.push('Tombol-tombol');
  if (!qc.Kelengkapan) missing.push('Kelengkapan awal');
  if (missing.length) throw new Error('Checklist QC belum lengkap. Kurang: ' + missing.join(', '));

  const row = (label, ok) => `<div class="kv"><span>${label}</span><span>${ok ? '✅ LULUS' : '❌'}</span></div>`;
  const garansiLine = t.garansi ? (t.garansiBerakhir ? `${esc(t.garansi)} (s/d ${esc(t.garansiBerakhir)})` : esc(t.garansi)) : '-';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>QC ${esc(ticketId)}</title><style>${PRINT_STYLE}</style></head><body>
  <div class="wrap"><div class="paper">
    <h1>QUALITY CONTROL</h1>
    <div class="brand">(Nota Serah Terima)</div>
    <div class="kv"><span>ID Tiket</span><span>${esc(ticketId)}</span></div>
    <div class="kv"><span>Tanggal</span><span>${esc(qc.tanggal)}</span></div>
    <div class="kv"><span>Nama</span><span>${esc(t.nama)}</span></div>
    <div class="kv"><span>Tipe</span><span>${esc(t.tipe)}</span></div>
    <div class="kv"><span>Teknisi</span><span>${esc(t.teknisi)}</span></div>
    <div class="kv"><span>Cabang</span><span>${esc(cab.nama || t.cabang || '-')}</span></div>
    <div class="kv"><span>Telp Cabang</span><span>${esc(cab.phone || '-')}</span></div>
    <hr/><div class="small"><b>Keluhan / Kerusakan</b><br>${esc(t.keluhan || '-')}</div>
    <hr/><div class="small"><b>Checklist Fungsi Dasar</b></div>
    ${row('Kamera Depan', qc.CamDepan)}${row('Kamera Belakang', qc.CamBelakang)}${row('Speaker', qc.Speaker)}${row('Microphone', qc.Mic)}${row('WiFi', qc.Wifi)}${row('Konektor Charger', qc.Charger)}${row('Tombol-tombol', qc.Tombol)}${row('Kelengkapan awal', qc.Kelengkapan)}
    <div class="stamp">✅ LOLOS QUALITY CONTROL</div>
    <hr/><div class="small"><b>Ringkasan</b></div>
    <div class="kv"><span>Total</span><span class="tot">${fmtIDR(t.total || 0)}</span></div>
    <div class="kv"><span>Garansi</span><span>${garansiLine}</span></div>
    ${qc.Catatan ? ('<hr/><div class="small"><b>Catatan</b><br>' + esc(qc.Catatan) + '</div>') : ''}
    <hr/><div class="small">Mohon pemilik melakukan pengecekan ulang sebelum meninggalkan tempat servis. Simpan nota ini untuk klaim garansi.</div>
    <div class="small" style="text-align:center;margin-top:10px">Terima kasih \u{1F64F}</div>
  </div></div>${PRINT_SCRIPT}</body></html>`;
}

/* =========================================================
 * RPC DISPATCH  (menggantikan google.script.run)
 * Auth diverifikasi SERVER-SIDE dari token; argumen auth dari
 * client diabaikan untuk keputusan otorisasi.
 * =======================================================*/
const PUBLIC_FNS = new Set(['authLogin']);
const HANDLERS = {
  authLogin: (a) => authLogin(a[0]),
  listCabang: (a, auth) => listCabang(),
  listBranches: (a, auth) => listCabang(),
  listTechnicians: (a, auth) => listTechnicians(auth),
  createTicket: (a, auth) => createTicket(a[0], auth),
  listTicketsWithCounts: (a, auth) => listTicketsWithCounts(a[0], auth, a[2]),
  updateTicketStatus: (a, auth) => updateTicketStatus(a[0], auth),
  getTicket: (a, auth) => getTicket(a[0], auth),
  updateTicket: (a, auth) => updateTicket(a[0], auth),
  getTicketImages: (a, auth) => getTicketImages(a[0], a[1]),
  addTicketPhotos: (a, auth) => addTicketPhotos(a[0], a[1], auth),
  deleteTicketPhoto: (a, auth) => deleteTicketPhoto(a[0], a[1], auth),
  addFinance: (a, auth) => addFinance(a[0], auth),
  listFinance: (a, auth) => listFinance(a[0], auth, a[2]),
  getFinance: (a, auth) => getFinance(a[0], auth),
  updateFinance: (a, auth) => updateFinance(a[0], auth),
  getDashboard2: (a, auth) => getDashboard2(auth, a[1]),
  exportTicketsExcel: (a, auth) => exportTicketsExcel(auth, a[1]),
  buildNotifMessage: (a, auth) => buildNotifMessage(a[0], a[1]),
  getQC: (a, auth) => getQC(a[0]),
  saveQC: (a, auth) => saveQC(a[0], a[1], auth),
  generateTicketHTML: (a, auth) => generateTicketHTML(a[0], a[1]),
  generateQCPrintHTML: (a, auth) => generateQCPrintHTML(a[0])
};

/* =========================================================
 * EXPRESS APP
 * =======================================================*/
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/rpc', async (req, res) => {
  const { fn, args, token } = req.body || {};
  const handler = HANDLERS[fn];
  if (!handler) return res.status(400).json({ error: 'Metode tidak dikenal: ' + fn });
  try {
    let auth = null;
    if (!PUBLIC_FNS.has(fn)) {
      auth = await userFromToken(token);
      if (!auth) return res.status(401).json({ error: 'Sesi tidak valid. Silakan login ulang.' });
    }
    const result = await handler(Array.isArray(args) ? args : [], auth);
    res.json({ result });
  } catch (e) {
    res.status(400).json({ error: (e && e.message) || 'Terjadi kesalahan.' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`REPAIR CENTER berjalan di port ${PORT}`));
