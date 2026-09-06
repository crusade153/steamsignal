-- ============================================================================
-- Steam Pulse — 롤업 / 보관정책 함수
--
-- 집계는 Node 로 행을 끌어오지 않고 DB 안에서 끝낸다.
--   -> Vercel Fast Origin Transfer(무료 10GB/월)와 Active CPU 를 아끼는 가장 큰 한 수.
-- 모든 함수는 멱등하다. 몇 번을 돌려도 같은 결과가 된다.
--
-- 적용:  psql "$DATABASE_URL_DIRECT" -f db/functions.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 시간 롤업. 최근 p_hours 시간만 다시 계산한다(진행 중인 버킷이 갱신되도록 겹쳐서 돌린다).
--
-- **창은 반드시 버킷 경계로 스냅한다.** NOW() 에서 그냥 빼면 창의 시작점이 버킷 한가운데에
-- 떨어지고, 가장 오래된 버킷은 그 조각만으로 집계된다. ON CONFLICT DO UPDATE 가
-- 한 시간 전에 온전히 계산해 둔 값을 그 조각으로 덮어쓰고, 다음 실행 때는 이미 창 밖이라
-- 영영 복구되지 않는다. 실제로 이 잡이 :37 에 도는 동안 모든 버킷이
-- 6표본이 아니라 마지막 2표본(=17분)만 담고 있었다 — 평균이 최대 7% 어긋났다.
-- tests/rollup.test.mjs 가 이 불변식을 지킨다.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rollup_player_hourly(p_hours INTEGER DEFAULT 3)
RETURNS INTEGER AS $$
DECLARE
  affected INTEGER;
BEGIN
  INSERT INTO player_hourly (appid, bucket, avg_players, max_players, min_players, best_rank, samples)
  SELECT appid,
         date_trunc('hour', captured_at),
         ROUND(AVG(players))::INTEGER,
         MAX(players),
         MIN(players),
         MIN(rank)::SMALLINT,
         COUNT(*)::SMALLINT
    FROM player_snapshots
   WHERE captured_at >= date_trunc('hour', NOW() - make_interval(hours => p_hours))
     AND players IS NOT NULL
   GROUP BY appid, date_trunc('hour', captured_at)
      ON CONFLICT (appid, bucket) DO UPDATE
     SET avg_players = EXCLUDED.avg_players,
         max_players = EXCLUDED.max_players,
         min_players = EXCLUDED.min_players,
         best_rank   = EXCLUDED.best_rank,
         samples     = EXCLUDED.samples;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 일 롤업. KST 기준으로 자른다. 원시 스냅샷을 7일 보관하므로 기본 2일 겹치기면 충분하다.
-- peak_reported 는 Steam 이 준 당일 최고치라 우리 샘플링이 놓친 피크까지 포함한다.
--
-- **창은 반드시 KST 자정으로 스냅한다.** 시간 롤업과 같은 이유다 — NOW() 에서 그냥 빼면
-- 창의 시작점이 D-2 의 '지금 시각'에 떨어져서, 이 잡이 03:41 에 도는 동안
-- D-2 의 00:00~03:41 이 빠진 평균이 온전한 값을 덮어쓴다. 하루가 지나면 창 밖이라
-- 그 잘린 값이 영구 보관된다 — 일 롤업은 prune 이 지우지 않기 때문에 더욱 그렇다.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rollup_player_daily(p_days INTEGER DEFAULT 2)
RETURNS INTEGER AS $$
DECLARE
  affected INTEGER;
BEGIN
  INSERT INTO player_daily (appid, day, avg_players, peak_observed, peak_reported, min_players, best_rank, samples)
  SELECT appid,
         (captured_at AT TIME ZONE 'Asia/Seoul')::DATE,
         ROUND(AVG(players))::INTEGER,
         MAX(players),
         MAX(peak_today),
         MIN(players),
         MIN(rank)::SMALLINT,
         COUNT(*)::SMALLINT
    FROM player_snapshots
   WHERE captured_at >= ((((NOW() AT TIME ZONE 'Asia/Seoul')::DATE - p_days)::TIMESTAMP)
                          AT TIME ZONE 'Asia/Seoul')
     AND players IS NOT NULL
   GROUP BY appid, (captured_at AT TIME ZONE 'Asia/Seoul')::DATE
      ON CONFLICT (appid, day) DO UPDATE
     SET avg_players   = EXCLUDED.avg_players,
         peak_observed = EXCLUDED.peak_observed,
         peak_reported = GREATEST(player_daily.peak_reported, EXCLUDED.peak_reported),
         min_players   = EXCLUDED.min_players,
         best_rank     = LEAST(player_daily.best_rank, EXCLUDED.best_rank),
         samples       = EXCLUDED.samples;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 보관정책. 원시는 7일, 시간 롤업은 90일. 일 롤업은 지우지 않는다.
