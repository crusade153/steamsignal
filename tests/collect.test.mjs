import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, slugify, parseReleaseDate, evaluateHealth, HEALTH_LIMITS, planRetention } from '../lib/collect.mjs';
import { RETENTION, RETENTION_FLOOR, STORAGE_BUDGET_BYTES } from '../lib/db.mjs';

// 태그드 템플릿 sql 을 흉내내어 실제 DB 없이 적재 로직(페이로드 모양, 커서 전진, 덮어쓰기 방지)을 검증한다.
function fakeSql({ targets = [], snapshots = [] } = {}) {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    if (text.startsWith('INSERT INTO collector_runs')) return Promise.resolve([{ id: 1 }]);
    if (text.startsWith('SELECT appid FROM apps')) return Promise.resolve(targets);
    if (text.includes('RETURNING appid')) return Promise.resolve(snapshots);
    return Promise.resolve([]);
  };
  sql.calls = calls;
  sql.find = fragment => calls.filter(call => call.text.includes(fragment));
  sql.payload = fragment => JSON.parse(sql.find(fragment)[0].values.find(value => typeof value === 'string' && value.startsWith('[')));
  return sql;
}

const chart = {
  updatedAt: '2026-09-05T10:00:00.000Z',
  stale: false,
  games: [
    { appid: 730, rank: 1, players: 900_000, peakToday: 1_200_000, title: 'Counter-Strike 2', headerImage: 'https://cdn.steamstatic.com/730.jpg' },
    { appid: 570, rank: 2, players: 500_000, peakToday: 700_000, title: 'Steam 앱 570', headerImage: null }
  ]
};

test('차트 적재는 Steam last_update 를 captured_at 으로 쓰고 임시 제목을 표시한다', async () => {
  const sql = fakeSql({ snapshots: [{ appid: 730 }, { appid: 570 }] });
  const collector = createCollector({ sql, steam: { getChart: async () => chart } });
  const result = await collector.run('chart');

  assert.equal(result.status, 'ok');
  assert.equal(result.processed, 2);
  assert.equal(result.snapshots, 2);

  // 원시 스냅샷의 시각은 우리 시계가 아니라 Steam 이 준 값이어야 재실행이 멱등해진다.
  const snapshot = sql.find('INSERT INTO player_snapshots')[0];
  assert.ok(snapshot.values.includes(chart.updatedAt));
  assert.ok(snapshot.text.includes('ON CONFLICT (appid, captured_at) DO NOTHING'));

  // 메타데이터를 못 받아 만들어진 임시 제목은 플래그가 서고, 제목 UPDATE 에서 걸러진다.
  const rows = sql.payload('INSERT INTO apps');
  assert.deepEqual(rows.map(row => row.title_is_fallback), [false, true]);
  assert.ok(sql.find('UPDATE apps a')[0].text.includes('x.title_is_fallback IS NOT TRUE'));

  // 차트에서 빠진 게임의 순위는 반드시 비운다.
  assert.equal(sql.find('UPDATE app_stats SET rank = NULL').length, 1);
});

test('상세 수집은 성공·실패 모두 커서를 전진시키고 실패만 카운터를 올린다', async () => {
  const sql = fakeSql({ targets: [{ appid: 730 }, { appid: 570 }] });
  const detail = { name: 'Counter-Strike 2', is_free: true, release_date: { date: '2023년 9월 27일' }, genres: [{ description: '액션' }], developers: ['Valve'], publishers: ['Valve'] };
  const reviews = { success: 1, query_summary: { total_positive: 900, total_negative: 100, review_score_desc: 'Very Positive' } };
  const collector = createCollector({
    sql,
    steam: { getChart: async () => chart },
    fetcher: async url => {
      if (url.includes('570')) return new Response('nope', { status: 500 });
      return url.includes('appreviews') ? Response.json(reviews) : Response.json({ 730: { success: true, data: detail } });
    }
  });

  const result = await collector.run('details');
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failedIds, [570]);
  assert.equal(result.status, 'partial');

  // 실패한 앱도 details_fetched_at 이 밀려야 큐가 막히지 않는다.
  const bumped = sql.find('details_failures = details_failures + 1')[0];
  assert.ok(bumped.text.includes('details_fetched_at = NOW()'));
  assert.deepEqual(bumped.values[0], [570]);
  assert.deepEqual(sql.find('details_failures = 0')[0].values[0], [730]);

  // 한쪽만 실패했을 때 멀쩡한 값을 NULL 로 덮지 않도록 조회 성공 표식이 실려야 한다.
  const stats = sql.payload('INSERT INTO app_stats (appid, final_price');
  assert.equal(stats.length, 1);
  assert.deepEqual([stats[0].has_detail, stats[0].has_reviews], [true, true]);
  assert.equal(stats[0].positive_ratio, 90);

  // 무료 게임은 가격 0 으로, 발매일은 한국어 문자열에서 파싱된다.
  const meta = sql.payload('UPDATE apps a SET title');
  assert.equal(meta[0].release_date, '2023-09-27');
  assert.equal(meta[0].slug, '730-counter-strike-2');
  assert.equal(stats[0].final_price, 0);
});

