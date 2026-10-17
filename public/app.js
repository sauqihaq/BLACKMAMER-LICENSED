'use strict';

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = 'rc_token';

let token = sessionStorage.getItem(TOKEN_KEY) || '';
let snap = null;
let offset = 0; // waktu server - waktu browser (ms)
let pollTimer = null;
let messageDirty = false;
let toastTimer = null;

// ---------- util ----------
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function pad(n) { return String(n).padStart(2, '0'); }

function clock(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() + offset - ms) / 1000));
  return s < 60 ? s + ' dtk lalu' : Math.round(s / 60) + ' mnt lalu';
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* body kosong */ }
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('Sesi habis, silakan masuk lagi.');
  }
  if (!res.ok) throw new Error(data.error || 'Permintaan gagal (' + res.status + ').');
  return data;
}

function confirmBox({ title, text, okLabel, withMessage, message }) {
  return new Promise((resolve) => {
    const d = $('#confirm');
    $('#cTitle').textContent = title;
    $('#cText').textContent = text;
    $('#cOk').textContent = okLabel;
    $('#cField').hidden = !withMessage;
    if (withMessage) $('#cInput').value = message || '';
    d.returnValue = '';
    d.addEventListener('close', () => {
      resolve(d.returnValue === 'ok' ? { ok: true, message: $('#cInput').value } : { ok: false });
    }, { once: true });
    d.showModal();
  });
}

// ---------- tampilan login / app ----------
function showLogin() {
  token = '';
  sessionStorage.removeItem(TOKEN_KEY);
  clearInterval(pollTimer);
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#password').value = '';
  $('#password').focus();
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 10000);
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#loginError');
  err.hidden = true;
  try {
    const data = await api('/api/login', { password: $('#password').value });
    token = data.token;
    sessionStorage.setItem(TOKEN_KEY, token);
    showApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$('#logout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', {}); } catch (_) { /* abaikan */ }
  showLogin();
});

// ---------- data ----------
async function refresh() {
  try {
    snap = await api('/api/admin/state');
    offset = snap.serverTime - Date.now();
    render();
  } catch (ex) {
    if (token) toast(ex.message);
  }
}

function lockState() {
  if (!snap || snap.lockAt === null || snap.lockAt === undefined) return 'open';
  return Date.now() + offset >= snap.lockAt ? 'locked' : 'pending';
}

function renderStatus() {
  if (!snap) return;
  const state = lockState();
  $('#status').dataset.state = state;
  $('#lockOpen').hidden = state !== 'open';
  $('#lockClosed').hidden = state === 'open';

  if (state === 'open') {
    $('#statusLabel').textContent = 'Game terbuka';
    $('#statusSub').textContent = snap.totalPlayers + ' pemain di ' + snap.servers.length + ' server sekarang.';
  } else if (state === 'pending') {
    const left = Math.max(0, Math.ceil((snap.lockAt - (Date.now() + offset)) / 1000));
    $('#statusLabel').textContent = 'Terkunci dalam ' + pad(Math.floor(left / 60)) + ':' + pad(left % 60);
    $('#statusSub').textContent = 'Pemain sudah melihat hitung mundur. Saat waktunya habis, semua pemain ditendang dan pemain baru ditolak.';
  } else {
    $('#statusLabel').textContent = 'Game terkunci';
    $('#statusSub').textContent = 'Pemain baru langsung ditolak. Server yang masih hidup menendang sisa pemain.';
  }
}

function renderServers() {
  const body = $('#serverRows');
  body.replaceChildren();
  $('#serversEmpty').hidden = snap.servers.length > 0;
  for (const s of snap.servers) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = s.jobId.slice(0, 8);
    if (s.studio) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'Studio';
      name.appendChild(tag);
    }
    const players = document.createElement('td');
    players.textContent = String(s.players);
    const seen = document.createElement('td');
    seen.textContent = ago(s.lastSeen);
    const ver = document.createElement('td');
    ver.textContent = s.version ? 'v' + s.version : '-';
    tr.append(name, players, seen, ver);
    body.appendChild(tr);
  }
}

function renderFeatures() {
  const list = $('#featureList');
  list.replaceChildren();
  $('#featuresEmpty').hidden = snap.catalog.length > 0;
  for (const f of snap.catalog) {
    const enabled = snap.features[f.id] !== false;
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = f.label;
    if (!enabled) name.className = 'off';

    const wrap = document.createElement('label');
    wrap.className = 'switch';
    wrap.style.margin = '0';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = enabled;
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', f.label);
    input.addEventListener('change', async () => {
      input.disabled = true;
      try {
        snap = await api('/api/admin/feature', { id: f.id, enabled: input.checked });
        toast(f.label + (input.checked ? ' dinyalakan.' : ' dimatikan.'));
      } catch (ex) {
        toast(ex.message);
      }
      refresh();
    });
    wrap.appendChild(input);
    li.append(name, wrap);
    list.appendChild(li);
  }
}

function renderAudit() {
  const ul = $('#auditList');
  ul.replaceChildren();
  for (const a of snap.audit) {
    const li = document.createElement('li');
    const t = document.createElement('time');
    t.textContent = clock(a.t);
    const text = document.createElement('span');
    text.textContent = a.text;
    li.append(t, text);
    ul.appendChild(li);
  }
}

function render() {
  if (!messageDirty && document.activeElement !== $('#lockMessage')) {
    $('#lockMessage').value = snap.lockMessage;
  }
  renderStatus();
  renderServers();
  renderFeatures();
  renderAudit();
}

setInterval(renderStatus, 1000);

// ---------- aksi ----------
$('#lockMessage').addEventListener('input', () => { messageDirty = true; });

$('#lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const delay = Number($('#lockDelay').value);
  const when = delay === 0 ? 'sekarang' : 'dalam ' + $('#lockDelay').selectedOptions[0].textContent.replace(' lagi', '');
  const r = await confirmBox({
    title: 'Kunci game ' + when + '?',
    text: delay === 0
      ? 'Semua pemain di semua server langsung ditendang dan pemain baru tidak bisa masuk.'
      : 'Pemain akan melihat hitung mundur, lalu semua ditendang dan pemain baru ditolak.',
    okLabel: 'Ya, kunci game',
  });
  if (!r.ok) return;
  try {
    snap = await api('/api/admin/lock', { delayMinutes: delay, message: $('#lockMessage').value });
    messageDirty = false;
    toast('Pengaturan kunci disimpan. Server game mengambilnya dalam sekitar 30 detik.');
    render();
  } catch (ex) { toast(ex.message); }
});

$('#unlockBtn').addEventListener('click', async () => {
  try {
    snap = await api('/api/admin/unlock', {});
    toast('Kunci dibuka. Pemain bisa masuk lagi.');
    render();
  } catch (ex) { toast(ex.message); }
});

$('#kickBtn').addEventListener('click', async () => {
  const r = await confirmBox({
    title: 'Tendang semua pemain?',
    text: 'Semua pemain di semua server dikeluarkan sekali. Mereka masih boleh join lagi.',
    okLabel: 'Ya, tendang semua',
    withMessage: true,
    message: snap ? snap.kickMessage : '',
  });
  if (!r.ok) return;
  try {
    snap = await api('/api/admin/kickall', { message: r.message });
    toast('Perintah dikirim. Server game mengambilnya dalam sekitar 30 detik.');
    render();
  } catch (ex) { toast(ex.message); }
});

// ---------- mulai ----------
if (token) showApp(); else showLogin();
