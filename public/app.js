/* SevakTV — a web IPTV player for Xtream Codes logins and M3U playlists.
   Plain JavaScript, no build step. Uses hls.js (HLS) and mpegts.js (MPEG-TS). */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const STORE_KEY = 'opentuner.v1';
const FILE_KEY = (id) => 'opentuner.file.' + id;
const DEMO = { name: 'Free news channels (iptv-org)', url: 'https://iptv-org.github.io/iptv/categories/news.m3u' };
const CHUNK = 150;

/* ------------------------------------------------------------------ store */

function defaultStore() {
  return { sources: [], activeId: null, favorites: {}, settings: { useProxy: true, format: 'm3u8', ua: '', sort: 'recent' }, ui: {} };
}
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.sources)) return { ...defaultStore(), ...s, settings: { ...defaultStore().settings, ...s.settings } };
  } catch {}
  return defaultStore();
}
function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.store)); } catch {}
}
const memoryFiles = new Map();
function saveFileText(id, text) {
  memoryFiles.set(id, text);
  try { localStorage.setItem(FILE_KEY(id), text); return true; } catch { return false; }
}
function getFileText(id) {
  if (memoryFiles.has(id)) return memoryFiles.get(id);
  try { return localStorage.getItem(FILE_KEY(id)); } catch { return null; }
}

const state = {
  store: loadStore(),
  proxyAvailable: false,
  catalog: null,
  section: 'live',
  category: '__all',
  query: '',
  filtered: [],
  rendered: 0,
  playing: null,     // item currently playing
  playList: [],      // list used for channel up/down
  device: null,      // { id, name, mac } from the helper server
  sheetItem: null,
  loadToken: 0,
};

const activeSource = () => state.store.sources.find((s) => s.id === state.store.activeId) || null;

/* ---------------------------------------------------------------- helpers */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const initials = (name) => (String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
const fmtTime = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function decodeB64(s) {
  if (!s) return '';
  try { return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); } catch { return s; }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

/* ---------------------------------------------------------------- network */

let proxyBase = ''; // '' = same origin as the page, or e.g. http://localhost:8080
const useProxy = () => state.proxyAvailable && state.store.settings.useProxy !== false;

function viaProxy(url, { raw = false, headers = {} } = {}) {
  if (!useProxy()) return url;
  let q = proxyBase + '/proxy?url=' + encodeURIComponent(url);
  const ua = headers.ua || state.store.settings.ua;
  if (ua) q += '&ua=' + encodeURIComponent(ua);
  if (headers.ref) q += '&ref=' + encodeURIComponent(headers.ref);
  if (headers.extra) q += '&h=' + btoa(JSON.stringify(headers.extra)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (raw) q += '&raw=1';
  return q;
}

function blockedReason(url) {
  if (useProxy()) return null;
  if (location.protocol === 'https:' && /^http:/i.test(url)) {
    return 'This address uses http://, which browsers block on a secure (https) page. Run the helper server (node server.js) and open SevakTV from it.';
  }
  if (state.proxyAvailable) return 'The helper server is turned off in Settings. Turn it back on and try again.';
  return 'The helper server isn’t running, so the browser blocked this request. In a terminal, go to the web-iptv folder, run: node server.js — keep that window open, then open http://localhost:8080 and try again.';
}

async function getText(url, headers, timeoutMs) {
  let res;
  const ac = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    res = await fetch(viaProxy(url, { raw: true, headers }), { cache: 'no-store', signal: ac.signal });
  } catch {
    clearTimeout(timer);
    if (ac.signal.aborted) throw new Error('The server took too long to answer.');
    throw new Error(blockedReason(url) || 'Could not reach the server.');
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text();
  if (res.status === 401 && /Sign in to SevakTV/.test(body)) { location.reload(); throw new Error('Please sign in again.'); }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('The server refused access (' + res.status + '). Check your login, or whether your subscription is active.');
    throw new Error((body && body.length < 200 ? body : 'The server answered with an error') + ' (' + res.status + ').');
  }
  return body;
}

async function getJSON(url) {
  const text = await getText(url);
  try { return JSON.parse(text); } catch { throw new Error('The server did not return the data SevakTV expected. Check the server URL.'); }
}

// Looks for the helper server: first where the page came from, then on the
// usual local addresses (so it also works when index.html is opened directly).
async function checkProxy() {
  const candidates = [];
  if (/^https?:$/.test(location.protocol)) candidates.push('');
  for (const host of ['localhost', '127.0.0.1']) {
    const base = `http://${host}:8080`;
    if (base !== location.origin) candidates.push(base);
  }
  for (const base of candidates) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 1500);
      const r = await fetch(base + '/api/status', { cache: 'no-store', signal: ac.signal });
      clearTimeout(timer);
      const j = r.ok ? await r.json() : null;
      if (j && j.proxy) { proxyBase = base; state.server = j; return true; }
    } catch {}
  }
  return false;
}

/* ----------------------------------------------------------------- xtream */

function xtBase(server) {
  let s = server.trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s);
  const p = u.pathname.replace(/\/(player_api|get|xmltv|panel_api)\.php$/i, '').replace(/\/+$/, '');
  return u.origin + p;
}

function xtApi(src, action, extra = {}) {
  const u = new URL(src.server + '/player_api.php');
  u.searchParams.set('username', src.username);
  u.searchParams.set('password', src.password);
  if (action) u.searchParams.set('action', action);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return getJSON(u.href);
}

const xtPath = (src, kind, id, ext) =>
  `${src.server}/${kind}/${encodeURIComponent(src.username)}/${encodeURIComponent(src.password)}/${id}.${ext}`;

// An M3U link like http://host/get.php?username=a&password=b is really an Xtream login.
function xtreamFromM3uUrl(url) {
  try {
    const u = new URL(url);
    if (!/\/get\.php$/i.test(u.pathname)) return null;
    const username = u.searchParams.get('username');
    const password = u.searchParams.get('password');
    if (!username || !password) return null;
    return { server: xtBase(u.origin + u.pathname), username, password };
  } catch { return null; }
}

async function loadXtream(src, onStep) {
  onStep('Signing in…');
  const auth = await xtApi(src);
  const ui = auth && auth.user_info;
  if (!ui || String(ui.auth) === '0') throw new Error('Login failed. Check the server URL, username and password.');
  if (ui.status && !/active/i.test(ui.status)) throw new Error('Your subscription status is "' + ui.status + '". Contact your provider.');
  src.account = {
    status: ui.status, exp: ui.exp_date ? Number(ui.exp_date) : null,
    max: ui.max_connections, active: ui.active_cons,
  };

  onStep('Loading channels, movies and series…');
  const safe = (p) => p.catch(() => []);
  const [lc, ls, vc, vs, sc, ss] = await Promise.all([
    safe(xtApi(src, 'get_live_categories')), safe(xtApi(src, 'get_live_streams')),
    safe(xtApi(src, 'get_vod_categories')), safe(xtApi(src, 'get_vod_streams')),
    safe(xtApi(src, 'get_series_categories')), safe(xtApi(src, 'get_series')),
  ]);
  const arr = (x) => (Array.isArray(x) ? x : []);
  const catMap = (cats) => new Map(arr(cats).map((c) => [String(c.category_id), c.category_name]));
  const lm = catMap(lc), vm = catMap(vc), sm = catMap(sc);
  const order = (cats) => arr(cats).map((c) => c.category_name);

  const live = arr(ls).map((s, i) => ({
    key: 'l' + s.stream_id, kind: 'live', id: s.stream_id, name: s.name, logo: s.stream_icon,
    group: lm.get(String(s.category_id)) || 'Uncategorized', num: Number(s.num) || i + 1, xt: true,
    archive: String(s.tv_archive) === '1' ? Number(s.tv_archive_duration) || 1 : 0,
  }));
  const movies = arr(vs).map((s) => ({
    key: 'm' + s.stream_id, kind: 'movie', id: s.stream_id, name: s.name, poster: s.stream_icon, added: Number(s.added) || 0,
    group: vm.get(String(s.category_id)) || 'Uncategorized', rating: s.rating, ext: s.container_extension || 'mp4', xt: true,
  }));
  const series = arr(ss).map((s) => ({
    key: 's' + s.series_id, kind: 'series', id: s.series_id, name: s.name, poster: s.cover, added: Number(s.last_modified) || 0,
    group: sm.get(String(s.category_id)) || 'Uncategorized', rating: s.rating, plot: s.plot,
    year: (s.releaseDate || s.release_date || '').slice(0, 4), genre: s.genre, xt: true,
  }));
  return buildCatalog({ live, movies, series }, { live: order(lc), movies: order(vc), series: order(sc) });
}

/* -------------------------------------------------------------------- m3u */

function parseM3U(text) {
  const out = [];
  let cur = null;
  let n = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      cur = { attrs: {}, headers: {} };
      // name is everything after the first comma that is not inside quotes
      let inQ = false, cut = -1;
      for (let i = 8; i < line.length; i++) {
        const c = line[i];
        if (c === '"') inQ = !inQ;
        else if (c === ',' && !inQ) { cut = i; break; }
      }
      const head = cut >= 0 ? line.slice(0, cut) : line;
      cur.name = cut >= 0 ? line.slice(cut + 1).trim() : '';
      for (const m of head.matchAll(/([\w-]+)="([^"]*)"/g)) cur.attrs[m[1].toLowerCase()] = m[2];
    } else if (line.startsWith('#EXTGRP:')) {
      if (cur) cur.attrs['group-title'] ||= line.slice(8).trim();
    } else if (line.startsWith('#EXTVLCOPT:')) {
      if (!cur) continue;
      const [k, ...v] = line.slice(11).split('=');
      const val = v.join('=').trim();
      if (/http-user-agent/i.test(k)) cur.headers.ua = val;
      if (/http-referr?er/i.test(k)) cur.headers.ref = val;
    } else if (!line.startsWith('#')) {
      const e = cur || { attrs: {}, headers: {}, name: '' };
      n++;
      out.push({
        name: e.name || e.attrs['tvg-name'] || line.split('/').pop(),
        logo: e.attrs['tvg-logo'] || '',
        group: (e.attrs['group-title'] || '').split(';')[0].trim() || 'Uncategorized',
        tvgId: e.attrs['tvg-id'] || '',
        num: Number(e.attrs['tvg-chno']) || n,
        url: line,
        headers: e.headers,
      });
      cur = null;
    }
  }
  return out;
}