test('상세 대상이 없으면 아무 것도 쓰지 않는다', async () => {
  const sql = fakeSql({ targets: [] });
  const collector = createCollector({ sql, steam: { getChart: async () => chart } });
  assert.deepEqual(await collector.details(), { processed: 0, failed: 0 });
  assert.equal(sql.find('INSERT INTO app_stats').length, 0);
});

test('할인 중인 게임은 한국시간 상점 종료일을 현재값에 함께 저장한다', async () => {
  const sql = fakeSql({ targets: [{ appid: 289070 }] });
  const detail = {
    name: 'Civilization VI', is_free: false,
    price_overview: { final: 650000, initial: 6500000, discount_percent: 90, final_formatted: '₩ 6,500' }
  };
  const reviews = { success: 1, query_summary: { total_positive: 90, total_negative: 10 } };
  const store = '<p class="game_purchase_discount_countdown">SPECIAL PROMOTION! Offer ends 18 September</p>' +
    '<div class="discount_block game_purchase_discount" data-price-final="650000" data-discount="90"></div>';
  const requested = [];
  const collector = createCollector({
    sql,
    now: () => Date.parse('2026-09-06T00:00:00Z'),
    fetcher: async url => {
      requested.push(url);
      if (url.includes('appdetails')) return Response.json({ 289070: { success: true, data: detail } });
      if (url.includes('appreviews')) return Response.json(reviews);
      return new Response(store, { headers: { 'content-type': 'text/html' } });
    }
  });

  await collector.details();
  const stats = sql.payload('INSERT INTO app_stats (appid, final_price');
  assert.equal(stats[0].discount_end_date, '2026-09-18');
  assert.equal(stats[0].discount_end_checked, true);
  assert.ok(requested.some(url => url.includes('/app/289070/')), '할인 중일 때만 상점 페이지를 추가 확인해야 한다');
  const upsert = sql.find('INSERT INTO app_stats (appid, final_price')[0].text;
  assert.ok(upsert.includes('discount_end_checked_at'));
  assert.ok(upsert.includes('ELSE app_stats.discount_end_date'), '상점 요청 실패 때 기존 종료일을 보존해야 한다');
});

test('슬러그와 발매일 파서는 한글·결측을 안전하게 다룬다', () => {
  assert.equal(slugify('Counter-Strike 2', 730), '730-counter-strike-2');
  assert.equal(slugify('배틀그라운드', 578080), '578080-배틀그라운드');
  assert.equal(slugify('', 1), '1');
  assert.equal(slugify('Steam 앱 42', 42), '42');

  assert.equal(parseReleaseDate('2023년 9월 27일'), '2023-09-27');
  assert.equal(parseReleaseDate('2024년 3월'), '2024-03-01');
  assert.equal(parseReleaseDate('Aug 21, 2012'), '2012-08-21');
  assert.equal(parseReleaseDate('출시 예정'), null);
  assert.equal(parseReleaseDate(null), null);
});

test('알 수 없는 잡은 즉시 거부한다', async () => {
  const collector = createCollector({ sql: fakeSql(), steam: { getChart: async () => chart } });
  assert.throws(() => collector.run('nope'), /알 수 없는 잡/);
});

// --- 파이프라인 감시 ---------------------------------------------------------

