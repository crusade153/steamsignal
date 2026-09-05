// 읽기 전용 쿼리 모음. 사용자 요청은 여기만 통과하며 Steam 을 절대 호출하지 않는다.
// 규칙 3가지
//   1. SELECT * 를 쓰지 않는다. 컬럼이 늘어나면 응답이 조용히 커진다.
//   2. 모든 목록 쿼리에 LIMIT 을 건다. 앱이 10,000개가 돼도 페이지가 터지지 않는다.
//   3. DATE 컬럼은 TO_CHAR 로 문자열로 꺼낸다.
//      드라이버가 DATE 를 로컬 자정 Date 객체로 돌려주기 때문에, 화면단에서 toISOString()
//      한 번만 잘못 쓰면 하루가 밀린다. 애초에 문자열로 받으면 그 실수가 불가능해진다.

const clampLimit = (value, fallback, max) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), max) : fallback;
};

// --- 목록 ------------------------------------------------------------------

// 현재 TOP 100. 프런트 목록과 /api/games 가 함께 쓴다.
export function chartTop(sql, limit = 100) {
  return sql`
    SELECT a.appid, a.title, a.slug, a.header_image, a.genres, a.metacritic_score, a.metacritic_url,
           s.players, s.peak_today, s.rank,
           s.final_price, s.initial_price, s.discount_percent, s.price_formatted,
           s.positive_ratio, s.total_positive, s.total_negative,
           s.review_desc, s.players_at, s.price_at, s.reviews_at
      FROM app_stats s
      JOIN apps a USING (appid)
     WHERE s.rank IS NOT NULL
     ORDER BY s.rank
     LIMIT ${clampLimit(limit, 100, 200)}`;
}

// --- 게임 상세 --------------------------------------------------------------

export function appById(sql, appid) {
  return sql`
    SELECT a.appid, a.title, a.slug, a.header_image, a.short_description,
           a.release_date_text, TO_CHAR(a.release_date, 'YYYY-MM-DD') AS release_date,
           a.developers, a.publishers, a.genres, a.is_free,
           a.metacritic_score, a.metacritic_url, a.details_fetched_at, a.last_charted_at,
           s.players, s.peak_today, s.rank, s.players_at,
           s.final_price, s.initial_price, s.discount_percent, s.price_formatted, s.currency, s.price_at,
           s.total_positive, s.total_negative, s.positive_ratio, s.review_desc, s.reviews_at
      FROM apps a
      LEFT JOIN app_stats s USING (appid)
     WHERE a.appid = ${appid}`;
}

// 최근 N일 시간 롤업. 상세 페이지 동접 차트의 기본 재료.
export function playerHourly(sql, appid, days = 7) {
  return sql`
    SELECT bucket, avg_players, max_players, min_players
      FROM player_hourly
     WHERE appid = ${appid}
       AND bucket >= NOW() - (${clampLimit(days, 7, 90)} || ' days')::interval
     ORDER BY bucket
     LIMIT 2200`;
}

// 최근 N일 일 롤업. 시간 롤업이 아직 얇을 때의 대체 재료이자 장기 추세.
export function playerDaily(sql, appid, days = 90) {
  return sql`
    SELECT TO_CHAR(day, 'YYYY-MM-DD') AS day,
           avg_players, peak_observed, peak_reported, min_players, best_rank
      FROM player_daily
     WHERE appid = ${appid}
       AND day >= (NOW() AT TIME ZONE 'Asia/Seoul')::date - ${clampLimit(days, 90, 3650)}::int
     ORDER BY day
     LIMIT 3700`;
}

// 역대 최고 동접. peak_reported 는 Steam 이 준 당일 최고치라 우리 샘플링이 놓친 순간까지 담는다.
export function peakAllTime(sql, appid) {
  return sql`
    SELECT TO_CHAR(day, 'YYYY-MM-DD') AS day, peak_reported
      FROM player_daily
     WHERE appid = ${appid} AND peak_reported IS NOT NULL
     ORDER BY peak_reported DESC, day ASC
     LIMIT 1`;
}

// 역대 최저가. 무료 전환(0원)은 '할인'이 아니므로 제외한다.
export function priceLow(sql, appid) {
  return sql`
    SELECT final_price, initial_price, discount_percent, observed_at
      FROM price_events
     WHERE appid = ${appid} AND final_price IS NOT NULL AND final_price > 0
     ORDER BY final_price ASC, observed_at ASC
     LIMIT 1`;
}

