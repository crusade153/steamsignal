// Game Pass 층위 테스트.
//
// 이 층위가 틀리는 방식은 셋이고 전부 화면이 멀쩡한 채로 일어난다.
//   1. 첫 수집에서 728개를 전부 '오늘 입점'이라고 적는다 — 기록이 아니라 거짓말이 된다.
//   2. 요청이 막혀 빈 목록을 받고 728개를 전부 '퇴점'으로 기록한다 — 복구되지 않는다.
//   3. 산문에서 설명 문단을 게임 제목으로 읽는다 — 없는 게임의 입점 예정이 뜬다.
// 셋 다 여기서 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffCatalog, normalizeProduct, parseAnnouncement, parseWirePost,
  resolveAnnouncedDate, createGamePassService, SIGLS, DETAIL_BATCH
} from '../lib/gamepass.mjs';
import { createCollector } from '../lib/collect.mjs';

const product = (id, title, releaseDate) => ({
  ProductId: id,
  LocalizedProperties: [{ ProductTitle: title, DeveloperName: '개발사', Images: [{ ImagePurpose: 'Poster', Uri: '//img/x.png' }] }],
  MarketProperties: [{ OriginalReleaseDate: releaseDate }]
});

test('첫 수집은 기준선만 잡고 입점을 만들지 않는다', () => {
  const current = [{ productId: 'A' }, { productId: 'B' }];
  const result = diffCatalog({ previous: [], current, baseline: true });
  assert.deepEqual(result.added, [], '처음 본 목록을 전부 오늘 입점이라고 적으면 거짓 기록이 된다');
  assert.deepEqual(result.removed, []);
  assert.equal(result.baseline, true);
});

test('두 번째부터 어제와 비교해 입점·퇴점을 만든다', () => {
  const result = diffCatalog({
    previous: ['A', 'B', 'C'],
    current: [{ productId: 'B' }, { productId: 'C' }, { productId: 'D' }]
  });
  assert.deepEqual(result.added, ['D']);
  assert.deepEqual(result.removed, ['A']);
});

test('자리표시자 출시일은 날짜로 쓰지 않는다', () => {
  // 실측: 콘솔 카탈로그 558건 중 25건이 9998-12-30 이었다.
  assert.equal(normalizeProduct(product('A', '게임', '9998-12-30T00:00:00Z'), { today: '2026-09-07' }).releaseDate, null);
  assert.equal(normalizeProduct(product('B', '게임', '2024-08-29T15:00:00Z'), { today: '2026-09-07' }).releaseDate, '2024-08-29');
  // 제목이 없는 상품은 아예 버린다. 이름 없는 행을 화면에 올릴 수 없다.
  assert.equal(normalizeProduct({ ProductId: 'C', LocalizedProperties: [{}] }), null);
});

test('공식 발표의 게임 줄만 읽고 설명 문단은 버린다', () => {
  const posted = 'Tue, 16 Jun 2026 16:00:00 +0000';
  const line = parseAnnouncement('EA Sports FC 26 (Cloud, Console, and PC) – June 18 Game Pass Ultimate, PC Game Pass', posted);
  assert.equal(line.title, 'EA Sports FC 26');
  assert.equal(line.announcedFor, '2026-06-18');
  assert.match(line.devices, /Cloud, Console, and PC/);

  // 설명 문단은 괄호도 대시도 없다 — 걸리면 안 된다.
  assert.equal(parseAnnouncement('Rise on every front: Dogfight over the Pacific, airdrop over France.', posted), null);
  // 괄호가 있어도 기기 목록이 아니면 게임 줄이 아니다.
  assert.equal(parseAnnouncement('Game Pass Ultimate (15 hours) – the best value', posted), null);
  // 날짜도 '지금'도 없으면 우리가 아는 게 없다.
  assert.equal(parseAnnouncement('Some Game (Cloud, Console, and PC) – Game Pass Ultimate', posted), null);
});

test('연도가 없는 발표 날짜는 글이 난 날을 기준으로 해석한다', () => {
  assert.equal(resolveAnnouncedDate('June 18 Game Pass Ultimate', 'Tue, 16 Jun 2026 16:00:00 +0000'), '2026-06-18');
  // 12월 글의 1월 예정은 다음 해다. 여기를 틀리면 예정일이 1년 밀린다.
  assert.equal(resolveAnnouncedDate('January 5', 'Mon, 15 Dec 2025 16:00:00 +0000'), '2026-01-05');
  // 2월 30일 같은 값은 달력에 없다.
  assert.equal(resolveAnnouncedDate('February 30', 'Mon, 02 Feb 2026 16:00:00 +0000'), null);
  assert.equal(resolveAnnouncedDate('아무 날짜 없음', 'Mon, 02 Feb 2026 16:00:00 +0000'), null);
});

test('한 글에서 같은 게임을 두 번 세지 않는다', () => {
  const html = '<p>Junkster (Cloud, XBOX Series X|S, and PC) – June 16 Game Pass Ultimate</p>'
    + '<p>설명 문단입니다. 여기에는 아무 형식도 없습니다</p>'
    + '<p>Junkster (Cloud, XBOX Series X|S, and PC) – June 16 Game Pass Ultimate</p>';
  const rows = parseWirePost(html, 'Tue, 16 Jun 2026 16:00:00 +0000');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Junkster');
});

// --- 수집 잡 ---------------------------------------------------------------