test('감시 잡은 멀쩡할 때 조용하고, 멈추면 무엇이 멈췄는지 말한다', () => {
  const now = Date.parse('2026-09-06T12:00:00.000Z');
  const fresh = {
    latest_snapshot: '2026-09-06T11:53:00.000Z',
    last_chart_ok: '2026-09-06T11:53:10.000Z',
    detail_processed: 240, detail_failed: 3, dead_apps: 4
  };
  assert.deepEqual(evaluateHealth(fresh, now), [], '정상일 때 경보를 지어내지 않는다');

  // 한 번 밀리는 것은 정상이다(GitHub 스케줄은 정확하지 않다). 두 번 연속 빠지면 사고다.
  assert.deepEqual(evaluateHealth({ ...fresh, latest_snapshot: '2026-09-06T11:38:00.000Z' }, now), [],
    '한 사이클 지연으로는 깨우지 않는다');

  const stale = evaluateHealth({ ...fresh, latest_snapshot: '2026-09-06T10:00:00.000Z' }, now);
  assert.equal(stale.length, 1);
  assert.match(stale[0], /120분째 멈춰/);
});

test('감시 잡은 우리 쪽 문제와 개별 게임 실패를 구분한다', () => {
  const now = Date.parse('2026-09-06T12:00:00.000Z');
  const base = {
    latest_snapshot: '2026-09-06T11:53:00.000Z',
    last_chart_ok: '2026-09-06T11:53:10.000Z',
    detail_processed: 240, detail_failed: 0, dead_apps: 0
  };
  // 죽은 게임 몇 개가 실패하는 것은 늘 있는 일이다.
  assert.deepEqual(evaluateHealth({ ...base, detail_failed: 12 }, now), []);
  // 실패가 성공만큼 많으면 IP 차단이나 API 변경이다.
  assert.match(evaluateHealth({ ...base, detail_processed: 20, detail_failed: 20 }, now)[0], /IP 차단/);
  assert.match(evaluateHealth({ ...base, dead_apps: HEALTH_LIMITS.deadApps + 1 }, now)[0], /큐에서 빠진 앱/);
});

test('기록이 하나도 없으면 정상으로 보지 않는다', () => {
  // NULL 을 "오래되지 않았다"로 읽으면 한 번도 성공한 적 없는 파이프라인이 건강해 보인다.
  const alerts = evaluateHealth({ latest_snapshot: null, last_chart_ok: null, detail_processed: 0, detail_failed: 0, dead_apps: 0 });
  assert.equal(alerts.length, 2);
  assert.match(alerts.join(' '), /하나도 없습니다/);
});

test('감시 잡은 경보가 있으면 던진다 — 워크플로가 빨개지는 것이 경보다', async () => {
  const sql = (strings) => {
    const text = strings.join(' ? ');
    if (text.startsWith('INSERT INTO collector_runs')) return Promise.resolve([{ id: 1 }]);
    if (text.includes('latest_snapshot')) return Promise.resolve([{
      latest_snapshot: null, last_chart_ok: null, detail_processed: 0, detail_failed: 0, dead_apps: 0
    }]);
    return Promise.resolve([]);
  };
  const collector = createCollector({ sql, steam: { getChart: async () => [] } });
  await assert.rejects(collector.run('watchdog'), /파이프라인 경보/);
});

test('감시 잡은 아무것도 쓰지 않는다', async () => {
  const writes = [];
  const sql = (strings) => {
    const text = strings.join(' ? ').trim();
    if (text.startsWith('INSERT INTO collector_runs') || text.startsWith('UPDATE collector_runs')) return Promise.resolve([{ id: 1 }]);
    if (/^(INSERT|UPDATE|DELETE)/i.test(text)) writes.push(text);
    if (text.includes('latest_snapshot')) return Promise.resolve([{
      latest_snapshot: new Date().toISOString(), last_chart_ok: new Date().toISOString(),
      detail_processed: 100, detail_failed: 0, dead_apps: 0
    }]);
    return Promise.resolve([]);
  };
  const collector = createCollector({ sql, steam: { getChart: async () => [] } });
  const result = await collector.run('watchdog');
  assert.equal(result.healthy, true);
  assert.deepEqual(writes, [], '감시는 읽기만 한다');
});