export function priceHistory(sql, appid, limit = 12) {
  return sql`
    SELECT final_price, initial_price, discount_percent, observed_at
      FROM price_events
     WHERE appid = ${appid}
     ORDER BY observed_at DESC
     LIMIT ${clampLimit(limit, 12, 60)}`;
}

// 최근 N일 신규 리뷰. 누적값의 차분이라 Steam 이 리뷰를 지우면 음수가 될 수 있어 GREATEST 로 막는다.
// 표본이 2일 미만이면 차분이 0 이라 의미가 없으므로 samples 를 함께 돌려준다.
export function reviewTrend(sql, appid, days = 30) {
  return sql`
    SELECT COUNT(*)::int AS samples,
           GREATEST(MAX(total_positive) - MIN(total_positive), 0)::int AS new_positive,
           GREATEST(MAX(total_negative) - MIN(total_negative), 0)::int AS new_negative,
           TO_CHAR(MIN(day), 'YYYY-MM-DD') AS from_day,
           TO_CHAR(MAX(day), 'YYYY-MM-DD') AS to_day
      FROM review_daily
     WHERE appid = ${appid}
       AND day >= (NOW() AT TIME ZONE 'Asia/Seoul')::date - ${clampLimit(days, 30, 365)}::int`;
}

// 같은 장르의 다른 인기작. 내부 링크가 없으면 상세 페이지는 크롤러에게 막다른 길이다.
export function relatedByGenre(sql, appid, genres, limit = 6) {
  return sql`
    SELECT a.appid, a.title, a.slug, a.header_image, s.players, s.rank, s.positive_ratio
      FROM apps a
      JOIN app_stats s USING (appid)
     WHERE a.appid <> ${appid}
       AND a.genres && ${genres}::text[]
       AND s.players IS NOT NULL
     ORDER BY s.players DESC
     LIMIT ${clampLimit(limit, 6, 24)}`;
}

// --- 파생 페이지 ------------------------------------------------------------

// 급상승: 최근 구간 평균 vs 직전 구간 평균. Steam 이 주지 않는 우리만의 콘텐츠다.
// 창(window)을 인자로 받는 이유는 적재 초기에 8일치가 없기 때문이다.
// 호출부가 넓은 창부터 시도해 내려오고, 실제로 쓴 창을 화면에 표기한다.
export function rising(sql, { recentHours = 24, pastHours = 192, minPlayers = 1000, limit = 24 } = {}) {
  const recent = clampLimit(recentHours, 24, 720);
  const past = clampLimit(pastHours, 192, 2160);
  return sql`
    WITH recent AS (
      SELECT appid, AVG(avg_players)::int AS players, MAX(max_players) AS peak, COUNT(*)::int AS samples
        FROM player_hourly
       WHERE bucket >= NOW() - (${recent} || ' hours')::interval
       GROUP BY appid
    ), past AS (
      SELECT appid, AVG(avg_players)::int AS players, COUNT(*)::int AS samples
        FROM player_hourly
       WHERE bucket >= NOW() - (${past} || ' hours')::interval
         AND bucket <  NOW() - (${recent} || ' hours')::interval
       GROUP BY appid
    )
    SELECT a.appid, a.title, a.slug, a.header_image, a.genres,
           r.players AS now_players, p.players AS past_players, r.peak AS now_peak,
           r.samples AS recent_samples, p.samples AS past_samples,
           ROUND((r.players - p.players) * 100.0 / NULLIF(p.players, 0), 1)::float8 AS change_pct,
           s.positive_ratio, s.rank
      FROM recent r
      JOIN past p USING (appid)
      JOIN apps a USING (appid)
      LEFT JOIN app_stats s USING (appid)
     WHERE p.players >= ${clampLimit(minPlayers, 1000, 1000000)}
       AND r.players > p.players
     ORDER BY change_pct DESC NULLS LAST
     LIMIT ${clampLimit(limit, 24, 100)}`;
}

