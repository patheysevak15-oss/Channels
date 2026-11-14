// Small stream helpers shared by every SevakTV server (home, Vercel and
// Cloudflare). No Node-only APIs, so they run in Cloudflare Workers too.
'use strict';

const utf8 = new TextDecoder('utf-8');
const text = (bytes) => utf8.decode(bytes);

// Builds a relayed URL that keeps the same header overrides.
function proxied(absUrl, ua, ref, h) {
  let q = '/proxy?url=' + encodeURIComponent(absUrl);
  if (ua) q += '&ua=' + encodeURIComponent(ua);
  if (ref) q += '&ref=' + encodeURIComponent(ref);
  if (h) q += '&h=' + encodeURIComponent(h);
  return q;
}

// Extra headers a Stalker/MAG portal expects. Only these names are forwarded.
const EXTRA_HEADERS = new Set(['cookie', 'authorization', 'x-user-agent']);
function extraHeaders(h) {
  const out = {};
  if (!h) return out;
  try {
    const b64 = h.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const obj = JSON.parse(text(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    for (const [k, v] of Object.entries(obj)) {
      if (EXTRA_HEADERS.has(k.toLowerCase()) && typeof v === 'string' && !/[\r\n]/.test(v)) out[k] = v;
    }
  } catch {}
  return out;
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Headers sent to the provider, from the relay's query parameters.
function upstreamHeaders(params) {
  const ua = params.get('ua') || '', ref = params.get('ref') || '';
  const headers = { 'User-Agent': ua || DEFAULT_UA, Accept: '*/*', ...extraHeaders(params.get('h') || '') };
  if (ref) {
    headers.Referer = ref;
    try { headers.Origin = new URL(ref).origin; } catch {}
  }
  return headers;
}

// Rewrites every URI inside an HLS playlist so segments, keys and variant
// playlists also go through the relay.
function rewriteHls(playlist, baseUrl, ua, ref, h) {
  const abs = (u) => { try { return new URL(u, baseUrl).href; } catch { return u; } };
  return playlist.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxied(abs(u), ua, ref, h)}"`);
    return proxied(abs(t), ua, ref, h);
  }).join('\n');
}

function looksLikeHls(contentType, url) {
  if ((contentType || '').toLowerCase().includes('mpegurl')) return true;
  try { return /\.m3u8?$/i.test(new URL(url).pathname); } catch { return false; }
}

const TS_TYPES = {
  0x01: 'mpeg1-video', 0x02: 'mpeg2-video', 0x1b: 'h264', 0x24: 'hevc', 0x0f: 'aac', 0x11: 'aac-latm',
  0x03: 'mpeg-audio', 0x04: 'mpeg-audio', 0x81: 'ac-3', 0x87: 'e-ac-3',
};

// Reads the program map of an MPEG-TS stream to find its video/audio codecs.
function tsCodecs(buf) {
  let start = buf.indexOf(0x47);
  while (start >= 0 && start + 188 * 2 < buf.length && buf[start + 188] !== 0x47) start = buf.indexOf(0x47, start + 1);
  if (start < 0) return null;
  const pkts = [];
  for (let i = start; i + 188 <= buf.length; i += 188) if (buf[i] === 0x47) pkts.push(buf.subarray(i, i + 188));
  const payload = (p) => {
    const afc = (p[3] >> 4) & 3;
    let off = 4;
    if (afc === 2) return null;
    if (afc === 3) off += 1 + p[4];
    return off < 188 ? p.subarray(off) : null;
  };
  const pid = (p) => ((p[1] & 0x1f) << 8) | p[2];
  const pusi = (p) => (p[1] & 0x40) !== 0;
  let pmtPid = null;
  for (const p of pkts) {
    if (pid(p) !== 0 || !pusi(p)) continue;
    const pl = payload(p); if (!pl) continue;
    const t = pl.subarray(1 + pl[0]);
    const len = ((t[1] & 0x0f) << 8) | t[2];
    for (let i = 8; i + 4 <= 3 + len - 4; i += 4) {
      const prog = (t[i] << 8) | t[i + 1];
      if (prog !== 0) { pmtPid = ((t[i + 2] & 0x1f) << 8) | t[i + 3]; break; }
    }
    if (pmtPid != null) break;
  }
  if (pmtPid == null) return null;
  for (const p of pkts) {
    if (pid(p) !== pmtPid || !pusi(p)) continue;
    const pl = payload(p); if (!pl) continue;
    const t = pl.subarray(1 + pl[0]);
    const len = ((t[1] & 0x0f) << 8) | t[2];
    const end = Math.min(t.length, 3 + len - 4);
    let i = 12 + (((t[10] & 0x0f) << 8) | t[11]);
    const out = { video: [], audio: [] };
    while (i + 5 <= end) {
      const type = t[i];
      const esLen = ((t[i + 3] & 0x0f) << 8) | t[i + 4];
      let name = TS_TYPES[type];
      if (type === 0x06) {
        for (let d = i + 5; d + 2 <= i + 5 + esLen; d += 2 + t[d + 1]) {
          if (t[d] === 0x6a) name = 'ac-3';
          if (t[d] === 0x7a) name = 'e-ac-3';
        }
      }
      if (name) (/video|h264|hevc/.test(name) ? out.video : out.audio).push(name);
      i += 5 + esLen;
    }
    return out;
  }
  return null;
}

