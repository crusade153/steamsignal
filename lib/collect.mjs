import { createHash } from 'node:crypto';
import {
  createSteamService, normalizeDetails, appDetailsUrl, appReviewsUrl,
  currentPlayersUrl, topSellersUrl, parseStoreAppIds, normalizePlayerCount,
  storePageUrl, parseDiscountEndDate
} from './steam.mjs';
import { withRun, rowsAsJson, RETENTION, RETENTION_FLOOR, STORAGE_BUDGET_BYTES } from './db.mjs';
import { mailEnabled, sendMail, alertTemplate, weeklyTemplate } from './mail.mjs';
import {
  resetRisenAlerts, pendingPriceDrops, markAlertsNotified, weeklyRecipients,
  claimDelivery, finishDelivery, recordSendResult, isoWeekKey
} from './alerts.mjs';
import { rising as risingQuery, deals as dealsQuery, storageUsage } from './queries.mjs';
import { createWikidataService } from './platforms.mjs';

// getChart() 는 스토어 메타데이터를 못 받으면 제목을 이 형태로 채운다.
// 그 임시값이 appdetails 로 받은 진짜 제목을 덮어쓰지 않도록 구분해야 한다.
const isFallbackTitle = (title, appid) => title === `Steam 앱 ${appid}`;

const intOrNull = value => Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;

// SEO URL: /game/730-counter-strike-2. 한글 제목은 그대로 둔다(퍼센트 인코딩되며 한국어 검색에 유리).
export function slugify(title, appid) {
  const base = String(title ?? '').toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return base && !/^steam-앱-\d+$/.test(base) ? `${appid}-${base}` : String(appid);
}

const isoDate = (year, month, day) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

