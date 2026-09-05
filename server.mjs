import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './lib/http.mjs';
import { matchRoute } from './lib/routes.mjs';
import { HANDLERS, notFound, serverError, sitemap } from './lib/pages.mjs';
import { getSql } from './lib/db.mjs';

const publicRoot = fileURLToPath(new URL('./public/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };

// 배포에서는 vercel.json 의 rewrites 가 하는 일을 로컬에서는 여기서 한다.
// 두 경로가 어긋나지 않도록 규칙은 lib/routes.mjs 한곳에만 적혀 있다.
async function renderPage(req, res, produce) {
  let result;
  try {
    result = await produce();
  } catch (error) {
    console.error('[ssr]', req.url, error);
    result = serverError();
  }
  res.writeHead(result.status, { ...result.headers, 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : result.body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res);
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }

  if (url.pathname === '/sitemap.xml') return renderPage(req, res, () => sitemap(getSql()));
  const route = matchRoute(url.pathname);
  if (route) {
    const handle = HANDLERS[route.name];
    return renderPage(req, res, () => (handle ? handle(getSql(), route.params) : notFound()));
  }

  try {
    const path = resolve(publicRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(resolve(publicRoot) + sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return renderPage(req, res, async () => notFound());
    res.writeHead(400);
    res.end('Bad Request');
  }
});
server.listen(Number(process.env.PORT || 5174), '127.0.0.1', () => console.log(`Steam Pulse ready at http://127.0.0.1:${server.address().port}`));
