// 플랫폼 층위 테스트.
//
// 이 층위가 틀리는 방식은 화면이 깨지는 것이 아니라 **그럴듯하게 틀린 날짜가 뜨는 것**이다.
// 실제로 첫 시도에서 두 번 그랬다 — 플랫폼과 출시일을 그냥 함께 조회해서 2020년 게임이
// 닌텐도 스위치 2에도 2020년에 나온 것처럼 나왔고, Xbox 로 적어 둔 QID 는 'The Pentagon' 이었다.
// 둘 다 에러 없이 통과했을 사고라, 여기서 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  foldBindings, normalizeDay, createWikidataService, datedQuery, platformQuery,
  PLATFORM_BY_QID, PLATFORMS, USER_AGENT
} from '../lib/platforms.mjs';

const entity = qid => ({ value: `http://www.wikidata.org/entity/${qid}` });
const literal = value => ({ value });
// 정밀도는 기본이 11(일)이다. Wikidata 의 대부분이 그렇고, 더 거친 값은 그 테스트에서 직접 준다.
const row = (appid, game, platform, date, precision = '11') => ({
  appid: literal(String(appid)), game: entity(game), platform: entity(platform),
  ...(date ? { date: literal(date), precision: literal(precision) } : {})
});

test('Steam appid 로 항목이 하나면 확정하고 플랫폼별 날짜를 붙인다', () => {
  const [result] = foldBindings([1091500], {
    plain: [
      { ...row(1091500, 'Q1143389', 'Q13361286'), enTitle: literal('Cyberpunk 2077') },
      row(1091500, 'Q1143389', 'Q63184502'),
      row(1091500, 'Q1143389', 'Q122761124')
    ],
    dated: [
      row(1091500, 'Q1143389', 'Q13361286', '2020-12-10T00:00:00Z'),
      row(1091500, 'Q1143389', 'Q63184502', '2022-02-15T00:00:00Z')
    ]
  });

  assert.equal(result.status, 'matched');
  assert.equal(result.wikidataId, 'Q1143389');
  assert.equal(result.wikipediaTitle, 'Cyberpunk 2077');
  assert.deepEqual(result.releases, [
    { platform: 'playstation', releasedOn: '2022-02-15' },
    { platform: 'xbox', releasedOn: '2020-12-10' },
    // 스위치 2 는 플랫폼만 있고 날짜가 없다. 다른 플랫폼의 날짜를 빌려 오면 안 된다 —
    // 이게 카테시안 곱으로 처음 났던 사고다.
    { platform: 'switch', releasedOn: null }
  ]);
});

test('같은 플랫폼에 날짜가 여럿이면 가장 이른 날을 쓴다', () => {
  // 지역·에디션·재발매로 한 플랫폼에 날짜가 셋씩 붙는다(검은 신화: 오공이 실제로 그랬다).
  const [result] = foldBindings([2358720], {
    plain: [row(2358720, 'Q117', 'Q63184502')],
    dated: [
      row(2358720, 'Q117', 'Q63184502', '2025-01-16T00:00:00Z'),
      row(2358720, 'Q117', 'Q63184502', '2024-08-20T00:00:00Z'),
      row(2358720, 'Q117', 'Q63184502', '2024-11-01T00:00:00Z')
    ]
  });
  assert.deepEqual(result.releases, [{ platform: 'playstation', releasedOn: '2024-08-20' }]);
});