// Steam 은 l=koreana 로 "2012년 8월 21일" 같은 문자열을 준다. 파싱에 실패해도 원문은 따로 보존한다.
// 발매일은 '시각'이 아니라 '달력 날짜'다. toISOString() 을 쓰면 로컬 자정이 UTC 로 밀려 하루가 어긋난다.
export function parseReleaseDate(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const korean = text.match(/(\d{4})\s*년(?:\s*(\d{1,2})\s*월)?(?:\s*(\d{1,2})\s*일)?/);
  if (korean) {
    const [, year, month = '1', day = '1'] = korean;
    const probe = new Date(Date.UTC(+year, +month - 1, +day));
    // 2월 30일 같은 값은 다음 달로 굴러가므로 되돌아온 월로 검증한다.
    if (probe.getUTCMonth() !== +month - 1 || probe.getUTCDate() !== +day) return null;
    return isoDate(+year, +month, +day);
  }
  // ISO 날짜만 있는 문자열은 Date.parse 가 UTC 자정으로 읽는다. 로컬 게터로 꺼내면
  // 음수 오프셋 지역(예: 미국)에서 하루가 밀리므로 문자열에서 바로 집어낸다.
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return isoDate(+iso[1], +iso[2], +iso[3]);

  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return null;
  const date = new Date(parsed);
  return isoDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

// 추적할 게임 수. Steam 차트는 정확히 100개만 주므로 나머지는 우리가 따로 붙잡아야 한다.
//
//   - 차트 안 100개: 차트 응답 한 번에 동접이 다 들어 있다.
//   - 차트 밖 나머지: appid 하나당 GetNumberOfCurrentPlayers 한 번.
//
// 차트 밖을 굳이 찍는 이유가 커버리지 숫자만은 아니다. 지금까지는 게임이 100위 밖으로
// 내려간 순간 동접 기록이 끊겨서, 상세 페이지의 그래프가 어느 날 갑자기 잘렸다.
// "예전엔 잘나갔는데 지금은" 이라는 이야기는 그 끊긴 자리에서만 나올 수 있다.
//
// 200개일 때 Steam 요청량은 10분당 100건 남짓 늘어난다(하루 ~14,400건). 공식 API 의
// 알려진 한도 안이고, 대부분 네트워크 대기라 Vercel Active CPU 에도 거의 안 잡힌다.
export const TRACKED_TARGET = 200;

// 파이프라인 경보 임계값. 근거는 docs/DATA-PIPELINE.md §7 에 있다.
export const HEALTH_LIMITS = {
  // 수집은 10분 간격이다. 한 번 밀리는 것은 정상이고(GitHub 스케줄은 정확하지 않다),
  // 두 번 연속 빠지면 그때부터는 사고다.
  snapshotStaleMinutes: 25,
  // chart 잡이 30분 넘게 ok 를 못 냈다 = Steam 차트 API 또는 스케줄러 문제.
  chartOkMinutes: 30,
  // 상세 수집에서 실패가 성공을 넘었다 = IP 차단 또는 스토어 API 변경.
  detailFailureRatio: 1,
  // 연속 실패로 커서에서 빠진 앱. 몇 개는 늘 있다(퍼블리셔가 내린 게임). 급증이 신호다.
  deadApps: 20,
  // 저장소가 예산의 90% 를 넘었다. 여기부터는 보관정책을 조여도 사람이 봐야 한다 —
  // 요금제를 올리든 커버리지를 줄이든 판단이 필요하고, 한도에 닿으면 쓰기가 막힌다.
  storageRatio: 0.9
};

// 저장소 압박 단계. 예산 대비 사용률에 따라 보관 기간의 **상한**을 낮춘다.
//
// 왜 자동으로 조이나 — 0.5GB 는 지키라고 있는 벽이 아니라 넘으면 쓰기가 막히는 벽이다.
// 커버리지를 늘리거나(200 -> 300) 새 지표(Twitch·Wikipedia)를 붙이면 증가 속도가 바뀌는데,
// 그때마다 사람이 알아채고 손으로 기간을 줄이는 것은 늦다. 그래서 prune 이 매번 재고
// 압박이 있을 때만 창을 좁힌다. 압박이 풀리면 평상시 기간으로 알아서 돌아온다.
//
// **일 롤업은 어느 단계에서도 줄이지 않는다.** 그게 이 사이트의 영구 기록이고,
// 하루치 행은 게임당 1행이라 애초에 용량 문제를 일으키지 않는다.
export const STORAGE_STEPS = [
  { at: 0, level: 'ok', snapshotDays: Infinity, hourlyDays: Infinity },
  { at: 0.7, level: 'tight', snapshotDays: 5, hourlyDays: 60 },
  { at: 0.85, level: 'critical', snapshotDays: RETENTION_FLOOR.snapshotDays, hourlyDays: 30 }
];

// 순수 판정. 지금 쓰는 용량과 예산을 받아 이번 prune 이 쓸 보관 기간을 돌려준다.
// SQL 과 분리해 두는 이유는 evaluateHealth 와 같다 — 임계값은 DB 없이 검증할 수 있어야 한다.
export function planRetention({ usedBytes, budgetBytes = STORAGE_BUDGET_BYTES, base = RETENTION } = {}) {
  const ratio = Number.isFinite(usedBytes) && budgetBytes > 0 ? usedBytes / budgetBytes : null;
  // 용량을 못 쟀다면 조이지 않는다. 재지 못한 것을 위험으로 읽어 데이터를 지우는 쪽이 더 나쁘다.
  const step = ratio === null ? STORAGE_STEPS[0] : STORAGE_STEPS.findLast(s => ratio >= s.at);
  return {
    // 하한은 절대 뚫지 않는다. 원시가 3일 밑으로 내려가면 rollup_player_daily(2) 가
    // 이미 지워진 이틀을 다시 읽어 온전한 일 롤업을 조각으로 덮어쓴다(규칙 23 과 같은 사고).
    snapshotDays: Math.max(Math.min(base.snapshotDays, step.snapshotDays), RETENTION_FLOOR.snapshotDays),
    hourlyDays: Math.max(Math.min(base.hourlyDays, step.hourlyDays), RETENTION_FLOOR.hourlyDays),
    ratio,
    level: ratio === null ? 'unknown' : step.level
  };
}

// 순수 판정. 사실(facts)을 받아 경보 문자열 목록을 돌려준다.
// SQL 과 분리해 두는 이유는 하나다 — 임계값 판정은 DB 없이 테스트할 수 있어야 한다.
export function evaluateHealth(facts, now = Date.now()) {
  const alerts = [];
  const minutesSince = value => (value ? (now - new Date(value).getTime()) / 60_000 : null);

  const snapshotAge = minutesSince(facts.latest_snapshot);
  if (snapshotAge === null) {
    alerts.push('동시접속자 스냅샷이 하나도 없습니다. 수집이 한 번도 성공하지 못했습니다.');
  } else if (snapshotAge > HEALTH_LIMITS.snapshotStaleMinutes) {
    alerts.push(`동시접속자 스냅샷이 ${Math.round(snapshotAge)}분째 멈춰 있습니다 (기준 ${HEALTH_LIMITS.snapshotStaleMinutes}분). 스케줄러 또는 /api/cron 을 확인하세요.`);
  }

  const chartAge = minutesSince(facts.last_chart_ok);
  if (chartAge === null) {
    alerts.push('chart 잡이 성공한 기록이 없습니다.');
  } else if (chartAge > HEALTH_LIMITS.chartOkMinutes) {
    alerts.push(`chart 잡이 ${Math.round(chartAge)}분째 성공하지 못했습니다 (기준 ${HEALTH_LIMITS.chartOkMinutes}분).`);
  }

  // 실패가 성공을 넘었다면 개별 게임 문제가 아니라 우리 쪽 문제다.
  const { detail_processed: ok = 0, detail_failed: bad = 0 } = facts;
  if (bad > 0 && bad >= ok * HEALTH_LIMITS.detailFailureRatio) {
    alerts.push(`상세 수집의 실패(${bad})가 성공(${ok})만큼 많습니다. IP 차단이나 스토어 API 변경을 의심하세요.`);
  }

  if ((facts.dead_apps ?? 0) > HEALTH_LIMITS.deadApps) {
    alerts.push(`연속 실패로 큐에서 빠진 앱이 ${facts.dead_apps}개입니다 (기준 ${HEALTH_LIMITS.deadApps}개).`);
  }

  // 저장소는 보관정책이 이미 자동으로 조이고 있다. 그런데도 여기까지 왔다면
  // 조이는 것으로는 못 막는다는 뜻이라 사람이 봐야 한다.
  const used = Number(facts.storage_bytes);
  if (Number.isFinite(used) && used > 0) {
    const ratio = used / STORAGE_BUDGET_BYTES;
    if (ratio > HEALTH_LIMITS.storageRatio) {
      alerts.push(`저장소가 예산의 ${Math.round(ratio * 100)}% 입니다 (${Math.round(used / 1024 / 1024)}MB / ${Math.round(STORAGE_BUDGET_BYTES / 1024 / 1024)}MB, 기준 ${Math.round(HEALTH_LIMITS.storageRatio * 100)}%). 요금제·커버리지·보관 기간 중 하나를 정해야 합니다.`);
    }
  }

  return alerts;
}

export function createCollector({
  sql,
  steam = createSteamService({ timeoutMs: 15_000 }),
  wikidata = createWikidataService(),
  fetcher = fetch,
  concurrency = 4,
  timeoutMs = 15_000,
  now = Date.now,
  // 메일은 주입 가능하게 둔다. 테스트가 실제로 발송하는 사고를 막는 유일한 방법이다.
  mailer = sendMail,
  mailReady = mailEnabled
}) {
  // 크론 전용 페처. API 서버의 응답 캐시를 타지 않는다 — 잡마다 앱을 한 번씩만 보므로 캐시가 무의미하고,
  // 동시성은 Steam 스토어 API 를 배려해 낮게 잡는다(대략 5분당 200요청이 한계로 알려져 있다).
  let active = 0;
  const queue = [];
  async function limited(task) {
    if (active >= concurrency) await new Promise(resolve => queue.push(resolve));
    else active++;
    try { return await task(); }
    finally { const next = queue.shift(); if (next) next(); else active--; }
  }
  const request = (url, { json = true, headers = {} } = {}) => limited(async () => {
    const response = await fetcher(url, {
      headers: {
        'User-Agent': 'SteamPulse/2.0 (+collector)',
        Accept: json ? 'application/json' : 'text/html',
        ...headers
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`Steam HTTP ${response.status}`);
    return json ? response.json() : response.text();
  });

  // ---------------------------------------------------------------------------
  // 1. 차트 수집 — 10분 주기. Steam 호출 2회, DB 왕복 5회.
  // ---------------------------------------------------------------------------
  async function collectChart() {
    const chart = await steam.getChart();
    const capturedAt = chart.updatedAt;
    const payload = JSON.stringify(chart.games.map(game => ({
      appid: game.appid,
      title: game.title,
      title_is_fallback: isFallbackTitle(game.title, game.appid),
      header_image: game.headerImage,
      players: intOrNull(game.players),
      peak_today: intOrNull(game.peakToday),
      rank: game.rank
    })));

    // (1) 마스터 확보. 신규 앱은 임시 제목으로 들어오고, 진짜 제목은 상세 수집이 채운다.
    // 이미지는 '있으면 그대로 둔다'. 차트가 주는 건 231x87 캡슐이고 상세 수집이 받는 건
    // 460x215 헤더라, EXCLUDED 를 우선하면 10분마다 좋은 이미지가 작은 캡슐로 되돌아간다.
    // (OG 이미지·상세 페이지 히어로가 그 캡슐을 쓰게 되므로 눈에 보이는 손해다.)
    await sql`
      INSERT INTO apps (appid, title, header_image, last_charted_at)
      SELECT x.appid, x.title, x.header_image, ${capturedAt}::timestamptz
        FROM jsonb_to_recordset(${payload}::jsonb)
          AS x(appid int, title text, header_image text)
          ON CONFLICT (appid) DO UPDATE
         SET last_charted_at = EXCLUDED.last_charted_at,
             header_image    = COALESCE(apps.header_image, EXCLUDED.header_image)`;

    // (2) 차트가 진짜 제목을 알고 있고 우리 값과 다를 때만 갱신. 평소엔 0행이라 dead tuple 이 안 쌓인다.
    await sql`
      UPDATE apps a
         SET title = x.title, updated_at = NOW()
        FROM jsonb_to_recordset(${payload}::jsonb)
          AS x(appid int, title text, title_is_fallback boolean)
       WHERE a.appid = x.appid
         AND x.title_is_fallback IS NOT TRUE
         AND a.title IS DISTINCT FROM x.title`;

    // (3) 원시 시계열. captured_at 이 Steam 의 last_update 라 재실행·중복 실행이 무해하다.
    const inserted = await sql`
      INSERT INTO player_snapshots (appid, captured_at, players, peak_today, rank)
      SELECT x.appid, ${capturedAt}::timestamptz, x.players, x.peak_today, x.rank
        FROM jsonb_to_recordset(${payload}::jsonb)
          AS x(appid int, players int, peak_today int, rank smallint)
          ON CONFLICT (appid, captured_at) DO NOTHING
      RETURNING appid`;

    // (4) "지금 값" 캐시. 목록 페이지는 이 테이블만 읽는다.
    await sql`
      INSERT INTO app_stats (appid, players, peak_today, rank, players_at)
      SELECT x.appid, x.players, x.peak_today, x.rank, ${capturedAt}::timestamptz
        FROM jsonb_to_recordset(${payload}::jsonb)
          AS x(appid int, players int, peak_today int, rank smallint)
          ON CONFLICT (appid) DO UPDATE
         SET players = EXCLUDED.players, peak_today = EXCLUDED.peak_today,
             rank = EXCLUDED.rank, players_at = EXCLUDED.players_at`;

    // (5) 차트에서 빠진 게임의 순위·동접은 지운다. 어제 순위가 오늘 순위인 척하면 안 된다.
    //     아래 (6) 이 그중 추적 대상의 동접을 직접 물어 다시 채운다 — 순위는 채우지 않는다.
    //     차트 밖 게임에는 순위가 없는 게 사실이기 때문이다.
    await sql`
      UPDATE app_stats SET rank = NULL, players = NULL
       WHERE rank IS NOT NULL
         AND appid NOT IN (SELECT x.appid FROM jsonb_to_recordset(${payload}::jsonb) AS x(appid int))`;

    const extras = await collectExtraPlayers(chart.games.map(game => game.appid), capturedAt);

    return {
      processed: chart.games.length + extras.processed,
      charted: chart.games.length,
      offChart: extras.processed,
      offChartFailed: extras.failed,
      snapshots: inserted.length + extras.snapshots,
      capturedAt,
      stale: chart.stale
    };
  }

  // ---------------------------------------------------------------------------
  // 1-b. 차트 밖 게임의 동접 — appid 하나당 요청 하나.
  //
  //      captured_at 은 차트와 **같은 값**을 쓴다. 시각이 어긋나면 롤업이 두 무리를
  //      다른 버킷에 넣고, 같은 10분을 두 번 센 것처럼 보인다.
  //      값을 못 받은 앱은 건드리지 않는다 — 0 으로 적으면 '아무도 안 한다'가 된다.
  // ---------------------------------------------------------------------------
  async function collectExtraPlayers(chartIds, capturedAt, { target = TRACKED_TARGET } = {}) {
    const room = Math.max(target - chartIds.length, 0);
    if (!room) return { processed: 0, failed: 0, snapshots: 0 };

    // 최근에 차트에 있었던 순서. 방금 100위 밖으로 밀린 게임이 가장 먼저다 —
    // 그 게임의 시계열이 끊기는 것이 사용자에게 가장 크게 보이는 손실이기 때문이다.
    const targets = await sql`
      SELECT appid FROM apps
       WHERE appid <> ALL(${chartIds}::int[])
       ORDER BY last_charted_at DESC NULLS LAST, appid
       LIMIT ${room}`;
    if (!targets.length) return { processed: 0, failed: 0, snapshots: 0 };

    const results = await Promise.all(targets.map(async ({ appid }) => ({
      appid,
      players: await request(currentPlayersUrl(appid)).then(normalizePlayerCount).catch(() => null)
    })));
    const measured = results.filter(row => row.players !== null);
    if (!measured.length) return { processed: 0, failed: results.length, snapshots: 0 };

    const extraPayload = JSON.stringify(measured);
    const inserted = await sql`
      INSERT INTO player_snapshots (appid, captured_at, players)
      SELECT x.appid, ${capturedAt}::timestamptz, x.players
        FROM jsonb_to_recordset(${extraPayload}::jsonb) AS x(appid int, players int)
        ON CONFLICT (appid, captured_at) DO NOTHING
      RETURNING appid`;

    // rank 는 건드리지 않는다. 차트 밖 게임에 순위를 적으면 그건 우리가 지어낸 값이다.
    await sql`
      INSERT INTO app_stats (appid, players, players_at)
      SELECT x.appid, x.players, ${capturedAt}::timestamptz
        FROM jsonb_to_recordset(${extraPayload}::jsonb) AS x(appid int, players int)
        ON CONFLICT (appid) DO UPDATE
       SET players = EXCLUDED.players, players_at = EXCLUDED.players_at`;

    return { processed: measured.length, failed: results.length - measured.length, snapshots: inserted.length };
  }

  // ---------------------------------------------------------------------------
  // 1-c. 로스터 넓히기 — 하루 한 번.
  //
  //      apps 는 지금까지 '차트에 든 적이 있는 게임'으로만 늘었다. 그 방식만으로 200개를
  //      채우려면 몇 달이 걸린다. 스토어 판매 상위를 후보로 받아 부족한 만큼만 채운다.
  //      많이 팔리는 게임과 많이 켜 두는 게임은 다르므로, 겹치지 않는 후보가 많이 나온다.
  //
  //      **넣기 전에 게임인지 확인한다.** DLC·사운드트랙·데모가 한 번 들어오면 목록·장르·
  //      사이트맵에 전부 나타나고, 그때 빼는 것은 이미 색인된 URL 을 죽이는 일이 된다.
  // ---------------------------------------------------------------------------
  async function discover({ target = TRACKED_TARGET, pages = 3, verifyLimit = 60 } = {}) {
    const [{ tracked }] = await sql`SELECT COUNT(*)::int AS tracked FROM apps`;
    const room = target - tracked;
    if (room <= 0) return { processed: 0, tracked, skipped: 'target-reached' };

    const candidates = new Set();
    for (let page = 0; page < pages; page += 1) {
      const body = await request(topSellersUrl(page)).catch(() => null);
      for (const appid of parseStoreAppIds(body)) candidates.add(appid);
    }
    if (!candidates.size) return { processed: 0, failed: 1, tracked, skipped: 'no-candidates' };

    const ids = [...candidates];
    const known = new Set((await sql`SELECT appid FROM apps WHERE appid = ANY(${ids}::int[])`).map(row => row.appid));
    const fresh = ids.filter(appid => !known.has(appid));

    // 한 번에 다 확인하지 않는다. 확인은 appid 하나당 요청 하나라, 하루치씩 나눠 채워도
    // 며칠이면 목표에 닿는다. 스토어 API 를 몰아치는 것보다 그게 낫다.
    const checked = [];
    for (const appid of fresh.slice(0, verifyLimit)) {
      if (checked.length >= room) break;
      const detail = await request(appDetailsUrl(appid))
        .then(body => (body?.[appid]?.success && body[appid].data) || null)
        .catch(() => null);
      if (detail?.type !== 'game' || !detail.name) continue;
      const game = normalizeDetails(appid, detail, null);
      checked.push({
        appid,
        title: game.title,
        slug: slugify(game.title, appid),
        header_image: game.headerImage
      });
    }
    if (!checked.length) return { processed: 0, tracked, candidates: fresh.length };

    // slug 는 UNIQUE 다. 제목이 같은 게임이 이미 있으면 그 행이 이기고 새 행은 slug 없이 들어간다
    // — 상세 수집이 다음 차례에 다시 채운다. 여기서 던지면 나머지 후보까지 통째로 날아간다.
    await sql`
      INSERT INTO apps (appid, title, slug, header_image)
      SELECT x.appid, x.title, x.slug, x.header_image
        FROM jsonb_to_recordset(${JSON.stringify(checked)}::jsonb)
          AS x(appid int, title text, slug text, header_image text)
       WHERE NOT EXISTS (SELECT 1 FROM apps a WHERE a.slug = x.slug)
          ON CONFLICT (appid) DO NOTHING`;

    const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM apps`;
    return { processed: checked.length, tracked: total, candidates: fresh.length, target };
  }

  // ---------------------------------------------------------------------------
  // 2. 상세 수집 — 10분 주기, 라운드로빈으로 batch 개씩.
  //    "가장 오래 안 본 앱" 순서라 앱이 100개든 10,000개든 크론 설정을 바꿀 필요가 없다.
  //    public API 의 getDetails() 는 현재 TOP 100 밖 ID 를 거부하므로 여기서는 쓰지 않는다.
  // ---------------------------------------------------------------------------
  // batch 는 한 번에 상세를 갱신할 게임 수다. 추적 게임이 200개가 되면서 20 으로는
  // 한 바퀴가 1.7시간 → 3.3시간으로 늘어난다(목표는 2시간 이내, docs/PRODUCT.md §2-1).
  // 40 이면 다시 1.7시간이고, Steam 요청량은 10분당 80건으로 알려진 한계 안이다.
  async function collectDetails({ batch = 40 } = {}) {
    const targets = await sql`
      SELECT appid FROM apps
       WHERE details_failures < 5
       ORDER BY details_fetched_at NULLS FIRST
       LIMIT ${batch}`;
    if (!targets.length) return { processed: 0, failed: 0 };

    const results = await Promise.all(targets.map(async ({ appid }) => {
      const [detail, reviews] = await Promise.all([
        request(appDetailsUrl(appid))
          .then(body => (body?.[appid]?.success && body[appid].data) || null).catch(() => null),
        request(appReviewsUrl(appid))
          .then(body => (body?.success === 1 && body.query_summary ? body : null)).catch(() => null)
      ]);
      const game = normalizeDetails(appid, detail, reviews);
      let discountEndChecked = false;
      let discountEndDate = null;

      if (detail && (game.discount ?? 0) <= 0) {
        // 할인이 끝났다면 예전 종료일을 즉시 지운다. 상점 HTML을 한 번 더 받을 이유도 없다.
        discountEndChecked = true;
      } else if (detail && game.discount > 0) {
        try {
          const page = await request(storePageUrl(appid), {
            json: false,
            // Steam 이 날짜를 한국 달력 날짜로 렌더링하도록 명시한다. 이 쿠키가 없으면 같은 할인이
            // 서버 위치에 따라 하루 전 날짜로 보일 수 있다.
            headers: { Cookie: 'birthtime=568022401; lastagecheckage=1-January-1988; timezoneOffset=32400,0' }
          });
          discountEndChecked = true;
          discountEndDate = parseDiscountEndDate(page, {
            finalPrice: game.price,
            discountPercent: game.discount,
            now: now()
          });
        } catch {
          // 가격·리뷰 수집까지 실패시키지 않는다. 이전에 확인한 미래 종료일이 있으면 DB가 보존한다.
        }
      }
      return { appid, detail, reviews, game, discountEndChecked, discountEndDate };
    }));

    const ok = results.filter(row => row.detail || row.reviews);
    const failedIds = results.filter(row => !row.detail && !row.reviews).map(row => row.appid);

    // 전부 실패했으면 커서만 밀고 끝낸다. 빈 페이로드로 쿼리를 던져 봐야 왕복만 낭비된다.
    if (!ok.length) {
      await sql`UPDATE apps SET details_fetched_at = NOW(), details_failures = details_failures + 1
                 WHERE appid = ANY(${failedIds}::int[])`;
      return { processed: 0, failed: failedIds.length, failedIds };
    }

    // --- 2a. SEO 본문 (appdetails 를 받은 앱만) --------------------------------
    const meta = ok.filter(row => row.detail).map(({ appid, detail, game }) => ({
      appid,
      title: game.title,
      slug: game.title ? slugify(game.title, appid) : null,
      header_image: game.headerImage,
      short_description: game.description,
      release_date_text: game.releaseDate,
      release_date: parseReleaseDate(game.releaseDate),
      developers: game.developers.filter(value => typeof value === 'string'),
      publishers: Array.isArray(detail.publishers) ? detail.publishers.filter(value => typeof value === 'string') : [],
      genres: game.genres,
      is_free: game.isFree,
      metacritic_score: game.metacritic?.score ?? null,
      metacritic_url: game.metacritic?.url ?? null
    }));

    if (meta.length) {
      await sql`
        UPDATE apps a
           SET title             = COALESCE(x.title, a.title),
               slug              = COALESCE(x.slug, a.slug),
               header_image      = COALESCE(x.header_image, a.header_image),
               short_description = x.short_description,
               release_date_text = x.release_date_text,
               release_date      = x.release_date,
               developers        = COALESCE(x.developers, '{}'),
               publishers        = COALESCE(x.publishers, '{}'),
               genres            = COALESCE(x.genres, '{}'),
               is_free           = x.is_free,
               metacritic_score  = x.metacritic_score,
               metacritic_url    = x.metacritic_url,
               updated_at        = NOW()
          FROM jsonb_to_recordset(${JSON.stringify(meta)}::jsonb)
            AS x(appid int, title text, slug text, header_image text, short_description text,
                 release_date_text text, release_date date, developers text[], publishers text[],
                 genres text[], is_free boolean, metacritic_score smallint, metacritic_url text)
         WHERE a.appid = x.appid`;
    }

    // --- 2b. 가격·리뷰 ---------------------------------------------------------
    // has_detail / has_reviews 는 "조회 성공" 표식이다. 한쪽만 실패했을 때
    // 멀쩡한 기존 값을 NULL 로 덮어쓰지 않기 위해 필요하다.
    const stats = JSON.stringify(ok.map(({ appid, detail, reviews, game, discountEndChecked, discountEndDate }) => ({
      appid,
      final_price: game.price,
      initial_price: intOrNull(detail?.price_overview?.initial),
      discount_percent: game.discount ?? 0,
      price_formatted: game.priceFormatted,
      discount_end_date: discountEndDate,
      discount_end_checked: discountEndChecked,
      is_free: game.isFree,
      has_detail: Boolean(detail),
      total_positive: intOrNull(reviews?.query_summary?.total_positive),
      total_negative: intOrNull(reviews?.query_summary?.total_negative),
      positive_ratio: game.positiveRatio,
      review_desc: game.reviewLabel,
      has_reviews: Boolean(reviews)
    })));

    await sql`
      INSERT INTO app_stats (appid, final_price, initial_price, discount_percent, price_formatted, price_at,
                             discount_end_date, discount_end_checked_at,
                             total_positive, total_negative, positive_ratio, review_desc, reviews_at)
      SELECT x.appid,
             CASE WHEN x.has_detail  THEN x.final_price END,
             CASE WHEN x.has_detail  THEN x.initial_price END,
             CASE WHEN x.has_detail  THEN COALESCE(x.discount_percent, 0) ELSE 0 END,
             CASE WHEN x.has_detail  THEN x.price_formatted END,
             CASE WHEN x.has_detail  THEN NOW() END,
             CASE WHEN x.discount_end_checked THEN x.discount_end_date END,
             CASE WHEN x.discount_end_checked THEN NOW() END,
             CASE WHEN x.has_reviews THEN x.total_positive END,
             CASE WHEN x.has_reviews THEN x.total_negative END,
             CASE WHEN x.has_reviews THEN x.positive_ratio END,
             CASE WHEN x.has_reviews THEN x.review_desc END,
             CASE WHEN x.has_reviews THEN NOW() END
        FROM jsonb_to_recordset(${stats}::jsonb)
          AS x(appid int, final_price int, initial_price int, discount_percent smallint,
               price_formatted text, discount_end_date date, discount_end_checked boolean,
               has_detail boolean, total_positive int, total_negative int,
               positive_ratio smallint, review_desc text, has_reviews boolean)
          ON CONFLICT (appid) DO UPDATE
         SET final_price      = CASE WHEN EXCLUDED.price_at IS NOT NULL THEN EXCLUDED.final_price      ELSE app_stats.final_price END,
             initial_price    = CASE WHEN EXCLUDED.price_at IS NOT NULL THEN EXCLUDED.initial_price    ELSE app_stats.initial_price END,
             discount_percent = CASE WHEN EXCLUDED.price_at IS NOT NULL THEN EXCLUDED.discount_percent ELSE app_stats.discount_percent END,
             price_formatted  = CASE WHEN EXCLUDED.price_at IS NOT NULL THEN EXCLUDED.price_formatted  ELSE app_stats.price_formatted END,
             price_at         = COALESCE(EXCLUDED.price_at, app_stats.price_at),
             discount_end_date = CASE WHEN EXCLUDED.discount_end_checked_at IS NOT NULL THEN EXCLUDED.discount_end_date ELSE app_stats.discount_end_date END,
             discount_end_checked_at = COALESCE(EXCLUDED.discount_end_checked_at, app_stats.discount_end_checked_at),
             total_positive   = CASE WHEN EXCLUDED.reviews_at IS NOT NULL THEN EXCLUDED.total_positive ELSE app_stats.total_positive END,
             total_negative   = CASE WHEN EXCLUDED.reviews_at IS NOT NULL THEN EXCLUDED.total_negative ELSE app_stats.total_negative END,
             positive_ratio   = CASE WHEN EXCLUDED.reviews_at IS NOT NULL THEN EXCLUDED.positive_ratio ELSE app_stats.positive_ratio END,
             review_desc      = CASE WHEN EXCLUDED.reviews_at IS NOT NULL THEN EXCLUDED.review_desc    ELSE app_stats.review_desc END,
             reviews_at       = COALESCE(EXCLUDED.reviews_at, app_stats.reviews_at)`;

    // --- 2c. 가격 변경점만 기록 — 스냅샷이 아니라 변경 로그라 연간 수천 행에 그친다. ----
    await sql`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset(${stats}::jsonb)
          AS x(appid int, final_price int, initial_price int, discount_percent smallint,
               is_free boolean, has_detail boolean)
      ), latest AS (
        SELECT DISTINCT ON (appid) appid, final_price, discount_percent
          FROM price_events
         WHERE appid IN (SELECT appid FROM incoming)
         ORDER BY appid, observed_at DESC
      )
      INSERT INTO price_events (appid, currency, final_price, initial_price, discount_percent, is_free)
      SELECT i.appid, 'KRW', i.final_price, i.initial_price, COALESCE(i.discount_percent, 0), i.is_free
        FROM incoming i
        LEFT JOIN latest l ON l.appid = i.appid
       WHERE i.has_detail
         AND (l.appid IS NULL
              OR l.final_price      IS DISTINCT FROM i.final_price
              OR l.discount_percent IS DISTINCT FROM i.discount_percent)`;

    // --- 2d. 리뷰 일별 스냅샷 (KST 기준 하루 1행) ------------------------------
    await sql`
      INSERT INTO review_daily (appid, day, total_positive, total_negative, score_desc)
      SELECT x.appid, (NOW() AT TIME ZONE 'Asia/Seoul')::date,
             x.total_positive, x.total_negative, x.review_desc
        FROM jsonb_to_recordset(${stats}::jsonb)
          AS x(appid int, total_positive int, total_negative int, review_desc text, has_reviews boolean)
       WHERE x.has_reviews AND x.total_positive IS NOT NULL AND x.total_negative IS NOT NULL
          ON CONFLICT (appid, day) DO UPDATE
         SET total_positive = EXCLUDED.total_positive,
             total_negative = EXCLUDED.total_negative,
             score_desc     = EXCLUDED.score_desc`;

    // --- 2e. 커서 전진 — 성공이든 실패든 반드시 밀어준다. 안 그러면 죽은 앱이 큐를 영원히 막는다.
    const okIds = ok.map(row => row.appid);
    if (okIds.length) {
      await sql`UPDATE apps SET details_fetched_at = NOW(), details_failures = 0
                 WHERE appid = ANY(${okIds}::int[])`;
    }
    if (failedIds.length) {
      await sql`UPDATE apps SET details_fetched_at = NOW(), details_failures = details_failures + 1
                 WHERE appid = ANY(${failedIds}::int[])`;
    }

    return { processed: okIds.length, failed: failedIds.length, failedIds };
  }

  // ---------------------------------------------------------------------------
  // 2-1. 플랫폼 층위 — 이 게임이 다른 기계에 언제 나왔나.
  //
  //   Steam 수집과 완전히 분리돼 있다. 이 잡이 하루 종일 실패해도 사이트의 기존 화면은
  //   한 칸도 달라지지 않는다 — 없으면 '다른 플랫폼' 절이 안 그려질 뿐이다.
  //   새 층위를 얹을 때 기존 파이프라인을 인질로 잡지 않는 것이 요점이다.
  //
  //   커서는 상세 수집과 같은 규율이다(CLAUDE.md 규칙 6): **성공·실패 모두 전진시킨다.**
  //   Wikidata 에 아예 없는 게임이 30% 쯤 되는데, 실패를 전진시키지 않으면 그 게임들이
  //   큐 맨 앞에서 영원히 재시도되고 나머지는 한 번도 조회되지 않는다.
  // ---------------------------------------------------------------------------
  async function collectPlatforms({ limit = 60 } = {}) {
    // 아직 한 번도 안 본 것 먼저, 그다음 오래된 것 순. 새 게임이 들어오면 다음 날 잡힌다.
    const targets = await sql`
      SELECT a.appid
        FROM apps a
        LEFT JOIN game_sources g USING (appid)
       ORDER BY g.checked_at ASC NULLS FIRST, a.appid
       LIMIT ${limit}`;
    if (!targets.length) return { processed: 0 };

    const appids = targets.map(row => row.appid);
    let results;
    try {
      results = await wikidata.lookup(appids);
    } catch (error) {
      // 통째로 실패했으면 커서를 전진시키지 않는다. 여기서 전진시키면 WDQS 가 한 시간
      // 아팠던 것 때문에 60개가 '조회했지만 없음'으로 굳어 다음 차례가 하루 뒤가 된다.
      return { processed: 0, failed: appids.length, error: String(error?.message || error) };
    }

    const sources = results.map(row => ({
      appid: row.appid,
      wikidata_id: row.wikidataId,
      wikipedia_title: row.wikipediaTitle,
      match_status: row.status
    }));
    await sql`
      INSERT INTO game_sources (appid, wikidata_id, wikipedia_title, match_status, checked_at, matched_at)
      SELECT x.appid, x.wikidata_id, x.wikipedia_title, x.match_status, NOW(),
             CASE WHEN x.match_status = 'matched' THEN NOW() END
        FROM jsonb_to_recordset(${rowsAsJson(sources)}::jsonb)
          AS x(appid int, wikidata_id text, wikipedia_title text, match_status text)
          ON CONFLICT (appid) DO UPDATE
         SET wikidata_id = EXCLUDED.wikidata_id,
             -- 이미 받아 둔 위키백과 제목을 NULL 로 덮지 않는다. 한쪽 질의만 실패해도
             -- 다음 단계(조회수)의 조회 키가 사라지면 205개를 다시 크롤링해야 한다.
             wikipedia_title = COALESCE(EXCLUDED.wikipedia_title, game_sources.wikipedia_title),
             match_status = EXCLUDED.match_status,
             checked_at = NOW(),
             matched_at = COALESCE(EXCLUDED.matched_at, game_sources.matched_at)`;

    const releases = results.flatMap(row =>
      row.releases.map(release => ({ appid: row.appid, platform: release.platform, released_on: release.releasedOn })));
    if (releases.length) {
      await sql`
        INSERT INTO platform_releases (appid, platform, released_on, source, observed_at)
        SELECT x.appid, x.platform, x.released_on, 'wikidata', NOW()
          FROM jsonb_to_recordset(${rowsAsJson(releases)}::jsonb)
            AS x(appid int, platform text, released_on date)
            ON CONFLICT (appid, platform) DO UPDATE
           -- **그대로 덮어쓴다(NULL 로도).** COALESCE 로 옛 값을 지키면 틀린 날짜를 고칠 수
           -- 없다. 실제로 연도만 아는 값이 1월 1일로 적재된 적이 있는데, 보호 장치 때문에
           -- 재수집으로 지워지지 않았다. 여기 오는 행은 항목이 확정된 게임뿐이고
           -- 배치가 통째로 성공했을 때만 도달하므로, 이 값이 언제나 최신 사실이다.
           SET released_on = EXCLUDED.released_on,
               observed_at = NOW()`;
    }

    // 확정된 게임에서 사라진 플랫폼은 지운다(Wikidata 에서 잘못된 진술이 정정된 경우다).
    // 모호·미매칭은 건드리지 않는다 — '조회를 못 한 것'과 '없어진 것'은 다르다.
    const matched = results.filter(row => row.status === 'matched');
    for (const row of matched) {
      const keep = row.releases.map(release => release.platform);
      await sql`DELETE FROM platform_releases
                 WHERE appid = ${row.appid} AND NOT (platform = ANY(${keep}::text[]))`;
    }

    const ambiguous = results.filter(row => row.status === 'ambiguous');
    const candidates = ambiguous.flatMap(row =>
      row.candidates.map(wikidataId => ({ appid: row.appid, wikidata_id: wikidataId })));
    if (candidates.length) {
      await sql`
        INSERT INTO identity_candidates (appid, wikidata_id)
        SELECT x.appid, x.wikidata_id
          FROM jsonb_to_recordset(${rowsAsJson(candidates)}::jsonb)
            AS x(appid int, wikidata_id text)
            ON CONFLICT (appid, wikidata_id) DO NOTHING`;
    }

    return {
      processed: results.length,
      matched: matched.length,
      ambiguous: ambiguous.length,
      unmatched: results.filter(row => row.status === 'unmatched').length,
      releases: releases.length,
      dated: releases.filter(release => release.released_on).length
    };
  }

  // ---------------------------------------------------------------------------
  // 3. 롤업 / 보관정책 — 집계는 행을 Node 로 끌어오지 않고 DB 안에서 끝낸다.
  // ---------------------------------------------------------------------------
  // 용량 측정은 실패해도 잡을 죽이지 않는다. 못 쟀으면 planRetention 이 평상시 기간을 쓴다.
  async function measureStorage() {
    try {
      const [row] = await storageUsage(sql);
      const bytes = Number(row?.total_bytes);
      return { bytes: Number.isFinite(bytes) ? bytes : null };
    } catch (error) {
      return { bytes: null, error: String(error?.message || error) };
    }
  }

  async function rollupHourly() {
    const [row] = await sql`SELECT rollup_player_hourly(3) AS rows`;
    return { processed: Number(row.rows) };
  }
  async function rollupDaily() {
    const [row] = await sql`SELECT rollup_player_daily(2) AS rows`;
    return { processed: Number(row.rows) };
  }
  // 보관정책. 기간을 SQL 기본값에 맡기지 않고 **매번 다시 계산해서 넘긴다** —
  // 그래야 예산이 바뀌거나(요금제) 증가 속도가 바뀌어도(커버리지·새 지표)
  // 마이그레이션 없이 배포만으로 따라간다.
  async function prune() {
    const usage = await measureStorage();
    const plan = planRetention({ usedBytes: usage.bytes });

    const [pruned] = await sql`SELECT * FROM prune_timeseries(${plan.snapshotDays}, ${plan.hourlyDays})`;
    const [runs] = await sql`SELECT prune_collector_runs() AS rows`;
    // 구독 데이터는 용량이 아니라 원칙 때문에 지운다 — 보관할 근거가 사라진 개인정보는 남기지 않는다.
    const [subs] = await sql`SELECT * FROM prune_subscriptions()`;
    // 만료 세션도 같은 이유로 지운다 — 쓸 수 없게 된 개인정보를 들고 있을 근거가 없다.
    const [sessions] = await sql`SELECT prune_sessions() AS rows`;
    return {
      processed: Number(pruned.snapshots_deleted) + Number(pruned.hourly_deleted),
      snapshots: Number(pruned.snapshots_deleted),
      hourly: Number(pruned.hourly_deleted),
      // 남겨 두면 collector_runs.detail 만 보고도 '언제부터 조이기 시작했나'를 되짚을 수 있다.
      storageMb: usage.bytes === null ? null : Math.round(usage.bytes / 1024 / 1024),
      storageLevel: plan.level,
      snapshotDays: plan.snapshotDays,
      hourlyDays: plan.hourlyDays,
      runs: Number(runs.rows),
      pendingSignups: Number(subs.pending_deleted),
      droppedSubscribers: Number(subs.dropped_deleted),
      deliveries: Number(subs.deliveries_deleted),
      sessions: Number(sessions.rows)
    };
  }

  // ---------------------------------------------------------------------------
  // 4. 메일 — 가격 하락 알림 / 주간 리포트.
  //
  //    발송 규율 넷. 어기면 사고가 조용히 나거나(중복 발송) 도메인이 스팸으로 죽는다.
  //      (1) 설정이 없으면 아무 일도 하지 않는다. 반쯤 켜진 상태를 만들지 않는다.
  //      (2) 보내기 전에 mail_deliveries 에 자리를 잡는다 — 그 UNIQUE 가 중복 판정의 전부다.
  //      (3) 한 사람에게 여러 건이 걸리면 한 통으로 묶는다. 세일 첫날 20통은 스팸 신고감이다.
  //      (4) 한 번에 보내는 통 수를 제한한다. Vercel 함수 시간(60초)과 Resend 일일 한도가 둘 다 있다.
  // ---------------------------------------------------------------------------
  const MAX_ALERT_MAILS_PER_RUN = 40;
  const MAX_WEEKLY_MAILS_PER_RUN = 90;

  // dedupe_key 는 사람이 읽을 수 있으면서 길이가 고정이어야 한다(UNIQUE 인덱스에 들어간다).
  const digest = value => createHash('sha256').update(value).digest('base64url').slice(0, 22);

  // 한 통 보내고 원장을 닫는다. 여기서 던지지 않는다 — 한 사람의 실패가 나머지를 막으면 안 된다.
  async function deliver({ subscriberId, kind, dedupeKey, to, template, unsubscribeToken }) {
    const claim = await claimDelivery(sql, { subscriberId, kind, dedupeKey });
    if (!claim) return { skipped: true };
    try {
      await mailer({ to, ...template, unsubscribeToken });
      await finishDelivery(sql, claim, { status: 'sent' });
      await recordSendResult(sql, subscriberId, true);
      return { sent: true };
    } catch (error) {
      await finishDelivery(sql, claim, { status: 'error', error: error?.message || error });
      await recordSendResult(sql, subscriberId, false);
      return { failed: true, error: String(error?.message || error) };
    }
  }

  async function sendAlerts() {
    if (!mailReady()) return { processed: 0, skipped: 'mail-disabled' };

    const reset = await resetRisenAlerts(sql);
    const rows = await pendingPriceDrops(sql, 400);
    if (!rows.length) return { processed: 0, reset, candidates: 0 };

    // 사람 단위로 묶는다. pendingPriceDrops 가 subscriber_id 순으로 정렬해 준다.
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.subscriber_id)) groups.set(row.subscriber_id, []);
      groups.get(row.subscriber_id).push(row);
    }

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const [subscriberId, items] of [...groups].slice(0, MAX_ALERT_MAILS_PER_RUN)) {
      const fingerprint = items.map(row => `${row.appid}@${row.final_price}`).sort().join(',');
      const result = await deliver({
        subscriberId,
        kind: 'alert',
        dedupeKey: `alert:${subscriberId}:${digest(fingerprint)}`,
        to: items[0].email,
        unsubscribeToken: items[0].unsubscribe_token,
        template: alertTemplate({ rows: items, unsubscribeToken: items[0].unsubscribe_token })
      });
      if (result.sent) {
        sent++;
        // 워터마크는 **보낸 뒤에만** 올린다. 먼저 올리면 발송이 실패한 하락을 영영 못 알린다.
        await markAlertsNotified(sql, items);
      } else if (result.failed) failed++;
      else skipped++;
    }

    return { processed: sent, failed, skipped, reset, candidates: rows.length, subscribers: groups.size };
  }

  async function sendWeekly() {
    if (!mailReady()) return { processed: 0, skipped: 'mail-disabled' };

    // 본문은 한 번만 만든다. 사람마다 다시 질의하면 왕복이 구독자 수만큼 늘어난다.
    let rising = [];
    for (const window of [
      { recentHours: 168, pastHours: 336, minPlayers: 1000, limit: 5 },
      { recentHours: 24, pastHours: 168, minPlayers: 500, limit: 5 }
    ]) {
      rising = await risingQuery(sql, window);
      if (rising.length) break;
    }
    const deals = await dealsQuery(sql, { minRatio: 80, limit: 5 });

    // 실을 게 없으면 보내지 않는다. 빈 뉴스레터는 해지 사유가 된다.
    if (!rising.length && !deals.length) return { processed: 0, skipped: 'no-content' };

    const week = isoWeekKey();
    const recipients = await weeklyRecipients(sql, MAX_WEEKLY_MAILS_PER_RUN);
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const person of recipients) {
      const result = await deliver({
        subscriberId: person.id,
        kind: 'weekly',
        dedupeKey: `weekly:${person.id}:${week}`,
        to: person.email,
        unsubscribeToken: person.unsubscribe_token,
        template: weeklyTemplate({ rising, deals, unsubscribeToken: person.unsubscribe_token })
      });
      if (result.sent) sent++;
      else if (result.failed) failed++;
      else skipped++;
    }

    return { processed: sent, failed, skipped, week, rising: rising.length, deals: deals.length };
  }

  // ---------------------------------------------------------------------------
  // watchdog — 파이프라인이 조용히 죽는 것을 막는다.
  //
  // 경보 채널을 새로 만들지 않는다. 조건이 걸리면 이 잡은 **던진다**. 그러면
  //   withRun 이 collector_runs 에 error 로 남기고
  //   -> /api/cron 이 500 을 내고
  //   -> GitHub Actions 의 curl 이 실패해 워크플로가 빨갛게 되고
  //   -> GitHub 이 저장소 소유자에게 실패 메일을 보낸다.
  // 설정이 하나도 필요 없는 유일한 경로다. Slack·Resend 를 붙이는 것은 그다음 이야기다.
  //
  // 이 잡은 아무것도 쓰지 않는다. 읽기만 하고 판정은 evaluateHealth() 가 한다.
  async function watchdog() {
    const [facts] = await sql`
      SELECT (SELECT MAX(captured_at) FROM player_snapshots) AS latest_snapshot,
             (SELECT MAX(finished_at) FROM collector_runs
               WHERE job = 'chart' AND status IN ('ok', 'partial')) AS last_chart_ok,
             (SELECT COALESCE(SUM(processed), 0)::int FROM collector_runs
               WHERE job = 'details' AND started_at > NOW() - INTERVAL '6 hours') AS detail_processed,
             (SELECT COALESCE(SUM(failed), 0)::int FROM collector_runs
               WHERE job = 'details' AND started_at > NOW() - INTERVAL '6 hours') AS detail_failed,
             (SELECT COUNT(*)::int FROM apps WHERE details_failures >= 5) AS dead_apps,
             pg_database_size(current_database())::bigint AS storage_bytes`;

    const alerts = evaluateHealth(facts, Date.now());
    if (alerts.length) {
      // 사실을 함께 던진다. collector_runs.error 만 보고도 원인을 좁힐 수 있어야 한다.
      throw new Error(`파이프라인 경보 ${alerts.length}건 — ${alerts.join(' / ')}`);
    }
    return {
      processed: 0,
      healthy: true,
      latestSnapshot: facts.latest_snapshot,
      deadApps: facts.dead_apps,
      storageMb: Number.isFinite(Number(facts.storage_bytes))
        ? Math.round(Number(facts.storage_bytes) / 1024 / 1024) : null
    };
  }

  const jobs = {
    chart: collectChart,
    details: collectDetails,
    discover,
    platforms: collectPlatforms,
    'rollup-hourly': rollupHourly,
    'rollup-daily': rollupDaily,
    prune,
    alerts: sendAlerts,
    newsletter: sendWeekly,
    watchdog
  };

  return {
    ...jobs,
    jobNames: Object.keys(jobs),
    run(name, options) {
      const job = jobs[name];
      if (!job) throw new Error(`알 수 없는 잡: ${name}. 가능한 값: ${Object.keys(jobs).join(', ')}`);
      return withRun(sql, name, () => job(options));
    }
  };
}
