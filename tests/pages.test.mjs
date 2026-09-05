import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

import { ROUTES, rewrites, matchRoute, decodeParam } from '../lib/routes.mjs';
import { esc, escXml, lineChart, formatDay, won, gameCell, gamePath, safeImage, layout } from '../lib/render.mjs';
import { parseGameSlug, gamePage, risingPage, sitemap, RISING_WINDOWS } from '../lib/pages.mjs';
import { serializeGame } from '../lib/http.mjs';

// DB 없이 페이지 로직을 검증한다. 쿼리 텍스트에 든 테이블 이름으로 어느 질문인지 알아내고
// 미리 정해 둔 행을 돌려준다. 어떤 쿼리가 몇 번 나갔는지도 함께 기록한다.
function fakeSql(tables = {}) {
  const calls = [];
  const sql = strings => {
    const text = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    calls.push(text);
    for (const [fragment, rows] of Object.entries(tables)) {
      if (text.includes(fragment)) return Promise.resolve(rows);
    }
    return Promise.resolve([]);
  };
  sql.calls = calls;
  return sql;
}

const app = {
  appid: 730, title: 'Counter-Strike 2', slug: '730-counter-strike-2',
  header_image: 'https://shared.fastly.steamstatic.com/steam/apps/730/header.jpg',
  short_description: '설명', release_date: '2012-08-21', release_date_text: '2012년 8월 21일',
  developers: ['Valve'], publishers: ['Valve'], genres: ['액션'], is_free: true,
  metacritic_score: null, metacritic_url: null,
  players: 900_000, peak_today: 1_200_000, rank: 1, players_at: '2026-09-05T10:00:00.000Z',
  final_price: 0, initial_price: null, discount_percent: 0, price_formatted: '무료 플레이',
  currency: 'KRW', price_at: '2026-09-05T10:00:00.000Z',
  total_positive: 8_600_000, total_negative: 1_400_000, positive_ratio: 86,
  review_desc: 'Very Positive', reviews_at: '2026-09-05T10:00:00.000Z'
};

// --- 라우팅 -----------------------------------------------------------------

test('vercel.json 의 rewrites 가 lib/routes.mjs 와 정확히 일치한다', async () => {
  // 어긋나면 "로컬은 되는데 배포하면 404" 가 난다. 사람 눈으로 잡기 어려운 종류의 사고라 테스트로 고정한다.
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.rewrites, rewrites());
});

test('matchRoute 는 모든 라우트를 잡고 끝 슬래시를 같은 페이지로 본다', () => {
  for (const route of ROUTES) {
    const path = route.source.replace(':slug', '730-cs2').replace(':genre', '액션');
    assert.equal(matchRoute(path)?.name, route.name, `${route.source} 가 매칭되지 않았다`);
  }
  assert.equal(matchRoute('/rising/')?.name, 'rising');
  assert.equal(matchRoute('/game/730-cs2/')?.name, 'game');
  assert.equal(matchRoute('/game/730/extra'), null);
  assert.equal(matchRoute('/nope'), null);
});

test('decodeParam 은 이미 디코딩된 값에 아무 일도 하지 않는다', () => {
  // 이게 깨지면 /game 정규화 301 이 자기 자신으로 무한 반복한다.
  assert.equal(decodeParam('1172470-apex-%EB%A0%88%EC%A0%84%EB%93%9C'), '1172470-apex-레전드');
  assert.equal(decodeParam('1172470-apex-레전드'), '1172470-apex-레전드');
  assert.equal(decodeParam('100%'), '100%'); // 깨진 인코딩도 던지지 않는다
  assert.equal(decodeParam(null), null);
});

test('parseGameSlug 는 appid 만 신뢰한다', () => {
  assert.equal(parseGameSlug('730-counter-strike-2'), 730);
  assert.equal(parseGameSlug('730'), 730);
  assert.equal(parseGameSlug('1172470-apex-레전드'), 1172470);
  assert.equal(parseGameSlug('abc'), null);
  assert.equal(parseGameSlug('-730'), null);
  assert.equal(parseGameSlug(''), null);
  assert.equal(parseGameSlug(null), null);
});

// --- 이스케이프 -------------------------------------------------------------

