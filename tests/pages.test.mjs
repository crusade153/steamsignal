import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

import { ROUTES, rewrites, matchRoute, decodeParam } from '../lib/routes.mjs';
import { esc, escXml, lineChart, formatDay, won, gameCell, gamePath, safeImage, layout, adSlot, dataTable, COL } from '../lib/render.mjs';
import {
  parseGameSlug, gamePage, gameReviewsPage, reviewDeltas, risingPage, sitemap, genrePage,
  monthlyPage, dealsLowPage, genreFreePage, genreDiscountedPage, releasePage,
  RISING_WINDOWS, MIN_COMBO_GAMES
} from '../lib/pages.mjs';
import { serializeGame } from '../lib/http.mjs';
import { LEGAL_HANDLERS } from '../lib/legal.mjs';

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
    const path = route.source.replace(':slug', '730-cs2').replace(':genre', '액션').replace(':year', '2024');
    assert.equal(matchRoute(path)?.name, route.name, `${route.source} 가 매칭되지 않았다`);
  }
  assert.equal(matchRoute('/rising/')?.name, 'rising');
  assert.equal(matchRoute('/game/730-cs2/')?.name, 'game');
  assert.equal(matchRoute('/game/730/extra'), null);
  assert.equal(matchRoute('/nope'), null);

  // 하위 경로가 상위 라우트에 먹히면 /game/730/reviews 가 게임 상세로 떨어져
  // '730/reviews' 를 슬러그로 읽고 404 를 낸다. 배포에서만 보이는 종류의 사고다.
  assert.equal(matchRoute('/game/730-cs2/reviews')?.name, 'gameReviews');
  assert.equal(matchRoute('/genre/액션/free')?.name, 'genreFree');
  assert.equal(matchRoute('/genre/액션/discounted')?.name, 'genreDiscounted');
  assert.equal(matchRoute('/deals/all-time-low')?.name, 'dealsLow');
  assert.equal(matchRoute('/releases/2024')?.name, 'release');
  // 연도가 아닌 값은 라우트 단계에서 막는다 — 안 그러면 크롤러가 URL 을 무한히 만들어 낸다.
  assert.equal(matchRoute('/releases/abcd'), null);
  assert.equal(matchRoute('/releases/24'), null);
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
    // 급상승 쿼리만 센다. player_hourly 는 스파크라인도 읽으므로 테이블 이름으로 세면
    // 창을 좁힌 횟수가 아니라 '그 테이블을 몇 번 봤나'를 세게 된다.
    if (strings.join(' ').includes('WITH recent AS')) return Promise.resolve(++attempt >= 3 ? rows : []);
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

// --- 리뷰 추이 ---------------------------------------------------------------

test('리뷰 차분은 음수를 만들지 않고 빠진 날을 지어내지 않는다', () => {
  // Steam 은 이미 쓴 리뷰를 지울 수 있다. 그대로 빼면 "신규 리뷰 -12개" 가 화면에 나간다.
  const deltas = reviewDeltas([
    { day: '2026-09-01', total_positive: 100, total_negative: 10 },
    { day: '2026-09-02', total_positive: 120, total_negative: 12 },
    // 하루 걸렀다 — 없는 날을 0 으로 채우지 않고 구간이 넓어질 뿐이다.
    { day: '2026-09-04', total_positive: 110, total_negative: 20 }
  ]);
  assert.equal(deltas.length, 2);
  assert.deepEqual(
    { positive: deltas[0].positive, negative: deltas[0].negative, ratio: deltas[0].ratio },
    { positive: 20, negative: 2, ratio: 91 }
  );
  assert.equal(deltas[1].positive, 0, '리뷰가 지워져도 음수가 되지 않는다');
  assert.equal(deltas[1].from, '2026-09-02', '빠진 날은 앞 기록까지의 구간이 된다');
  assert.equal(deltas[1].negative, 8);
});

