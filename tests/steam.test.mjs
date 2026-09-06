import test from 'node:test';
import assert from 'node:assert/strict';
import { createSteamService, normalizeRanks, normalizeDetails, parseChartMetadata, parseIds, safeSteamImage, normalizePlayerCount, parseStoreAppIds, currentPlayersUrl, topSellersUrl, CHART_URL, STORE_CHART_URL } from '../lib/steam.mjs';

const ranks = Array.from({ length: 100 }, (_, i) => ({ appid: i + 1, rank: i + 1, concurrent_in_game: 10000 - i * 50, peak_in_game: 15000 - i * 50 }));
const chartHtml = ranks.map(row => `<tr><td><a href="https://store.steampowered.com/app/${row.appid}/Game"><img src="https://shared.fastly.steamstatic.com/${row.appid}.jpg"><div>Game ${row.appid}</div></a></td></tr>`).join('');
const detail = { name: 'Test & Game', is_free: false, price_overview: { final: 1500000, final_formatted: '₩ 15,000', discount_percent: 50 }, metacritic: { score: 88, url: 'https://www.metacritic.com/game/test/' } };
const reviews = { success: 1, query_summary: { total_positive: 900, total_negative: 100, review_score_desc: 'Very Positive' } };
function makeFetcher({ fail = () => false, observe = () => {} } = {}) {
  return async url => {
    observe(url);
    if (fail(url)) throw new Error('Unavailable');
    if (url === CHART_URL) return Response.json({ response: { ranks, last_update: 1700000000 } });
    if (url === STORE_CHART_URL) return new Response(chartHtml);
    if (url.includes('appdetails')) { const id = new URL(url).searchParams.get('appids'); return Response.json({ [id]: { success: true, data: detail } }); }
    return Response.json(reviews);
  };
}
test('ranking sorts all results by concurrent players, removes duplicates and caps at 100', () => {
  const input = [...ranks].reverse(); input.push(ranks[0], { appid: -3, concurrent_in_game: 99999 }, { appid: 200, concurrent_in_game: 1 });
  const output = normalizeRanks({ ranks: input });
  assert.equal(output.length, 100); assert.equal(output[0].appid, 1); assert.equal(output[99].rank, 100);
  assert.equal(normalizeRanks({ ranks: [{ appid: 1 }] })[0].players, null);
  assert.throws(() => normalizeRanks({ ranks: [] }));
});
test('metadata parser does not depend on CSS classes and decodes titles', () => {
  const parsed = parseChartMetadata('<tr><td><a href="https://store.steampowered.com/app/5/a"><img src="https://shared.fastly.steamstatic.com/image.jpg"><div>A &amp; B &#39;test&#39;</div></a></td></tr>');
  assert.equal(parsed.get(5).title, "A & B 'test'"); assert.ok(parsed.get(5).headerImage);
  assert.equal(safeSteamImage('https://steamstatic.com.evil.test/image'), null);
  assert.equal(safeSteamImage('javascript:alert(1)'), null);
});
test('missing data stays null; no review count or critic score is fabricated', () => {
  const game = normalizeDetails(1, null, null);
  assert.equal(game.price, null); assert.equal(game.positiveRatio, null); assert.equal(game.metacritic, null); assert.equal(game.isFree, null);
  assert.equal(normalizeDetails(1, { is_free: true }, { query_summary: { total_positive: 0, total_negative: 0 } }).positiveRatio, null);
  assert.equal(normalizeDetails(1, { is_free: true }, null).price, 0);
  const valid = normalizeDetails(1, detail, reviews);
  assert.equal(valid.metacritic.score, 88); assert.equal(valid.positiveRatio, 90); assert.equal(valid.reviewTotal, 1000);
  assert.equal(normalizeDetails(1, { metacritic: { score: 90, url: 'javascript:alert(1)' } }, null).metacritic.url, null);
});
test('batch validation rejects malformed IDs and more than one page', () => {
  for (const value of ['', '-1', '1.5', '1,', '0', 'abc', Array.from({ length: 21 }, (_, i) => i + 1).join(',')]) assert.throws(() => parseIds(value), { status: 400 });
  assert.deepEqual(parseIds('1,2,2'), [1, 2]);
});
test('requests share in-flight work and cached results', async () => {
  let count = 0;
  const service = createSteamService({ fetcher: makeFetcher({ observe: () => count++ }) });
  const [first, second] = await Promise.all([service.getChart(), service.getChart()]);
  assert.equal(first.games.length, 100); assert.equal(second.games[99].title, 'Game 100'); assert.equal(count, 2);
  await Promise.all([service.getDetails([1]), service.getDetails([1])]);
  assert.equal(count, 4); await service.getDetails([1]); assert.equal(count, 4);
  await assert.rejects(service.getDetails([999]), { status: 400 });
});
test('stale chart fallback preserves original timestamps; cold failure rejects', async () => {
  let time = 1700000000000; let failing = false;
  const fetcher = makeFetcher({ fail: url => failing && url === CHART_URL });
  const service = createSteamService({ fetcher, now: () => time });
  const first = await service.getChart(); time += 61000; failing = true;
  const stale = await service.getChart(); assert.equal(stale.stale, true); assert.equal(stale.retrievedAt, first.retrievedAt);
  assert.equal((await service.getChart()).stale, true);
  time += 3600000; await assert.rejects(service.getChart());
  await assert.rejects(createSteamService({ fetcher }).getChart());
});
test('partial detail failures do not lose the game or pretend to be connected', async () => {
  const service = createSteamService({ fetcher: makeFetcher({ fail: url => url.includes('appdetails') }) });
  const { games } = await service.getDetails([1, 2]);
  assert.equal(games.length, 2); assert.equal(games[0].positiveRatio, 90); assert.equal(games[0].metacritic, null);
  assert.equal(games[0].sources.details.status, 'unavailable'); assert.equal(games[0].sources.reviews.status, 'ok');
});
test('concurrent page visitors never exceed eight upstream requests', async () => {
  let active = 0, maximum = 0;
  const base = makeFetcher();
  const service = createSteamService({ fetcher: async url => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 3));
    try { return await base(url); } finally { active--; }
  } });
  await Promise.all([service.getDetails(ranks.slice(0, 20).map(row => row.appid)), service.getDetails(ranks.slice(20, 40).map(row => row.appid))]);
  assert.ok(maximum <= 8, `maximum: ${maximum}`);
});