test('한 appid 에 항목이 둘 이상이면 고르지 않고 후보로 넘긴다', () => {
  const [result] = foldBindings([440], {
    plain: [row(440, 'Q1', 'Q63184502'), row(440, 'Q2', 'Q13361286')],
    dated: [row(440, 'Q1', 'Q63184502', '2010-06-10T00:00:00Z')]
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.wikidataId, null);
  assert.deepEqual(result.candidates, ['Q1', 'Q2']);
  // 어느 항목에서 온 날짜인지 모르는 채로 화면에 올리면 그냥 틀린 값이다.
  assert.deepEqual(result.releases, []);
});

test('Wikidata 에 없는 게임도 결과에 남는다 — 커서가 전진해야 한다', () => {
  const results = foldBindings([730, 999999], { plain: [row(730, 'Q3', 'Q1406')], dated: [] });
  assert.equal(results.length, 2);
  const missing = results.find(r => r.appid === 999999);
  assert.equal(missing.status, 'unmatched');
  // 730 은 항목이 잡혔지만 우리가 다루는 콘솔이 아니다(Q1406 = 윈도우).
  assert.equal(results.find(r => r.appid === 730).status, 'matched');
  assert.deepEqual(results.find(r => r.appid === 730).releases, []);
});

test('우리가 아는 플랫폼 QID 만 분류하고 나머지는 버린다', () => {
  // PS3(Q10683)·Vita(Q188808)·Wii U(Q56942)·Xbox 360(Q48263) 은 현행 세대가 아니다.
  // 이걸 '플레이스테이션 출시'로 적으면 PS5 를 든 사람에게 거짓말이 된다.
  for (const legacy of ['Q10683', 'Q188808', 'Q56942', 'Q48263', 'Q1406', 'Q14116', 'Q388']) {
    assert.equal(PLATFORM_BY_QID[legacy], undefined, `${legacy} 가 현행 세대로 분류됐다`);
  }
  const families = new Set(Object.values(PLATFORM_BY_QID));
  assert.deepEqual([...families].sort(), ['playstation', 'switch', 'xbox']);
  assert.deepEqual(PLATFORMS.map(p => p.key).sort(), ['playstation', 'switch', 'xbox']);
});

test('달력 날짜가 아닌 값은 날짜로 만들지 않는다', () => {
  assert.equal(normalizeDay('+2022-02-25T00:00:00Z'), '2022-02-25');
  assert.equal(normalizeDay('2026-08-28T00:00:00Z'), '2026-08-28');
  // Wikidata 는 '연도만 안다'를 0월 0일로 준다. 1월 1일로 바꾸면 없는 날짜를 지어내는 것이다.
  assert.equal(normalizeDay('2026-00-00T00:00:00Z'), null);
  assert.equal(normalizeDay('2026-02-30T00:00:00Z'), null);
  assert.equal(normalizeDay(null), null);
});

test('질의는 P1733 역방향만 쓰고 날짜는 플랫폼 한정어에서 읽는다', () => {
  const dated = datedQuery([730, 570]);
  assert.match(dated, /wdt:P1733/);
  // 이 구조가 핵심이다. 출시일 진술(?st)에 플랫폼 한정어(pq:P400)가 같이 걸려야
  // 날짜가 플랫폼별로 갈린다. 따로 조회하면 카테시안 곱이 된다.
  assert.match(dated, /\?st psv:P577 \?tv/);
  assert.match(dated, /\?st pq:P400 \?platform/);
  assert.match(dated, /"730" "570"/);
  // 제목으로 잇지 않는다 — 질의에 라벨 매칭이 들어가면 안 된다.
  assert.doesNotMatch(dated + platformQuery([730]), /rdfs:label|CONTAINS|REGEX/i);
});

test('조회는 배치로 나눠 보내고 연락처가 있는 User-Agent 를 붙인다', async () => {
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push({ url, ua: options.headers['User-Agent'] });
    return { ok: true, json: async () => ({ results: { bindings: [] } }) };
  };
  const service = createWikidataService({ fetcher });
  const results = await service.lookup([1, 2, 3, 4, 5], { batchSize: 2 });

  // 배치 3개 × 질의 2개. 50개씩 한 번에 물으면 WDQS 60초 한도에 걸려 전부 504 가 난다.
  assert.equal(seen.length, 6);
  // Wikimedia 는 연락처 없는 User-Agent 를 403 으로 막는다.
  assert.ok(seen.every(call => call.ua === USER_AGENT && /steamsignal/.test(call.ua)));
  assert.equal(results.length, 5);
  assert.ok(results.every(r => r.status === 'unmatched'));
});

test('일시적 실패는 물러섰다 다시 묻고, 계속 실패하면 던진다', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 504 };
    return { ok: true, json: async () => ({ results: { bindings: [] } }) };
  };
  const service = createWikidataService({ fetcher: flaky, wait: async () => {} });
  await service.lookup([1], { batchSize: 1 });
  assert.ok(calls >= 3, 'WDQS 의 504 는 흔하다. 한 번 실패로 포기하면 하루치가 통째로 빈다');

  const dead = createWikidataService({ fetcher: async () => ({ ok: false, status: 500 }), wait: async () => {} });
  await assert.rejects(() => dead.lookup([1], { batchSize: 1 }), /WDQS HTTP 500/);
});

test('연도·월까지만 아는 출시일은 날짜로 쓰지 않는다', () => {
  // Wikidata 의 '2027년 출시 예정'은 값으로는 2027-01-01 이다. 정밀도를 안 보면
  // 1월 1일 출시로 굳는다 — 실제로 Enshrouded 의 Xbox 판이 그렇게 적재됐다.
  const [result] = foldBindings([1203620], {
    plain: [row(1203620, 'Q9', 'Q98973368'), row(1203620, 'Q9', 'Q63184502')],
    dated: [
      { ...row(1203620, 'Q9', 'Q98973368', '2027-01-01T00:00:00Z'), precision: literal('9') },
      { ...row(1203620, 'Q9', 'Q63184502', '2026-10-15T00:00:00Z'), precision: literal('11') }
    ]
  });
  const byPlatform = Object.fromEntries(result.releases.map(r => [r.platform, r.releasedOn]));
  assert.equal(byPlatform.playstation, '2026-10-15');
  assert.equal(byPlatform.xbox, null, '연도만 아는 값을 1월 1일로 적으면 없는 날짜를 지어내는 것이다');
  // 플랫폼 자체는 남는다 — '언젠가 나온다'는 사실은 맞다.
  assert.ok('xbox' in byPlatform);
});

test('질의가 출시일의 정밀도를 함께 가져온다', () => {
  assert.match(datedQuery([1]), /wikibase:timePrecision \?precision/);
  assert.match(datedQuery([1]), /wikibase:timeValue \?date/);
});