test('리뷰 추이는 표본이 얇으면 색인되지 않는다', async () => {
  const one = fakeSql({
    'FROM apps a LEFT JOIN app_stats': [app],
    'FROM review_daily': [{ day: '2026-09-05', total_positive: 100, total_negative: 10 }]
  });
  const thin = await gameReviewsPage(one, { slug: '730-counter-strike-2' });
  assert.equal(thin.status, 200, '데이터가 얇다고 404 를 내면 나중에 쌓여도 그 404 가 남는다');
  assert.ok(thin.body.includes('name="robots" content="noindex'));
  assert.ok(thin.body.includes('아직 비교할 구간이 없습니다'));

  const days = Array.from({ length: 5 }, (_, i) => ({
    day: `2026-09-0${i + 1}`, total_positive: 100 + i * 30, total_negative: 10 + i
  }));
  const rich = await gameReviewsPage(fakeSql({
    'FROM apps a LEFT JOIN app_stats': [app],
    'FROM review_daily': days
  }), { slug: '730-counter-strike-2' });
  assert.ok(!rich.body.includes('name="robots"'), '표본이 쌓이면 색인 대상이다');
  assert.ok(rich.body.includes('rel="canonical" href="http://127.0.0.1:5174/game/730-counter-strike-2/reviews"'));
});

test('리뷰 추이도 정규 슬러그로 301 한다', async () => {
  const sql = fakeSql({ 'FROM apps a LEFT JOIN app_stats': [app] });
  const moved = await gameReviewsPage(sql, { slug: '730' });
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.Location, '/game/730-counter-strike-2/reviews');
});

// --- 표 ---------------------------------------------------------------------

test('모든 td 는 data-label 을 달고 나온다 — 좁은 화면에서 그게 열 이름이 된다', () => {
  // 720px 아래에서 표는 카드가 되고 thead 가 숨는다(public/styles.css §7).
  // 그때 data-label 이 없으면 라벨 없는 숫자만 남는다. 눈으로는 데스크톱에서 멀쩡해 보여서
  // 이 회귀는 모바일에서만 드러난다 — 그래서 서버 쪽에서 못을 박아 둔다.
  const html = dataTable(
    [COL.rank(), COL.game(), COL.players(), COL.review(), COL.meta(), COL.price(),
      { cellClass: 'action-cell', cell: () => '<button>빼기</button>' }],
    [{ appid: 730, title: 'CS2', slug: '730-cs2', header_image: null, genres: ['액션'], players: 900_000, positive_ratio: 86, total_positive: 86, total_negative: 14, metacritic_score: 83, final_price: 1_500_000, initial_price: 3_000_000 }]
  );
  const cells = html.match(/<td[^>]*>/g);
  assert.equal(cells.length, 7);
  // 라벨을 준 여섯 열에는 붙고, 동작 버튼 열에는 붙지 않는다.
  assert.equal(cells.filter(cell => cell.includes('data-label=')).length, 6);
  assert.ok(cells[0].includes('data-label="순위"'));
  assert.ok(cells[1].includes('class="game-cell"'), '게임 칸은 카드의 제목이라 별도 클래스를 갖는다');
  assert.ok(!cells[6].includes('data-label='), '버튼 열에 라벨을 붙이면 카드에 빈 제목이 생긴다');
  // 헤더는 숨겨질 뿐 사라지지 않는다 — 스크린리더와 크롤러는 그대로 읽는다.
  assert.equal((html.match(/<th /g) || []).length, 7);
});

test('표의 열 라벨도 esc() 를 통과한다', () => {
  const html = dataTable([{ label: '<img src=x>', cell: () => 'x' }], [{}]);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('data-label="&lt;img src=x&gt;"'));
});

// --- 파생 목록 ---------------------------------------------------------------

test('월간 차트는 30일 창을 쓰고 주간과 다른 주소를 갖는다', async () => {
  const rows = [{
    appid: 730, title: 'CS2', slug: '730-cs2', header_image: null, genres: [],
    avg_players: 800_000, peak_players: 1_000_000, best_rank: 1, days: 30, samples: 4000,
    positive_ratio: 86, current_rank: 1, current_players: 900_000
  }];
  const { body } = await monthlyPage(fakeSql({ 'FROM player_daily': rows }));
  assert.ok(body.includes('rel="canonical" href="http://127.0.0.1:5174/charts/monthly"'));
  assert.ok(body.includes('월간 평균 동접'));
  assert.ok(body.includes('href="/charts/weekly"'), '두 차트는 서로를 가리켜야 한다');
});

