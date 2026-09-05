// 구독 — 이 파일만 사용자 요청 경로에서 **쓰기**를 한다.
//
// lib/queries.mjs 는 읽기 전용이라는 규율을 그대로 두려고 쓰기를 여기로 몰았다.
// 읽기 경로의 다른 규율은 그대로다: Steam 은 부르지 않고, 값은 전부 esc() 를 통과한다.
//
// 남용 방지는 IP 를 저장하지 않고 한다(개인정보를 늘리지 않는 게 우선이다).
//   1. 주소마다 확인 메일 재발송 간격 10분
//   2. 시간당 미확인 가입 상한 — 넘으면 새 가입만 잠시 거절한다
// 둘 다 '우리 메일 할당량과 남의 메일함'을 지키기 위한 것이다.
import { randomBytes } from 'node:crypto';

export const CONFIRM_RESEND_MS = 10 * 60_000;
export const PENDING_SIGNUPS_PER_HOUR = 100;
export const MAX_ALERTS_PER_SUBSCRIBER = 50;

// 가격은 통화 최소단위 x100 으로 저장한다(app_stats.final_price 와 같은 단위).
// 사용자는 원 단위로 입력하므로 여기서 한 번만 곱한다.
export const MAX_TARGET_WON = 1_000_000;

export const randomToken = () => randomBytes(24).toString('base64url');

// 이메일 검증은 "보낼 수 있는 모양인가"까지만 본다. 정규식으로 RFC 를 흉내 내면
// 멀쩡한 주소를 거절하게 된다. 진짜 검증은 확인 메일이 도착하는지 여부다.
export function normalizeEmail(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value.length < 6 || value.length > 254) return null;
  if (!/^[^\s@,;<>"']+@[^\s@,;<>"'.]+(\.[^\s@,;<>"'.]+)+$/.test(value)) return null;
  return value;
}

// 목표가. 빈 값이면 null 이고, 그건 "할인이 시작되면 언제든"이라는 뜻이다.
export function parseTargetPrice(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { ok: true, value: null };
  const won = Number(String(raw).replace(/[,\s원]/g, ''));
  if (!Number.isFinite(won) || won < 0 || won > MAX_TARGET_WON) return { ok: false, value: null };
  return { ok: true, value: Math.round(won) * 100 };
}

export function parseAppid(raw) {
  const appid = Number(raw);
  return Number.isSafeInteger(appid) && appid > 0 && appid < 2 ** 31 ? appid : null;
}

// --- 가입 -------------------------------------------------------------------

/**
 * 구독 신청. 항상 같은 결과 모양을 돌려준다 — 이미 가입한 주소인지 아닌지를
 * 응답으로 구분할 수 있으면 그 자체가 주소 존재 확인 도구가 된다.
 * 실제 발송 여부(needsConfirm)는 호출부만 알고 화면에는 나가지 않는다.
 */
