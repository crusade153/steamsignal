// 롤업·보관정책 SQL 함수 테스트.
//
// **이 파일이 있는 이유.** 나머지 테스트는 전부 JS 라 db/*.sql 을 한 줄도 덮지 않았고,
// 그 사각지대에서 시간 롤업이 매시 마지막 17분만 담는 버그가 며칠 동안 조용히 돌았다.
// 롤업은 홈의 변화율·스파크라인·급상승·주간 차트·게임 상세 그래프가 전부 읽는 값이라,
// 여기가 틀리면 화면의 숫자가 전부 조금씩 틀린다. 그런데 아무 데서도 실패하지 않는다.
//
// PGlite 는 진짜 Postgres 를 wasm 으로 프로세스 안에서 돌린다. 서버도 도커도 네트워크도
// 필요 없고, db/schema.sql 과 db/functions.sql 을 **프로덕션과 같은 파일 그대로** 올린다.
//
// 검사하는 불변식은 하나다:
//
//   **롤업이 쓴 버킷은 그 버킷의 원시 스냅샷 전부를 요약한 값이어야 한다.**
//
// 창이 버킷 경계에 맞지 않으면 가장 오래된 버킷이 잘린 채로 기존 값을 덮어쓰고,
// 그 뒤로는 창 밖이라 영영 복구되지 않는다. 평균·최소·최대·표본 수가 한꺼번에 틀어진다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { storageUsage } from '../lib/queries.mjs';

const [SCHEMA, FUNCTIONS] = await Promise.all([
  readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'),
  readFile(new URL('../db/functions.sql', import.meta.url), 'utf8')
]);

const APPID = 730;

// 프로덕션과 같은 파일로 빈 DB 를 만든다. 스키마를 테스트용으로 따로 적으면
// 그 순간 이 테스트는 실제 배포와 다른 것을 검사하게 된다.
async function freshDb() {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(FUNCTIONS);
  await db.query('INSERT INTO apps (appid, title) VALUES ($1, $2)', [APPID, 'Counter-Strike 2']);
  return db;
}

// 수집은 매시 3·13·23·33·43·53분에 돈다(정각을 피한 것은 의도다 — CLAUDE.md 규칙 2).
// 그 리듬 그대로 심어야 "롤업 창이 버킷 한가운데를 자른다"는 실제 상황이 재현된다.
const MINUTES = [3, 13, 23, 33, 43, 53];

// 지난 hoursBack 시간의 원시 스냅샷. 현재 시(H)에는 넣지 않는다 —
// 아직 지나지 않은 분에 스냅샷을 심으면 '미래의 수집'이 되어 상황이 달라진다.
async function seedHourly(db, { hoursBack = 5 } = {}) {
  for (let hour = hoursBack; hour >= 1; hour -= 1) {
    for (const minute of MINUTES) {
      await db.query(
        `INSERT INTO player_snapshots (appid, captured_at, players, peak_today, rank)
         VALUES ($1::int,
                 date_trunc('hour', NOW()) - make_interval(hours => $2::int) + make_interval(mins => $3::int),
                 $4::int, $5::int, $6::smallint)`,
        // 시각마다 값을 다르게 둔다. 값이 평평하면 잘린 평균과 온전한 평균이 같아져
        // 버그가 있어도 테스트가 통과한다.
        [APPID, hour, minute, 100_000 + hour * 1_000 + minute * 10, 200_000, 1]);
    }
  }
}

// 지난 daysBack 일의 원시 스냅샷. 한국시간 0·4·8·12·16·20시에 하나씩 둔다.
// 0시를 반드시 포함시킨다 — 그게 없으면 새벽에 테스트를 돌릴 때만 조용히 통과한다.
async function seedDaily(db, { daysBack = 3 } = {}) {
  for (let day = daysBack; day >= 1; day -= 1) {
    for (const hour of [0, 4, 8, 12, 16, 20]) {
      // 파라미터에 ::int 를 명시한다. 빼면 Postgres 가 `date - $2` 를 date−date 로 읽어
      // 정수를 돌려주고, 그다음 ::timestamp 캐스팅에서 터진다.
      await db.query(
        `INSERT INTO player_snapshots (appid, captured_at, players, peak_today, rank)
         VALUES ($1::int,
                 ((((NOW() AT TIME ZONE 'Asia/Seoul')::date - $2::int)::timestamp
                    + make_interval(hours => $3::int)) AT TIME ZONE 'Asia/Seoul'),
                 $4::int, $5::int, $6::smallint)`,
        [APPID, day, hour, 100_000 + day * 1_000 + hour * 10, 200_000, 1]);
    }
  }
}

