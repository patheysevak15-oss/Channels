// Where SevakTV keeps its device list, settings and short-lived values.
//  - At home (node server.js): JSON files in the data/ folder.
//  - On Vercel: Upstash Redis (files can't be kept between requests there).
'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------ local files */

function fileStorage(dir) {
  const devicesFile = path.join(dir, 'devices.json');
  const settingsFile = path.join(dir, 'settings.json');
  const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
  const write = (f, obj) => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
  };
  let devices = (read(devicesFile, {}).devices || []);
  let settings = read(settingsFile, {}) || {};
  const temp = new Map(); // key -> { value, until }

  return {
    kind: 'files',
    async listDevices() { return devices.map((d) => ({ ...d })); },
    async putDevice(dev) {
      const i = devices.findIndex((d) => d.id === dev.id);
      if (i >= 0) devices[i] = { ...dev }; else devices.push({ ...dev });
      write(devicesFile, { devices });
    },
    async deleteDevice(id) {
      devices = devices.filter((d) => d.id !== id);
      write(devicesFile, { devices });
    },
    async getSettings() { return JSON.parse(JSON.stringify(settings)); },
    async saveSettings(s) { settings = s; write(settingsFile, settings); },
    async setTemp(key, value, seconds) {
      if (value == null) temp.delete(key); else temp.set(key, { value, until: Date.now() + seconds * 1000 });
    },
    async getTemp(keys) {
      const now = Date.now();
      return keys.map((k) => { const t = temp.get(k); return t && t.until > now ? t.value : null; });
    },
  };
}

/* ---------------------------------------------------------- Upstash Redis */

function redisStorage(url, token) {
  const base = url.replace(/\/+$/, '');
  async function cmd(...args) {
    const r = await fetch(base, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error('Database error: ' + (data.error || r.status));
    return data.result;
  }
  const DEV = 'sevak:devices', SET = 'sevak:settings', TMP = 'sevak:tmp:';
  return {
    kind: 'redis',
    async listDevices() {
      const flat = (await cmd('HGETALL', DEV)) || [];
      const out = [];
      for (let i = 1; i < flat.length; i += 2) { try { out.push(JSON.parse(flat[i])); } catch {} }
      return out;
    },
    async putDevice(dev) { await cmd('HSET', DEV, dev.id, JSON.stringify(dev)); },
    async deleteDevice(id) { await cmd('HDEL', DEV, id); },
    async getSettings() { try { return JSON.parse((await cmd('GET', SET)) || '{}'); } catch { return {}; } },
    async saveSettings(s) { await cmd('SET', SET, JSON.stringify(s)); },
    async setTemp(key, value, seconds) {
      if (value == null) await cmd('DEL', TMP + key);
      else await cmd('SET', TMP + key, JSON.stringify(value), 'EX', String(Math.max(1, Math.round(seconds))));
    },
    async getTemp(keys) {
      if (!keys.length) return [];
      const vals = (await cmd('MGET', ...keys.map((k) => TMP + k))) || [];
      return vals.map((v) => { try { return v == null ? null : JSON.parse(v); } catch { return null; } });
    },
  };
}

// Picks Redis when its settings are present (Vercel adds them when you
// connect an Upstash database), otherwise files in data/.
function createStorage(dataDir) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return redisStorage(url, token);
  if (process.env.VERCEL) return null; // no database connected yet
  return fileStorage(dataDir);
}

module.exports = { createStorage, fileStorage, redisStorage };