export async function subscribe(sql, { email, appid = null, targetPrice = null, weekly = false }) {
  const address = normalizeEmail(email);
  if (!address) return { ok: false, reason: 'email' };

  if (appid !== null) {
    const [app] = await sql`SELECT appid FROM apps WHERE appid = ${appid}`;
    if (!app) return { ok: false, reason: 'app' };
  }
  // 게임 알림도 주간 리포트도 아니면 신청할 것이 없다.
  if (appid === null && !weekly) return { ok: false, reason: 'empty' };

  const [{ pending }] = await sql`
    SELECT COUNT(*)::int AS pending
      FROM subscribers
     WHERE confirmed_at IS NULL AND created_at > NOW() - INTERVAL '1 hour'`;
  if (pending >= PENDING_SIGNUPS_PER_HOUR) return { ok: false, reason: 'busy' };

  // 해지했던 주소가 다시 신청하면 해지 표시를 풀되 **확인은 처음부터 다시 받는다.**
  // 예전 동의를 재사용하면 그건 더 이상 옵트인이 아니다.
  const [row] = await sql`
    INSERT INTO subscribers (email, confirm_token, unsubscribe_token, weekly_report)
    VALUES (${address}, ${randomToken()}, ${randomToken()}, ${weekly})
        ON CONFLICT (email) DO UPDATE
       SET weekly_report    = subscribers.weekly_report OR EXCLUDED.weekly_report,
           unsubscribed_at  = NULL,
           confirmed_at     = CASE WHEN subscribers.unsubscribed_at IS NOT NULL THEN NULL ELSE subscribers.confirmed_at END,
           confirm_token    = CASE WHEN subscribers.unsubscribed_at IS NOT NULL THEN EXCLUDED.confirm_token ELSE subscribers.confirm_token END,
           send_failures    = 0
     RETURNING id, email, confirm_token, unsubscribe_token, confirmed_at, confirm_sent_at`;

  if (appid !== null) {
    const [{ alerts }] = await sql`
      SELECT COUNT(*)::int AS alerts FROM price_alerts WHERE subscriber_id = ${row.id}`;
    const [existing] = await sql`
      SELECT id FROM price_alerts WHERE subscriber_id = ${row.id} AND appid = ${appid}`;
    if (!existing && alerts >= MAX_ALERTS_PER_SUBSCRIBER) return { ok: false, reason: 'limit' };

    // notified_price 를 **신청 시점 가격으로 채워 둔다.** 이게 없으면 이미 할인 중인 게임을
    // 신청한 순간 "가격이 내려갔습니다" 메일이 즉시 날아간다 — 내려간 게 아닌데도.
    await sql`
      INSERT INTO price_alerts (subscriber_id, appid, target_price, notified_price)
      SELECT ${row.id}, ${appid}, ${targetPrice},
             (SELECT final_price FROM app_stats WHERE appid = ${appid})
          ON CONFLICT (subscriber_id, appid) DO UPDATE
         SET target_price   = EXCLUDED.target_price,
             notified_price = EXCLUDED.notified_price,
             notified_at    = NULL`;
  }

  const confirmed = Boolean(row.confirmed_at);
  const resendReady = !row.confirm_sent_at || Date.now() - new Date(row.confirm_sent_at).getTime() > CONFIRM_RESEND_MS;
  return {
    ok: true,
    subscriber: row,
    confirmed,
    // 확인 메일은 미확인 주소에만, 그것도 10분에 한 번만 보낸다.
    needsConfirm: !confirmed && resendReady
  };
}

export async function markConfirmSent(sql, id) {
  await sql`UPDATE subscribers SET confirm_sent_at = NOW() WHERE id = ${id}`;
}

// --- 확인 / 해지 ------------------------------------------------------------

export async function confirmSubscription(sql, token) {
  if (!token || String(token).length > 200) return { state: 'unknown' };
  const [row] = await sql`
    SELECT id, email, confirmed_at, unsubscribed_at, unsubscribe_token
      FROM subscribers WHERE confirm_token = ${String(token)}`;
  if (!row) return { state: 'unknown' };
  if (row.confirmed_at && !row.unsubscribed_at) return { state: 'already', subscriber: row };

  await sql`
    UPDATE subscribers
       SET confirmed_at = COALESCE(confirmed_at, NOW()), unsubscribed_at = NULL
     WHERE id = ${row.id}`;
  return { state: 'confirmed', subscriber: row };
}

// 해지는 되돌릴 수 있어야 한다(다시 신청하면 된다). 행을 지우지 않고 표시만 남긴다.
// 알림 구독은 함께 지운다 — 남겨 둘 근거가 없다.
export async function unsubscribeByToken(sql, token) {
  if (!token || String(token).length > 200) return { state: 'unknown' };
  const [row] = await sql`
    SELECT id, email, unsubscribed_at FROM subscribers WHERE unsubscribe_token = ${String(token)}`;
  if (!row) return { state: 'unknown' };
  if (row.unsubscribed_at) return { state: 'already', subscriber: row };

  await sql`DELETE FROM price_alerts WHERE subscriber_id = ${row.id}`;
  await sql`
    UPDATE subscribers
       SET unsubscribed_at = NOW(), weekly_report = FALSE, confirm_sent_at = NULL
     WHERE id = ${row.id}`;
  return { state: 'unsubscribed', subscriber: row };
}

// --- 발송 원장 --------------------------------------------------------------

// **보내기 전에** 자리를 잡는다. UNIQUE(dedupe_key) 가 걸리면 이미 누군가 보냈거나
// 보내는 중이라는 뜻이므로 조용히 건너뛴다. 크론이 겹쳐 돌아도 같은 메일이 두 번 나가지 않는다.
export async function claimDelivery(sql, { subscriberId, kind, dedupeKey }) {
  const rows = await sql`
    INSERT INTO mail_deliveries (subscriber_id, kind, dedupe_key)
    VALUES (${subscriberId}, ${kind}, ${dedupeKey})
        ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`;
  return rows.length ? rows[0].id : null;
}

export async function finishDelivery(sql, id, { status, error = null }) {
  await sql`
    UPDATE mail_deliveries
       SET status = ${status}, sent_at = CASE WHEN ${status} = 'sent' THEN NOW() ELSE sent_at END,
           error = ${error ? String(error).slice(0, 500) : null}
     WHERE id = ${id}`;
}

