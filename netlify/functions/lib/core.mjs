/*
 * Logika inti panel kontrol. Sengaja nggak import apa pun dari Netlify supaya bisa dites lokal.
 * `store` = objek dengan get(key,{type:'json'}), setJSON(key,value), delete(key), list({prefix}).
 * Di Netlify, store ini adalah Netlify Blobs (consistency "strong").
 */

import crypto from 'node:crypto';

export const DEFAULT_LOCK_MESSAGE = 'Game sedang ditutup sementara. Silakan coba lagi nanti.';
export const DEFAULT_KICK_MESSAGE = 'Kamu dikeluarkan dari server oleh admin. Kamu boleh join lagi.';

const SESSION_TTL = 12 * 60 * 60 * 1000;
const SERVER_ALIVE_MS = 120 * 1000; // server dianggap hidup kalau lapor dalam 2 menit terakhir
const SERVER_FORGET_MS = 10 * 60 * 1000; // data server yang lebih lama dari ini dihapus
const MAX_BODY = 64 * 1024;
const MAX_MESSAGE = 200;
const MAX_DELAY_MINUTES = 24 * 60;
const MAX_SERVERS_SHOWN = 100;
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------- util ----------
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw fail(413, 'Request terlalu besar.');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) {
    throw fail(400, 'JSON tidak valid.');
  }
}

function cleanMessage(v, fallback) {
  if (typeof v !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_MESSAGE);
  return t || fallback;
}

function sanitizeCatalog(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const item of list.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!/^[a-z0-9_]{1,40}$/i.test(id) || RESERVED_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: cleanMessage(item.label, id).slice(0, 60) });
  }
  return out;
}

function safeJobKey(jobId) {
  const s = typeof jobId === 'string' ? jobId : '';
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : sha256hex(s).slice(0, 24);
}

// ---------- akses data ----------
async function getConfig(store) {
  const c = (await store.get('config', { type: 'json' })) || {};
  return {
    lockAt: Number.isFinite(c.lockAt) ? c.lockAt : null,
    lockMessage: typeof c.lockMessage === 'string' ? c.lockMessage : DEFAULT_LOCK_MESSAGE,
    kickNonce: Number.isInteger(c.kickNonce) ? c.kickNonce : 0,
    kickMessage: typeof c.kickMessage === 'string' ? c.kickMessage : DEFAULT_KICK_MESSAGE,
    features: c.features && typeof c.features === 'object' && !Array.isArray(c.features) ? c.features : {},
  };
}

async function addAudit(store, text) {
  const list = (await store.get('audit', { type: 'json' })) || [];
  list.push({ t: Date.now(), text });
  await store.setJSON('audit', list.slice(-200));
}

async function listServers(store) {
  const { blobs } = await store.list({ prefix: 'srv/' });
  const now = Date.now();
  const rows = await Promise.all(
    blobs.slice(0, MAX_SERVERS_SHOWN).map(async (b) => {
      const v = await store.get(b.key, { type: 'json' });
      return v ? Object.assign({ jobId: b.key.slice(4) }, v) : null;
    })
  );
  const live = [];
  const stale = [];
  for (const r of rows) {
    if (!r) continue;
    if (now - r.lastSeen <= SERVER_ALIVE_MS) live.push(r);
    else if (now - r.lastSeen > SERVER_FORGET_MS) stale.push(r);
  }
  await Promise.all(stale.map((r) => store.delete('srv/' + r.jobId)));
  live.sort((a, b) => b.players - a.players);
  return live;
}

async function adminSnapshot(store) {
  const [cfg, catalog, audit, servers] = await Promise.all([
    getConfig(store),
    store.get('catalog', { type: 'json' }),
    store.get('audit', { type: 'json' }),
    listServers(store),
  ]);
  return {
    serverTime: Date.now(),
    lockAt: cfg.lockAt,
    lockMessage: cfg.lockMessage,
    kickMessage: cfg.kickMessage,
    features: cfg.features,
    catalog: Array.isArray(catalog) ? catalog : [],
    servers,
    totalPlayers: servers.reduce((n, s) => n + (Number(s.players) || 0), 0),
    audit: (audit || []).slice(-40).reverse(),
  };
}

async function adminAuth(req, store) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const key = 'sess/' + sha256hex(token);
  const s = await store.get(key, { type: 'json' });
  if (!s) return null;
  if (s.exp < Date.now()) {
    await store.delete(key);
    return null;
  }
  return key;
}