test('Steam 이 준 제목은 HTML 로 해석되지 않는다', () => {
  const evil = '<img src=x onerror="alert(1)">&"\'';
  const cell = gameCell({ appid: 1, title: evil, slug: '1-x', header_image: null, genres: [evil] });
  assert.ok(!cell.includes('<img src=x'));
  assert.ok(cell.includes('&lt;img src=x'));

  const page = layout({ title: evil, description: evil, path: '/x', body: '' });
  assert.ok(!page.includes('onerror="alert(1)"'));
  assert.equal(esc('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
  assert.equal(escXml("'"), '&apos;');
});

test('이미지는 steamstatic 이 아니면 링크하지 않는다', () => {
  assert.equal(safeImage('https://evil.example.com/x.jpg'), null);
  assert.equal(safeImage('http://cdn.steamstatic.com/x.jpg'), null); // https 만
  assert.equal(safeImage('javascript:alert(1)'), null);
  assert.ok(safeImage('https://shared.fastly.steamstatic.com/x.jpg'));
});

// --- 포맷 -------------------------------------------------------------------

test('formatDay 는 시간대를 타지 않는다', () => {
  // 발매일과 일 롤업의 day 는 달력 날짜라 Date 로 바꾸면 하루가 밀린다.
  const script = "import {formatDay} from './lib/render.mjs'; console.log(formatDay('2012-08-21'));";
  for (const tz of ['UTC', 'Asia/Seoul', 'America/New_York', 'Pacific/Auckland']) {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, TZ: tz }, encoding: 'utf8'
    }).trim();
    assert.equal(out, '2012년 8월 21일', `${tz} 에서 날짜가 밀렸다`);
  }
});

test('가격은 통화 최소단위 x100 을 되돌린다', () => {
  assert.equal(won(1_500_000), '₩15,000');
  assert.equal(won(0), '무료');
  assert.equal(won(null), null);
  assert.equal(won(undefined), null);
});

test('결측은 0 이 아니라 null 로 직렬화된다', () => {
  const bare = serializeGame({ appid: 1, title: 'x', slug: null, header_image: null, genres: null });
  assert.equal(bare.players, null);
  assert.equal(bare.positiveRatio, null);
  assert.equal(bare.reviewTotal, null);
  assert.equal(bare.price, null);
  assert.equal(bare.isFree, null);            // '무료'가 아니라 '모른다'
  assert.equal(bare.metacritic, null);
  assert.equal(bare.discount, 0);             // 할인만 0 이 기본값이다
  assert.equal(bare.path, '/game/1');         // 슬러그가 없으면 appid 로 연다

  assert.equal(serializeGame({ appid: 1, title: 'x', final_price: 0 }).isFree, true);
  assert.equal(serializeGame({ appid: 1, title: 'x', final_price: 1000 }).isFree, false);
});

// --- 차트 -------------------------------------------------------------------

test('lineChart 는 표본이 부족하면 그리지 않고 평평해도 터지지 않는다', () => {
  assert.equal(lineChart([]), null);
  assert.equal(lineChart([{ y: 5 }]), null);
  assert.equal(lineChart([{ y: 5 }, { y: null }]), null);   // null 은 표본이 아니다

  const flat = lineChart([{ y: 100 }, { y: 100 }, { y: 100 }]);
  assert.ok(flat.includes('<path'));
  assert.ok(!/NaN|Infinity/.test(flat));
});

test('lineChart 좌표는 0~100 을 벗어나지 않고 축 글자는 SVG 밖에 있다', () => {
  const svg = lineChart([{ y: 10, label: '시작' }, { y: 900 }, { y: 450, label: '끝' }]);
  const path = /class="chart-line"/.test(svg) && svg.match(/d="(M[^"]+)" class="chart-line"/)[1];
  for (const value of path.match(/-?\d+\.\d+/g).map(Number)) {
    assert.ok(value >= 0 && value <= 100, `좌표 ${value} 가 상자를 벗어났다`);
  }
  // 축 라벨을 SVG 안에 두면 preserveAspectRatio="none" 이 글자까지 늘린다.
  assert.ok(!svg.includes('<text'));
  assert.ok(svg.includes('class="chart-axis"'));
  assert.ok(svg.includes('시작') && svg.includes('끝'));
});

// --- 게임 상세 --------------------------------------------------------------

test('게임 상세는 정규 슬러그로 301 하고, 정규 주소에서는 다시 리다이렉트하지 않는다', async () => {
  const sql = fakeSql({ 'FROM apps a LEFT JOIN app_stats': [app] });

  const wrong = await gamePage(sql, { slug: '730-wrong-name' });
  assert.equal(wrong.status, 301);
  assert.equal(wrong.headers.Location, '/game/730-counter-strike-2');

  const bare = await gamePage(sql, { slug: '730' });
  assert.equal(bare.status, 301);

  const ok = await gamePage(sql, { slug: '730-counter-strike-2' });
  assert.equal(ok.status, 200);
});

