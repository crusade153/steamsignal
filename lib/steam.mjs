const MINUTE = 60_000;
export const CHART_URL = 'https://api.steampowered.com/ISteamChartsService/GetGamesByConcurrentPlayers/v1/';
export const STORE_CHART_URL = 'https://store.steampowered.com/charts/mostplayed?l=koreana&cc=kr';
// 지역/언어 파라미터는 가격의 통화를 결정한다. API 서버와 수집기가 어긋나면 안 되므로 한곳에서만 만든다.
export const appDetailsUrl = appid => `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=kr&l=koreana`;
export const appReviewsUrl = appid => `https://store.steampowered.com/appreviews/${appid}?json=1&language=all&num_per_page=1&filter=all&purchase_type=all`;

export class ServiceError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function normalizeRanks(response) {
  if (!Array.isArray(response?.ranks) || !response.ranks.length) throw new ServiceError('Steam 인기 순위를 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  const seen = new Set();
  return response.ranks.filter(row => {
    if (!Number.isSafeInteger(row.appid) || row.appid <= 0 || seen.has(row.appid)) return false;
    seen.add(row.appid); return true;
  }).map(row => ({ appid: row.appid, players: numberOrNull(row.concurrent_in_game), peakToday: numberOrNull(row.peak_in_game) }))
    .sort((a, b) => (b.players ?? -1) - (a.players ?? -1) || a.appid - b.appid)
    .slice(0, 100).map((row, i) => ({ ...row, rank: i + 1 }));
}

function decodeText(text) {
  return text.replace(/<[^>]*>/g, '').replace(/&#(x[\da-f]+|\d+);/gi, (_, code) => {
    const value = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return value <= 0x10ffff ? String.fromCodePoint(value) : '';
  }).replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, entity) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[entity]).trim();
}

// Names/capsules are presentation metadata from Steam's public chart, not a second ranking.
// Use semantic table rows and app links, never generated CSS class names.
export function parseChartMetadata(html) {
  const result = new Map();
  for (const row of html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    for (const link of row.matchAll(/<a\b[^>]*href="https:\/\/store\.steampowered\.com\/app\/(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const name = decodeText(link[2]);
      if (!name) continue;
      const image = link[2].match(/<img\b[^>]*src="([^"]+)"/i)?.[1];
      result.set(Number(link[1]), { title: name, headerImage: safeSteamImage(image ? decodeText(image) : null) });
    }
  }
  return result;
}

export function safeSteamImage(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && /(^|\.)steamstatic\.com$/.test(url.hostname) ? url.href : null; } catch { return null; }
}
function metacriticUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && /(^|\.)metacritic\.com$/.test(url.hostname) ? url.href.replace(/^http:/, 'https:') : null; } catch { return null; }
}

export function normalizeDetails(appid, detail, reviews) {
  const summary = reviews?.query_summary;
  const positive = numberOrNull(summary?.total_positive);
  const negative = numberOrNull(summary?.total_negative);
  const total = positive !== null && negative !== null ? positive + negative : null;
  const score = numberOrNull(detail?.metacritic?.score);
  return {
    appid, title: detail?.name || null, headerImage: safeSteamImage(detail?.header_image),
    description: detail?.short_description ? decodeText(detail.short_description) : null,
    genres: (detail?.genres || []).map(item => item.description).filter(value => typeof value === 'string'),
    releaseDate: detail?.release_date?.date || null, developers: detail?.developers || [],
    isFree: detail ? Boolean(detail.is_free) : null,
    price: detail?.is_free ? 0 : numberOrNull(detail?.price_overview?.final),
    priceFormatted: detail?.is_free ? '무료 플레이' : detail?.price_overview?.final_formatted || null,
    originalPrice: detail?.price_overview?.initial_formatted || null,
    discount: detail ? numberOrNull(detail.price_overview?.discount_percent) ?? 0 : null,
    reviewTotal: total, positiveRatio: total > 0 ? Math.round(positive / total * 100) : null,
    reviewLabel: summary?.review_score_desc || null,
    metacritic: score !== null && score > 0 && score <= 100 ? { score, url: metacriticUrl(detail.metacritic.url) } : null
  };
}

export function parseIds(value) {
  const parts = (value || '').split(',');
  if (!value || parts.length > 20 || parts.some(id => !/^[1-9]\d{0,9}$/.test(id))) throw new ServiceError('게임 ID를 1~20개 지정해 주세요.', 400);
  return [...new Set(parts.map(Number))];
}