async function loadM3U(src, onStep) {
  let text;
  if (src.type === 'file') {
    text = getFileText(src.id);
    if (text == null) throw new Error('This playlist file is no longer stored in the browser. Remove it and add the file again.');
  } else {
    onStep('Downloading playlist…');
    text = await getText(src.url);
  }
  if (!/#EXTM3U|#EXTINF/i.test(text.slice(0, 2000))) throw new Error('That doesn’t look like an M3U playlist.');
  onStep('Reading playlist…');
  const entries = parseM3U(text);
  if (!entries.length) throw new Error('The playlist is empty.');
  const live = [], movies = [];
  entries.forEach((e, i) => {
    const isVod = /\/(movie|series)\//i.test(e.url) || /\.(mp4|mkv|avi|mov|m4v)(\?|$)/i.test(e.url);
    const item = { key: (isVod ? 'm' : 'l') + i, id: i, added: i, name: e.name, group: e.group, url: e.url, headers: e.headers };
    if (isVod) movies.push({ ...item, kind: 'movie', poster: e.logo });
    else live.push({ ...item, kind: 'live', logo: e.logo, num: e.num });
  });
  return buildCatalog({ live, movies, series: [] }, {});
}

function buildCatalog(lists, order) {
  const cats = {};
  for (const sec of ['live', 'movies', 'series']) {
    const counts = new Map();
    for (const name of order[sec] || []) counts.set(name, 0);
    for (const it of lists[sec]) counts.set(it.group, (counts.get(it.group) || 0) + 1);
    cats[sec] = [...counts].filter(([, n]) => n > 0).map(([name, n]) => ({ name, n }));
  }
  const byKey = new Map();
  for (const sec of ['live', 'movies', 'series']) for (const it of lists[sec]) byKey.set(it.key, it);
  return { ...lists, cats, byKey };
}

async function loadSource(src, onStep = () => {}) {
  if (src.type === 'stalker') return loadStalker(src, onStep);
  return src.type === 'xtream' ? loadXtream(src, onStep) : loadM3U(src, onStep);
}

const hasSection = (cat, sec) => !!(cat && (cat[sec]?.length || cat.lazy?.[sec]));
const isLazy = (sec = state.section) => !!state.catalog?.lazy?.[sec];

/* ---------------------------------------------------------------- stalker */
// Stalker / Ministra / MAG portals: the app acts like a MAG250 set-top box.
// Needs the helper server, which adds the box's cookie and headers.

const MAG_UA = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
const ST_PAGE_CAP = 3000; // newest items loaded per movie/series category
class PortalAuthError extends Error {}

function normalizeMac(input) {
  const hex = String(input || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

// Portal addresses come in many shapes (http://host, http://host:8080/c/,
// http://host/stalker_portal/c/ …). The API lives next to them, usually at
// portal.php or server/load.php. This lists the likely API addresses, most
// likely first. `extra` holds addresses the portal redirected to.
function stalkerApiCandidates(portal, extra = []) {
  const first = [], second = [];
  const add = (list, x) => { if (!first.includes(x) && !second.includes(x)) list.push(x); };
  for (const raw of [...extra, portal]) {
    let s = String(raw || '').trim();
    if (!s) continue;
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    let u;
    try { u = new URL(s); } catch { continue; }
    if (/\/(portal|load)\.php$/i.test(u.pathname)) add(first, u.origin + u.pathname);
    const p = u.pathname.replace(/\/[^/]+\.(php|html?)$/i, '').replace(/\/+$/, '').replace(/\/c$/i, '');
    const parent = p.replace(/\/[^/]*$/, '');
    for (const base of [p, parent, '/stalker_portal', '']) {
      const sp = /stalker_portal$/i.test(base);
      add(first, u.origin + base + (sp ? '/server/load.php' : '/portal.php'));
      add(second, u.origin + base + (sp ? '/portal.php' : '/server/load.php'));
    }
  }
  return [...first, ...second];
}

// Opens the portal address the way a browser would and reports where it led:
// an HTTP redirect, a <meta refresh>, or a simple script redirect.
async function stalkerRedirects(src) {
  const found = [];
  try {
    const res = await fetch(viaProxy(src.portal, { raw: true, headers: stHeaders(src, false) }), { cache: 'no-store', signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
    const finalUrl = decodeURI(res.headers.get('X-Final-Url') || '') || src.portal;
    if (finalUrl !== src.portal) found.push(finalUrl);
    const html = (await res.text()).slice(0, 20000);
    const m = html.match(/http-equiv=["']?refresh["']?[^>]*?url=['"]?([^"'>\s]+)/i) ||
      html.match(/(?:window\.|document\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
    if (m) { try { found.push(new URL(m[1], finalUrl).href); } catch {} }
  } catch {}
  return found;
}

function stHeaders(src, withAuth = true) {
  let tz = 'Europe/London';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch {}
  const extra = {
    Cookie: `mac=${encodeURIComponent(src.mac)}; stb_lang=en; timezone=${encodeURIComponent(tz)}`,
    'X-User-Agent': 'Model: MAG250; Link: WiFi',
  };
  if (withAuth && src.token) extra.Authorization = 'Bearer ' + src.token;
  return { ua: MAG_UA, ref: src.portal, extra };
}

async function stRaw(src, api, params, withAuth = true, timeoutMs = 20000) {
  const u = new URL(api);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v ?? '');
  u.searchParams.set('JsHttpRequest', '1-xml');
  let text;
  try {
    text = await getText(u.href, stHeaders(src, withAuth), timeoutMs);
  } catch (e) {
    if (/refused access \((401|403)\)/.test(e.message)) throw new PortalAuthError(e.message);
    throw e;
  }
  if (/authori[sz]ation failed/i.test(text)) throw new PortalAuthError('Authorization failed');
  try { return JSON.parse(text); } catch { throw new Error('The portal sent an answer SevakTV couldn’t read. Check the portal URL.'); }
}

async function stalkerAuth(src) {
  src.token = '';
  if (src.api) {
    try {
      const h = await stRaw(src, src.api, { type: 'stb', action: 'handshake', token: '', prehash: '' }, false, 12000);
      if (h && h.js && h.js.token) src.token = h.js.token;
    } catch {}
    if (!src.token) src.api = ''; // the saved address stopped working: search again
  }
  if (!src.token) {
    const tried = [];
    const apis = stalkerApiCandidates(src.portal, await stalkerRedirects(src));
    for (const api of apis) {
      let why;
      try {
        const h = await stRaw(src, api, { type: 'stb', action: 'handshake', token: '', prehash: '' }, false, 8000);
        if (h && h.js && h.js.token) { src.api = api; src.token = h.js.token; break; }
        why = 'answered, but without a session key';
      } catch (e) {
        why = e instanceof PortalAuthError ? 'MAC not accepted'
          : /couldn’t read/.test(e.message) ? 'not a Stalker portal'
          : /too long/.test(e.message) ? 'no answer (timed out)'
          : /Could not reach/.test(e.message) ? 'couldn’t connect'
          : /\((\d{3})\)/.test(e.message) ? 'error ' + e.message.match(/\((\d{3})\)/)[1]
          : /helper server/.test(e.message) ? 'blocked: helper server not running'
          : 'no answer';
      }
      tried.push({ api, why });
    }
    if (!src.token) {
      const macRefused = tried.find((t) => t.why === 'MAC not accepted');
      const list = tried.map((t) => `• ${t.api} — ${t.why}`).join('\n');
      if (macRefused) {
        throw new Error(`Found the portal at ${macRefused.api}, but it didn’t accept this device’s MAC (${src.mac}). Ask your provider to activate it.`);
      }
      if (tried.length && tried.every((t) => t.why === 'couldn’t connect')) {
        throw new Error(`Couldn’t connect to ${src.portal}. Check the address and port your provider gave you, and that the portal is online.`);
      }
      throw new Error(`Couldn’t find a Stalker portal at ${src.portal}. Check the address and port your provider gave you.\nAddresses tried:\n${list}`);
    }
  }
  const prof = await stRaw(src, src.api, {
    type: 'stb', action: 'get_profile', hd: 1, num_banks: 2, stb_type: 'MAG250', client_type: 'STB',
    image_version: 218, video_out: 'hdmi', hw_version: '1.7-BD-00', not_valid_token: 0, auth_second_step: 1,
    sn: src.sn || '', device_id: src.deviceId || '', device_id2: src.deviceId || '', signature: '',
    ver: 'ImageDescription: 0.2.18-r23-250; PORTAL version: 5.6.2; API Version: JS API version: 343; STB API version: 146',
    timestamp: Math.floor(Date.now() / 1000), api_signature: 262, metrics: '',
  }).catch((e) => { if (e instanceof PortalAuthError) throw new Error(`The portal rejected this device’s MAC (${src.mac}). Ask your provider to activate it.`); throw e; });
  const p = prof && prof.js;
  if (p && String(p.blocked) === '1') throw new Error('This MAC address is blocked by the portal. Contact your provider.');
  if (p && p.msg && !p.id && Number(p.status) > 0) throw new Error('The portal says: ' + p.msg);
}

async function stalkerCall(src, params, retry = true) {
  try {
    if (!src.token) await stalkerAuth(src);
    return await stRaw(src, src.api, params);
  } catch (e) {
    if (e instanceof PortalAuthError && retry) { await stalkerAuth(src); return stalkerCall(src, params, false); }
    throw e;
  }
}

// Portals give the catch-up length in hours or days; more than 31 means hours.
const stArchiveDays = (v) => { const n = Number(v) || 0; return n > 31 ? Math.ceil(n / 24) : n || 7; };
const stList = (js) => (Array.isArray(js) ? js : Array.isArray(js?.data) ? js.data : []);
const stTime = (s) => { const t = Date.parse(String(s || '').replace(' ', 'T')); return Number.isFinite(t) ? t / 1000 : 0; };

function stImage(src, url, logoDir) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  try {
    const origin = new URL(src.api).origin;
    if (url.startsWith('/')) return origin + url;
    if (logoDir) return new URL(src.api).href.replace(/\/(server\/load|portal)\.php.*$/i, '') + '/misc/logos/320/' + url;
    return origin + '/' + url;
  } catch { return ''; }
}

async function loadStalker(src, onStep) {
  onStep('Connecting to portal…');
  await stalkerAuth(src);
  try {
    const acc = await stRaw(src, src.api, { type: 'account_info', action: 'get_main_info' });
    const j = acc && acc.js;
    src.account = { stExpiry: (j && (j.end_date || j.phone || j.expire_billing_date)) || '' };
  } catch { src.account = {}; }

  onStep('Loading channels…');
  const genres = stList((await stalkerCall(src, { type: 'itv', action: 'get_genres' })).js);
  const gm = new Map(genres.filter((g) => String(g.id) !== '*').map((g) => [String(g.id), g.title]));
  let chans = stList((await stalkerCall(src, { type: 'itv', action: 'get_all_channels' }).catch(() => ({}))).js);
  if (!chans.length) {
    for (let p = 1; p <= 200; p++) {
      const js = (await stalkerCall(src, { type: 'itv', action: 'get_ordered_list', genre: '*', p, sortby: 'number' })).js || {};
      const data = stList(js);
      chans.push(...data);
      if (!data.length || chans.length >= Number(js.total_items || 0)) break;
    }
  }
  const live = chans.map((c, i) => ({
    key: 'l' + c.id, kind: 'live', id: c.id, name: c.name, logo: stImage(src, c.logo, true),
    group: gm.get(String(c.tv_genre_id)) || 'Uncategorized', num: Number(c.number) || i + 1, cmd: c.cmd, st: true,
    archive: String(c.tv_archive) === '1' || String(c.archive) === '1' ? stArchiveDays(c.tv_archive_duration) : 0,
  }));

  onStep('Loading movie and series categories…');
  const vodCats = stList((await stalkerCall(src, { type: 'vod', action: 'get_categories' }).catch(() => ({}))).js);
  const serCats = stList((await stalkerCall(src, { type: 'series', action: 'get_categories' }).catch(() => ({}))).js);
  const cats = (list) => list.filter((c) => String(c.id) !== '*').map((c) => ({ name: c.title || c.name, value: String(c.id), n: '' }));

  const catalog = buildCatalog({ live, movies: [], series: [] }, {});
  catalog.cats.movies = cats(vodCats);
  catalog.cats.series = cats(serCats);
  catalog.lazy = { movies: vodCats.length > 0, series: serCats.length > 0 };
  catalog.lazyCache = new Map();
  return catalog;
}

function stVodItem(src, v, section, catName) {
  const isSeries = section === 'series' || String(v.is_series) === '1';
  const base = {
    id: v.id, name: v.name, poster: stImage(src, v.screenshot_uri || v.cover_big || v.logo), group: catName,
    added: stTime(v.added), rating: v.rating_imdb || v.rating_kinopoisk || '', year: String(v.year || '').slice(0, 4),
    plot: v.description || '', genre: v.genres_str || '', duration: v.time ? v.time + ' min' : '', cmd: v.cmd, st: true,
  };
  if (section === 'series') return { ...base, key: 's' + v.id, kind: 'series', stType: 'series' };
  if (isSeries) return { ...base, key: 'sv' + v.id, kind: 'series', stType: 'vodseries', seriesNums: Array.isArray(v.series) ? v.series : [] };
  return { ...base, key: 'm' + v.id, kind: 'movie' };
}

// Loads one movie/series category page by page (newest first), showing items as they arrive.
async function loadLazyCategory(entry, section, catId, catName) {
  const src = activeSource();
  const token = state.loadToken;
  entry.started = true;
  const type = section === 'series' ? 'series' : 'vod';
  const page = (p) => stalkerCall(src, { type, action: 'get_ordered_list', category: catId, genre: catId, p, sortby: 'added', fav: 0, hd: 0, not_ended: 0 });
  const add = (js) => {
    for (const v of stList(js)) {
      const it = stVodItem(src, v, section, catName);
      entry.items.push(it);
      state.catalog.byKey.set(it.key, it);
    }
  };
  try {
    const js = (await page(1)).js || {};
    if (token !== state.loadToken) return;
    entry.total = Number(js.total_items) || stList(js).length;
    const per = Number(js.max_page_items) || stList(js).length || 14;
    add(js);
    lazyProgress(entry);
    const pages = Math.min(Math.ceil(entry.total / per), Math.ceil(ST_PAGE_CAP / per));
    const results = new Map();
    let next = 2, appendAt = 2;
    const worker = async () => {
      while (next <= pages) {
        const p = next++;
        const r = await page(p).catch(() => ({ js: [] }));
        if (token !== state.loadToken) return;
        results.set(p, r.js);
        while (results.has(appendAt)) { add(results.get(appendAt)); results.delete(appendAt); appendAt++; }
        lazyProgress(entry);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (token !== state.loadToken) return;
    entry.capped = entry.total > entry.items.length;
  } catch (e) {
    entry.error = e.message;
  }
  entry.done = true;
  lazyProgress(entry, true);
}

function lazyProgress(entry, finished) {
  if (state.currentLazy !== entry) return;
  const sortedByPortal = (state.store.settings.sort || 'recent') === 'recent' && !state.query.trim();
  if (finished) { applyFilter(true); return; }
  updateLazyCount(entry);
  if (entry.items.length) $('#empty').hidden = true;
  if (sortedByPortal && sentinelVisible()) renderMore();
}

function updateLazyCount(entry) {
  const n = entry.items.length.toLocaleString();
  let text = n;
  if (!entry.done) text = `${n} of ${Number(entry.total || 0).toLocaleString()} · loading…`;
  else if (entry.capped) text = `newest ${n} of ${Number(entry.total).toLocaleString()}`;
  $('#browser-count').textContent = text;
}

async function stalkerLink(src, type, cmd, series = '') {
  const d = await stalkerCall(src, { type, action: 'create_link', cmd, series, forced_storage: 0, disable_ad: 0, download: 0, force_ch_link_check: 0 });
  let url = d && d.js && (typeof d.js === 'string' ? d.js : d.js.cmd);
  if (typeof url !== 'string') throw new Error('The portal didn’t return a link for this item.');
  url = url.replace(/^(ffmpeg|ffrt\d?|auto|rtsp|rtmp)\s+/i, '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('The portal returned a link this player can’t open.');
  return url;
}

async function stalkerEpisodes(src, item) {
  if (item.stType === 'vodseries') {
    const nums = item.seriesNums.length ? item.seriesNums : [1];
    return { '1': nums.map((n) => ({ episode_num: n, title: 'Episode ' + n, _cmd: item.cmd, _series: n })) };
  }
  const seasons = stList((await stalkerCall(src, { type: 'series', action: 'get_ordered_list', movie_id: item.id, season_id: 0, episode_id: 0, p: 1 })).js);
  const out = {};
  for (let i = 0; i < seasons.length; i++) {
    const s = seasons[i];
    const label = String(s.season_number || (String(s.name || '').match(/\d+/) || [])[0] || i + 1);
    if (Array.isArray(s.series) && s.series.length) {
      out[label] = s.series.map((n) => ({ episode_num: n, title: 'Episode ' + n, _cmd: s.cmd, _series: n }));
    } else {
      const eps = stList((await stalkerCall(src, { type: 'series', action: 'get_ordered_list', movie_id: item.id, season_id: s.id, episode_id: 0, p: 1 })).js);
      out[label] = eps.map((e, j) => ({ episode_num: e.series_number || j + 1, title: e.name, _cmd: e.cmd, _series: e.series_number || '' }));
    }
  }
  return out;
}

/* -------------------------------------------------------------- favorites */

function favSet() {
  const id = state.store.activeId;
  return new Set(state.store.favorites[id] || []);
}
function isFav(item) { return favSet().has(item.key); }
function toggleFav(item) {
  const id = state.store.activeId;
  const set = favSet();
  set.has(item.key) ? set.delete(item.key) : set.add(item.key);
  state.store.favorites[id] = [...set];
  // Keep a copy so favorites from lazily loaded lists show up after a restart.
  state.store.favMeta ||= {};
  const meta = (state.store.favMeta[id] ||= {});
  if (set.has(item.key)) {
    const { _episodes, _season, ...copy } = item;
    meta[item.key] = copy;
  } else delete meta[item.key];
  saveStore();
  return set.has(item.key);
}

/* ------------------------------------------------------------ app screens */

function showWelcome({ cancellable = false } = {}) {
  $('#welcome').hidden = false;
  $('#app').hidden = true;
  $('#add-cancel').hidden = !cancellable;
  $('#add-error').hidden = true;
  const note = $('#proxy-note-welcome');
  if (!state.proxyAvailable) {
    note.hidden = false;
    note.innerHTML = 'SevakTV is running without its helper server, so many providers will be blocked by the browser. For best results run <code>node server.js</code> and open <code>http://localhost:8080</code>.';
  } else note.hidden = true;
}

function showApp() {
  $('#welcome').hidden = true;
  $('#app').hidden = false;
  const b = $('#proxy-banner');
  if (!state.proxyAvailable) {
    b.hidden = false;
    b.innerHTML = 'Running without the helper server. If channels won’t load, run <code>node server.js</code> and open <code>http://localhost:8080</code>.';
  } else b.hidden = true;
  renderSourceSelect();
}

function renderSourceSelect() {
  const sel = $('#source-select');
  sel.innerHTML = state.store.sources.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('') +
    '<option value="__add">+ Add playlist…</option>';
  sel.value = state.store.activeId || '';
}

async function openSource(src) {
  const token = ++state.loadToken;
  stopPlayback(true);
  state.catalog = null;
  state.playing = null;
  $('#now').hidden = true;
  $('#channel-list').innerHTML = '';
  $('#poster-grid').innerHTML = '';
  $('#cat-list').innerHTML = '';
  $('#empty').hidden = true;
  $('#browser-count').textContent = '';
  setLoading('Loading…');
  try {
    const cat = await loadSource(src, (msg) => token === state.loadToken && setLoading(msg));
    if (token !== state.loadToken) return;
    state.catalog = cat;
    saveStore(); // keeps refreshed account info
    setLoading(null);
    const remembered = state.store.ui[src.id]?.section;
    const firstNonEmpty = ['live', 'movies', 'series'].find((s) => hasSection(cat, s)) || 'live';
    setSection(remembered && (remembered === 'favorites' || hasSection(cat, remembered)) ? remembered : firstNonEmpty);
  } catch (e) {
    if (token !== state.loadToken) return;
    setLoading(null);
    showEmpty(e.message, true);
  }
}

function setLoading(msg) {
  $('#loading').hidden = !msg;
  if (msg) $('#loading-text').textContent = msg;
}

function showEmpty(msg, retry) {
  const el = $('#empty');
  el.hidden = false;
  el.innerHTML = `<p>${esc(msg)}</p>` + (retry ? '<button class="btn btn-ghost" id="retry-load">Try again</button>' : '');
  if (retry) $('#retry-load').onclick = () => openSource(activeSource());
}

/* --------------------------------------------------------------- browsing */

function setSection(sec) {
  state.section = sec;
  state.category = '__all';
  const src = activeSource();
  if (src) { state.store.ui[src.id] = { section: sec }; saveStore(); }
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-on', t.dataset.section === sec));
  const c = state.catalog;
  if (c) {
    $('#t-movies').hidden = !hasSection(c, 'movies');
    $('#t-series').hidden = !hasSection(c, 'series');
  }
  const showStage = sec === 'live' || sec === 'favorites';
  $('#layout').classList.toggle('no-stage', !showStage);
  renderCategories();
  applyFilter();
}

function sectionCats() {
  const c = state.catalog;
  if (!c) return [];
  if (state.section === 'favorites') {
    const favs = favItems();
    const kinds = [['live', 'Live TV'], ['movie', 'Movies'], ['series', 'Series']];
    return kinds.map(([k, name]) => ({ name, value: k, n: favs.filter((f) => f.kind === k).length })).filter((x) => x.n);
  }
  return c.cats[state.section].map((x) => ({ ...x, value: x.value ?? x.name }));
}

function sectionItems() {
  if (!state.catalog) return [];
  return state.section === 'favorites' ? favItems() : state.catalog[state.section];
}

function favItems() {
  const set = favSet();
  const out = [];
  const meta = state.store.favMeta?.[state.store.activeId] || {};
  for (const key of set) { const it = state.catalog?.byKey.get(key) || meta[key]; if (it) out.push(it); }
  return out;
}

function renderCategories() {
  const cats = sectionCats();
  const total = isLazy() ? '' : sectionItems().length;
  const allLabel = { live: 'All channels', movies: 'All movies', series: 'All series', favorites: 'All favorites' }[state.section];
  const rows = [{ name: allLabel, value: '__all', n: total }, ...cats];
  $('#cat-list').innerHTML = rows.map((r) =>
    `<li><button data-cat="${esc(r.value)}" class="${r.value === state.category ? 'is-on' : ''}"><span class="label">${esc(r.name)}</span><span class="n">${r.n}</span></button></li>`
  ).join('');
  $('#cat-select').innerHTML = rows.map((r) => `<option value="${esc(r.value)}">${esc(r.name)}${r.n === '' ? '' : ` (${r.n})`}</option>`).join('');
  $('#cat-select').value = state.category;
}

function setCategory(value) {
  state.category = value;
  document.querySelectorAll('#cat-list button').forEach((b) => b.classList.toggle('is-on', b.dataset.cat === value));
  $('#cat-select').value = value;
  applyFilter();
  $('.browser').scrollTop = 0;
}

function applyFilter(keepScroll) {
  const cat = state.category;
  const q = state.query.trim().toLowerCase();
  const sort = state.store.settings.sort || 'recent';
  let items = sectionItems();
  let lazyEntry = null;
  state.currentLazy = null;
  if (isLazy()) {
    const catId = cat === '__all' ? '*' : cat;
    const key = state.section + ':' + catId;
    lazyEntry = state.catalog.lazyCache.get(key);
    if (!lazyEntry) { lazyEntry = { items: [], total: 0, done: false }; state.catalog.lazyCache.set(key, lazyEntry); }
    state.currentLazy = lazyEntry;
    const catName = cat === '__all' ? '' : (sectionCats().find((c) => c.value === cat)?.name || '');
    if (!lazyEntry.started) loadLazyCategory(lazyEntry, state.section, catId, catName);
    // Newest-first comes straight from the portal, so the growing list is shown as is.
    items = lazyEntry.items;
    if (q) items = items.filter((i) => i.name && i.name.toLowerCase().includes(q));
    if (sort !== 'recent' && lazyEntry.done) items = sortItems(items, sort);
  } else if (cat !== '__all') {
    items = state.section === 'favorites' ? items.filter((i) => i.kind === cat) : items.filter((i) => i.group === cat);
  }
  if (!lazyEntry) {
    if (q) items = items.filter((i) => i.name && i.name.toLowerCase().includes(q));
    if (state.section === 'movies' || state.section === 'series') items = sortItems(items, sort);
  }
  const scroll = keepScroll ? $('.browser').scrollTop : 0;
  const winScroll = keepScroll ? window.scrollY : 0;
  state.filtered = items;
  state.rendered = 0;

  const label = cat === '__all'
    ? { live: 'All channels', movies: 'All movies', series: 'All series', favorites: 'Favorites' }[state.section]
    : (sectionCats().find((c) => c.value === cat)?.name || cat);
  $('#browser-title').textContent = q ? `“${state.query.trim()}” in ${label}` : label;
  $('#browser-count').textContent = state.catalog ? items.length.toLocaleString() : '';
  if (lazyEntry) updateLazyCount(lazyEntry);

  const grid = state.section === 'movies' || state.section === 'series';
  $('#sort-wrap').hidden = !grid;
  $('#sort-select').value = state.store.settings.sort || 'recent';
  $('#channel-list').hidden = grid;
  $('#poster-grid').hidden = !grid;
  $('#channel-list').innerHTML = '';
  $('#poster-grid').innerHTML = '';
  renderContinue();

  const empty = $('#empty');
  if (lazyEntry && !lazyEntry.done && !items.length) {
    empty.hidden = false;
    empty.innerHTML = '<p><span class="spinner"></span> Loading from the portal…</p>';
  } else if (lazyEntry && lazyEntry.error && !items.length) {
    empty.hidden = false;
    empty.innerHTML = `<p>${esc(lazyEntry.error)}</p>`;
  } else if (state.catalog && !items.length) {
    empty.hidden = false;
    empty.innerHTML = state.section === 'favorites' && !q
      ? '<p>No favorites yet. Tap ★ next to a channel, movie or series to keep it here.</p>'
      : '<p>Nothing matches. Try another word or category.</p>';
  } else if (state.catalog) empty.hidden = true;

  renderMore();
  if (keepScroll) {
    while (state.rendered < state.filtered.length && $('.browser').scrollHeight < scroll + $('.browser').clientHeight) renderMore();
    $('.browser').scrollTop = scroll;
    if (winScroll) window.scrollTo(0, winScroll);
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function sortItems(items, how) {
  const list = items.slice();
  const byName = (a, b) => collator.compare(a.name || '', b.name || '');
  const added = (x) => x.added || 0;
  switch (how) {
    case 'oldest': return list.sort((a, b) => added(a) - added(b) || byName(a, b));
    case 'az': return list.sort(byName);
    case 'za': return list.sort((a, b) => byName(b, a));
    case 'rating': return list.sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) || byName(a, b));
    default: return list.sort((a, b) => added(b) - added(a) || byName(a, b));
  }
}

function renderMore() {
  const items = state.filtered;
  if (state.rendered >= items.length) return;
  const end = Math.min(items.length, state.rendered + CHUNK);
  const grid = state.section === 'movies' || state.section === 'series';
  const frag = document.createDocumentFragment();
  for (let i = state.rendered; i < end; i++) frag.appendChild(grid ? posterEl(items[i], i) : rowEl(items[i], i));
  (grid ? $('#poster-grid') : $('#channel-list')).appendChild(frag);
  state.rendered = end;
  requestAnimationFrame(() => { if (sentinelVisible()) renderMore(); });
}

function sentinelVisible() {
  const r = $('#sentinel').getBoundingClientRect();
  const box = $('.browser').getBoundingClientRect();
  const bottom = Math.min(window.innerHeight, box.bottom > 0 ? box.bottom : window.innerHeight);
  return r.top < bottom + 400;
}

function logoHTML(src, name, cls) {
  if (src) return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${esc(initials(name))}">`;
  return `<span class="${cls}">${esc(initials(name))}</span>`;
}

function rowEl(item, idx) {
  const li = document.createElement('li');
  li.className = 'ch' + (state.playing && state.playing.key === item.key ? ' is-playing' : '');
  li.dataset.idx = idx;
  const sub = state.section === 'favorites'
    ? ({ live: 'Live TV', movie: 'Movie', series: 'Series' }[item.kind] + ' · ' + item.group)
    : item.group + (item.archive ? ' · Catch-up' : '');
  const num = item.kind === 'live' ? item.num : '';
  li.innerHTML =
    `<span class="ch-num">${esc(num)}</span>` +
    logoHTML(item.logo || item.poster, item.name, 'logo') +
    `<span class="ch-name">${esc(item.name)}<span class="ch-sub">${esc(sub)}</span></span>` +
    `<button class="star${isFav(item) ? ' is-on' : ''}" aria-label="Favorite" aria-pressed="${isFav(item)}">★</button>`;
  return li;
}

function posterEl(item, idx) {
  const li = document.createElement('li');
  li.className = 'poster';
  li.dataset.idx = idx;
  li.tabIndex = 0;
  const meta = [item.year, item.rating && Number(item.rating) ? '★ ' + Number(item.rating).toFixed(1) : ''].filter(Boolean).join(' · ');
  li.innerHTML = (item.poster
    ? `<img class="poster-img" src="${esc(item.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${esc(item.name)}">`
    : `<span class="poster-img">${esc(item.name)}</span>`) +
    (() => { const pr = item.kind === 'movie' && progressMap()[item.key]; return pr && pr.dur ? `<span class="pbar"><i style="width:${Math.round((pr.pos / pr.dur) * 100)}%"></i></span>` : ''; })() +
    `<span class="poster-name" title="${esc(item.name)}">${esc(item.name)}</span>` +
    (meta ? `<span class="poster-meta">${esc(meta)}</span>` : '');
  return li;
}

// Broken logos fall back to initials.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
  const span = document.createElement('span');
  span.className = img.className;
  span.textContent = img.dataset.fallback;
  img.replaceWith(span);
}, true);

function activate(item) {
  if (item.kind === 'live') playLive(item);
  else openSheet(item);
}

/* ----------------------------------------------------------------- player */

const video = $('#video');
const player = { hls: null, ts: null, token: 0, retries: 0, request: null };

function stopPlayback(resetUI) {
  clearTimeout(player.attemptTimer);
  saveProgress();
  player.context = null;
  player.token++;
  if (player.hls) { player.hls.destroy(); player.hls = null; }
  if (player.ts) { destroyTs(player.ts); player.ts = null; }
  video.onerror = null;
  video.removeAttribute('src');
  video.load();
  if (resetUI) { setStatus(null); $('#player-idle').hidden = false; $('#layout').classList.remove('has-playing'); window.PUI?.onIdle(); }
}

function setStatus(msg, { error = false, retry = false } = {}) {
  $('#player').classList.remove('has-problem');
  const el = $('#player-status');
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle('is-error', error);
  el.innerHTML = `<span>${esc(msg)}</span>` + (retry ? '<button class="btn btn-ghost" id="play-retry">Try again</button>' : '');
  if (retry) $('#play-retry').onclick = () => (player.replay ? player.replay() : player.request && startPlayback(player.request));
}

function guessKind(url) {
  const path = url.split('?')[0].toLowerCase();
  if (/\.m3u8$/.test(path) || /[?&](type|format|output)=m3u8/i.test(url)) return 'hls';
  if (/\.(ts|flv)$/.test(path)) return 'ts';
  if (/\.(mp4|mkv|webm|mov|m4v|mp3|aac|ogg)$/.test(path)) return 'native';
  return 'unknown';
}

function startPlayback(req) {
  // req: { url, headers, live, startAt }
  stopPlayback(false);
  player.request = req;
  player.retries = 0;
  window.PUI?.onStart(req);
  if (req.startAt > 0) {
    const tk = player.token;
    video.addEventListener('loadedmetadata', () => {
      if (tk !== player.token) return;
      try { video.currentTime = req.startAt; } catch {}
    }, { once: true });
  }
  $('#player-idle').hidden = true;
  setStatus('Connecting…');
  req.failures = [];
  req.diags = {};
  player.activeUrl = null;
  attempt(playChain(req), req, player.token);
}

// The ways to try a stream, best first. For a live Xtream-style link
// (…/live/…/123.m3u8) the other format (.ts) is tried as well.
function playChain(req) {
  const order = { hls: ['hls', 'ts', 'native'], ts: ['ts', 'hls', 'native'], native: ['native', 'hls'], unknown: ['hls', 'ts', 'native'] };
  const main = order[guessKind(req.url)].map((how) => ({ how, url: req.url }));
  const alt = req.live && altLiveUrl(req.url);
  if (!alt) return main;
  const altMain = { how: guessKind(alt) === 'ts' ? 'ts' : 'hls', url: alt };
  return [main[0], altMain, ...main.slice(1)];
}

function altLiveUrl(url) {
  const m = url.match(/^(.*\/live\/[^?#]+\/\d+)\.(m3u8|ts)(\?.*)?$/i);
  if (!m) return null;
  return m[1] + (m[2].toLowerCase() === 'm3u8' ? '.ts' : '.m3u8') + (m[3] || '');
}

function attempt(chain, req, token) {
  const step = chain.shift();
  const how = step.how;
  player.activeUrl = step.url;
  const src = viaProxy(step.url, { headers: req.headers || {} });
  // Some players wait forever on a bad stream, so each attempt gets a time limit.
  clearTimeout(player.attemptTimer);
  player.attemptTimer = setTimeout(() => fail('no video arrived within 12 seconds'), 12000);
  const fail = async (why) => {
    if (token !== player.token || step.done) return;
    step.done = true;
    clearTimeout(player.attemptTimer);
    req.failures.push({ how, url: step.url, why: String(why || 'failed') });
    if (player.hls) { player.hls.destroy(); player.hls = null; }
    if (player.ts) { destroyTs(player.ts); player.ts = null; }
    video.onerror = null;
    // Check the link once; if it can't work (refused, a web page, a format the
    // browser can't decode), skip the other ways of playing that same link.
    if (!(step.url in req.diags)) {
      setStatus('Connecting… (checking the stream)');
      req.diags[step.url] = await diagnoseUrl(step.url, req);
      if (token !== player.token) return;
    }
    const drop = (url) => { for (let i = chain.length - 1; i >= 0; i--) if (chain[i].url === url) chain.splice(i, 1); };
    if (hopeless(req.diags[step.url])) drop(step.url);
    // Refused (not just "not found")? Check the other link before trying it.
    const d = req.diags[step.url];
    while (chain.length && !(chain[0].url in req.diags) && isRefusal(d) && d.status !== 404) {
      const u = chain[0].url;
      req.diags[u] = await diagnoseUrl(u, req);
      if (token !== player.token) return;
      if (hopeless(req.diags[u])) drop(u); else break;
    }
    if (chain.length) attempt(chain, req, token);
    else playError(req);
  };
  const go = () => video.play().catch((e) => {
    if (token !== player.token) return;
    if (e.name === 'NotAllowedError') setStatus('Press play to start.');
  });

  if (how === 'hls') {
    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, maxBufferLength: 30, liveSyncDurationCount: 3, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2 });
      player.hls = hls;
      window.PUI?.attachHls(hls);
      let parsed = false;
      hls.on(Hls.Events.MANIFEST_PARSED, () => { parsed = true; go(); });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal || token !== player.token) return;
        if (!parsed) return fail(d.response?.code >= 400 ? `the server answered ${d.response.code}` : d.details);
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && player.retries < 3) { player.retries++; setStatus('Reconnecting…'); hls.startLoad(); return; }
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && player.retries < 3) { player.retries++; hls.recoverMediaError(); return; }
        fail(d.details);
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      return;
    }
    if (video.canPlayType('application/vnd.apple.mpegurl')) return playNative(src, go, fail);
    return fail('HLS is not supported in this browser');
  }

  if (how === 'ts') {
    if (window.mpegts && mpegts.getFeatureList().mseLivePlayback) {
      const p = mpegts.createPlayer(
        { type: 'mpegts', isLive: !!req.live, url: new URL(src, location.href).href },
        { enableWorker: false, lazyLoad: false, liveBufferLatencyChasing: !!req.live, autoCleanupSourceBuffer: true }
      );
      player.ts = p;
      p.on(mpegts.Events.ERROR, (type, detail) => fail(`${type}: ${detail}`));
      p.on(mpegts.Events.MEDIA_INFO, (info) => { if (info && info.hasVideo === false && info.hasAudio === false) fail('no audio or video found'); });
      p.attachMediaElement(video);
      p.load();
      go();
      return;
    }
    return fail('MPEG-TS playback is not supported in this browser');
  }

  playNative(src, go, fail);
}

function playNative(src, go, fail) {
  video.onerror = () => {
    const code = video.error?.code;
    fail(code === 4 ? 'this format or codec is not supported by the browser' : 'the stream could not be loaded');
  };
  video.src = src;
  go();
}

/* ------------------------------------------------- why a stream won't play */

function destroyTs(p) {
  for (const step of ['pause', 'unload', 'detachMediaElement', 'destroy']) { try { p[step](); } catch {} }
}

async function diagnoseUrl(url, req) {
  if (!useProxy()) return null;
  try {
    const r = await fetch(viaProxy(url, { headers: req.headers || {} }).replace('/proxy?', '/api/diagnose?'), { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const isRefusal = (d) => d && (d.error || d.status >= 400 || d.kind === 'html' || d.kind === 'text' || d.segmentStatus >= 400);
const hopeless = (d) => !!d && (isRefusal(d) || unsupportedCodecs(d).length > 0);

// Of all the links tried, explain using the most telling check: an
// unplayable format first, then a refusal, then anything else.
function bestDiag(req) {
  const list = Object.entries(req.diags || {}).map(([url, d]) => ({ url, d })).filter((x) => x.d);
  const pick = list.find((x) => unsupportedCodecs(x.d).length) ||
    list.find((x) => x.d.status && x.d.status !== 404 && isRefusal(x.d)) ||
    list.find((x) => x.url === req.url) || list[0];
  return pick ? pick.d : null;
}

async function playError(req) {
  const token = player.token;
  const blocked = blockedReason(req.url);
  if (blocked) { showPlayProblem(req, blocked, null); return; }
  if (!(req.url in req.diags)) {
    setStatus('Checking why this stream didn’t play…');
    req.diags[req.url] = await diagnoseUrl(req.url, req);
    if (token !== player.token) return;
  }
  const diag = bestDiag(req);
  showPlayProblem(req, explainProblem(diag, req), diag);
}

function browserName() {
  const ua = navigator.userAgent;
  return /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'this browser';
}

// Formats the stream uses that this browser can't decode.
function unsupportedCodecs(diag) {
  const found = new Set([...(diag?.codecs?.video || []), ...(diag?.codecs?.audio || [])]);
  const declared = String(diag?.declared || '').toLowerCase();
  if (/hvc1|hev1/.test(declared)) found.add('hevc');
  if (/ec-3/.test(declared)) found.add('e-ac-3');
  if (/ac-3/.test(declared)) found.add('ac-3');
  const ms = window.ManagedMediaSource || window.MediaSource;
  const can = (t) => { try { return !!(ms && ms.isTypeSupported(t)) || video.canPlayType(t) === 'probably'; } catch { return false; } };
  const test = {
    'hevc': () => can('video/mp4; codecs="hvc1.1.6.L93.B0"') || can('video/mp4; codecs="hev1.1.6.L93.B0"'),
    'ac-3': () => can('audio/mp4; codecs="ac-3"'),
    'e-ac-3': () => can('audio/mp4; codecs="ec-3"'),
    'mpeg2-video': () => false,
    'mpeg1-video': () => false,
  };
  return [...found].filter((c) => test[c] && !test[c]());
}

function explainProblem(diag, req) {
  const triedAlt = req.failures.some((f) => f.url !== req.url);
  const also = triedAlt ? ' SevakTV also tried the other live format.' : '';
  if (!diag) return 'This stream didn’t start, and SevakTV couldn’t check why. It may be offline right now. Try again, or open it in VLC.';
  if (diag.error) return `Couldn’t reach your provider’s server (${diag.error}). It may be down, or blocking this connection.`;
  const st = diag.status, text = diag.text || '';
  if ([429, 458, 509].includes(st) || /max(imum)?[ _-]?conn|connection limit|too many (connections|streams|users)|already (in use|watching)/i.test(text)) {
    return 'Too many streams are open on your subscription. Stop watching on your other devices or apps (most plans allow 1–2 at a time), wait a minute, then try again.';
  }
  if (st === 401 || st === 403) {
    return `Your provider refused this stream (error ${st}). Usually this means another device is already watching, the subscription has expired, or the provider blocks browsers. For the last one, set a User-Agent override in Settings, e.g. VLC/3.0.20 LibVLC/3.0.20.` + also;
  }
  if (st === 404 || st === 410) return `Your provider says this stream doesn’t exist (error ${st}). The channel may be offline or removed.` + also;
  if (st >= 500) return `Your provider’s server had a problem (error ${st}). Try again in a minute.`;
  if (diag.kind === 'html' || diag.kind === 'text') {
    return 'Your provider sent a message instead of video' + (text ? `: “${text.slice(0, 140)}”` : '.') + ' This usually means the link expired or access was refused.';
  }
  if (diag.segmentStatus >= 400) return `The channel opened, but your provider refused the video itself (error ${diag.segmentStatus}). Another device may be watching, or the provider blocks browsers.`;
  const bad = unsupportedCodecs(diag);
  if (bad.length) {
    const names = { 'hevc': 'HEVC (H.265) video', 'ac-3': 'Dolby Digital (AC-3) audio', 'e-ac-3': 'Dolby Digital Plus audio', 'mpeg2-video': 'MPEG-2 video', 'mpeg1-video': 'MPEG-1 video' };
    const tips = [];
    if (bad.includes('hevc')) tips.push('Safari on iPhone/Mac, or Edge on Windows, can usually play HEVC.');
    if (bad.includes('ac-3') || bad.includes('e-ac-3')) tips.push('Safari on iPhone/Mac can play Dolby audio.');
    if (bad.some((c) => /mpeg[12]-video/.test(c))) tips.push('No browser plays MPEG-2 video; use VLC for this channel.');
    const vlc = bad.some((c) => /mpeg[12]-video/.test(c)) ? '' : ' You can also open it in VLC.';
    return `This channel uses ${bad.map((c) => names[c]).join(' and ')}, which ${browserName()} can’t play. ${tips.join(' ')}${vlc}`;
  }
  return 'This stream didn’t start, though your provider answered normally. The channel may be offline at the moment. Try again, or open it in VLC.' + also;
}

function showPlayProblem(req, msg, diag, stillPlaying) {
  const el = $('#player-status');
  el.hidden = false;
  el.classList.add('is-error');
  // Nothing to control while a stream has failed, so the message gets the space.
  $('#player').classList.toggle('has-problem', !stillPlaying);
  const names = { hls: 'HLS', ts: 'MPEG-TS', native: 'Built-in player' };
  const lines = (req.failures || []).map((f) => `${names[f.how] || f.how}${f.url !== req.url ? ' (other format)' : ''}: ${f.why}`);
  if (diag) {
    const c = diag.codecs ? [...diag.codecs.video, ...diag.codecs.audio].join(', ') : diag.declared || '';
    lines.push(`Provider answered: ${diag.error ? diag.error : 'HTTP ' + diag.status}${diag.kind ? ' · ' + diag.kind : ''}${diag.segment ? ' → ' + diag.segment : ''}${diag.segmentStatus ? ' (' + diag.segmentStatus + ')' : ''}${c ? ' · ' + c : ''}`);
  }
  el.innerHTML = `<span>${esc(msg)}</span>` +
    '<div class="status-actions">' + (stillPlaying ? '<button class="btn btn-ghost" id="play-dismiss">Hide</button>' : '<button class="btn btn-ghost" id="play-retry">Try again</button>') +
    '<button class="btn btn-ghost" id="play-copy">Copy stream link</button>' +
    `<a class="btn btn-ghost" id="play-vlc" href="vlc://${esc(req.url)}">Open in VLC</a></div>` +
    (lines.length ? `<details class="status-details"><summary>Details</summary><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details>` : '');
  if (stillPlaying) $('#play-dismiss').onclick = () => setStatus(null);
  else $('#play-retry').onclick = () => (player.replay ? player.replay() : startPlayback(player.request));
  $('#play-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(req.url); toast('Link copied. In VLC: Open Network Stream, then paste.'); }
    catch { prompt('Copy this link:', req.url); }
  };
}

video.addEventListener('loadeddata', () => clearTimeout(player.attemptTimer));

// Sound but no picture: the video format may be one the browser can't show.
let noPictureTimer;
video.addEventListener('playing', () => {
  clearTimeout(noPictureTimer);
  const req = player.request, token = player.token;
  if (!req || !state.proxyAvailable) return;
  noPictureTimer = setTimeout(async () => {
    if (token !== player.token || video.paused) return;
    const noPicture = video.videoWidth === 0;
    const noSound = video.webkitAudioDecodedByteCount === 0 || video.mozHasAudio === false;
    if (!noPicture && !noSound) return;
    const diag = await diagnoseUrl(player.activeUrl || req.url, req);
    if (token !== player.token || !diag?.codecs) return;
    if (noPicture && video.videoWidth === 0 && diag.codecs.video.length) {
      const bad = unsupportedCodecs({ codecs: { video: diag.codecs.video, audio: [] } });
      if (!bad.length) return;
      const name = { 'hevc': 'HEVC (H.265)', 'mpeg2-video': 'MPEG-2', 'mpeg1-video': 'MPEG-1' }[bad[0]] || bad[0];
      showPlayProblem(req, `Only the sound is playing: this channel’s picture is ${name} video, which ${browserName()} can’t show.` +
        (bad[0] === 'hevc' ? ' Safari on iPhone/Mac, or Edge on Windows, can usually show it.' : ' Use VLC for this channel.'), diag, true);
    } else if (noSound && video.webkitAudioDecodedByteCount === 0 && diag.codecs.audio.length) {
      const bad = unsupportedCodecs({ codecs: { video: [], audio: diag.codecs.audio } });
      if (!bad.length) return;
      showPlayProblem(req, `The picture is playing but there’s no sound: this channel uses Dolby ${bad[0] === 'e-ac-3' ? 'Digital Plus' : 'Digital (AC-3)'} audio, which ${browserName()} can’t play. Safari on iPhone/Mac can, or open it in VLC.`, diag, true);
    }
  }, 4500);
});

// If the other live format worked, remember it for this provider.
video.addEventListener('playing', () => {
  const req = player.request;
  if (!req || !req.live || !player.activeUrl || player.activeUrl === req.url) return;
  const ext = /\.ts(\?|$)/i.test(player.activeUrl) ? 'ts' : 'm3u8';
  if (activeSource()?.type === 'xtream' && state.store.settings.format !== ext) {
    state.store.settings.format = ext;
    saveStore();
    toast(`Your provider works better with ${ext === 'ts' ? 'MPEG-TS' : 'HLS'}, so SevakTV switched the live format.`);
  }
});

video.addEventListener('playing', () => setStatus(null));
let waitTimer;
video.addEventListener('waiting', () => { clearTimeout(waitTimer); waitTimer = setTimeout(() => { if (video.readyState < 3 && !video.paused) setStatus('Buffering…'); }, 700); });
video.addEventListener('canplay', () => { clearTimeout(waitTimer); if ($('#player-status').textContent === 'Buffering…') setStatus(null); });

function itemUrl(item, episode) {
  const src = activeSource();
  if (!item.xt) return item.url;
  if (item.kind === 'live') return xtPath(src, 'live', item.id, state.store.settings.format === 'ts' ? 'ts' : 'm3u8');
  if (item.kind === 'movie') return xtPath(src, 'movie', item.id, item.ext || 'mp4');
  if (episode) return xtPath(src, 'series', episode.id, episode.container_extension || 'mp4');
  return null;
}

// Stalker links are temporary, so they are fetched right before playing.
async function resolveUrl(item, episode) {
  if (!item.st) return itemUrl(item, episode);
  const src = activeSource();
  if (item.kind === 'live') return stalkerLink(src, 'itv', item.cmd);
  if (item.kind === 'movie') return stalkerLink(src, 'vod', item.cmd);
  return stalkerLink(src, 'vod', episode._cmd, episode._series);
}

function playHeaders(item) {
  if (!item.st) return item.headers;
  const h = stHeaders(activeSource(), false);
  return { ua: h.ua, extra: { Cookie: h.extra.Cookie } };
}

// Fetches a link (some are temporary) and plays it. `context` marks a movie or
// episode whose position is remembered.
async function playWith(resolve, { live = false, headers, startAt = 0, context = null, meta = {} } = {}) {
  const token = ++player.token;
  player.replay = () => playWith(resolve, { live, headers, startAt: context && player.lastPos > 5 ? player.lastPos : startAt, context, meta });
  $('#player-idle').hidden = true;
  setStatus('Connecting…');
  let url;
  try { url = await resolve(); } catch (e) {
    if (token === player.token) setStatus(e.message, { error: true, retry: true });
    return;
  }
  if (token !== player.token) return;
  startPlayback({ url, headers, live, startAt, meta });
  player.context = context; // set after startPlayback, which saves the previous one
  player.lastPos = startAt;
}

function playResolved(item, episode, live, startAt = 0, season = null, meta = {}) {
  const context = live ? null : {
    srcId: state.store.activeId,
    pkey: progressKey(item, episode, season),
    item: snapshot(item),
    ep: episode ? { id: episode.id, episode_num: episode.episode_num, title: episode.title, container_extension: episode.container_extension, _cmd: episode._cmd, _series: episode._series } : null,
    season,
  };
  return playWith(() => resolveUrl(item, episode), { live, headers: playHeaders(item), startAt, context, meta });
}

/* ------------------------------------------------------- resume positions */

function progressMap(id = state.store.activeId) {
  state.store.progress ||= {};
  return (state.store.progress[id] ||= {});
}
const progressKey = (item, ep, season) => (ep ? `${item.key}#${season ?? ''}#${ep.episode_num ?? ep.id ?? ''}` : item.key);
function snapshot(item) { const { _episodes, _season, ...copy } = item; return copy; }
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s2).padStart(2, '0');
}

function saveProgress() {
  const c = player.context;
  if (!c) return;
  const pos = video.currentTime, dur = video.duration;
  if (!Number.isFinite(pos) || pos <= 0) return;
  const map = progressMap(c.srcId);
  const finished = Number.isFinite(dur) && dur > 0 && (pos > dur - 90 || pos / dur > 0.95);
  if (finished) { if (map[c.pkey]) { delete map[c.pkey]; saveStore(); } return; }
  if (pos < 30 && !map[c.pkey]) return;
  map[c.pkey] = { pos: Math.floor(pos), dur: Number.isFinite(dur) ? Math.floor(dur) : 0, at: Date.now(), item: c.item, ep: c.ep, season: c.season };
  const keys = Object.keys(map);
  if (keys.length > 80) keys.sort((a, b) => map[a].at - map[b].at).slice(0, keys.length - 80).forEach((k) => delete map[k]);
  saveStore();
}

// Latest unfinished position for a movie, or for any episode of a series.
function resumeFor(item) {
  const map = progressMap();
  let best = null;
  for (const [k, v] of Object.entries(map)) {
    if (k === item.key || k.startsWith(item.key + '#')) if (!best || v.at > best.at) best = v;
  }
  return best;
}

let lastSave = 0;
video.addEventListener('timeupdate', () => {
  if (!player.context) return;
  player.lastPos = video.currentTime;
  if (Date.now() - lastSave > 10000) { lastSave = Date.now(); saveProgress(); }
});
video.addEventListener('pause', () => saveProgress());
video.addEventListener('ended', () => saveProgress());
window.addEventListener('pagehide', () => saveProgress());
document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });

function renderContinue() {
  const box = $('#continue');
  const grid = state.section === 'movies' || state.section === 'series';
  const kind = state.section === 'movies' ? 'movie' : 'series';
  if (!grid || state.category !== '__all' || state.query.trim()) { box.hidden = true; return; }
  const list = Object.entries(progressMap())
    .filter(([, v]) => v.item && v.item.kind === kind)
    .sort((a, b) => b[1].at - a[1].at);
  const seen = new Set();
  const rows = [];
  for (const [k, v] of list) { if (seen.has(v.item.key)) continue; seen.add(v.item.key); rows.push([k, v]); if (rows.length >= 12) break; }
  box.hidden = !rows.length;
  $('#continue-row').innerHTML = rows.map(([k, v]) => {
    const pct = v.dur ? Math.min(100, Math.round((v.pos / v.dur) * 100)) : 0;
    const left = v.dur ? fmtDur(v.dur - v.pos) + ' left' : 'at ' + fmtDur(v.pos);
    const ep = v.ep ? `S${v.season ?? '?'} E${v.ep.episode_num ?? '?'} · ` : '';
    const img = v.item.poster
      ? `<img class="cw-img" src="${esc(v.item.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${esc(initials(v.item.name))}">`
      : `<span class="cw-img">${esc(initials(v.item.name))}</span>`;
    return `<li class="cw" data-pkey="${esc(k)}" tabindex="0">${img}<div style="min-width:0"><div class="cw-name">${esc(v.item.name)}</div>` +
      `<div class="cw-sub">${esc(ep + left)}</div><span class="pbar"><i style="width:${pct}%"></i></span></div>` +
      `<button class="cw-x" data-remove="${esc(k)}" aria-label="Remove from Continue watching">✕</button></li>`;
  }).join('');
}

function onContinueClick(e) {
  const x = e.target.closest('[data-remove]');
  const map = progressMap();
  if (x) {
    const key = map[x.dataset.remove]?.item?.key;
    for (const k of Object.keys(map)) if (k === key || k.startsWith(key + '#')) delete map[k];
    saveStore();
    renderContinue();
    return;
  }
  const li = e.target.closest('.cw');
  const v = li && map[li.dataset.pkey];
  if (v) openSheet(state.catalog?.byKey.get(v.item.key) || v.item);
}

function mountPlayer(where) {
  const p = $('#player');
  const target = where === 'sheet' ? $('#sheet-player-slot') : where === 'guide' ? $('#guide-player-slot') : $('#player-dock');
  if (p.parentElement !== target) target.appendChild(p);
}

/* --------------------------------------------------------------- live tv */

function playLive(item) {
  if (!$('#sheet').hidden) closeSheet();
  mountPlayer('dock');
  state.playing = item;
  state.playList = state.filtered.filter((i) => i.kind === 'live');
  document.querySelectorAll('.ch.is-playing').forEach((el) => el.classList.remove('is-playing'));
  const row = document.querySelector(`.ch[data-idx="${state.filtered.indexOf(item)}"]`);
  if (row) { row.classList.add('is-playing'); row.scrollIntoView({ block: 'nearest' }); }
  $('#layout').classList.add('has-playing');
  playResolved(item, null, true, 0, null, { title: item.name, sub: `CH ${item.num}` + (item.group ? ' · ' + item.group : '') });
  showNow(item);
}

function zap(step) {
  if (!state.playing || state.playing.kind !== 'live') return;
  const list = state.playList.length ? state.playList : state.filtered.filter((i) => i.kind === 'live');
  if (!list.length) return;
  const i = list.indexOf(state.playing);
  const next = list[(i + step + list.length) % list.length];
  const keep = state.playList;
  playLive(next);
  state.playList = keep.length ? keep : state.playList;
}

let epgToken = 0;
async function showNow(item) {
  const now = $('#now');
  now.hidden = false;
  const logo = $('#now-logo');
  logo.hidden = !item.logo;
  if (item.logo) logo.src = item.logo;
  logo.referrerPolicy = 'no-referrer';
  logo.onerror = () => (logo.hidden = true);
  $('#now-num').textContent = 'CH ' + item.num;
  $('#now-guide').hidden = !(item.xt || item.st);
  $('#now-guide').textContent = item.archive ? 'TV guide & catch-up' : 'TV guide';
  $('#now-name').textContent = item.name;
  const fav = $('#now-fav');
  fav.setAttribute('aria-pressed', isFav(item));
  const epg = $('#epg');
  const t = ++epgToken;
  const src = activeSource();
  if (!item.xt && !item.st) { epg.innerHTML = `<li><time></time><div class="d">${esc(item.group)}</div></li>`; return; }
  epg.innerHTML = '<li><time>…</time><div class="d">Loading guide…</div></li>';
  try {
    let list;
    if (item.st) {
      const d = await stalkerCall(src, { type: 'itv', action: 'get_short_epg', ch_id: item.id, size: 4 });
      list = stList(d && d.js).map((p) => ({ title: p.name, description: p.descr, start_timestamp: p.start_timestamp, stop_timestamp: p.stop_timestamp, plain: true }));
    } else {
      const data = await xtApi(src, 'get_short_epg', { stream_id: item.id, limit: 4 });
      list = (data && data.epg_listings) || [];
    }
    if (t !== epgToken) return;
    if (!list.length) { epg.innerHTML = '<li><time></time><div class="d">No guide information for this channel.</div></li>'; return; }
    const nowSec = Date.now() / 1000;
    epg.innerHTML = list.map((p) => {
      const s = Number(p.start_timestamp), e = Number(p.stop_timestamp);
      const live = s <= nowSec && nowSec < e;
      const pct = live ? Math.round(((nowSec - s) / (e - s)) * 100) : 0;
      return `<li class="${live ? 'is-now' : ''}"><time>${fmtTime(new Date(s * 1000))}</time><div>` +
        `<div class="t">${esc(p.plain ? p.title : decodeB64(p.title))}</div>` +
        (p.description ? `<div class="d">${esc(p.plain ? p.description : decodeB64(p.description))}</div>` : '') +
        (live ? `<div class="bar"><i style="width:${pct}%"></i></div>` : '') + '</div></li>';
    }).join('');
  } catch {
    if (t === epgToken) epg.innerHTML = '<li><time></time><div class="d">Guide unavailable.</div></li>';
  }
}

/* ------------------------------------------------------ movie/series sheet */

let sheetToken = 0;
async function openSheet(item) {
  state.sheetItem = item;
  const t = ++sheetToken;
  $('#sheet').hidden = false;
  $('#sheet-player-slot').hidden = true;
  $('#sheet-title').textContent = item.name;
  const poster = $('#sheet-poster');
  const body = $('.sheet-body');
  const setPoster = (url) => {
    poster.hidden = !url;
    body.classList.toggle('no-poster', !url);
    if (url) poster.src = url;
  };
  poster.referrerPolicy = 'no-referrer';
  poster.onerror = () => setPoster(null);
  setPoster(item.poster);
  $('#sheet-plot').textContent = item.plot || '';
  setMeta([item.year, item.genre, item.duration, item.rating && Number(item.rating) ? '★ ' + Number(item.rating).toFixed(1) : '', item.group]);
  $('#sheet-fav').setAttribute('aria-pressed', isFav(item));
  $('#seasons').hidden = true;
  $('#sheet-play').hidden = false;
  $('#sheet-play').textContent = 'Play';
  $('#sheet-play').disabled = false;
  $('#sheet-restart').hidden = true;
  if (item.kind === 'movie') {
    const pr = progressMap()[item.key];
    if (pr) { $('#sheet-play').textContent = 'Resume from ' + fmtDur(pr.pos); $('#sheet-restart').hidden = false; }
  }
  $('#sheet-close').focus();

  const src = activeSource();
  if (item.st && item.kind === 'series') {
    $('#sheet-play').disabled = true;
    $('#sheet-play').textContent = 'Loading episodes…';
    try {
      const eps = await stalkerEpisodes(src, item);
      if (t !== sheetToken) return;
      showEpisodes(item, eps);
    } catch {
      if (t === sheetToken) $('#sheet-play').textContent = 'Couldn’t load episodes';
    }
    return;
  }
  if (!item.xt) return;
  try {
    if (item.kind === 'movie') {
      const d = await xtApi(src, 'get_vod_info', { vod_id: item.id });
      if (t !== sheetToken) return;
      const info = d?.info || {};
      if (info.plot || info.description) $('#sheet-plot').textContent = info.plot || info.description;
      setMeta([(info.releasedate || '').slice(0, 4), info.genre, info.duration, info.rating ? '★ ' + Number(info.rating).toFixed(1) : '', item.group]);
      if (!item.poster && info.movie_image) setPoster(info.movie_image);
    } else if (item.kind === 'series') {
      $('#sheet-play').disabled = true;
      $('#sheet-play').textContent = 'Loading episodes…';
      const d = await xtApi(src, 'get_series_info', { series_id: item.id });
      if (t !== sheetToken) return;
      const info = d?.info || {};
      if (info.plot) $('#sheet-plot').textContent = info.plot;
      showEpisodes(item, d?.episodes || {});
    }
  } catch (e) {
    if (t !== sheetToken) return;
    if (item.kind === 'series') { $('#sheet-play').textContent = 'Couldn’t load episodes'; }
  }
}

function showEpisodes(item, eps) {
  const seasons = Object.keys(eps).filter((k) => eps[k]?.length).sort((a, b) => Number(a) - Number(b));
  item._episodes = eps;
  if (!seasons.length) { $('#sheet-play').textContent = 'No episodes available'; return; }
  $('#sheet-play').disabled = false;
  const pr = resumeFor(item);
  $('#sheet-play').textContent = pr && pr.ep ? `Resume S${pr.season} E${pr.ep.episode_num ?? '?'} · ${fmtDur(pr.pos)}` : 'Play episode 1';
  $('#seasons').hidden = false;
  $('#season-tabs').innerHTML = seasons.map((s) => `<button data-season="${esc(s)}">Season ${esc(s)}</button>`).join('');
  showSeason(seasons[0]);
}

function setMeta(parts) {
  $('#sheet-meta').innerHTML = parts.filter(Boolean).map((p) => `<span class="chip">${esc(p)}</span>`).join('');
}

function showSeason(season) {
  const item = state.sheetItem;
  item._season = season;
  document.querySelectorAll('#season-tabs button').forEach((b) => b.classList.toggle('is-on', b.dataset.season === season));
  const eps = item._episodes[season] || [];
  const map = progressMap();
  $('#episodes').innerHTML = eps.map((ep, i) => {
    const pr = map[progressKey(item, ep, season)];
    const bar = pr && pr.dur ? `<span class="pbar"><i style="width:${Math.round((pr.pos / pr.dur) * 100)}%"></i></span>` : '';
    return `<li><button data-ep="${i}"><span class="ep-n">E${esc(ep.episode_num || i + 1)}</span>` +
    `<span class="ep-t">${esc(ep.title || 'Episode ' + (i + 1))}${bar}</span>` +
    `<span class="ep-d">${esc(ep.info?.duration || '')}</span></button></li>`;
  }).join('');
}

function playInSheet(episode, label, startAt = 0, season = null) {
  state.playing = null;
  $('#now').hidden = true;
  document.querySelectorAll('.ch.is-playing').forEach((el) => el.classList.remove('is-playing'));
  $('#sheet-player-slot').hidden = false;
  mountPlayer('sheet');
  const item = state.sheetItem;
  const meta = { title: item.name, sub: label || item.group || '', search: { title: item.name, year: item.year, season: episode ? season : null, episode: episode ? episode.episode_num : null } };
  const nx = episode && nextEpisodeOf(item, season, episode);
  if (nx) {
    meta.next = () => {
      if (state.sheetItem !== item) return;
      if (String(item._season) !== String(nx.season)) showSeason(String(nx.season));
      playEpisode(nx.index);
    };
    meta.nextTitle = `S${nx.season} E${nx.ep.episode_num ?? nx.index + 1}` + (nx.ep.title ? ' · ' + nx.ep.title : '');
  }
  playResolved(item, episode, false, startAt, season, meta);
  if (startAt > 0) toast((label ? label + ': ' : '') + 'resuming from ' + fmtDur(startAt));
  else if (label) toast('Playing ' + label);
  $('.sheet').scrollTop = 0;
}

// The episode after this one: next in the season, else the first of the next season.
function nextEpisodeOf(item, season, ep) {
  const all = item._episodes || {};
  const eps = all[season] || [];
  const i = eps.findIndex((e) => e === ep || (String(e.episode_num) === String(ep.episode_num) && (e.id ?? null) === (ep.id ?? null)));
  if (i >= 0 && i + 1 < eps.length) return { season, index: i + 1, ep: eps[i + 1] };
  const seasons = Object.keys(all).filter((k) => all[k]?.length).sort((a, b) => Number(a) - Number(b));
  const si = seasons.indexOf(String(season));
  if (si >= 0 && si + 1 < seasons.length) return { season: seasons[si + 1], index: 0, ep: all[seasons[si + 1]][0] };
  return null;
}

function playEpisode(index) {
  const item = state.sheetItem;
  const ep = (item._episodes[item._season] || [])[index];
  if (!ep) return;
  document.querySelectorAll('#episodes button').forEach((b) => b.classList.toggle('is-playing', Number(b.dataset.ep) === index));
  const pr = progressMap()[progressKey(item, ep, item._season)];
  playInSheet(ep, `S${item._season} E${ep.episode_num || index + 1}`, pr ? pr.pos : 0, item._season);
}

function closeSheet() {
  $('#sheet').hidden = true;
  sheetToken++;
  if ($('#player').parentElement === $('#sheet-player-slot')) {
    stopPlayback(true); // also saves the position
    mountPlayer('dock');
  }
  state.sheetItem = null;
  if (state.section === 'movies' || state.section === 'series') {
    renderContinue();
    applyFilter(true); // refreshes progress bars on posters
  }
}

/* ------------------------------------------------------ TV guide / catch-up */

const guide = { channel: null, days: [], dayIdx: 0, progs: [], token: 0, cache: new Map(), watching: null, resumeLive: false };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function openGuide(channel) {
  guide.channel = channel;
  guide.watching = null;
  guide.resumeLive = state.playing === channel;
  $('#guide').hidden = false;
  $('#guide-player-slot').hidden = true;
  $('#guide-title').textContent = channel.name;
  const days = channel.archive ? Math.min(channel.archive, 14) : 0;
  $('#guide-sub').textContent = channel.archive
    ? `Catch-up: tap Watch on any programme from the last ${days} day${days === 1 ? '' : 's'}.`
    : 'This channel has no catch-up, so only the schedule is shown.';
  guide.days = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let i = -days; i <= 1; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    const label = i === 0 ? 'Today' : i === -1 ? 'Yesterday' : i === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    guide.days.push({ date: d, label });
  }
  $('#guide-days').innerHTML = guide.days.map((d, i) => `<button data-day="${i}">${esc(d.label)}</button>`).join('');
  showGuideDay(days); // today
  $('#guide-close').focus();
}

async function guideProgrammes(channel, day) {
  const src = activeSource();
  if (channel.xt) {
    const key = 'x' + channel.key;
    if (!guide.cache.has(key)) {
      const d = await xtApi(src, 'get_simple_data_table', { stream_id: channel.id });
      guide.cache.set(key, ((d && d.epg_listings) || []).map((p) => ({
        id: p.id, title: decodeB64(p.title), desc: decodeB64(p.description), start: Number(p.start_timestamp), stop: Number(p.stop_timestamp),
        startText: p.start, archive: String(p.has_archive) === '1',
      })));
    }
    const from = day.getTime() / 1000, to = from + 86400;
    return guide.cache.get(key).filter((p) => p.start >= from && p.start < to).sort((a, b) => a.start - b.start);
  }
  const key = 's' + channel.key + ymd(day);
  if (!guide.cache.has(key)) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const js = (await stalkerCall(src, { type: 'itv', action: 'get_simple_data_table', ch_id: channel.id, date: ymd(day), p: page })).js || {};
      const data = stList(js);
      out.push(...data);
      if (!data.length || out.length >= Number(js.total_items || 0)) break;
    }
    guide.cache.set(key, out.map((p) => ({
      id: p.id, title: p.name, desc: p.descr, start: Number(p.start_timestamp), stop: Number(p.stop_timestamp),
      archive: String(p.mark_archive) === '1',
    })).sort((a, b) => a.start - b.start));
  }
  return guide.cache.get(key);
}

async function showGuideDay(idx) {
  guide.dayIdx = idx;
  const t = ++guide.token;
  document.querySelectorAll('#guide-days button').forEach((b) => b.classList.toggle('is-on', Number(b.dataset.day) === idx));
  const list = $('#guide-list');
  list.innerHTML = '<li class="dev-meta"><span class="spinner"></span> Loading the guide…</li>';
  let progs;
  try { progs = await guideProgrammes(guide.channel, guide.days[idx].date); } catch (e) {
    if (t === guide.token) list.innerHTML = `<li class="dev-msg is-error">Couldn’t load the guide. ${esc(e.message)}</li>`;
    return;
  }
  if (t !== guide.token) return;
  guide.progs = progs;
  if (!progs.length) { list.innerHTML = '<li class="dev-meta">No programmes listed for this day.</li>'; return; }
  const now = Date.now() / 1000;
  const archiveFrom = guide.channel.archive ? now - guide.channel.archive * 86400 : Infinity;
  list.innerHTML = progs.map((p, i) => {
    const past = p.stop <= now, live = p.start <= now && now < p.stop;
    const canWatch = past && p.start >= archiveFrom && (p.archive || guide.channel.archive > 0);
    const action = live ? '<button class="btn btn-primary btn-sm" data-live="1">Watch live</button>'
      : canWatch ? `<button class="btn btn-ghost btn-sm" data-watch="${i}">▶ Watch</button>` : '';
    return `<li class="gl${past ? ' is-past' : ''}${live ? ' is-now' : ''}${canWatch ? ' can-watch' : ''}${guide.watching === p ? ' is-playing' : ''}" data-i="${i}">` +
      `<time>${fmtTime(new Date(p.start * 1000))}</time><div>` +
      (live ? '<div class="tag">On now</div>' : '') +
      `<div class="t">${esc(p.title || 'Untitled')}</div>${p.desc ? `<div class="d">${esc(p.desc)}</div>` : ''}</div>${action}</li>`;
  }).join('');
  const nowEl = $('.gl.is-now', list) || (guide.days[idx].label === 'Today' && $('.gl:not(.is-past)', list));
  if (nowEl) nowEl.scrollIntoView({ block: 'center' });
}

function catchupUrl(channel, p) {
  const src = activeSource();
  if (channel.xt) {
    // Xtream wants the start in the server's own time, which the listing gives as text.
    const m = String(p.startText || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
    const d = new Date(p.start * 1000);
    const start = m ? `${m[1]}:${m[2]}-${m[3]}` : `${ymd(d)}:${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}`;
    const mins = Math.max(1, Math.ceil((p.stop - p.start) / 60));
    return Promise.resolve(`${src.server}/timeshift/${encodeURIComponent(src.username)}/${encodeURIComponent(src.password)}/${mins}/${start}/${channel.id}.ts`);
  }
  return stalkerLink(src, 'tv_archive', `auto /media/${p.id}.mpg`);
}

function onGuideClick(e) {
  if (e.target.closest('[data-live]')) {
    const ch = guide.channel;
    guide.resumeLive = false;
    closeGuide();
    playLive(ch);
    return;
  }
  const b = e.target.closest('[data-watch]');
  if (!b) return;
  const p = guide.progs[Number(b.dataset.watch)];
  if (!p) return;
  guide.watching = p;
  document.querySelectorAll('.gl.is-playing').forEach((el) => el.classList.remove('is-playing'));
  b.closest('.gl').classList.add('is-playing');
  $('#guide-player-slot').hidden = false;
  mountPlayer('guide');
  const ch = guide.channel;
  playWith(() => catchupUrl(ch, p), { live: false, headers: playHeaders(ch), meta: { title: p.title || ch.name, sub: `${ch.name} · catch-up from ${fmtTime(new Date(p.start * 1000))}` } });
  toast(`Catch-up: ${p.title} (${fmtTime(new Date(p.start * 1000))})`);
  $('#guide .sheet').scrollTop = 0;
}

function closeGuide() {
  $('#guide').hidden = true;
  guide.token++;
  if ($('#player').parentElement === $('#guide-player-slot')) {
    stopPlayback(true);
    mountPlayer('dock');
    // Go back to the live channel that was on before catch-up.
    if (guide.resumeLive && guide.channel) playLive(guide.channel);
  }
}

/* ---------------------------------------------------------------- devices */
// The helper server gives every device its own MAC for Stalker portals.

const DEVICE_KEY = 'sevak.deviceId';
function savedDeviceId() { try { return localStorage.getItem(DEVICE_KEY); } catch { return null; } }
function saveDeviceId(id) { try { localStorage.setItem(DEVICE_KEY, id); } catch {} }

async function deviceApi(path, opts = {}) {
  const res = await fetch(proxyBase + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: proxyBase ? 'omit' : 'same-origin',
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.signIn) { location.reload(); throw new Error('Please sign in again.'); }
  if (!res.ok) throw new Error(data.error || 'The helper server answered with an error (' + res.status + ').');
  return data;
}

async function registerDevice() {
  if (!state.proxyAvailable) return;
  // A MAC this browser already used for a Stalker login is kept, so it stays activated.
  const preferredMac = state.store.sources.find((s) => s.type === 'stalker' && s.mac)?.mac;
  try {
    const dev = await deviceApi('/api/device/register', { method: 'POST', body: { id: savedDeviceId(), preferredMac } });
    state.device = dev;
    saveDeviceId(dev.id);
    syncStalkerMac();
  } catch { state.device = null; }
  renderDeviceMac();
}

// Every Stalker login on this device uses the device's MAC.
function syncStalkerMac() {
  if (!state.device) return false;
  let changed = false;
  for (const src of state.store.sources) {
    if (src.type === 'stalker' && src.mac !== state.device.mac) { src.mac = state.device.mac; src.token = ''; changed = true; }
  }
  if (changed) saveStore();
  return changed;
}

function renderDeviceMac() {
  const mac = $('#dev-mac');
  if (!mac) return;
  mac.textContent = state.device ? state.device.mac : 'Not available';
  $('#dev-mac-copy').hidden = !state.device;
  $('#dev-mac-hint').textContent = state.device
    ? `This is “${state.device.name}”. Each device gets its own MAC. Give this one to your provider so they can activate it, then sign in.`
    : state.server && !state.server.devices
      ? 'Device MACs need a database. In Vercel, open Storage, connect an Upstash Redis database to this project, then redeploy.'
      : 'Stalker portals need the helper server. Run node server.js and open http://localhost:8080 to get this device’s MAC.';
}

async function copyText(text, el) {
  try { await navigator.clipboard.writeText(text); toast('Copied ' + text); }
  catch {
    const r = document.createRange(); r.selectNodeContents(el);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    toast('Press Copy on your keyboard or menu to copy the MAC');
  }
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

async function openDevices() {
  $('#settings').hidden = true;
  $('#devices').hidden = false;
  const list = $('#dev-list');
  list.innerHTML = '<li class="dev-meta"><span class="spinner"></span> Loading devices…</li>';
  try {
    const { devices } = await deviceApi('/api/devices');
    const me = state.device?.id;
    devices.sort((a, b) => (b.id === me) - (a.id === me) || String(b.lastSeen).localeCompare(String(a.lastSeen)));
    list.innerHTML = devices.map((d) => `
      <li class="dev${d.id === me ? ' is-me' : ''}" data-id="${esc(d.id)}">
        <div class="dev-top">
          ${d.id === me ? '<span class="badge">This device</span>' : ''}
          ${d.watching ? `<span class="badge badge-live">● Watching ${esc(d.watching)}</span>` : ''}
          <span class="dev-meta">Last seen ${esc(timeAgo(d.lastSeen))}</span>
        </div>
        <div class="dev-fields">
          <label class="field"><span>Name</span><input class="dev-name" id="dn-${esc(d.id)}" value="${esc(d.name)}" maxlength="40"></label>
          <label class="field"><span>MAC address</span><input class="dev-mac mono" id="dm-${esc(d.id)}" value="${esc(d.mac)}" spellcheck="false" autocapitalize="characters"></label>
        </div>
        <div class="dev-actions">
          <button class="btn btn-primary btn-sm" data-act="save">Save</button>
          <button class="btn btn-ghost btn-sm" data-act="newmac">New MAC</button>
          ${d.id === me ? '' : '<button class="btn btn-ghost btn-sm" data-act="use">Use on this device</button>'}
          <button class="btn btn-danger btn-sm" data-act="remove">Remove</button>
        </div>
        <div class="dev-confirm" hidden></div>
        <p class="dev-msg" role="status"></p>
      </li>`).join('') || '<li class="dev-meta">No devices yet.</li>';
  } catch (e) {
    list.innerHTML = `<li class="dev-msg is-error">${esc(e.message)}</li>`;
  }
}

function devConfirm(li, text, label, onYes) {
  const box = $('.dev-confirm', li);
  box.hidden = false;
  box.innerHTML = `<p>${esc(text)}</p><button class="btn btn-danger btn-sm" data-c="yes">${esc(label)}</button><button class="btn btn-ghost btn-sm" data-c="no">Cancel</button>`;
  $('[data-c="no"]', box).onclick = () => (box.hidden = true);
  $('[data-c="yes"]', box).onclick = () => { box.hidden = true; onYes(); };
}

// Applies a change to this device's MAC: Stalker logins switch to it and reload.
async function afterThisDeviceChanged(dev) {
  state.device = dev;
  renderDeviceMac();
  if (syncStalkerMac() && activeSource()?.type === 'stalker') openSource(activeSource());
}

async function onDevicesClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const li = btn.closest('.dev');
  const id = li.dataset.id;
  const isMe = id === state.device?.id;
  const msg = $('.dev-msg', li);
  const say = (text, ok) => { msg.textContent = text; msg.className = 'dev-msg ' + (ok ? 'is-ok' : 'is-error'); };
  const act = btn.dataset.act;
  try {
    if (act === 'save') {
      const dev = await deviceApi('/api/devices/' + id, { method: 'POST', body: { name: $('.dev-name', li).value, mac: $('.dev-mac', li).value } });
      $('.dev-mac', li).value = dev.mac;
      say('Saved.', true);
      if (isMe) afterThisDeviceChanged(dev);
    } else if (act === 'newmac') {
      devConfirm(li, 'Give this device a new random MAC? Your provider will need to activate the new one before it can sign in.', 'Make new MAC', async () => {
        try {
          const dev = await deviceApi('/api/devices/' + id + '/new-mac', { method: 'POST' });
          $('.dev-mac', li).value = dev.mac;
          say('New MAC: ' + dev.mac, true);
          if (isMe) afterThisDeviceChanged(dev);
        } catch (err) { say(err.message); }
      });
    } else if (act === 'use') {
      devConfirm(li, `Make this browser “${$('.dev-name', li).value}”? It will use that device’s MAC. Use this after a device lost its settings.`, 'Use this device', async () => {
        saveDeviceId(id);
        await registerDevice();
        if (activeSource()?.type === 'stalker') openSource(activeSource());
        openDevices();
        toast('This browser is now ' + (state.device?.name || 'that device'));
      });
    } else if (act === 'remove') {
      devConfirm(li, isMe
        ? 'Remove this device? It will be registered again with a fresh entry the next time it opens SevakTV.'
        : 'Remove this device and free its MAC address?', 'Remove', async () => {
        try {
          await deviceApi('/api/devices/' + id, { method: 'DELETE' });
          if (isMe) { try { localStorage.removeItem(DEVICE_KEY); } catch {} await registerDevice(); }
          openDevices();
        } catch (err) { say(err.message); }
      });
    }
  } catch (err) { say(err.message); }
}

// Lets the Devices page show what each device is watching.
let lastPing = null;
function pingWatching() {
  if (!state.device) return;
  const title = !video.paused && !video.ended && video.currentTime > 0 ? (state.playing?.name || state.sheetItem?.name || 'something') : null;
  if (!title && !lastPing) return;
  lastPing = title;
  deviceApi('/api/device/ping', { method: 'POST', body: { id: state.device.id, watching: title } }).catch(() => {});
}
setInterval(pingWatching, 30000);
video.addEventListener('playing', () => setTimeout(pingWatching, 500));
video.addEventListener('pause', () => setTimeout(pingWatching, 500));

/* --------------------------------------------------------------- settings */

function openSettings() {
  const src = activeSource();
  const s = state.store.settings;
  $('#settings').hidden = false;
  $('#confirm-remove').hidden = true;
  const acct = src?.account;
  const info = $('#account-info');
  if (src?.type === 'xtream' && acct) {
    const exp = acct.exp ? new Date(acct.exp * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'Never';
    info.innerHTML = `<dl class="account"><dt>Playlist</dt><dd>${esc(src.name)}</dd><dt>Status</dt><dd>${esc(acct.status || '—')}</dd>` +
      `<dt>Expires</dt><dd>${esc(exp)}</dd><dt>Connections</dt><dd>${esc(acct.active ?? '?')} of ${esc(acct.max ?? '?')} in use</dd></dl>`;
  } else if (src?.type === 'stalker') {
    info.innerHTML = `<dl class="account"><dt>Playlist</dt><dd>${esc(src.name)}</dd><dt>Type</dt><dd>Stalker portal</dd>` +
      `<dt>Portal</dt><dd>${esc(src.portal)}</dd>` + (src.api ? `<dt>Connected via</dt><dd class="break">${esc(src.api)}</dd>` : '') + `<dt>MAC</dt><dd>${esc(src.mac)}</dd>` + (acct?.stExpiry ? `<dt>Expires</dt><dd>${esc(acct.stExpiry)}</dd>` : '') + '</dl>';
  } else {
    info.innerHTML = src ? `<dl class="account"><dt>Playlist</dt><dd>${esc(src.name)}</dd><dt>Type</dt><dd>${src.type === 'file' ? 'M3U file' : 'M3U link'}</dd></dl>` : '';
  }
  renderOsBox();
  $('#s-logout').hidden = !state.server?.password;
  $('#this-device').hidden = !state.device;
  if (state.device) $('#this-device-text').innerHTML = `${esc(state.device.name)} · <code>${esc(state.device.mac)}</code>`;
  const px = $('#s-proxy');
  px.checked = useProxy();
  px.disabled = !state.proxyAvailable;
  $('#s-proxy-hint').innerHTML = state.proxyAvailable
    ? 'Fixes blocked streams (CORS, http:// links, required headers). Leave it on unless a stream works better without it.'
    : 'Not available: the helper server isn’t running. Start it with <code>node server.js</code>.';
  $('#s-format').value = s.format;
  $('#s-ua').value = s.ua || '';
}

/* ------------------------------------------------------------ access gate */
// Shown only when the server has a password (SEVAK_PASSWORD).

function showGate() {
  $('#welcome').hidden = true;
  $('#app').hidden = true;
  $('#gate').hidden = false;
  $('#gate-pass').focus();
  $('#gate-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#gate-btn'), err = $('#gate-error');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const r = await fetch(proxyBase + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#gate-pass').value }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Couldn’t sign in.');
      location.reload();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  };
}

/* ------------------------------------------------- online subtitles setup */

async function renderOsBox() {
  const box = $('#os-box');
  box.hidden = !state.proxyAvailable || (state.server && !state.server.subtitles);
  if (box.hidden) return;
  $('#os-msg').textContent = '';
  const c = await (window.PUI ? PUI.loadOsConfig() : deviceApi('/api/subs/config')).catch(() => ({}));
  $('#os-state').textContent = c.configured ? '· set up' : '· not set up';
  $('#os-key').value = '';
  $('#os-key').placeholder = c.configured ? `Saved (${c.keyHint}). Type a new key to replace it` : 'Paste your API key';
  $('#os-user').value = c.username || '';
  $('#os-pass').value = '';
  $('#os-pass').placeholder = c.hasPassword ? 'Saved' : '';
  $('#os-langs').value = c.languages || 'en';
  $('#os-clear').hidden = !c.configured;
}

async function saveOs(clear) {
  const msg = $('#os-msg');
  msg.className = 'dev-msg';
  msg.textContent = clear ? 'Removing…' : 'Saving…';
  try {
    const body = clear ? { clear: true } : { apiKey: $('#os-key').value, username: $('#os-user').value, password: $('#os-pass').value, languages: $('#os-langs').value };
    await deviceApi('/api/subs/config', { method: 'POST', body });
    await renderOsBox();
    msg.className = 'dev-msg is-ok';
    msg.textContent = clear ? 'Removed.' : 'Saved. You can now search subtitles from the player (CC button → Search online).';
  } catch (e) {
    msg.className = 'dev-msg is-error';
    msg.textContent = e.message;
  }
}

/* ------------------------------------------------------------- add source */

let method = 'xtream';
function setMethod(m) {
  method = m;
  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.method === m);
    b.setAttribute('aria-selected', b.dataset.method === m);
  });
  document.querySelectorAll('[data-for]').forEach((el) => (el.hidden = el.dataset.for !== m));
  if (m === 'stalker') renderDeviceMac();
  $('#add-error').hidden = true;
}

async function submitSource(srcIn) {
  const err = $('#add-error');
  const btn = $('#add-submit');
  err.hidden = true;
  btn.disabled = true;
  const label = btn.textContent;
  try {
    const cat = await loadSource(srcIn, (msg) => (btn.textContent = msg));
    state.store.sources.push(srcIn);
    state.store.activeId = srcIn.id;
    saveStore();
    $('#add-form').reset();
    showApp();
    state.loadToken++;
    state.catalog = cat;
    setLoading(null);
    $('#empty').hidden = true;
    $('#now').hidden = true;
    stopPlayback(true);
    const first = ['live', 'movies', 'series'].find((s) => hasSection(cat, s)) || 'live';
    setSection(first);
    toast('Added ' + srcIn.name);
  } catch (e) {
    if (srcIn.type === 'file') { memoryFiles.delete(srcIn.id); try { localStorage.removeItem(FILE_KEY(srcIn.id)); } catch {} }
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function onAddSubmit(e) {
  e.preventDefault();
  const name = $('#f-name').value.trim();
  const err = $('#add-error');
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  if (method === 'xtream') {
    const server = $('#f-server').value.trim(), username = $('#f-user').value.trim(), password = $('#f-pass').value;
    if (!server || !username || !password) return fail('Enter the server URL, username and password from your provider.');
    let base;
    try { base = xtBase(server); } catch { return fail('That server URL isn’t valid. It usually looks like http://example.com:8080'); }
    return submitSource({ id: uid(), type: 'xtream', name: name || new URL(base).hostname, server: base, username, password });
  }
  if (method === 'stalker') {
    const portal = $('#f-portal').value.trim();
    if (!portal) return fail('Enter the portal URL from your provider, for example http://provider.com:8080 or http://provider.com:8080/c/');
    if (!useProxy()) return fail('Stalker portals only work through the helper server. Run node server.js and open http://localhost:8080.');
    if (!state.device) return fail(state.server && !state.server.devices
      ? 'This device has no MAC yet because no database is connected. In Vercel, connect an Upstash Redis database (Storage), then redeploy.'
      : 'Couldn’t get this device’s MAC from the helper server. Reload the page and try again.');
    const mac = state.device.mac;
    let host;
    try { stalkerApiCandidates(portal); host = new URL(/^https?:/i.test(portal) ? portal : 'http://' + portal).hostname; } catch { return fail('That portal URL isn’t valid. It looks like http://provider.com:8080 or http://provider.com:8080/c/'); }
    return submitSource({
      id: uid(), type: 'stalker', name: name || host, portal: /^https?:/i.test(portal) ? portal : 'http://' + portal,
      mac, sn: $('#f-sn').value.trim(), deviceId: $('#f-devid').value.trim(),
    });
  }
  if (method === 'm3u') {
    const url = $('#f-url').value.trim();
    if (!/^https?:\/\//i.test(url)) return fail('Enter a full link starting with http:// or https://');
    const xt = xtreamFromM3uUrl(url);
    if (xt) {
      toast('That link contains an Xtream login, so movies and series will load too.');
      return submitSource({ id: uid(), type: 'xtream', name: name || new URL(xt.server).hostname, ...xt });
    }
    return submitSource({ id: uid(), type: 'm3u', name: name || new URL(url).hostname, url });
  }
  const file = $('#f-file').files[0];
  if (!file) return fail('Choose an .m3u file.');
  const text = await file.text();
  const id = uid();
  if (!saveFileText(id, text)) toast('This file is too big to remember, so it will be kept until you close the tab.');
  return submitSource({ id, type: 'file', name: name || file.name.replace(/\.m3u8?$/i, ''), fileName: file.name });
}

/* ------------------------------------------------------------------ wiring */

function bindUI() {
  document.querySelectorAll('.seg-btn').forEach((b) => (b.onclick = () => setMethod(b.dataset.method)));
  $('#add-form').addEventListener('submit', onAddSubmit);
  $('#add-demo').onclick = () => submitSource({ id: uid(), type: 'm3u', name: DEMO.name, url: DEMO.url });
  $('#add-cancel').onclick = () => { if (activeSource()) { showApp(); } };

  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => state.catalog && setSection(t.dataset.section)));

  let qTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.query = e.target.value; applyFilter(); }, 120);
  });

  $('#cat-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cat]');
    if (b) setCategory(b.dataset.cat);
  });
  $('#cat-select').addEventListener('change', (e) => setCategory(e.target.value));

  const onListClick = (e) => {
    const host = e.target.closest('[data-idx]');
    if (!host) return;
    const item = state.filtered[Number(host.dataset.idx)];
    if (!item) return;
    const star = e.target.closest('.star');
    if (star) {
      const on = toggleFav(item);
      star.classList.toggle('is-on', on);
      star.setAttribute('aria-pressed', on);
      if (state.playing?.key === item.key) $('#now-fav').setAttribute('aria-pressed', on);
      if (state.section === 'favorites') { renderCategories(); applyFilter(); }
      return;
    }
    activate(item);
  };
  $('#channel-list').addEventListener('click', onListClick);
  $('#poster-grid').addEventListener('click', onListClick);
  $('#poster-grid').addEventListener('keydown', (e) => { if (e.key === 'Enter') onListClick(e); });

  $('.browser').addEventListener('scroll', () => { if (sentinelVisible()) renderMore(); }, { passive: true });
  window.addEventListener('scroll', () => { if (sentinelVisible()) renderMore(); }, { passive: true });

  $('#now-fav').onclick = () => {
    if (!state.playing) return;
    const on = toggleFav(state.playing);
    $('#now-fav').setAttribute('aria-pressed', on);
    const row = document.querySelector('.ch.is-playing .star');
    if (row) { row.classList.toggle('is-on', on); row.setAttribute('aria-pressed', on); }
    toast(on ? 'Added to favorites' : 'Removed from favorites');
  };

  // movie/series sheet
  $('#sheet-close').onclick = closeSheet;
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  $('#sheet-play').onclick = () => {
    const item = state.sheetItem;
    if (!item) return;
    if (item.kind === 'series') {
      const pr = resumeFor(item);
      if (pr && pr.ep) return playInSheet(pr.ep, `S${pr.season} E${pr.ep.episode_num ?? '?'}`, pr.pos, pr.season);
      return playEpisode(0);
    }
    const pr = progressMap()[item.key];
    playInSheet(null, null, pr ? pr.pos : 0);
  };
  $('#sheet-restart').onclick = () => { if (state.sheetItem) { playInSheet(null, null, 0); $('#sheet-restart').hidden = true; } };
  $('#continue-row').addEventListener('click', onContinueClick);
  $('#continue-row').addEventListener('keydown', (e) => { if (e.key === 'Enter') onContinueClick(e); });
  $('#now-guide').onclick = () => state.playing && openGuide(state.playing);
  $('#guide-close').onclick = closeGuide;
  $('#guide').addEventListener('click', (e) => { if (e.target.id === 'guide') closeGuide(); });
  $('#guide-days').addEventListener('click', (e) => { const b = e.target.closest('button[data-day]'); if (b) showGuideDay(Number(b.dataset.day)); });
  $('#guide-list').addEventListener('click', onGuideClick);
  $('#sheet-fav').onclick = () => {
    const item = state.sheetItem;
    if (!item) return;
    const on = toggleFav(item);
    $('#sheet-fav').setAttribute('aria-pressed', on);
    if (state.section === 'favorites') { renderCategories(); applyFilter(); }
  };
  $('#season-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-season]');
    if (b) showSeason(b.dataset.season);
  });
  $('#episodes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ep]');
    if (b) playEpisode(Number(b.dataset.ep));
  });

  // sources + settings
  $('#source-select').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === '__add') { e.target.value = state.store.activeId; return showWelcome({ cancellable: true }); }
    state.store.activeId = v;
    saveStore();
    state.query = '';
    $('#search').value = '';
    openSource(activeSource());
  });
  $('#btn-settings').onclick = openSettings;
  $('#dev-mac-copy').onclick = () => state.device && copyText(state.device.mac, $('#dev-mac'));
  $('#s-devices').onclick = openDevices;
  $('#os-save').onclick = () => saveOs(false);
  $('#s-logout').onclick = async () => {
    try { await fetch(proxyBase + '/api/logout', { method: 'POST' }); } catch {}
    location.reload();
  };
  $('#os-clear').onclick = () => saveOs(true);
  $('#devices-close').onclick = () => ($('#devices').hidden = true);
  $('#devices').addEventListener('click', (e) => { if (e.target.id === 'devices') $('#devices').hidden = true; });
  $('#dev-list').addEventListener('click', onDevicesClick);
  $('#settings-close').onclick = () => ($('#settings').hidden = true);
  $('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings') $('#settings').hidden = true; });
  $('#s-proxy').onchange = (e) => { state.store.settings.useProxy = e.target.checked; saveStore(); toast(e.target.checked ? 'Helper server on' : 'Helper server off'); };
  $('#sort-select').addEventListener('change', (e) => {
    state.store.settings.sort = e.target.value;
    saveStore();
    applyFilter();
    $('.browser').scrollTop = 0;
  });
  $('#s-format').onchange = (e) => {
    state.store.settings.format = e.target.value; saveStore();
    if (state.playing?.kind === 'live') playLive(state.playing);
  };
  $('#s-ua').onchange = (e) => { state.store.settings.ua = e.target.value.trim(); saveStore(); };
  $('#s-reload').onclick = () => { $('#settings').hidden = true; openSource(activeSource()); };
  $('#s-add').onclick = () => { $('#settings').hidden = true; showWelcome({ cancellable: true }); };
  $('#s-remove').onclick = () => { $('#confirm-name').textContent = activeSource()?.name || ''; $('#confirm-remove').hidden = false; };
  $('#confirm-no').onclick = () => ($('#confirm-remove').hidden = true);
  $('#confirm-yes').onclick = () => {
    const src = activeSource();
    if (!src) return;
    state.store.sources = state.store.sources.filter((s) => s.id !== src.id);
    delete state.store.favorites[src.id];
    delete state.store.ui[src.id];
    try { localStorage.removeItem(FILE_KEY(src.id)); } catch {}
    memoryFiles.delete(src.id);
    state.store.activeId = state.store.sources[0]?.id || null;
    saveStore();
    $('#settings').hidden = true;
    stopPlayback(true);
    toast('Removed ' + src.name);
    if (activeSource()) { renderSourceSelect(); openSource(activeSource()); } else showWelcome();
  };

  // keyboard
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
    if (e.key === 'Escape') {
      if (window.PUI?.menuOpen) { PUI.handleKey(e); return; }
      if (!$('#devices').hidden) $('#devices').hidden = true;
      else if (!$('#guide').hidden) closeGuide();
      else if (!$('#settings').hidden) $('#settings').hidden = true;
      else if (!$('#sheet').hidden) closeSheet();
      return;
    }
    if (typing || $('#app').hidden) return;
    if (e.key === '/') { e.preventDefault(); $('#search').focus(); return; }
    const dialogOpen = !$('#sheet').hidden || !$('#settings').hidden || !$('#devices').hidden || !$('#guide').hidden;
    const playerDialog = $('#player').closest('.sheet-backdrop');
    const playerVisible = !playerDialog ? !dialogOpen : !playerDialog.hidden && $('#settings').hidden && $('#devices').hidden;
    if (playerVisible && window.PUI && PUI.handleKey(e)) return;
    if (dialogOpen) return;
    if (e.key === 'ArrowUp' || e.key === 'PageUp') { if (state.playing) { e.preventDefault(); zap(-1); } }
    else if (e.key === 'ArrowDown' || e.key === 'PageDown') { if (state.playing) { e.preventDefault(); zap(1); } }
  });
}

async function init() {
  if (window.mpegts) {
    Object.assign(mpegts.LoggingControl, { enableVerbose: false, enableDebug: false, enableInfo: false });
  }
  bindUI();
  state.proxyAvailable = await checkProxy();
  if (state.server?.password && !state.server.signedIn) { showGate(); return; }
  await registerDevice();
  if (!state.store.sources.length) { showWelcome(); return; }
  if (!activeSource()) state.store.activeId = state.store.sources[0].id;
  showApp();
  openSource(activeSource());
}

// Exposed for tests in Node; harmless in the browser.
if (typeof window !== 'undefined') window.SevakTV = { parseM3U, xtBase, xtreamFromM3uUrl, guessKind };

init();
