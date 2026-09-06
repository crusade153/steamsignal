-- ============================================================================
-- Steam Pulse — 데이터 파이프라인 스키마 (Neon / PostgreSQL 16+)
--
-- 설계 원칙
--   1. 사용자 요청은 절대 Steam을 호출하지 않는다. 크론만 호출하고, 사용자는 이 DB만 읽는다.
--   2. 시계열은 3단 계층(원시 → 시간 → 일)으로 보관한다. 원시는 버리고 일별은 영구 보존한다.
--   3. 자주 바뀌는 값(가격/동접/리뷰수)과 거의 안 바뀌는 값(제목/장르/설명)을 테이블로 분리한다.
--      -> apps 는 SEO 본문, app_stats 는 매 사이클 UPDATE. MVCC dead tuple 을 좁은 쪽에 가둔다.
--   4. 모든 적재는 멱등하다. 크론이 두 번 돌아도 행이 중복되지 않는다.
--
-- 적용:  psql "$DATABASE_URL_DIRECT" -f db/schema.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. apps — 앱 마스터 / SEO 본문. TOP 100 에 한정하지 않는다.
--    차트에서 내려간 게임도 행을 유지해야 과거 추이 페이지가 살아남는다.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS apps (
  appid              INTEGER      PRIMARY KEY,
  title              TEXT         NOT NULL,
  slug               TEXT,
  header_image       TEXT,
  short_description  TEXT,
  release_date_text  TEXT,
  release_date       DATE,
  developers         TEXT[]       NOT NULL DEFAULT '{}',
  publishers         TEXT[]       NOT NULL DEFAULT '{}',
  genres             TEXT[]       NOT NULL DEFAULT '{}',
  is_free            BOOLEAN,
  metacritic_score   SMALLINT     CHECK (metacritic_score BETWEEN 1 AND 100),
  metacritic_url     TEXT,

  -- 수집 상태 (상세 수집 라운드로빈 커서)
  first_seen_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_charted_at    TIMESTAMPTZ,
  details_fetched_at TIMESTAMPTZ,
  details_failures   SMALLINT     NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN apps.release_date_text IS
  'Steam 원문 문자열. 지역·언어마다 형식이 달라 파싱에 실패해도 원문은 보존한다.';
COMMENT ON COLUMN apps.details_fetched_at IS
  '상세 수집 커서. NULL 이 가장 먼저 처리된다.';
COMMENT ON COLUMN apps.details_failures IS
  '연속 실패 횟수. 임계치를 넘으면 커서 인덱스에서 제외되어 죽은 앱이 큐를 막지 않는다.';

-- 라운드로빈 커서: "가장 오래 안 본 앱 N개". 실패 누적 앱은 부분 인덱스에서 자동 제외.
CREATE INDEX IF NOT EXISTS idx_apps_details_cursor
  ON apps (details_fetched_at NULLS FIRST) WHERE details_failures < 5;
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_slug ON apps (slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_apps_last_charted ON apps (last_charted_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_apps_genres ON apps USING GIN (genres);

-- ---------------------------------------------------------------------------
-- 2. app_stats — "지금 값" 비정규화 캐시. 목록 페이지가 JOIN 한 번으로 끝나게 한다.
--    이력은 아래 시계열 테이블이 갖는다. 여기는 항상 최신 1행.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_stats (
  appid             INTEGER      PRIMARY KEY REFERENCES apps(appid) ON DELETE CASCADE,
  players           INTEGER,
  peak_today        INTEGER,
  rank              SMALLINT,
  players_at        TIMESTAMPTZ,

  final_price       INTEGER,
  initial_price     INTEGER,
  discount_percent  SMALLINT     NOT NULL DEFAULT 0,
  price_formatted   TEXT,
  currency          TEXT         NOT NULL DEFAULT 'KRW',
  price_at          TIMESTAMPTZ,
  discount_end_date DATE,
  discount_end_checked_at TIMESTAMPTZ,

  total_positive    INTEGER,
  total_negative    INTEGER,
  positive_ratio    SMALLINT     CHECK (positive_ratio BETWEEN 0 AND 100),
  review_desc       TEXT,
  reviews_at        TIMESTAMPTZ
);

-- 기존 DB에도 안전하게 추가된다. Steam appdetails에는 종료일이 없어 할인 중인 앱의
-- 한국시간 상점 페이지를 별도로 확인하며, checked_at은 '미제공'과 '아직 미확인'을 구분한다.
ALTER TABLE app_stats ADD COLUMN IF NOT EXISTS discount_end_date DATE;
ALTER TABLE app_stats ADD COLUMN IF NOT EXISTS discount_end_checked_at TIMESTAMPTZ;

COMMENT ON COLUMN app_stats.final_price IS
  'Steam price_overview.final 원값. 통화 최소단위 x100 이다 (₩15,000 -> 1500000). 표시 전 100 으로 나눌 것.';
COMMENT ON COLUMN app_stats.positive_ratio IS
  '반올림 정수 %. 리뷰 0건이면 NULL — 0% 로 저장하지 않는다.';
COMMENT ON COLUMN app_stats.discount_end_date IS
  'Steam 한국시간 상점 페이지가 표시한 할인 종료 달력 날짜. 시각을 제공하지 않으므로 DATE로 보존한다.';
COMMENT ON COLUMN app_stats.discount_end_checked_at IS
  '상점 페이지에서 할인 종료일을 마지막으로 확인한 시각. 날짜 NULL이면 Steam이 종료일을 표시하지 않은 것이다.';

CREATE INDEX IF NOT EXISTS idx_app_stats_rank ON app_stats (rank) WHERE rank IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_stats_discount
  ON app_stats (discount_percent DESC) WHERE discount_percent > 0;

-- ---------------------------------------------------------------------------
-- 3. player_snapshots — 원시 동접. 10분 간격, 7일만 보관.
--    captured_at 은 우리 시계가 아니라 Steam 의 last_update 다.
--    -> 크론이 두 번 돌거나 Steam 이 아직 갱신 전이면 ON CONFLICT 로 조용히 무시된다.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_snapshots (
  appid       INTEGER     NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL,
  players     INTEGER,
  peak_today  INTEGER,
  rank        SMALLINT,
  PRIMARY KEY (appid, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_player_snapshots_time ON player_snapshots (captured_at);

-- ---------------------------------------------------------------------------
-- 4. player_hourly — 시간 롤업. 90일 보관. 상세 페이지의 "최근 7일" 차트가 여기서 나온다.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_hourly (
  appid       INTEGER     NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
  bucket      TIMESTAMPTZ NOT NULL,
  avg_players INTEGER     NOT NULL,
  max_players INTEGER     NOT NULL,
  min_players INTEGER     NOT NULL,
  best_rank   SMALLINT,
  samples     SMALLINT    NOT NULL,
  PRIMARY KEY (appid, bucket)
);
CREATE INDEX IF NOT EXISTS idx_player_hourly_bucket ON player_hourly (bucket);

-- ---------------------------------------------------------------------------
-- 5. player_daily — 일 롤업. 영구 보존. 사이트의 장기 자산이자 SEO 콘텐츠의 본체.
--    day 는 KST 기준이다 (한국 사용자 대상 사이트이므로 UTC 로 자르지 않는다).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_daily (
  appid         INTEGER  NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
  day           DATE     NOT NULL,
  avg_players   INTEGER  NOT NULL,
  peak_observed INTEGER  NOT NULL,
  peak_reported INTEGER,
  min_players   INTEGER  NOT NULL,
  best_rank     SMALLINT,
  samples       SMALLINT NOT NULL,
  PRIMARY KEY (appid, day)
);

COMMENT ON COLUMN player_daily.peak_observed IS
  '우리가 10분 샘플링으로 직접 관측한 최대치.';
COMMENT ON COLUMN player_daily.peak_reported IS
  'Steam 이 알려준 당일 최고 동접(peak_in_game)의 최대값. 샘플링이 놓친 순간 피크까지 포함하므로 역대 최고는 이 값으로 계산한다.';

CREATE INDEX IF NOT EXISTS idx_player_daily_day ON player_daily (day DESC);
CREATE INDEX IF NOT EXISTS idx_player_daily_app_day ON player_daily (appid, day DESC);

-- ---------------------------------------------------------------------------
-- 6. price_events — 가격 변경 로그. 스냅샷이 아니라 변경점만 적는다.
--    "역대 최저가"가 정확히 나오고, 행 수는 연간 수천 건에 그친다.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_events (
  id               BIGSERIAL   PRIMARY KEY,
  appid            INTEGER     NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  currency         TEXT        NOT NULL DEFAULT 'KRW',
  final_price      INTEGER,
  initial_price    INTEGER,
  discount_percent SMALLINT    NOT NULL DEFAULT 0,
  is_free          BOOLEAN
);
CREATE INDEX IF NOT EXISTS idx_price_events_app ON price_events (appid, observed_at DESC);

-- ---------------------------------------------------------------------------
-- 7. review_daily — 리뷰 일별 스냅샷. 누적값이라 일 1행이면 충분하다.
--    전일 대비 차분으로 "최근 30일 신규 리뷰 긍정률"을 만들 수 있다 — Steam 화면과 다른 우리 콘텐츠.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_daily (
  appid          INTEGER  NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
  day            DATE     NOT NULL,
  total_positive INTEGER  NOT NULL,
  total_negative INTEGER  NOT NULL,
  score_desc     TEXT,
  PRIMARY KEY (appid, day)
);

-- ---------------------------------------------------------------------------
-- 8. collector_runs — 수집 실행 로그. 관측 없는 파이프라인은 조용히 썩는다.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collector_runs (
  id          BIGSERIAL   PRIMARY KEY,
  job         TEXT        NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status      TEXT        NOT NULL DEFAULT 'running'
              CHECK (status IN ('running', 'ok', 'partial', 'error')),
  processed   INTEGER     NOT NULL DEFAULT 0,
  failed      INTEGER     NOT NULL DEFAULT 0,
  detail      JSONB,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_collector_runs_job ON collector_runs (job, started_at DESC);

-- ---------------------------------------------------------------------------
-- 9. subscribers — 이메일 구독자. **이 사이트가 개인정보를 보관하는 유일한 테이블이다.**
--
--    설계 규율 셋. 셋 다 어기면 법적 문제이거나 스팸 신고로 도메인이 죽는다.
--      1. 더블 옵트인. confirmed_at 이 NULL 인 주소로는 확인 메일 외에 아무것도 보내지 않는다.
--      2. 모든 메일에 수신거부 링크. unsubscribe_token 은 주소마다 하나이며 영구적이다.
--      3. IP·User-Agent 를 남기지 않는다. 그래서 남용 방지도 IP 가 아니라
--         '주소별 재발송 간격 + 시간당 미확인 가입 상한'으로 한다(lib/alerts.mjs).
--
--    해지는 행을 지우지 않고 unsubscribed_at 을 찍는다. 지워 버리면 같은 주소가
--    재가입할 때 "예전에 거부했던 사람"인지 알 수 없어 다시 메일을 보내게 된다.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscribers (
  id                BIGSERIAL   PRIMARY KEY,
  email             TEXT        NOT NULL UNIQUE,
  confirm_token     TEXT        NOT NULL UNIQUE,
  unsubscribe_token TEXT        NOT NULL UNIQUE,
  weekly_report     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirm_sent_at   TIMESTAMPTZ,
  confirmed_at      TIMESTAMPTZ,
  unsubscribed_at   TIMESTAMPTZ,
  last_sent_at      TIMESTAMPTZ,
  send_failures     SMALLINT    NOT NULL DEFAULT 0
);

COMMENT ON COLUMN subscribers.email IS
  '소문자로 정규화해서 넣는다. 대소문자만 다른 중복 가입이 생기면 같은 사람에게 두 번 발송된다.';
COMMENT ON COLUMN subscribers.confirmed_at IS
  '더블 옵트인 완료 시각. NULL 이면 확인 메일 외에는 무엇도 보내지 않는다.';
COMMENT ON COLUMN subscribers.unsubscribed_at IS
  '해지 시각. 행을 지우지 않는 이유는 재가입 시 과거 거부 이력을 잃지 않기 위해서다.';

-- 발송 대상 조회는 항상 "확인됐고 해지하지 않은" 조건이라 부분 인덱스가 정확히 맞는다.
CREATE INDEX IF NOT EXISTS idx_subscribers_active
  ON subscribers (id) WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 10. price_alerts — 게임별 가격 하락 알림 구독.
--     notified_price 는 워터마크다. 한 번 알린 가격보다 더 내려갔을 때만 다시 알린다.
--     -> 같은 할인으로 10분마다 메일이 가는 사고를 이 컬럼 하나가 막는다.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_alerts (
  id             BIGSERIAL   PRIMARY KEY,
  subscriber_id  BIGINT      NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  appid          INTEGER     NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
  target_price   INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at    TIMESTAMPTZ,
  notified_price INTEGER,
  UNIQUE (subscriber_id, appid)
);

COMMENT ON COLUMN price_alerts.target_price IS
  '통화 최소단위 x100 (app_stats.final_price 와 같은 단위). NULL 이면 "할인이 시작되면 언제든".';
COMMENT ON COLUMN price_alerts.notified_price IS
  '마지막으로 알린 가격. 가격이 다시 오르면 lib/collect.mjs 의 alerts 잡이 NULL 로 되돌린다.';

CREATE INDEX IF NOT EXISTS idx_price_alerts_app ON price_alerts (appid);

-- ---------------------------------------------------------------------------
-- 11. mail_deliveries — 발송 원장. **보내기 전에 먼저 쓴다.**
--     dedupe_key 의 UNIQUE 제약이 "이미 보냈다"를 판정하는 유일한 근거다.
--     크론이 두 번 돌거나 발송 도중 함수가 죽어도 같은 메일이 두 번 나가지 않는다
--     (죽으면 pending 으로 남고 재발송하지 않는다 — 중복 발송보다 누락이 낫다).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_deliveries (
  id            BIGSERIAL   PRIMARY KEY,
  subscriber_id BIGINT      REFERENCES subscribers(id) ON DELETE CASCADE,
  kind          TEXT        NOT NULL CHECK (kind IN ('confirm', 'alert', 'weekly')),
  dedupe_key    TEXT        NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at       TIMESTAMPTZ,
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sent', 'error')),
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_deliveries_time ON mail_deliveries (created_at DESC);

-- ---------------------------------------------------------------------------
-- 12. users — 회원 계정.
--
--     이 사이트는 오랫동안 계정을 만들지 않았다. 위시리스트는 localStorage,
--     알림은 이메일 하나면 충분했기 때문이다. 2026-09-06 에 운영자가 방향을 바꿨고,
--     그 판단의 근거와 대가는 docs/PRODUCT.md §7 에 적혀 있다.
--
--     설계 규율 넷.
--       1. **비밀번호 원문을 저장하지 않는다.** scrypt 해시만 남기고, 그 문자열 안에
--          파라미터·솔트를 함께 담는다(나중에 비용을 올려도 기존 계정이 계속 로그인된다).
--       2. **계정과 구독은 별개다.** 계정 없이도 이메일 알림을 받을 수 있어야 하고,
--          계정을 지워도 그 사람이 따로 신청한 구독까지 말없이 지우지 않는다.
--          연결이 필요할 때만 subscriber_id 가 채워진다.
--       3. **IP·User-Agent 를 남기지 않는다.** subscribers 와 같은 규율이다.
--          그래서 남용 방지도 IP 가 아니라 계정별 실패 횟수와 잠금 시각으로 한다.
--       4. **탈퇴는 진짜 삭제다.** 행을 남겨 두지 않는다. 세션·위시리스트는 CASCADE 로 함께 사라진다.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             BIGSERIAL   PRIMARY KEY,
  email          TEXT        NOT NULL UNIQUE,
  password_hash  TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at  TIMESTAMPTZ,
  failed_logins  SMALLINT    NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  subscriber_id  BIGINT      REFERENCES subscribers(id) ON DELETE SET NULL
);

COMMENT ON COLUMN users.email IS
  '소문자로 정규화해서 넣는다. 대소문자만 다른 중복 계정이 생기면 같은 사람이 둘이 된다.';
COMMENT ON COLUMN users.password_hash IS
  'scrypt$N$r$p$salt$hash (전부 base64url). 파라미터를 문자열에 담아 두면 나중에 비용을 올려도 기존 계정이 계속 로그인된다.';
COMMENT ON COLUMN users.locked_until IS
  '연속 실패가 쌓이면 잠근다. IP 를 저장하지 않기 때문에 남용 방지 수단이 이것뿐이다.';

-- ---------------------------------------------------------------------------
-- 13. user_sessions — 로그인 세션.
--
--     **토큰 원문을 저장하지 않는다.** 쿠키에는 무작위 32바이트가 들어가고 DB 에는
--     그 SHA-256 만 남는다. DB 가 통째로 새어도 그것만으로는 남의 세션을 못 만든다.
--     (해시 대상이 고엔트로피 난수라 salt 없이 SHA-256 으로 충분하다.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash   TEXT        PRIMARY KEY,
  user_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- 14. user_watchlist — 계정에 저장한 위시리스트.
--
--     로그인하지 않은 사람의 위시리스트는 여전히 브라우저에만 있다(CLAUDE.md 규칙 10).
--     로그인하면 이 표가 기기 사이의 공통본이 된다 — 브라우저의 목록과 합쳐서 저장한다.
--     **합치되 지우지 않는다**: 다른 기기에서 담은 게임이 이 기기의 목록에 없다고 해서
--     사라지면, 사용자는 그걸 '동기화'가 아니라 '분실'로 겪는다.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_watchlist (
  user_id  BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appid    INTEGER     NOT NULL REFERENCES apps(appid) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, appid)
);
CREATE INDEX IF NOT EXISTS idx_user_watchlist_app ON user_watchlist (appid);
