import assert from 'node:assert/strict';
import { handle } from '../netlify/functions/lib/core.mjs';

class FakeStore {
  constructor() { this.m = new Map(); }
  async get(k) { const v = this.m.get(k); return v === undefined ? null : JSON.parse(v); }
  async setJSON(k, v) { this.m.set(k, JSON.stringify(v)); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = '' } = {}) {
    return { blobs: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), directories: [] };
  }
}

const env = { ADMIN_PASSWORD: 'passwordTest123', GAME_KEY: '0123456789abcdef0123456789abcdef' };
const store = new FakeStore();
const call = async (method, path, { body, headers = {}, ip = '1.2.3.4', e = env } = {}) => {
  const req = new Request('https://x.netlify.app' + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handle(req, { store, env: e, ip });
  return { status: res.status, data: await res.json() };
};
const poll = (body, key = env.GAME_KEY) => call('POST', '/api/game/poll', { body, headers: { 'x-game-key': key } });

let n = 0;
const ok = (name) => console.log('  ok', ++n, name);

// 0. env belum diisi
{
  const r = await call('POST', '/api/login', { body: { password: 'x' }, e: {} });
  assert.equal(r.status, 500); assert.match(r.data.error, /belum dikonfigurasi/); ok('env kosong -> pesan jelas');
}

// 1. game poll
{
  assert.equal((await poll({}, 'salah')).status, 401); ok('poll dengan key salah ditolak');
  const r = await poll({ jobId: 'abc-123', players: 7, placeVersion: 42, catalog: [{ id: 'spin', label: 'Spin Wheel' }, { id: 'uno', label: 'Uno' }, { id: '__proto__', label: 'x' }, { id: 'bad id', label: 'y' }] });
  assert.equal(r.status, 200); assert.equal(r.data.lockAt, null); assert.deepEqual(r.data.features, {}); ok('poll valid -> state default (terbuka)');
}

// 2. login
let token;
{
  assert.equal((await call('GET', '/api/admin/state')).status, 401); ok('state tanpa token ditolak');
  assert.equal((await call('POST', '/api/login', { body: { password: 'salah' } })).status, 401); ok('password salah ditolak');
  const r = await call('POST', '/api/login', { body: { password: env.ADMIN_PASSWORD } });
  assert.equal(r.status, 200); assert.match(r.data.token, /^[a-f0-9]{64}$/); token = r.data.token; ok('login benar -> token');
  assert.equal((await call('GET', '/api/admin/state', { headers: { Authorization: 'Bearer ' + 'a'.repeat(64) } })).status, 401); ok('token palsu ditolak');
}
const H = () => ({ Authorization: 'Bearer ' + token });

// 3. snapshot + katalog (id jahat tersaring)
{
  const r = await call('GET', '/api/admin/state', { headers: H() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.catalog.map((c) => c.id), ['spin', 'uno']); ok('katalog tersanitasi (__proto__ & id aneh dibuang)');
  assert.equal(r.data.servers.length, 1); assert.equal(r.data.totalPlayers, 7); ok('server & jumlah pemain muncul');
}

// 4. fitur
{
  let r = await call('POST', '/api/admin/feature', { headers: H(), body: { id: 'spin', enabled: false } });
  assert.deepEqual(r.data.features, { spin: false }); ok('matikan fitur spin');
  r = await call('POST', '/api/admin/feature', { headers: H(), body: { id: '__proto__', enabled: false } });
  assert.equal(r.status, 400); ok('id fitur ngawur ditolak');
  r = await poll({ jobId: 'abc-123', players: 5 });
  assert.deepEqual(r.data.features, { spin: false }); ok('game melihat fitur spin mati');
  r = await call('POST', '/api/admin/feature', { headers: H(), body: { id: 'spin', enabled: true } });
  assert.deepEqual(r.data.features, {}); ok('nyalakan lagi spin');
}

// 5. kunci terjadwal, kunci langsung, buka kunci
{
  let r = await call('POST', '/api/admin/lock', { headers: H(), body: { delayMinutes: 5, message: 'Maintenance dulu ya' } });
  const wait = r.data.lockAt - r.data.serverTime;
  assert.ok(wait > 299000 && wait <= 300000); ok('kunci 5 menit terjadwal');
  r = await poll({ jobId: 'abc-123', players: 5 });
  assert.equal(r.data.lockMessage, 'Maintenance dulu ya'); assert.ok(r.data.lockAt > Date.now()); ok('game melihat jadwal kunci + pesan');
  r = await call('POST', '/api/admin/lock', { headers: H(), body: { delayMinutes: 0 } });
  assert.ok(r.data.lockAt <= Date.now() + 5); assert.equal(r.data.lockMessage, 'Game sedang ditutup sementara. Silakan coba lagi nanti.'); ok('kunci sekarang + pesan default');
  assert.equal((await call('POST', '/api/admin/lock', { headers: H(), body: { delayMinutes: -1 } })).status, 400);
  assert.equal((await call('POST', '/api/admin/lock', { headers: H(), body: { delayMinutes: 99999 } })).status, 400); ok('waktu tunda tidak valid ditolak');
  r = await call('POST', '/api/admin/unlock', { headers: H() });
  assert.equal(r.data.lockAt, null); ok('buka kunci');
}

// 6. kick all
{
  const before = (await poll({})).data.kickNonce;
  await call('POST', '/api/admin/kickall', { headers: H(), body: { message: 'Keluar dulu' } });
  const r = await poll({});
  assert.equal(r.data.kickNonce, before + 1); assert.equal(r.data.kickMessage, 'Keluar dulu'); ok('kick all menaikkan nonce + pesan');
}

// 7. server basi disembunyikan, pesan dibersihkan
{
  await store.setJSON('srv/lama', { players: 99, version: 1, studio: false, lastSeen: Date.now() - 30 * 60 * 1000 });
  await store.setJSON('srv/agak-lama', { players: 99, version: 1, studio: false, lastSeen: Date.now() - 5 * 60 * 1000 });
  const r = await call('GET', '/api/admin/state', { headers: H() });
  assert.ok(!r.data.servers.some((s) => s.jobId === 'lama' || s.jobId === 'agak-lama')); ok('server basi tidak ditampilkan');
  assert.equal(await store.get('srv/lama'), null); ok('data server >10 menit dihapus');
  await call('POST', '/api/admin/kickall', { headers: H(), body: { message: 'a\u0000b\n' + 'x'.repeat(500) } });
  const r2 = await poll({});
  assert.ok(r2.data.kickMessage.length <= 200 && !/[\u0000-\u001f]/.test(r2.data.kickMessage)); ok('pesan dibersihkan & dipotong 200 karakter');
}

// 8. audit & logout
{
  const r = await call('GET', '/api/admin/state', { headers: H() });
  assert.ok(r.data.audit.length >= 6 && r.data.audit[0].text); ok('riwayat tindakan tercatat');
  await call('POST', '/api/admin/logout', { headers: H() });
  assert.equal((await call('GET', '/api/admin/state', { headers: H() })).status, 401); ok('logout mencabut token');
}

// 9. sesi kedaluwarsa
{
  const r = await call('POST', '/api/login', { body: { password: env.ADMIN_PASSWORD } });
  const t = r.data.token;
  const { createHash } = await import('node:crypto');
  await store.setJSON('sess/' + createHash('sha256').update(t).digest('hex'), { exp: Date.now() - 1000 });
  assert.equal((await call('GET', '/api/admin/state', { headers: { Authorization: 'Bearer ' + t } })).status, 401); ok('sesi kedaluwarsa ditolak');
}

// 10. rate limit login (IP berbeda biar bersih)
{
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call('POST', '/api/login', { body: { password: 'x' }, ip: '9.9.9.9' })).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]); ok('login dibatasi 5 percobaan salah');
  assert.equal((await call('POST', '/api/login', { body: { password: env.ADMIN_PASSWORD }, ip: '9.9.9.9' })).status, 429); ok('IP terblokir walau password benar');
  assert.equal((await call('POST', '/api/login', { body: { password: env.ADMIN_PASSWORD }, ip: '8.8.8.8' })).status, 200); ok('IP lain tidak terpengaruh');
}

// 11. rute tak dikenal
{
  assert.equal((await call('GET', '/api/nope')).status, 404); ok('rute tak dikenal -> 404');
}

console.log('\nSemua ' + n + ' tes lolos.');