// 저장된 롤업 한 행 vs 그 버킷의 원시 스냅샷 전부를 집계한 값.
// 창이 버킷 경계에 맞으면 둘은 언제나 같다.
const HOURLY_TRUTH = `
  SELECT TO_CHAR(h.bucket, 'YYYY-MM-DD HH24:MI') AS bucket,
         h.samples AS stored_samples, h.avg_players AS stored_avg,
         h.max_players AS stored_max, h.min_players AS stored_min,
         t.rows AS true_samples, t.avg AS true_avg, t.max AS true_max, t.min AS true_min
    FROM player_hourly h
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::int AS rows, ROUND(AVG(p.players))::int AS avg,
             MAX(p.players) AS max, MIN(p.players) AS min
        FROM player_snapshots p
       WHERE p.appid = h.appid
         AND p.captured_at >= h.bucket
         AND p.captured_at <  h.bucket + INTERVAL '1 hour'
    ) t
   ORDER BY h.bucket`;

const DAILY_TRUTH = `
  SELECT TO_CHAR(d.day, 'YYYY-MM-DD') AS day,
         d.samples AS stored_samples, d.avg_players AS stored_avg,
         t.rows AS true_samples, t.avg AS true_avg
    FROM player_daily d
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::int AS rows, ROUND(AVG(p.players))::int AS avg
        FROM player_snapshots p
       WHERE p.appid = d.appid
         AND (p.captured_at AT TIME ZONE 'Asia/Seoul')::date = d.day
    ) t
   ORDER BY d.day`;

test('시간 롤업이 쓴 버킷은 그 시간의 스냅샷 전부를 담는다', async () => {
  const db = await freshDb();
  try {
    await seedHourly(db, { hoursBack: 5 });
    await db.query('SELECT rollup_player_hourly(3)');

    const { rows } = await db.query(HOURLY_TRUTH);
    assert.ok(rows.length >= 3, `3시간 창이면 버킷이 최소 3개는 쓰여야 한다 (실제 ${rows.length}개)`);

    for (const row of rows) {
      // 표본 수가 어긋난다는 것은 창이 버킷을 잘랐다는 뜻이고,
      // 그러면 평균·최대·최소가 전부 그 잘린 조각의 값이 된다.
      assert.equal(row.stored_samples, row.true_samples,
        `${row.bucket} 버킷이 ${row.true_samples}개 중 ${row.stored_samples}개만 담았다`);
      assert.equal(row.stored_avg, row.true_avg, `${row.bucket} 평균이 온전한 평균과 다르다`);
      assert.equal(row.stored_max, row.true_max, `${row.bucket} 최대가 온전한 최대와 다르다`);
      assert.equal(row.stored_min, row.true_min, `${row.bucket} 최소가 온전한 최소와 다르다`);
    }
  } finally { await db.close(); }
});

test('일 롤업이 쓴 날짜는 그 날(KST)의 스냅샷 전부를 담는다', async () => {
  const db = await freshDb();
  try {
    await seedDaily(db, { daysBack: 3 });
    await db.query('SELECT rollup_player_daily(2)');

    const { rows } = await db.query(DAILY_TRUTH);
    assert.ok(rows.length >= 2, `2일 창이면 날짜가 최소 2개는 쓰여야 한다 (실제 ${rows.length}개)`);

    for (const row of rows) {
      assert.equal(row.stored_samples, row.true_samples,
        `${row.day} 이 ${row.true_samples}개 중 ${row.stored_samples}개만 담았다`);
      assert.equal(row.stored_avg, row.true_avg, `${row.day} 평균이 온전한 하루 평균과 다르다`);
    }
  } finally { await db.close(); }
});

test('롤업은 몇 번을 돌려도 같은 값이 된다', async () => {
  const db = await freshDb();
  try {
    await seedHourly(db, { hoursBack: 5 });
    await seedDaily(db, { daysBack: 3 });

    // 크론이 밀려 두 번 도는 일은 실제로 일어난다. 그때 값이 흔들리면
    // 겹쳐 돌리는 설계(진행 중인 버킷 갱신) 자체가 성립하지 않는다.
    await db.query('SELECT rollup_player_hourly(3)');
    await db.query('SELECT rollup_player_daily(2)');
    const first = await db.query(HOURLY_TRUTH);
    const firstDaily = await db.query(DAILY_TRUTH);

    await db.query('SELECT rollup_player_hourly(3)');
    await db.query('SELECT rollup_player_daily(2)');
    assert.deepEqual((await db.query(HOURLY_TRUTH)).rows, first.rows);
    assert.deepEqual((await db.query(DAILY_TRUTH)).rows, firstDaily.rows);
  } finally { await db.close(); }
});