// What kind of data a response holds.
function sniff(buf, type) {
  const head = text(buf.subarray(0, 512));
  if (head.trimStart().startsWith('#EXTM3U')) return 'hls';
  if (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47)) return 'ts';
  if (String.fromCharCode(buf[4], buf[5], buf[6], buf[7]) === 'ftyp') return 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'mkv';
  if (/^\s*<(!doctype|html|head|body)/i.test(head) || /text\/html/i.test(type)) return 'html';
  if (/^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(head.slice(0, 200))) return 'text';
  return 'other';
}

// Reads up to `limit` bytes of a stream, keeping what arrived if it breaks.
async function peek(url, headers, limit = 262144) {
  const r = await fetch(url, { headers: { ...headers, Range: 'bytes=0-' + (limit - 1) }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
  const chunks = [];
  let size = 0;
  if (r.body) {
    const reader = r.body.getReader();
    try {
      while (size < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); size += value.length;
      }
    } catch (e) {
      if (!size) throw e;
    }
    try { await reader.cancel(); } catch {}
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return { status: r.status, type: r.headers.get('content-type') || '', url: r.url || url, buf };
}

// Looks at a stream: what the provider answered and which codecs it uses.
async function diagnose(target, headers) {
  const out = { status: 0 };
  try {
    let r = await peek(target, headers);
    out.status = r.status;
    out.kind = sniff(r.buf, r.type);
    if (out.kind === 'html' || out.kind === 'text') out.text = text(r.buf.subarray(0, 400)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    for (let depth = 0; out.kind === 'hls' && depth < 3; depth++) {
      const body = text(r.buf);
      const m = body.match(/#EXT-X-STREAM-INF:[^\n]*CODECS="([^"]+)"/);
      if (m && !out.declared) out.declared = m[1];
      const next = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (!next) break;
      try { r = await peek(new URL(next, r.url).href, headers); } catch (e) { out.segmentError = e.cause?.code || e.message; break; }
      out.segmentStatus = r.status;
      const k = sniff(r.buf, r.type);
      if (k !== 'hls') { out.segment = k; if (k === 'ts') out.codecs = tsCodecs(r.buf); break; }
    }
    if (out.kind === 'ts') out.codecs = tsCodecs(r.buf);
  } catch (e) {
    out.error = e.cause?.code || e.name || e.message;
  }
  return out;
}

/* ---------------------------------------------------------------- devices */

const ANY_MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
function normMac(v) {
  const hex = String(v || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length === 12 ? hex.match(/.{2}/g).join(':') : null;
}
function newMac(devices) {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(3));
    const mac = '00:1A:79:' + [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
    if (!devices.some((d) => d.mac === mac)) return mac;
  }
}
function guessName(ua, devices) {
  ua = ua || '';
  const base =
    /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /AFT\w+|Fire TV/i.test(ua) ? 'Fire TV' :
    /Tizen|SMART-TV.*Samsung/i.test(ua) ? 'Samsung TV' : /Web0S|webOS/i.test(ua) ? 'LG TV' :
    /Android TV|BRAVIA|GoogleTV|SmartTV|SMART-TV/i.test(ua) ? 'TV' : /Android/.test(ua) ? 'Android' :
    /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Device';
  let name = base, n = 2;
  while (devices.some((d) => d.name === name)) name = `${base} ${n++}`;
  return name;
}

module.exports = {
  DEFAULT_UA, proxied, extraHeaders, upstreamHeaders, rewriteHls, looksLikeHls,
  tsCodecs, sniff, peek, diagnose, ANY_MAC_RE, normMac, newMac, guessName,
};