export function createSteamService({ fetcher = fetch, now = Date.now, timeoutMs = 7000 } = {}) {
  const cache = new Map();
  const pending = new Map();
  let active = 0;
  const queue = [];
  async function limited(task) {
    if (active >= 8) await new Promise(resolve => queue.push(resolve));
    else active++;
    try { return await task(); }
    finally { const next = queue.shift(); if (next) next(); else active--; }
  }
  async function request(url, json = true) {
    return limited(async () => {
      const response = await fetcher(url, { headers: { 'User-Agent': 'SteamPulse/2.0', Accept: json ? 'application/json' : 'text/html' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`Steam HTTP ${response.status}`);
      return json ? response.json() : response.text();
    });
  }
  async function cached(key, ttl, loader, maxStale = 60 * MINUTE) {
    const previous = cache.get(key);
    if (previous?.retryAt > now() && previous.expires <= now()) {
      if (previous.data && now() - previous.at <= maxStale) return { ...previous, stale: true };
      throw new ServiceError('Steam 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.');
    }
    if (previous?.expires > now()) return { ...previous, stale: false };
    if (pending.has(key)) return pending.get(key);
    const job = (async () => {
      try {
        const data = await loader();
        const entry = { data, at: now(), expires: now() + ttl };
        cache.set(key, entry);
        if (cache.size > 1200) cache.delete(cache.keys().next().value);
        return { ...entry, stale: false };
      } catch (error) {
        cache.set(key, { ...previous, retryAt: now() + 30_000, expires: 0 });
        if (previous?.data && now() - previous.at <= maxStale) return { ...previous, stale: true };
        throw error;
      } finally { pending.delete(key); }
    })();
    pending.set(key, job); return job;
  }
  const stamp = entry => ({ status: entry ? entry.stale ? 'stale' : 'ok' : 'unavailable', retrievedAt: entry ? new Date(entry.at).toISOString() : null });
  async function getChart() {
    const [ranking, metadata] = await Promise.all([
      cached('chart', MINUTE, async () => {
        const data = (await request(CHART_URL)).response;
        const games = normalizeRanks(data);
        if (!games.length) throw new ServiceError('Steam 순위 응답에 게임이 없습니다.');
        return { games, updatedAt: Number.isFinite(data.last_update) ? new Date(data.last_update * 1000).toISOString() : new Date(now()).toISOString() };
      }),
      cached('names', 10 * MINUTE, async () => {
        const names = parseChartMetadata(await request(STORE_CHART_URL, false));
        if (!names.size) throw new Error('Steam chart metadata unavailable');
        return names;
      }).catch(() => null)
    ]);
    return {
      games: ranking.data.games.map(game => ({ ...game, ...(metadata?.data.get(game.appid) || { title: `Steam 앱 ${game.appid}`, headerImage: null }) })),
      total: ranking.data.games.length, updatedAt: ranking.data.updatedAt,
      retrievedAt: new Date(ranking.at).toISOString(), stale: ranking.stale,
      sources: { chart: stamp(ranking), names: stamp(metadata) },
      rankingBasis: 'current_players', refreshAfterSeconds: 60
    };
  }
  async function getDetails(ids) {
    const chart = await getChart();
    const allowed = new Set(chart.games.map(game => game.appid));
    if (ids.some(id => !allowed.has(id))) throw new ServiceError('현재 TOP 100에 없는 게임입니다. 순위를 새로고침해 주세요.', 400);
    const games = await Promise.all(ids.map(async appid => {
      const [detail, review] = await Promise.all([
        cached(`detail:${appid}`, 30 * MINUTE, async () => {
          const data = (await request(appDetailsUrl(appid)))[appid];
          if (!data?.success || !data.data) throw new Error('Store details unavailable');
          return data.data;
        }).catch(() => null),
        cached(`review:${appid}`, 10 * MINUTE, async () => {
          const data = await request(appReviewsUrl(appid));
          if (data.success !== 1 || !data.query_summary) throw new Error('Reviews unavailable');
          return data;
        }).catch(() => null)
      ]);
      return { ...normalizeDetails(appid, detail?.data, review?.data), sources: { details: stamp(detail), reviews: stamp(review) } };
    }));
    return { games, retrievedAt: new Date(now()).toISOString() };
  }
  return { getChart, getDetails };
}

export const steam = createSteamService();