test('보관정책은 원시 7일·시간 90일만 남기고 일 롤업은 건드리지 않는다', async () => {
  const db = await freshDb();
  try {
    await db.query(
      `INSERT INTO player_snapshots (appid, captured_at, players)
       VALUES ($1, NOW() - INTERVAL '8 days', 1), ($1, NOW() - INTERVAL '1 day', 2)`, [APPID]);
    await db.query(
      `INSERT INTO player_hourly (appid, bucket, avg_players, max_players, min_players, samples)
       VALUES ($1::int, date_trunc('hour', NOW() - INTERVAL '91 days'), 1, 1, 1, 1),
              ($1::int, date_trunc('hour', NOW() - INTERVAL '10 days'), 2, 2, 2, 1)`, [APPID]);
    await db.query(
      `INSERT INTO player_daily (appid, day, avg_players, peak_observed, min_players, samples)
       VALUES ($1::int, (NOW() AT TIME ZONE 'Asia/Seoul')::date - 400, 1, 1, 1, 1)`, [APPID]);

    const { rows: [pruned] } = await db.query('SELECT * FROM prune_timeseries()');
    assert.equal(Number(pruned.snapshots_deleted), 1);
    assert.equal(Number(pruned.hourly_deleted), 1);

    // 일 롤업은 영구 보관이다. 이게 지워지면 '몇 년 전엔 이랬다'가 영영 사라진다.
    const { rows: [left] } = await db.query('SELECT COUNT(*)::int AS n FROM player_daily');
    assert.equal(left.n, 1);
  } finally { await db.close(); }
});

// 보관 기간은 이제 Node 가 매번 계산해서 인자로 넘긴다(lib/collect.mjs 의 planRetention).
// SQL 기본값만 검사하면 '인자를 무시하고 7일로 지우는' 회귀를 놓친다.
test('보관정책은 넘겨받은 기간을 그대로 쓴다 — 예산이 바뀌면 마이그레이션 없이 따라간다', async () => {
  const db = await freshDb();
  try {
    await db.query(
      `INSERT INTO player_snapshots (appid, captured_at, players)
       VALUES ($1, NOW() - INTERVAL '5 days', 1), ($1, NOW() - INTERVAL '1 day', 2)`, [APPID]);
    await db.query(
      `INSERT INTO player_hourly (appid, bucket, avg_players, max_players, min_players, samples)
       VALUES ($1::int, date_trunc('hour', NOW() - INTERVAL '40 days'), 1, 1, 1, 1),
              ($1::int, date_trunc('hour', NOW() - INTERVAL '10 days'), 2, 2, 2, 1)`, [APPID]);

    // 압박 단계('critical')에서 쓰는 값. 기본값(7·90)이었다면 하나도 지워지지 않는다.
    const { rows: [pruned] } = await db.query('SELECT * FROM prune_timeseries($1, $2)', [3, 30]);
    assert.equal(Number(pruned.snapshots_deleted), 1);
    assert.equal(Number(pruned.hourly_deleted), 1);

    // 조인 뒤에도 일 롤업이 다시 계산할 이틀 치 원시는 남아 있어야 한다(하한 3일의 이유).
    const { rows: [left] } = await db.query(
      `SELECT COUNT(*)::int AS n FROM player_snapshots WHERE captured_at >= NOW() - INTERVAL '2 days'`);
    assert.equal(left.n, 1);
  } finally { await db.close(); }
});

// 이 쿼리는 /status 와 prune 이 함께 쓴다. 문법이 깨지면 상태 페이지가 500 이 되고
// 보관정책은 '용량을 못 쟀다'며 조용히 조이기를 멈춘다 — 둘 다 늦게 드러난다.
test('저장소 사용량 쿼리는 실제 Postgres 에서 돈다', async () => {
  const db = await freshDb();
  try {
    const tagged = (strings, ...values) =>
      db.query(strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), ''), values)
        .then(result => result.rows);
    const [row] = await storageUsage(tagged);
    assert.ok(Number(row.total_bytes) > 0);
    const tables = typeof row.tables === 'string' ? JSON.parse(row.tables) : row.tables;
    assert.ok(Array.isArray(tables) && tables.length > 0);
    assert.ok(tables.every(t => typeof t.table_name === 'string' && Number(t.bytes) >= 0));
  } finally { await db.close(); }
});