// --- 커버리지 200개 ----------------------------------------------------------

test('차트 밖 게임의 동접을 같은 captured_at 으로 찍고 순위는 지어내지 않는다', async () => {
  // Steam 차트는 100개만 준다. 그 밖의 게임은 appid 하나씩 직접 물어야 하고,
  // 그러지 않으면 100위 밖으로 내려간 순간 시계열이 끊긴다.
  const sql = fakeSql({ targets: [{ appid: 4000 }, { appid: 5000 }], snapshots: [{ appid: 4000 }] });
  const collector = createCollector({
    sql,
    steam: { getChart: async () => chart },
    // 5000 은 result 가 1 이 아니다 — 값이 아니므로 저장하지 않는다.
    fetcher: async url => (url.includes('appid=4000')
      ? Response.json({ response: { player_count: 1234, result: 1 } })
      : Response.json({ response: { result: 42 } }))
  });

  const result = await collector.run('chart');
  assert.equal(result.charted, 2);
  assert.equal(result.offChart, 1);
  assert.equal(result.offChartFailed, 1);

  const extra = sql.find('INSERT INTO player_snapshots')[1];
  // 시각이 차트와 어긋나면 롤업이 같은 10분을 두 버킷에 나눠 담는다.
  assert.ok(extra.values.includes(chart.updatedAt), '차트와 같은 captured_at 을 써야 한다');
  assert.deepEqual(JSON.parse(extra.values.find(v => typeof v === 'string' && v.startsWith('['))),
    [{ appid: 4000, players: 1234 }]);

  // 차트 밖 게임에 순위를 적으면 그건 우리가 지어낸 값이다.
  const stats = sql.find('INSERT INTO app_stats (appid, players, players_at)')[0];
  assert.ok(!stats.text.includes('rank'), '차트 밖 갱신은 rank 를 건드리지 않는다');
});

test('로스터가 목표에 닿으면 후보를 더 찾지 않는다', async () => {
  let fetched = 0;
  const collector = createCollector({
    sql: strings => Promise.resolve(
      strings.join(' ').includes('COUNT(*)::int AS tracked') ? [{ tracked: 200 }] : []),
    steam: { getChart: async () => chart },
    fetcher: async () => { fetched += 1; return Response.json({}); }
  });

  const result = await collector.discover();
  assert.equal(result.skipped, 'target-reached');
  assert.equal(fetched, 0, '목표에 닿았으면 Steam 을 한 번도 부르지 않는다');
});

test('로스터 확장은 게임이 아닌 앱을 넣지 않는다', async () => {
  // DLC·사운드트랙이 한 번 들어오면 목록·장르·사이트맵에 전부 나타나고,
  // 그때 빼는 것은 이미 색인된 URL 을 죽이는 일이 된다. 들어오기 전에 막는다.
  const calls = [];
  const sql = Object.assign((strings, ...values) => {
    const text = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    if (text.includes('COUNT(*)::int AS tracked')) return Promise.resolve([{ tracked: 118 }]);
    if (text.includes('COUNT(*)::int AS total')) return Promise.resolve([{ total: 120 }]);
    if (text.startsWith('INSERT INTO collector_runs')) return Promise.resolve([{ id: 1 }]);
    if (text.startsWith('SELECT appid FROM apps WHERE appid = ANY')) return Promise.resolve([{ appid: 730 }]);
    return Promise.resolve([]);
  }, {});

  const types = { 730: 'game', 900: 'game', 901: 'dlc', 902: 'music' };
  const collector = createCollector({
    sql,
    steam: { getChart: async () => chart },
    fetcher: async url => {
      if (url.includes('/search/results/')) {
        return Response.json({ results_html: [730, 900, 901, 902].map(id => `<a data-ds-appid="${id}"></a>`).join('') });
      }
      const appid = Number(url.match(/appids=(\d+)/)[1]);
      return Response.json({ [appid]: { success: true, data: { name: `게임 ${appid}`, type: types[appid], is_free: true } } });
    }
  });

  const result = await collector.discover({ pages: 1 });
  assert.equal(result.processed, 1, '이미 있는 730 은 다시 확인하지 않고, dlc·music 은 넣지 않는다');

  const insert = calls.find(call => call.text.startsWith('INSERT INTO apps'));
  const rows = JSON.parse(insert.values.find(v => typeof v === 'string' && v.startsWith('[')));
  assert.deepEqual(rows.map(row => row.appid), [900]);
  assert.equal(rows[0].slug, '900-게임-900');
});

