// sitemap.xml. 앱이 늘어나면 URL 도 같이 늘어나므로 정적 파일로 둘 수 없다.
// CDN 에 1시간 캐시하므로 크롤러가 아무리 자주 와도 DB 는 시간당 한 번만 읽힌다.
import { getSql } from '../lib/db.mjs';
import { sitemap } from '../lib/pages.mjs';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  try {
    const result = await sitemap(getSql());
    res.statusCode = result.status;
    for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
    res.end(req.method === 'HEAD' ? undefined : result.body);
  } catch (error) {
    console.error('[sitemap]', error);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end('sitemap unavailable');
  }
}
