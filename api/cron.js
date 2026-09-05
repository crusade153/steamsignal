import { timingSafeEqual } from 'node:crypto';
import { getSql } from '../lib/db.mjs';
import { createCollector } from '../lib/collect.mjs';

// 크론 엔드포인트는 반드시 인증한다. 열려 있으면 누구나 호출해
// (1) Vercel 함수 호출량을 태우고 (2) 우리 IP 가 Steam 에서 차단당한다.
function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-cron-secret'] || '');
  const a = Buffer.from(String(provided));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (!authorized(req)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const requested = (url.searchParams.get('jobs') || 'chart,details').split(',').map(v => v.trim()).filter(Boolean);
  const collector = createCollector({ sql: getSql() });
  const results = [];
  let failed = false;

  for (const name of requested) {
    try {
      results.push(await collector.run(name));
    } catch (error) {
      failed = true;
      results.push({ job: name, status: 'error', error: String(error?.message || error) });
    }
  }

  res.statusCode = failed ? 500 : 200;
  res.end(JSON.stringify({ ok: !failed, results }));
}