// --- 저장소 예산 -------------------------------------------------------------
//
// 0.5GB 는 지키라고 있는 벽이 아니라 넘으면 쓰기가 막히는 벽이다. 그래서 보관 기간을
// 코드에 못 박지 않고 사용률로 정하는데, 그 판정이 틀리면 두 방향으로 조용히 망가진다 —
// 안 조여서 한도에 닿거나, 너무 조여서 일 롤업이 조각으로 덮인다(규칙 23).
test('여유가 있으면 평상시 보관 기간을 그대로 쓴다', () => {
  const plan = planRetention({ usedBytes: 100 * 1024 * 1024, budgetBytes: 512 * 1024 * 1024 });
  assert.equal(plan.level, 'ok');
  assert.equal(plan.snapshotDays, RETENTION.snapshotDays);
  assert.equal(plan.hourlyDays, RETENTION.hourlyDays);
});

test('예산의 70% 를 넘으면 창을 좁히고 85% 를 넘으면 더 좁힌다', () => {
  const budgetBytes = 512 * 1024 * 1024;
  const tight = planRetention({ usedBytes: budgetBytes * 0.75, budgetBytes });
  assert.equal(tight.level, 'tight');
  assert.equal(tight.snapshotDays, 5);
  assert.equal(tight.hourlyDays, 60);

  const critical = planRetention({ usedBytes: budgetBytes * 0.95, budgetBytes });
  assert.equal(critical.level, 'critical');
  assert.equal(critical.hourlyDays, 30);
});

// 원시가 3일 밑으로 내려가면 rollup_player_daily(2) 가 이미 지워진 이틀을 다시 읽고,
// 온전한 하루를 조각으로 덮어쓴다. 일 롤업은 prune 대상이 아니라 그 조각이 영구 보관된다.
test('아무리 조여도 원시 보관은 3일 밑으로 내려가지 않는다', () => {
  const budgetBytes = 512 * 1024 * 1024;
  const plan = planRetention({ usedBytes: budgetBytes * 0.99, budgetBytes });
  assert.equal(plan.snapshotDays, RETENTION_FLOOR.snapshotDays);
  assert.ok(plan.snapshotDays >= 3);
  // 일 롤업 기간은 계획에 아예 없다. 어떤 압박에서도 영구 보관이다.
  assert.equal(plan.dailyDays, undefined);
});

test('용량을 재지 못하면 조이지 않는다 — 모르는 것을 위험으로 읽어 지우지 않는다', () => {
  const plan = planRetention({ usedBytes: null, budgetBytes: 512 * 1024 * 1024 });
  assert.equal(plan.level, 'unknown');
  assert.equal(plan.snapshotDays, RETENTION.snapshotDays);
  assert.equal(plan.hourlyDays, RETENTION.hourlyDays);
});

test('prune 은 계산한 보관 기간을 SQL 인자로 넘긴다 — 기간을 바꾸는 데 마이그레이션이 필요 없다', async () => {
  const calls = [];
  const budget = 512 * 1024 * 1024;
  const sql = (strings, ...values) => {
    const text = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    if (text.startsWith('INSERT INTO collector_runs')) return Promise.resolve([{ id: 1 }]);
    if (text.includes('pg_database_size')) return Promise.resolve([{ total_bytes: String(Math.round(budget * 0.9)) }]);
    if (text.includes('prune_timeseries')) return Promise.resolve([{ snapshots_deleted: 3, hourly_deleted: 2 }]);
    if (text.includes('prune_subscriptions')) return Promise.resolve([{ pending_deleted: 0, dropped_deleted: 0, deliveries_deleted: 0 }]);
    return Promise.resolve([{ rows: 0 }]);
  };
  const result = await createCollector({ sql }).run('prune');

  assert.equal(result.storageLevel, 'critical');
  assert.equal(result.snapshotDays, 3);
  const prune = calls.find(call => call.text.includes('prune_timeseries'));
  assert.deepEqual(prune.values, [3, 30]);
});