// ---------- handler utama ----------
export async function handle(req, { store, env, ip }) {
  try {
    const ADMIN_PASSWORD = env.ADMIN_PASSWORD || '';
    const GAME_KEY = env.GAME_KEY || '';
    if (ADMIN_PASSWORD.length < 10 || GAME_KEY.length < 24) {
      throw fail(
        500,
        'Server belum dikonfigurasi: isi ADMIN_PASSWORD (min 10 karakter) dan GAME_KEY (min 24 karakter) di Environment variables Netlify, lalu deploy ulang.'
      );
    }

    const p = new URL(req.url).pathname.replace(/\/+$/, '');
    const m = req.method;

    // --- login admin ---
    if (m === 'POST' && p === '/api/login') {
      const now = Date.now();
      const rlKey = 'rl/' + sha256hex(ip || 'unknown');
      const rl = await store.get(rlKey, { type: 'json' });
      const a = rl && rl.resetAt > now ? rl : { count: 0, resetAt: now + 15 * 60 * 1000 };
      if (a.count >= 5) throw fail(429, 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.');

      const body = await readJson(req);
      if (!safeEqual(body.password || '', ADMIN_PASSWORD)) {
        a.count += 1;
        await store.setJSON(rlKey, a);
        throw fail(401, 'Password salah.');
      }
      if (rl) await store.delete(rlKey);

      const token = crypto.randomBytes(32).toString('hex');
      await store.setJSON('sess/' + sha256hex(token), { exp: now + SESSION_TTL });
      await addAudit(store, 'Admin masuk ke panel');
      return json(200, { token });
    }

    // --- dipanggil server game (Roblox) ---
    if (m === 'POST' && p === '/api/game/poll') {
      if (!safeEqual(req.headers.get('x-game-key') || '', GAME_KEY)) throw fail(401, 'Kunci game salah.');
      const body = await readJson(req);

      const writes = [];
      if (typeof body.jobId === 'string' && body.jobId) {
        writes.push(
          store.setJSON('srv/' + safeJobKey(body.jobId), {
            players: Math.max(0, Math.min(200, Number(body.players) || 0)),
            version: Number(body.placeVersion) || 0,
            studio: body.studio === true,
            lastSeen: Date.now(),
          })
        );
      }
      const catalog = sanitizeCatalog(body.catalog);
      if (catalog && catalog.length) writes.push(store.setJSON('catalog', catalog));

      const [cfg] = await Promise.all([getConfig(store), ...writes]);
      return json(200, {
        serverTime: Date.now(),
        lockAt: cfg.lockAt,
        lockMessage: cfg.lockMessage,
        features: cfg.features,
        kickNonce: cfg.kickNonce,
        kickMessage: cfg.kickMessage,
      });
    }

    // --- endpoint admin ---
    if (p.startsWith('/api/admin/')) {
      const sessKey = await adminAuth(req, store);
      if (!sessKey) throw fail(401, 'Belum masuk.');

      if (m === 'GET' && p === '/api/admin/state') return json(200, await adminSnapshot(store));

      if (m === 'POST' && p === '/api/admin/logout') {
        await store.delete(sessKey);
        return json(200, { ok: true });
      }

      if (m === 'POST' && p === '/api/admin/lock') {
        const body = await readJson(req);
        const delay = Number(body.delayMinutes);
        if (!Number.isFinite(delay) || delay < 0 || delay > MAX_DELAY_MINUTES) throw fail(400, 'Waktu tunda tidak valid.');
        const cfg = await getConfig(store);
        cfg.lockMessage = cleanMessage(body.message, DEFAULT_LOCK_MESSAGE);
        cfg.lockAt = Date.now() + Math.round(delay * 60 * 1000);
        await store.setJSON('config', cfg);
        await addAudit(store, delay === 0 ? 'Game dikunci sekarang' : 'Game dijadwalkan terkunci dalam ' + delay + ' menit');
        return json(200, await adminSnapshot(store));
      }

      if (m === 'POST' && p === '/api/admin/unlock') {
        const cfg = await getConfig(store);
        cfg.lockAt = null;
        await store.setJSON('config', cfg);
        await addAudit(store, 'Kunci game dibuka');
        return json(200, await adminSnapshot(store));
      }

      if (m === 'POST' && p === '/api/admin/feature') {
        const body = await readJson(req);
        const catalog = (await store.get('catalog', { type: 'json' })) || [];
        const entry = catalog.find((c) => c.id === body.id);
        if (!entry || typeof body.enabled !== 'boolean') throw fail(400, 'Fitur tidak dikenal.');
        const cfg = await getConfig(store);
        if (body.enabled) delete cfg.features[entry.id];
        else cfg.features[entry.id] = false;
        await store.setJSON('config', cfg);
        await addAudit(store, 'Fitur "' + entry.label + '" ' + (body.enabled ? 'dinyalakan' : 'dimatikan'));
        return json(200, await adminSnapshot(store));
      }

      if (m === 'POST' && p === '/api/admin/kickall') {
        const body = await readJson(req);
        const cfg = await getConfig(store);
        cfg.kickMessage = cleanMessage(body.message, DEFAULT_KICK_MESSAGE);
        cfg.kickNonce += 1;
        await store.setJSON('config', cfg);
        await addAudit(store, 'Semua pemain ditendang dari semua server');
        return json(200, await adminSnapshot(store));
      }
    }

    throw fail(404, 'Tidak ditemukan.');
  } catch (e) {
    const status = e.status || 500;
    if (status === 500 && !e.status) console.error(e);
    return json(status, { error: status === 500 && !e.status ? 'Terjadi kesalahan di server.' : e.message });
  }
}
