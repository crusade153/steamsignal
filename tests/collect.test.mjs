import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, slugify, parseReleaseDate, evaluateHealth, HEALTH_LIMITS } from '../lib/collect.mjs';

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