test('없는 게임은 404 이며 색인되지 않는다', async () => {
  const result = await gamePage(fakeSql(), { slug: '999999' });
  assert.equal(result.status, 404);
  assert.ok(result.body.includes('noindex'));
  assert.equal((await gamePage(fakeSql(), { slug: 'abc' })).status, 404);
});

test('게임 상세는 있는 값만 구조화 데이터에 넣는다', async () => {
  const sql = fakeSql({ 'FROM apps a LEFT JOIN app_stats': [app] });
  const { body } = await gamePage(sql, { slug: '730-counter-strike-2' });
  const ld = JSON.parse(body.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  assert.equal(ld['@type'], 'VideoGame');
  assert.equal(ld.datePublished, '2012-08-21');
  assert.equal(ld.aggregateRating.ratingValue, 86);
  assert.equal(ld.aggregateRating.ratingCount, 10_000_000);

  // 리뷰가 없으면 평점을 지어내지 않는다.
  const noReviews = { ...app, positive_ratio: null, total_positive: null, total_negative: null };
  const plain = await gamePage(fakeSql({ 'FROM apps a LEFT JOIN app_stats': [noReviews] }), { slug: '730-counter-strike-2' });
  const bare = JSON.parse(plain.body.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  assert.equal(bare.aggregateRating, undefined);
});

test('표본이 하루뿐이면 신규 리뷰 긍정률을 계산하지 않는다', async () => {
  // 누적값의 차분이라 하루치로는 언제나 0 이 나온다. 0% 라고 적으면 거짓말이 된다.
  const sql = fakeSql({
    'FROM apps a LEFT JOIN app_stats': [app],
    'FROM review_daily': [{ samples: 1, new_positive: 0, new_negative: 0, from_day: '2026-09-05', to_day: '2026-09-05' }]
  });
  const { body } = await gamePage(sql, { slug: '730-counter-strike-2' });
  assert.ok(body.includes('차분 표본 부족'));
  assert.ok(!body.includes('긍정 0%'));
});

// --- 급상승 -----------------------------------------------------------------

test('급상승은 결과가 나오는 창까지 좁히고 실제로 쓴 창을 밝힌다', async () => {
  // 적재 초기에는 8일치가 없다. "24시간 대비"라고 써 놓고 3시간을 비교하면 거짓말이 된다.
  const rows = Array.from({ length: 5 }, (_, i) => ({
    appid: i + 1, title: `게임 ${i}`, slug: `${i + 1}-g`, header_image: null, genres: [],
    now_players: 200, past_players: 100, change_pct: 100, positive_ratio: 90
  }));
  let attempt = 0;
  const sql = strings => {
    if (strings.join(' ').includes('player_hourly')) return Promise.resolve(++attempt >= 3 ? rows : []);
    return Promise.resolve([]);
  };
  const { body } = await risingPage(sql);
  assert.equal(attempt, 3, '결과가 나올 때까지 창을 좁혀야 한다');
  assert.ok(body.includes(RISING_WINDOWS[2].label));
  assert.ok(!body.includes(RISING_WINDOWS[0].label));
});

test('급상승은 비교할 구간이 없으면 빈 순위를 지어내지 않는다', async () => {
  const { body, status } = await risingPage(fakeSql());
  assert.equal(status, 200);
  assert.ok(body.includes('아직 비교할 구간이 없습니다'));
  assert.ok(!body.includes('<tbody>'));
});

// --- 사이트맵 ---------------------------------------------------------------

test('사이트맵은 정적 경로·장르·게임을 모두 담고 XML 로 이스케이프한다', async () => {
  const sql = fakeSql({
    'FROM apps WHERE title IS NOT NULL': [{ appid: 730, slug: "730-it's-a-game", updated_at: '2026-09-05T10:00:00.000Z' }],
    'UNNEST(a.genres)': [{ genre: '액션', games: 3 }]
  });
  const { body, headers } = await sitemap(sql);
  assert.match(headers['Content-Type'], /application\/xml/);
  for (const path of ['/rising', '/deals', '/charts/weekly', '/genre']) {
    assert.ok(body.includes(`${path}</loc>`), `${path} 가 사이트맵에 없다`);
  }
  assert.ok(body.includes('/genre/%EC%95%A1%EC%85%98</loc>'));
  assert.ok(body.includes('<lastmod>2026-09-05</lastmod>'));
  assert.ok(!body.includes("'s-a-game"), '작은따옴표가 XML 로 이스케이프되지 않았다');
});

test('gamePath 는 경로 구분자를 만들지 않는다', () => {
  assert.equal(gamePath(730, '730-cs2'), '/game/730-cs2');
  assert.equal(gamePath(730, null), '/game/730');
  assert.ok(!gamePath(1, 'a/b').includes('a/b'));
});