// 고평가 할인. 할인율만 높은 저평가작을 걸러내는 게 이 페이지의 존재 이유다.
// 역대 최저가 여부는 price_events 전체 최저와 현재가를 맞춰 판정한다.
export function deals(sql, { minRatio = 75, limit = 40 } = {}) {
  return sql`
    WITH lows AS (
      SELECT appid, MIN(final_price) AS lowest
        FROM price_events
       WHERE final_price IS NOT NULL AND final_price > 0
       GROUP BY appid
    )
    SELECT a.appid, a.title, a.slug, a.header_image, a.genres, a.metacritic_score,
           s.final_price, s.initial_price, s.discount_percent, s.price_formatted,
           s.positive_ratio, s.total_positive, s.total_negative, s.players, s.rank,
           lows.lowest AS lowest_price,
           (lows.lowest IS NOT NULL AND s.final_price IS NOT NULL AND s.final_price <= lows.lowest) AS at_lowest
      FROM app_stats s
      JOIN apps a USING (appid)
      LEFT JOIN lows USING (appid)
     WHERE s.discount_percent > 0
       AND s.final_price IS NOT NULL
       AND (s.positive_ratio IS NULL OR s.positive_ratio >= ${clampLimit(minRatio, 75, 100)})
     ORDER BY (s.positive_ratio IS NOT NULL) DESC, s.discount_percent DESC, s.positive_ratio DESC NULLS LAST
     LIMIT ${clampLimit(limit, 40, 100)}`;
}

// 주간 차트: 최근 N일 일 롤업의 평균 동접 순위. 순간 순위와 달리 하루짜리 이벤트에 흔들리지 않는다.
export function weekly(sql, { days = 7, limit = 50 } = {}) {
  const window = clampLimit(days, 7, 90);
  return sql`
    WITH agg AS (
      SELECT appid,
             AVG(avg_players)::int AS avg_players,
             MAX(COALESCE(peak_reported, peak_observed)) AS peak_players,
             MIN(best_rank) AS best_rank,
             COUNT(*)::int AS days,
             SUM(samples)::int AS samples
        FROM player_daily
       WHERE day >= (NOW() AT TIME ZONE 'Asia/Seoul')::date - ${window}::int
       GROUP BY appid
    )
    SELECT a.appid, a.title, a.slug, a.header_image, a.genres,
           g.avg_players, g.peak_players, g.best_rank, g.days, g.samples,
           s.positive_ratio, s.rank AS current_rank, s.players AS current_players
      FROM agg g
      JOIN apps a USING (appid)
      LEFT JOIN app_stats s USING (appid)
     ORDER BY g.avg_players DESC
     LIMIT ${clampLimit(limit, 50, 100)}`;
}

// 장르 허브. 장르는 apps.genres 배열이며 GIN 인덱스가 걸려 있다.
export function genreList(sql, limit = 60) {
  return sql`
    SELECT genre, COUNT(*)::int AS games, MAX(s.players) AS top_players
      FROM apps a
      CROSS JOIN LATERAL UNNEST(a.genres) AS genre
      LEFT JOIN app_stats s ON s.appid = a.appid
     GROUP BY genre
    HAVING COUNT(*) >= 2
     ORDER BY games DESC, genre
     LIMIT ${clampLimit(limit, 60, 200)}`;
}

export function genreGames(sql, genre, limit = 60) {
  return sql`
    SELECT a.appid, a.title, a.slug, a.header_image, a.genres, a.metacritic_score,
           TO_CHAR(a.release_date, 'YYYY-MM-DD') AS release_date,
           s.players, s.peak_today, s.rank, s.positive_ratio, s.total_positive, s.total_negative,
           s.final_price, s.discount_percent, s.price_formatted
      FROM apps a
      LEFT JOIN app_stats s USING (appid)
     WHERE a.genres @> ARRAY[${genre}]::text[]
     ORDER BY s.players DESC NULLS LAST, a.appid
     LIMIT ${clampLimit(limit, 60, 200)}`;
}

// --- 사이트맵 / 운영 --------------------------------------------------------

// 색인 대상 앱. 제목이 아직 임시값인 앱은 내보내지 않는다 — 크롤러에 빈 페이지를 먹이면 손해다.
export function sitemapApps(sql, limit = 5000) {
  return sql`
    SELECT appid, slug, updated_at, last_charted_at
      FROM apps
     WHERE title IS NOT NULL
       AND title <> ('Steam 앱 ' || appid)
     ORDER BY last_charted_at DESC NULLS LAST, appid
     LIMIT ${clampLimit(limit, 5000, 45000)}`;
}

export function pipelineHealth(sql) {
  return sql`
    SELECT job, status, processed, failed, started_at, finished_at
      FROM collector_runs
     ORDER BY started_at DESC
     LIMIT 20`;
}
