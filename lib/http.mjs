// 읽기 API. 사용자 요청은 여기서 DB 만 읽는다 — Steam 은 크론(lib/collect.mjs)만 호출한다.
//
// 이렇게 나눈 이유는 캐시 때문이다. 예전 구조는 서버리스 인스턴스마다 인메모리 캐시를 따로 들고 있어서,
// 트래픽이 늘어 인스턴스가 N개로 벌어지면 Steam 호출도 N배가 됐다. 지금은 트래픽이 얼마든 Steam 호출은 고정이다.
import { getSql } from './db.mjs';
// parseIds 만 가져온다. Steam 클라이언트(getChart/getDetails)는 이 경로에서 절대 호출하지 않는다.
import { parseIds } from './steam.mjs';
import { chartTop, appById } from './queries.mjs';
import { gamePath, isNum, safeImage } from './render.mjs';

// 수집 주기가 10분이다. 25분을 넘겼다면 크론이 밀렸거나 죽은 것이므로 응답에 그렇게 적는다.
const STALE_AFTER_MS = 25 * 60_000;

const iso = value => (value ? new Date(value).toISOString() : null);
const reviewTotal = row =>
  isNum(row.total_positive) && isNum(row.total_negative) ? row.total_positive + row.total_negative : null;

// 응답 모양은 화면이 쓰는 이름으로 맞춘다. DB 컬럼명을 그대로 흘리면 스키마가 곧 공개 API 가 된다.
export function serializeGame(row) {
  return {
    appid: row.appid,
    title: row.title,
    slug: row.slug || String(row.appid),
    path: gamePath(row.appid, row.slug),
    headerImage: safeImage(row.header_image),
    genres: Array.isArray(row.genres) ? row.genres : [],
    players: row.players ?? null,
    peakToday: row.peak_today ?? null,
    rank: row.rank ?? null,
    positiveRatio: row.positive_ratio ?? null,
    reviewTotal: reviewTotal(row),
    reviewLabel: row.review_desc ?? null,
    metacritic: isNum(row.metacritic_score) ? { score: row.metacritic_score, url: row.metacritic_url ?? null } : null,
    price: row.final_price ?? null,
    priceFormatted: row.price_formatted ?? null,
    initialPrice: row.initial_price ?? null,
    discount: row.discount_percent ?? 0,
    isFree: row.final_price === 0 ? true : row.final_price > 0 ? false : null,
    playersAt: iso(row.players_at),
    priceAt: iso(row.price_at),
    reviewsAt: iso(row.reviews_at)
  };
}

function chartPayload(rows) {
  const games = rows.map(serializeGame);
  const newest = rows.reduce((max, row) => {
    const at = row.players_at ? new Date(row.players_at).getTime() : 0;
    return at > max ? at : max;
  }, 0);
  const updatedAt = newest ? new Date(newest).toISOString() : null;
  return {
    games,
    total: games.length,
    updatedAt,
    retrievedAt: new Date().toISOString(),
    // 결측을 0 으로 만들지 않는다는 규율의 연장. "모른다"와 "낡았다"를 구분해서 알린다.
    stale: newest === 0 || Date.now() - newest > STALE_AFTER_MS,
    source: 'steam-pulse-timeseries',
    rankingBasis: 'current_players',
    refreshAfterSeconds: 300
  };
}

export async function handleApi(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'GET 요청만 지원합니다.' }));
    return;
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    const sql = getSql();
    let payload;
    if (url.pathname === '/api/health') {
      payload = { ok: true, service: 'steam-pulse', version: 3 };
    } else if (url.pathname === '/api/games') {
      payload = chartPayload(await chartTop(sql, 100));
    } else if (url.pathname === '/api/game-details') {
      const ids = parseIds(url.searchParams.get('ids'));
      const rows = (await Promise.all(ids.map(id => appById(sql, id)))).flat();
      payload = { games: rows.map(serializeGame), retrievedAt: new Date().toISOString() };
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'API를 찾을 수 없습니다.' }));
      return;
    }
    // 수집이 10분 주기라 5분보다 짧게 캐시할 이유가 없다. 낡은 응답은 캐시하지 않는다.
    res.setHeader('Cache-Control', payload.stale ? 'no-store' : 'public, max-age=0, s-maxage=300, stale-while-revalidate=600');
    res.end(JSON.stringify(payload));
  } catch (error) {
    res.statusCode = error.status || 503;
    res.setHeader('Cache-Control', 'no-store');
    if (!error.status) console.error('[api]', req.url, error);
    res.end(JSON.stringify({ error: error.status ? error.message : '데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' }));
  }
}
