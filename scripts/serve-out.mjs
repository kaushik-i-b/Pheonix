#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', 'apps/web', 'out');
const port = Number(process.env.PORT ?? 4173);

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
]);

function contentType(file) {
  return MIME.get(extname(file).toLowerCase()) ?? 'application/octet-stream';
}

function sendFile(res, file, status) {
  const info = statSync(file);
  res.writeHead(status, {
    'content-type': contentType(file),
    'content-length': info.size,
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

function sendNotFound(res) {
  const fallback = join(root, '404.html');
  if (existsSync(fallback)) {
    sendFile(res, fallback, 404);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('404: not found in export');
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request: malformed path encoding');
    return;
  }

  const target = resolve(root, `.${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden: path escapes the export directory');
    return;
  }

  if (existsSync(target) && statSync(target).isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { location: `${pathname}/${url.search}` });
      res.end();
      return;
    }
    const index = join(target, 'index.html');
    if (existsSync(index)) {
      sendFile(res, index, 200);
      return;
    }
    sendNotFound(res);
    return;
  }

  if (existsSync(target) && statSync(target).isFile()) {
    sendFile(res, target, 200);
    return;
  }

  if (!pathname.endsWith('.html') && existsSync(`${target}.html`)) {
    sendFile(res, `${target}.html`, 200);
    return;
  }

  sendNotFound(res);
});

server.on('error', (error) => {
  console.error(`server error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} at http://127.0.0.1:${port}/`);
});