function gamepassSql({ known = 0, previous = [] } = {}) {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    if (text.startsWith('INSERT INTO collector_runs')) return Promise.resolve([{ id: 1 }]);
    if (text.includes('COUNT(*)::int AS known')) return Promise.resolve([{ known }]);
    if (text.includes('SELECT product_id FROM gamepass_catalog')) return Promise.resolve(previous.map(product_id => ({ product_id })));
    return Promise.resolve([]);
  };
  sql.calls = calls;
  sql.find = fragment => calls.filter(call => call.text.includes(fragment));
  sql.payload = fragment => JSON.parse(sql.find(fragment)[0].values.find(v => typeof v === 'string' && v.startsWith('[')));
  return sql;
}

const service = (ids, products, extras = {}) => ({
  collection: async sigl => (sigl === SIGLS.leaving ? (extras.leaving ?? []) : ids),
  products: async () => products,
  announcements: async () => extras.announcements ?? []
});

test('첫 실행은 사건을 기록하지 않는다 — 관측 시작이지 입점이 아니다', async () => {
  const sql = gamepassSql({ known: 0 });
  const result = await createCollector({
    sql,
    gamepass: service(['A', 'B'], [{ productId: 'A', title: '가', releaseDate: null }, { productId: 'B', title: '나', releaseDate: null }])
  }).run('gamepass');

  assert.equal(result.baseline, true);
  assert.equal(result.processed, 2);
  assert.equal(result.added, 0);
  assert.equal(sql.find('INSERT INTO gamepass_events').length, 0);
  // 카탈로그 자체는 기록한다. 그게 내일 비교할 기준선이다.
  assert.deepEqual(sql.payload('INSERT INTO gamepass_catalog').map(row => row.product_id), ['A', 'B']);
});

test('두 번째 실행부터 입점·퇴점을 사건으로 남긴다', async () => {
  const sql = gamepassSql({ known: 2, previous: ['A', 'B'] });
  const result = await createCollector({
    sql,
    gamepass: service(['B', 'C'], [{ productId: 'B', title: '나', releaseDate: null }, { productId: 'C', title: '다', releaseDate: null }])
  }).run('gamepass');

  assert.equal(result.baseline, false);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
  const events = sql.payload('INSERT INTO gamepass_events');
  assert.deepEqual(events.map(row => [row.product_id, row.event]), [['C', 'added'], ['A', 'removed']]);
  // 퇴점한 게임은 카탈로그에서 사라져 이름을 다시 얻을 수 없으므로 제목을 그때 박아 둔다.
  assert.equal(events.find(row => row.event === 'added').title, '다');
  assert.ok(sql.find('SET removed_on').length, '퇴점 표시가 되지 않았다');
});

test('빈 목록을 받으면 아무것도 기록하지 않는다 — 전부 퇴점으로 적으면 복구가 안 된다', async () => {
  const sql = gamepassSql({ known: 700, previous: Array.from({ length: 700 }, (_, i) => `P${i}`) });
  const result = await createCollector({ sql, gamepass: service([], []) }).run('gamepass');

  assert.equal(result.skipped, 'empty-catalog');
  assert.equal(sql.find('INSERT INTO gamepass_events').length, 0);
  assert.equal(sql.find('SET removed_on').length, 0);
});

test('상세를 절반도 못 받으면 비교하지 않는다', async () => {
  // 목록은 왔는데 상세가 반도 안 왔다면 displaycatalog 쪽이 아픈 것이다.
  // 그 반쪽으로 비교하면 멀쩡한 게임 수백 개가 퇴점으로 기록된다.
  const ids = Array.from({ length: 100 }, (_, i) => `P${i}`);
  const sql = gamepassSql({ known: 100, previous: ids });
  const result = await createCollector({
    sql,
    gamepass: service(ids, ids.slice(0, 10).map(id => ({ productId: id, title: id, releaseDate: null })))
  }).run('gamepass');

  assert.equal(result.skipped, 'partial-catalog');
  assert.equal(sql.find('INSERT INTO gamepass_catalog').length, 0);
});

test('지난 발표는 입점 예정으로 저장하지 않는다', async () => {
  const sql = gamepassSql({ known: 1, previous: ['A'] });
  const past = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  await createCollector({
    sql,
    gamepass: service(['A'], [{ productId: 'A', title: '가', releaseDate: null }], {
      announcements: [
        { title: '지난 게임', announcedFor: past, devices: 'PC', sourceUrl: 'u', postedAt: new Date().toISOString() },
        { title: '올 게임', announcedFor: future, devices: 'PC', sourceUrl: 'u', postedAt: new Date().toISOString() }
      ]
    })
  }).run('gamepass');

  assert.deepEqual(sql.payload('INSERT INTO gamepass_upcoming').map(row => row.title), ['올 게임']);
});

test('상세는 배치로 나눠 받고 연락처가 있는 User-Agent 를 붙인다', async () => {
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push({ url, ua: options.headers['User-Agent'] });
    return { ok: true, json: async () => ({ Products: [] }) };
  };
  const svc = createGamePassService({ fetcher });
  await svc.products(Array.from({ length: DETAIL_BATCH * 2 + 1 }, (_, i) => `P${i}`));
  assert.equal(seen.length, 3);
  assert.ok(seen.every(call => /steamsignal/.test(call.ua)));
  // 한국 지역·한국어로 묻는다. 지역이 바뀌면 카탈로그가 통째로 달라진다.
  assert.ok(seen.every(call => call.url.includes('market=KR') && call.url.includes('languages=ko-kr')));
});