// --- 차트 밖 게임 추적 (커버리지 200개) ---------------------------------------

test('동접 응답은 result 가 1 일 때만 값으로 인정한다', () => {
  // result 가 1 이 아닌데 player_count 를 읽으면 0 이 들어오고, 그 0 은 화면에서
  // '아무도 안 한다'로 읽힌다. 결측을 0 으로 만들지 않는다는 규율이 여기에도 걸린다.
  assert.equal(normalizePlayerCount({ response: { player_count: 634241, result: 1 } }), 634241);
  assert.equal(normalizePlayerCount({ response: { player_count: 0, result: 1 } }), 0);
  assert.equal(normalizePlayerCount({ response: { player_count: 42, result: 42 } }), null);
  assert.equal(normalizePlayerCount({ response: {} }), null);
  assert.equal(normalizePlayerCount(null), null);
  assert.match(currentPlayersUrl(730), /appid=730$/);
});

test('스토어 판매 상위에서 appid 만 뽑고 번들은 빼놓는다', () => {
  const html = '<a data-ds-appid="730" data-ds-tagids="[1]">CS</a>' +
    '<a data-ds-bundleid="12345">번들</a>' +
    '<a data-ds-appid="570">Dota</a>' +
    '<a data-ds-appid="730">중복</a>';
  assert.deepEqual(parseStoreAppIds({ results_html: html }), [730, 570]);
  assert.deepEqual(parseStoreAppIds({ results_html: html }, 1), [730]);
  // 응답이 깨져도 던지지 않는다 — 이 잡이 실패하면 로스터만 안 늘어나면 된다.
  assert.deepEqual(parseStoreAppIds(null), []);
  assert.deepEqual(parseStoreAppIds({}), []);
  assert.match(topSellersUrl(2), /start=100/);
});
