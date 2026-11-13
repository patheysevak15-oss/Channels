#!/usr/bin/env node
// SevakTV helper server for home use: serves the web app and relays
// playlists/streams (browsers block most IPTV servers on their own).
//
// Usage:  node server.js                -> http://127.0.0.1:8080
//         PORT=9000 node server.js
//         HOST=0.0.0.0 node server.js   (share on your Wi-Fi; see README)
//
// No dependencies; needs Node 18+. The same logic runs on Vercel through
// api/sevak.js (see README → Vercel).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHandler } = require('./lib/core');
const { createStorage } = require('./lib/storage');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return res.writeHead(403).end('Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const handle = createHandler({ storage: createStorage(path.join(__dirname, 'data')) });

http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://local');
  if (await handle(req, res, pathname, searchParams)) return;
  serveStatic(req, res, pathname);
}).listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`SevakTV running at http://${shown}:${PORT}`);
  if (HOST === '0.0.0.0') console.log('Anyone on your network can use SevakTV. Do not expose this port to the internet.');
  if (process.env.SEVAK_PASSWORD) console.log('Access password is on (SEVAK_PASSWORD).');
});
