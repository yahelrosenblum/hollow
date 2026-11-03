// Local static server. Bound to loopback only. The one write path stores audit results
// in docs/audit, under a fixed set of names, so a page can report what it measured.

import { createServer } from 'node:http';
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8791);
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const AUDIT_NAMES = new Set(['gpu', 'audio', 'soak']);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function saveAudit(req, res, name) {
  if (!AUDIT_NAMES.has(name)) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_RESULT_BYTES) {
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const dir = join(root, 'docs', 'audit');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(parsed, null, 2));
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
  });
}

// Audit results may only come from this server's own pages. Without this, any website open in
// the same browser could write to these files with a plain cross-origin POST.
function isOwnRequest(req) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowed.has(req.headers.host)) return false;
  const { origin } = req.headers;
  return !origin || allowed.has(origin.replace(/^https?:\/\//, ''));
}

const server = createServer((req, res) => {
  let url;
  let requested;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
    requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const audit = url.pathname.match(/^\/__audit\/([a-z]+)$/);
  if (audit && req.method === 'POST') {
    if (!isOwnRequest(req)) {
      res.writeHead(403).end();
      return;
    }
    saveAudit(req, res, audit[1]);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const path = resolve(root, `.${normalize(requested)}`);
  if (path !== root && !path.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (!statSync(path).isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(path).on('error', () => res.destroy()).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Hollow is running at http://127.0.0.1:${port}\n`);
});