-- 이 함수가 없으면 Neon 무료 0.5GB 를 1년 안에 넘긴다 — 파이프라인의 필수 부품이다.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prune_timeseries(
  p_snapshot_days INTEGER DEFAULT 7,
  p_hourly_days   INTEGER DEFAULT 90
)
RETURNS TABLE (snapshots_deleted BIGINT, hourly_deleted BIGINT) AS $$
DECLARE
  snaps BIGINT;
  hours BIGINT;
BEGIN
  DELETE FROM player_snapshots WHERE captured_at < NOW() - make_interval(days => p_snapshot_days);
  GET DIAGNOSTICS snaps = ROW_COUNT;

  DELETE FROM player_hourly WHERE bucket < NOW() - make_interval(days => p_hourly_days);
  GET DIAGNOSTICS hours = ROW_COUNT;

  -- 90일 넘게 차트에 없었고 상세도 계속 실패하는 앱은 마스터에서 정리한다.
  -- ON DELETE CASCADE 로 딸린 시계열도 함께 사라진다.
  DELETE FROM apps
   WHERE details_failures >= 5
     AND COALESCE(last_charted_at, first_seen_at) < NOW() - INTERVAL '90 days';

  RETURN QUERY SELECT snaps, hours;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 오래된 실행 로그 정리 (30일).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prune_collector_runs(p_days INTEGER DEFAULT 30)
RETURNS BIGINT AS $$
DECLARE
  affected BIGINT;
BEGIN
  DELETE FROM collector_runs WHERE started_at < NOW() - make_interval(days => p_days);
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 구독 데이터 보관정책. 시계열과 달리 이건 **개인정보**라 용량이 아니라 원칙의 문제다.
-- 보관할 근거가 사라진 주소는 지운다.
--
--   확인하지 않은 가입  -> 30일. 동의하지 않은 주소를 계속 들고 있을 이유가 없다.
--   해지한 주소         -> 30일. 그 뒤 재가입하려면 본인이 다시 더블 옵트인을 해야 한다.
--   발송 원장           -> 90일. 중복 발송 판정은 그보다 짧은 기간만 필요하다.
--
-- 이 기간은 /privacy 에 그대로 적혀 있다. 여기를 고치면 그 페이지도 같이 고친다.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prune_subscriptions(
  p_pending_days   INTEGER DEFAULT 30,
  p_dropped_days   INTEGER DEFAULT 30,
  p_delivery_days  INTEGER DEFAULT 90
)
RETURNS TABLE (pending_deleted BIGINT, dropped_deleted BIGINT, deliveries_deleted BIGINT) AS $$
DECLARE
  pending    BIGINT;
  dropped    BIGINT;
  deliveries BIGINT;
BEGIN
  DELETE FROM subscribers
   WHERE confirmed_at IS NULL
     AND created_at < NOW() - make_interval(days => p_pending_days);
  GET DIAGNOSTICS pending = ROW_COUNT;

  DELETE FROM subscribers
   WHERE unsubscribed_at IS NOT NULL
     AND unsubscribed_at < NOW() - make_interval(days => p_dropped_days);
  GET DIAGNOSTICS dropped = ROW_COUNT;

  DELETE FROM mail_deliveries WHERE created_at < NOW() - make_interval(days => p_delivery_days);
  GET DIAGNOSTICS deliveries = ROW_COUNT;

  RETURN QUERY SELECT pending, dropped, deliveries;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 만료 세션 정리. 용량이 아니라 원칙의 문제다 — 쓸 수 없게 된 세션을 계속 들고 있을 이유가 없다.
-- prune 잡이 하루 한 번 부른다.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prune_sessions()
RETURNS BIGINT AS $$
DECLARE
  affected BIGINT;
BEGIN
  DELETE FROM user_sessions WHERE expires_at < NOW();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$ LANGUAGE plpgsql;