test('역대 최저가는 판정 근거와 한계를 함께 적는다', async () => {
  const rows = [{
    appid: 730, title: 'CS2', slug: '730-cs2', header_image: null, genres: [], metacritic_score: null,
    final_price: 1_000_000, initial_price: 2_000_000, discount_percent: 50, price_formatted: '₩10,000',
    positive_ratio: 86, total_positive: 100, total_negative: 10, players: 1000, rank: 1,
    lowest_price: 1_000_000, observations: 4, first_seen: '2026-08-01T00:00:00.000Z'
  }];
  const { body } = await dealsLowPage(fakeSql({ 'FROM app_stats s JOIN apps a USING (appid) JOIN lows': rows }));
  assert.ok(body.includes('역대 최저가'));
  assert.ok(body.includes('기록을 시작한 이후'), '"역대" 의 범위를 밝혀야 한다');

  const empty = await dealsLowPage(fakeSql());
  assert.equal(empty.status, 200);
  assert.ok(empty.body.includes('아직 역대 최저가로 판정할 게임이 없습니다'));
});

test('조합 페이지는 게임이 적으면 만들지 않는다', async () => {
  const make = n => Array.from({ length: n }, (_, i) => ({
    appid: i + 1, title: `게임 ${i}`, slug: `${i + 1}-g`, header_image: null, genres: ['액션'],
    metacritic_score: null, players: 100, positive_ratio: 90, total_positive: 90, total_negative: 10,
    final_price: 0, discount_percent: 0, is_free: true
  }));

  const thin = await genreFreePage(fakeSql({ 'is_free IS TRUE': make(MIN_COMBO_GAMES - 1) }), { genre: '액션' });
  assert.equal(thin.status, 404, '얇은 조합 페이지는 색인에 손해다');

  const ok = await genreFreePage(fakeSql({ 'is_free IS TRUE': make(MIN_COMBO_GAMES) }), { genre: '액션' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.includes('rel="canonical" href="http://127.0.0.1:5174/genre/%EC%95%A1%EC%85%98/free"'));

  const sale = await genreDiscountedPage(fakeSql({ 's.discount_percent > 0': make(MIN_COMBO_GAMES) }), { genre: '액션' });
  assert.equal(sale.status, 200);
  assert.ok(sale.body.includes('할인 중인 액션 게임'));
});

test('장르 페이지는 실제로 열리는 조합만 링크한다', async () => {
  // 링크와 페이지의 판정 기준이 다르면 "눌렀더니 404" 가 생긴다.
  const rows = Array.from({ length: 6 }, (_, i) => ({
    appid: i + 1, title: `게임 ${i}`, slug: `${i + 1}-g`, header_image: null, genres: ['액션'],
    metacritic_score: null, players: 100, positive_ratio: 90, total_positive: 90, total_negative: 10,
    // 무료는 6개(기준 충족), 할인은 1개(기준 미달)
    final_price: 0, discount_percent: i === 0 ? 30 : 0, is_free: true
  }));
  const { body } = await genrePage(fakeSql({ 'a.genres @> ARRAY': rows }), { genre: '액션' });
  assert.ok(body.includes('/free">무료 6개'));
  assert.ok(!body.includes('/discounted"'), '기준에 못 미치는 조합은 링크하지 않는다');
});

test('목록이 상한에 닿으면 링크에 개수를 적지 않는다', async () => {
  // 개수는 받아 온 60개 안에서 센 값이다. 장르에 게임이 61개 있으면 실제보다 적게 나온다.
  // 틀린 숫자를 적느니 안 적는다.
  const many = Array.from({ length: 60 }, (_, i) => ({
    appid: i + 1, title: `게임 ${i}`, slug: `${i + 1}-g`, header_image: null, genres: ['액션'],
    metacritic_score: null, players: 100, positive_ratio: 90, total_positive: 90, total_negative: 10,
    final_price: 0, discount_percent: 0, is_free: true
  }));
  const { body } = await genrePage(fakeSql({ 'a.genres @> ARRAY': many }), { genre: '액션' });
  assert.ok(body.includes('/free">무료</a>'), '상한에 닿으면 숫자를 뺀다');
  assert.ok(!/무료 \d+개/.test(body));
});

test('발매 연도는 네 자리 숫자만 받는다', async () => {
  const rows = [{
    appid: 730, title: 'CS2', slug: '730-cs2', header_image: null, genres: [], metacritic_score: null,
    release_date: '2012-08-21', players: 900_000, positive_ratio: 86,
    total_positive: 100, total_negative: 10, final_price: 0, discount_percent: 0
  }];
  const sql = fakeSql({ 'EXTRACT(YEAR FROM a.release_date)': rows });
  const { status, body } = await releasePage(sql, { year: '2012' });
  assert.equal(status, 200);
  assert.ok(body.includes('2012년에 나온 게임'));
  assert.ok(body.includes('2012년 8월 21일'), '발매일은 시간대를 타지 않는 문자열이어야 한다');

  assert.equal((await releasePage(sql, { year: 'abcd' })).status, 404);
  assert.equal((await releasePage(sql, { year: '1200' })).status, 404);
});

// --- 사이트맵 ---------------------------------------------------------------

test('사이트맵은 정적 경로·장르·게임을 모두 담고 XML 로 이스케이프한다', async () => {
  const sql = fakeSql({
    'FROM apps WHERE title IS NOT NULL': [{ appid: 730, slug: "730-it's-a-game", updated_at: '2026-09-05T10:00:00.000Z' }],
    'UNNEST(a.genres)': [{ genre: '액션', games: 3 }]
  });
  const { body, headers } = await sitemap(sql);
  assert.match(headers['Content-Type'], /application\/xml/);
  for (const path of ['/rising', '/deals', '/deals/all-time-low', '/charts/weekly', '/charts/monthly', '/genre', '/releases']) {
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

test('링크 공유용 og:image 는 어느 페이지에도 빠지지 않는다', () => {
  // 게임 페이지는 Steam 헤더를, 나머지는 브랜드 카드를 쓴다.
  const withImage = layout({ title: 't', description: 'd', path: '/x', image: 'https://shared.fastly.steamstatic.com/h.jpg', body: '' });
  assert.ok(withImage.includes('content="https://shared.fastly.steamstatic.com/h.jpg"'));

  const withoutImage = layout({ title: 't', description: 'd', path: '/rising', body: '' });
  assert.match(withoutImage, /og:image" content="[^"]+\/og-cover\.png"/);

  // 외부 이미지가 섞여 들어와도 남의 서버를 가리키지 않는다.
  const hostile = layout({ title: 't', description: 'd', path: '/x', image: 'https://evil.example.com/x.jpg', body: '' });
  assert.ok(!hostile.includes('evil.example.com'));
  assert.match(hostile, /og:image" content="[^"]+\/og-cover\.png"/);
});

// --- P1 고정 문서 · 광고 -----------------------------------------------------

test('법적 문서 3종은 색인 가능하고 canonical 을 갖는다', () => {
  // 애드센스 심사가 실제로 확인하는 페이지들이다. noindex 가 붙으면 심사에서 못 본다.
  for (const [name, path] of [['privacy', '/privacy'], ['terms', '/terms'], ['contact', '/contact']]) {
    const { status, body, headers } = LEGAL_HANDLERS[name]();
    assert.equal(status, 200, `${path} 가 200 이 아니다`);
    assert.match(headers['Content-Type'], /text\/html/);
    assert.ok(body.includes(`rel="canonical" href="http`), `${path} 에 canonical 이 없다`);
    assert.ok(!body.includes('name="robots"'), `${path} 는 색인돼야 한다`);
    assert.equal(body.match(/<h1>/g).length, 1, `${path} 의 h1 은 하나여야 한다`);
  }
});

test('법적 문서는 사이트맵에도 실린다', async () => {
  const { body } = await sitemap(fakeSql());
  for (const path of ['/privacy', '/terms', '/contact']) {
    assert.ok(body.includes(`${path}</loc>`), `${path} 가 사이트맵에 없다`);
  }
  // 위시리스트는 사람마다 다른 화면이라 색인 대상이 아니다.
  assert.ok(!body.includes('/watchlist</loc>'));
});

test('위시리스트 페이지는 색인되지 않고 캐시되지 않는다', () => {
  const { status, body, headers } = LEGAL_HANDLERS.watchlist();
  assert.equal(status, 200);
  assert.equal(headers['Cache-Control'], 'no-store', 'CDN 이 남의 화면을 캐시하면 안 된다');
  assert.ok(body.includes('noindex'));
  assert.ok(body.includes('/watchlist.js'));
});

test('ads.txt 는 게시자 ID 가 있을 때만 존재한다', async () => {
  // 내용이 틀린 ads.txt 는 없는 것보다 나쁘다 — 정상 광고 요청까지 거부된다.
  const off = LEGAL_HANDLERS.ads();
  assert.equal(off.status, 404);

  const script = `
    process.env.ADSENSE_PUBLISHER_ID = 'ca-pub-1234567890123456';
    const { adsTxt } = await import('./lib/legal.mjs');
    const r = adsTxt();
    console.log(JSON.stringify({ status: r.status, body: r.body }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8'
  }).trim());
  assert.equal(out.status, 200);
  assert.equal(out.body, 'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n');
});

test('광고 슬롯은 게시자 ID 가 없으면 자리조차 잡지 않는다', () => {
  assert.equal(adSlot('123'), '');
  assert.equal(adSlot(undefined), '');
});

test('광고 슬롯은 높이를 미리 예약한다 (CLS 방어)', () => {
  // 광고가 늦게 로드되며 아래 내용을 밀어내면 CLS 가 무너지고 사용자가 누르려던 링크가 어긋난다.
  const script = `
    process.env.ADSENSE_PUBLISHER_ID = 'ca-pub-1234567890123456';
    const { adSlot } = await import('./lib/render.mjs');
    console.log(adSlot('9876543210', { minHeight: 280 }));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8'
  });
  assert.match(out, /min-height:280px/);
  assert.match(out, /data-ad-client="ca-pub-1234567890123456"/);
  assert.match(out, /data-ad-slot="9876543210"/);
});

test('분석 스크립트는 명시적으로 켰을 때만 나간다', () => {
  // /_vercel/insights/script.js 는 대시보드에서 Web Analytics 를 켠 프로젝트에만 존재한다.
  // 켜지 않은 채 태그를 내보내면 방문자마다 404 요청이 하나씩 나간다.
  const render = env => execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { layout } = await import('./lib/render.mjs');
     console.log(layout({ title: 't', description: 'd', path: '/x', body: '' }).includes('_vercel/insights'));`],
  { cwd: new URL('..', import.meta.url), encoding: 'utf8', env }).trim();

  assert.equal(render({ ...process.env, VERCEL_WEB_ANALYTICS: undefined }), 'false');
  assert.equal(render({ ...process.env, VERCEL: '1', VERCEL_WEB_ANALYTICS: undefined }), 'false',
    '배포 환경이라는 것만으로는 켜지지 않는다 — 대시보드 토글이 먼저다');
  assert.equal(render({ ...process.env, VERCEL_WEB_ANALYTICS: '1' }), 'true');
});

test('모든 페이지 하단에 방침·약관·문의 링크가 있다', () => {
  // 애드센스 심사는 이 링크들이 사이트 전역에서 닿는지를 본다.
  const page = layout({ title: 't', description: 'd', path: '/x', body: '' });
  for (const href of ['/privacy', '/terms', '/contact']) {
    assert.ok(page.includes(`href="${href}"`), `푸터에 ${href} 링크가 없다`);
  }
});

test('DB 를 읽지 않는 페이지는 DATABASE_URL 이 없어도 뜬다', async () => {
  // 방침·약관·문의·위시리스트 껍데기는 질의가 없다. 라우터가 클라이언트를 미리 만들면
  // DATABASE_URL 이 없는 환경에서 이 페이지들까지 503 이 된다.
  const script = `
    delete process.env.DATABASE_URL;
    const { lazySql } = await import('./lib/db.mjs');
    const { HANDLERS } = await import('./lib/pages.mjs');
    const out = {};
    for (const name of ['privacy', 'terms', 'contact', 'watchlist', 'ads']) {
      out[name] = (await HANDLERS[name](lazySql(), {})).status;
    }
    // 반대로 DB 가 필요한 페이지는 여기서 던져야 한다 — 조용히 빈 화면을 내면 안 된다.
    out.gameThrows = await HANDLERS.game(lazySql(), { slug: '730' }).then(() => false, () => true);
    console.log(JSON.stringify(out));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8'
  }).trim());
  assert.deepEqual(out, { privacy: 200, terms: 200, contact: 200, watchlist: 200, ads: 404, gameThrows: true });
});