export async function recordSendResult(sql, subscriberId, ok) {
  if (ok) {
    await sql`UPDATE subscribers SET last_sent_at = NOW(), send_failures = 0 WHERE id = ${subscriberId}`;
  } else {
    // 연속 실패가 쌓이면 발송 대상에서 빠진다. 죽은 주소에 계속 던지면 도메인 평판이 깎인다.
    await sql`UPDATE subscribers SET send_failures = send_failures + 1 WHERE id = ${subscriberId}`;
  }
}

// --- 알림 대상 --------------------------------------------------------------

// 가격이 다시 오른 알림은 워터마크를 푼다. 그래야 다음 할인 때 또 알릴 수 있다.
export async function resetRisenAlerts(sql) {
  const rows = await sql`
    UPDATE price_alerts pa
       SET notified_price = NULL
      FROM app_stats st
     WHERE st.appid = pa.appid
       AND pa.notified_price IS NOT NULL
       AND st.final_price IS NOT NULL
       AND st.final_price > pa.notified_price
    RETURNING pa.id`;
  return rows.length;
}

/**
 * 지금 알려야 할 가격 하락. 조건은 세 겹이다.
 *   1. 확인된 구독자이고 해지하지 않았고 연속 실패가 쌓이지 않았다
 *   2. 마지막으로 알린 가격보다 더 내려갔다 (notified_price 워터마크)
 *   3. 목표가가 있으면 그 이하, 없으면 '할인 중이거나 무료가 됨'
 */
export function pendingPriceDrops(sql, limit = 200) {
  return sql`
    SELECT pa.id AS alert_id, pa.subscriber_id, pa.target_price, pa.notified_price,
           s.email, s.unsubscribe_token,
           a.appid, a.title, a.slug,
           st.final_price, st.initial_price, st.discount_percent, st.price_formatted,
           (lows.lowest IS NOT NULL AND st.final_price <= lows.lowest) AS at_lowest
      FROM price_alerts pa
      JOIN subscribers s ON s.id = pa.subscriber_id

      JOIN apps a ON a.appid = pa.appid
      JOIN app_stats st ON st.appid = pa.appid
      LEFT JOIN LATERAL (
        SELECT MIN(final_price) AS lowest FROM price_events pe
         WHERE pe.appid = pa.appid AND pe.final_price IS NOT NULL AND pe.final_price > 0
      ) lows ON TRUE
     WHERE s.confirmed_at IS NOT NULL AND s.unsubscribed_at IS NULL AND s.send_failures < 5
       AND st.final_price IS NOT NULL AND st.price_at IS NOT NULL
       AND (pa.notified_price IS NULL OR st.final_price < pa.notified_price)
       AND (
             (pa.target_price IS NOT NULL AND st.final_price <= pa.target_price)
          OR (pa.target_price IS NULL AND (st.discount_percent > 0 OR st.final_price = 0))
           )
     ORDER BY pa.subscriber_id, st.final_price
     LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 1000)}`;
}

export async function markAlertsNotified(sql, rows) {
  if (!rows.length) return 0;
  const payload = JSON.stringify(rows.map(row => ({ id: Number(row.alert_id), price: row.final_price })));
  const updated = await sql`
    UPDATE price_alerts pa
       SET notified_at = NOW(), notified_price = x.price
      FROM jsonb_to_recordset(${payload}::jsonb) AS x(id bigint, price int)
     WHERE pa.id = x.id
    RETURNING pa.id`;
  return updated.length;
}

// --- 주간 리포트 대상 --------------------------------------------------------

export function weeklyRecipients(sql, limit = 90) {
  return sql`
    SELECT id, email, unsubscribe_token
      FROM subscribers
     WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL
       AND weekly_report AND send_failures < 5
     ORDER BY COALESCE(last_sent_at, created_at)
     LIMIT ${Math.min(Math.max(Number(limit) || 90, 1), 500)}`;
}

// 주간 리포트의 중복 판정 기준. 같은 주에는 한 통만 간다.
// KST 기준 ISO 주차를 쓰는 이유는 발송이 월요일 아침(KST)이기 때문이다.
export function isoWeekKey(date = new Date()) {
  // KST 로 옮긴 뒤 UTC 게터로 읽는다. 로컬 시간대에 따라 주차가 달라지면 안 된다.
  const kst = new Date(date.getTime() + 9 * 3600_000);
  const day = (kst.getUTCDay() + 6) % 7; // 월요일 = 0
  const thursday = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() - day + 3));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday - firstThursday) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
