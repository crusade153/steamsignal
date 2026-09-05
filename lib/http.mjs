import { steam, parseIds } from './steam.mjs';

export async function handleApi(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.statusCode = 405; res.end(JSON.stringify({ error: 'GET 요청만 지원합니다.' })); return; }
  try {
    const url = new URL(req.url, 'http://localhost');
    let payload;
    if (url.pathname === '/api/health') payload = { ok: true, service: 'steam-pulse', version: 2 };
    else if (url.pathname === '/api/games') payload = await steam.getChart();
    else if (url.pathname === '/api/game-details') payload = await steam.getDetails(parseIds(url.searchParams.get('ids')));
    else { res.statusCode = 404; res.end(JSON.stringify({ error: 'API를 찾을 수 없습니다.' })); return; }
    const partial = payload.stale || Object.values(payload.sources || {}).some(source => source.status !== 'ok') || payload.games?.some(game => Object.values(game.sources || {}).some(source => source.status !== 'ok'));
    res.setHeader('Cache-Control', partial ? 'no-store' : 'public, max-age=0, s-maxage=60, stale-while-revalidate=120');
    res.end(JSON.stringify(payload));
  } catch (error) {
    res.statusCode = error.status || 503;
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: error.status ? error.message : 'Steam 데이터를 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.' }));
  }
}