test('저장소가 예산을 거의 채우면 감시 잡이 경보한다', () => {
  const facts = { latest_snapshot: new Date().toISOString(), last_chart_ok: new Date().toISOString() };
  assert.equal(evaluateHealth({ ...facts, storage_bytes: STORAGE_BUDGET_BYTES * 0.5 }).length, 0);
  const alerts = evaluateHealth({ ...facts, storage_bytes: STORAGE_BUDGET_BYTES * 0.95 });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /저장소가 예산의 95%/);
});

// --- 플랫폼 층위 -------------------------------------------------------------

function platformSql() {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    if (text.startsWith('INSERT INTO collector_runs')) return Promise.resolve([{ id: 1 }]);
    if (text.includes('FROM apps a LEFT JOIN game_sources')) return Promise.resolve([{ appid: 730 }, { appid: 440 }]);
    return Promise.resolve([]);
  };
  sql.calls = calls;
  sql.find = fragment => calls.filter(call => call.text.includes(fragment));
  sql.payload = fragment => JSON.parse(sql.find(fragment)[0].values.find(v => typeof v === 'string' && v.startsWith('[')));
  return sql;
}

test('플랫폼 잡은 확정·모호·미매칭을 구분해 적재한다', async () => {
  const sql = platformSql();
  const wikidata = {
    lookup: async () => ([
      { appid: 730, status: 'matched', wikidataId: 'Q3', wikipediaTitle: 'Counter-Strike 2', candidates: [], releases: [{ platform: 'xbox', releasedOn: '2020-12-10' }, { platform: 'switch', releasedOn: null }] },
      { appid: 440, status: 'ambiguous', wikidataId: null, wikipediaTitle: null, candidates: ['Q1', 'Q2'], releases: [] }
    ])
  };
  const result = await createCollector({ sql, wikidata }).run('platforms');

  assert.equal(result.processed, 2);
  assert.equal(result.matched, 1);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.releases, 2);
  assert.equal(result.dated, 1, '날짜가 없는 플랫폼을 날짜 있는 것으로 세면 커버리지가 부풀려진다');

  // 조회한 것은 성공·실패 없이 전부 커서가 전진해야 한다(규칙 6).
  assert.deepEqual(sql.payload('INSERT INTO game_sources').map(r => r.match_status), ['matched', 'ambiguous']);
  // 모호한 게임의 플랫폼은 쓰지 않는다 — 어느 항목의 날짜인지 모른다.
  assert.deepEqual(sql.payload('INSERT INTO platform_releases').map(r => r.appid), [730, 730]);
  assert.deepEqual(sql.payload('INSERT INTO identity_candidates').map(r => r.wikidata_id), ['Q1', 'Q2']);
  // 이미 받아 둔 위키백과 제목을 NULL 로 덮지 않는다.
  assert.ok(sql.find('INSERT INTO game_sources')[0].text.includes('COALESCE(EXCLUDED.wikipedia_title, game_sources.wikipedia_title)'));
});

test('Wikidata 가 통째로 죽으면 커서를 전진시키지 않는다', async () => {
  const sql = platformSql();
  const wikidata = { lookup: async () => { throw new Error('WDQS HTTP 504'); } };
  const result = await createCollector({ sql, wikidata }).run('platforms');

  assert.equal(result.status, 'partial');
  assert.equal(result.failed, 2);
  // 여기서 전진시키면 WDQS 가 한 시간 아팠던 것 때문에 60개가 '조회했지만 없음'으로 굳는다.
  assert.equal(sql.find('INSERT INTO game_sources').length, 0);
  assert.equal(sql.find('INSERT INTO platform_releases').length, 0);
});

test('플랫폼 잡은 기존 Steam 수집을 건드리지 않는다', async () => {
  const sql = platformSql();
  await createCollector({ sql, wikidata: { lookup: async () => [] } }).run('platforms');
  for (const table of ['player_snapshots', 'app_stats', 'INSERT INTO apps', 'price_events']) {
    assert.equal(sql.find(table).length, 0, `플랫폼 잡이 ${table} 을 건드렸다`);
  }
});
