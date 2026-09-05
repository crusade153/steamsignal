// /api/* 의 HTTP 핸들러. Steam 은 크론(lib/collect.mjs)만 호출한다 — 이 경로에서는 절대 부르지 않는다.
//
// 이렇게 나눈 이유는 캐시 때문이다. 예전 구조는 서버리스 인스턴스마다 인메모리 캐시를 따로 들고 있어서,
// 트래픽이 늘어 인스턴스가 N개로 벌어지면 Steam 호출도 N배가 됐다. 지금은 트래픽이 얼마든 Steam 호출은 고정이다.
//
// handleApi 는 읽기 전용이다(lib/queries.mjs). 쓰기는 handleAlerts 하나뿐이며
// 그 SQL 은 전부 lib/alerts.mjs 에 있다.
import { getSql } from './db.mjs';
// parseIds 만 가져온다. Steam 클라이언트(getChart/getDetails)는 이 경로에서 절대 호출하지 않는다.
import { parseIds } from './steam.mjs';
import { chartTop, appById } from './queries.mjs';
import { gamePath, isNum, safeImage } from './render.mjs';
import { mailEnabled, sendMail, confirmTemplate } from './mail.mjs';
import * as sub from './alerts.mjs';

// 수집 주기가 10분이다. 25분을 넘겼다면 크론이 밀렸거나 죽은 것이므로 응답에 그렇게 적는다.
const STALE_AFTER_MS = 25 * 60_000;

const iso = value => (value ? new Date(value).toISOString() : null);
const reviewTotal = row =>
  isNum(row.total_positive) && isNum(row.total_negative) ? row.total_positive + row.total_negative : null;

// 응답 모양은 화면이 쓰는 이름으로 맞춘다. DB 컬럼명을 그대로 흘리면 스키마가 곧 공개 API 가 된다.
export function serializeGame(row) {
  return {
    appid: row.appid,
    title: row.title,
    slug: row.slug || String(row.appid),
    path: gamePath(row.appid, row.slug),
    headerImage: safeImage(row.header_image),
    genres: Array.isArray(row.genres) ? row.genres : [],
    players: row.players ?? null,
    peakToday: row.peak_today ?? null,
    rank: row.rank ?? null,
    positiveRatio: row.positive_ratio ?? null,
    reviewTotal: reviewTotal(row),
    reviewLabel: row.review_desc ?? null,
    metacritic: isNum(row.metacritic_score) ? { score: row.metacritic_score, url: row.metacritic_url ?? null } : null,
    price: row.final_price ?? null,
    priceFormatted: row.price_formatted ?? null,
    initialPrice: row.initial_price ?? null,
    discount: row.discount_percent ?? 0,
    isFree: row.final_price === 0 ? true : row.final_price > 0 ? false : null,
    playersAt: iso(row.players_at),
    priceAt: iso(row.price_at),
    reviewsAt: iso(row.reviews_at)
  };
}

function chartPayload(rows) {
  const games = rows.map(serializeGame);
  const newest = rows.reduce((max, row) => {
    const at = row.players_at ? new Date(row.players_at).getTime() : 0;
    return at > max ? at : max;
  }, 0);
  const updatedAt = newest ? new Date(newest).toISOString() : null;
  return {
    games,
    total: games.length,
    updatedAt,
    retrievedAt: new Date().toISOString(),
    // 결측을 0 으로 만들지 않는다는 규율의 연장. "모른다"와 "낡았다"를 구분해서 알린다.
    stale: newest === 0 || Date.now() - newest > STALE_AFTER_MS,
    source: 'steam-pulse-timeseries',
    rankingBasis: 'current_players',
    refreshAfterSeconds: 300
  };
}

export async function handleApi(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'GET 요청만 지원합니다.' }));
    return;
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    const sql = getSql();
    let payload;
    if (url.pathname === '/api/health') {
      payload = { ok: true, service: 'steam-pulse', version: 3 };
    } else if (url.pathname === '/api/games') {
      payload = chartPayload(await chartTop(sql, 100));
    } else if (url.pathname === '/api/game-details') {
      const ids = parseIds(url.searchParams.get('ids'));
      const rows = (await Promise.all(ids.map(id => appById(sql, id)))).flat();
      payload = { games: rows.map(serializeGame), retrievedAt: new Date().toISOString() };
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'API를 찾을 수 없습니다.' }));
      return;
    }
    // 수집이 10분 주기라 5분보다 짧게 캐시할 이유가 없다. 낡은 응답은 캐시하지 않는다.
    res.setHeader('Cache-Control', payload.stale ? 'no-store' : 'public, max-age=0, s-maxage=300, stale-while-revalidate=600');
    res.end(JSON.stringify(payload));
  } catch (error) {
    res.statusCode = error.status || 503;
    res.setHeader('Cache-Control', 'no-store');
    if (!error.status) console.error('[api]', req.url, error);
    res.end(JSON.stringify({ error: error.status ? error.message : '데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' }));
  }
}

// =============================================================================
// /api/alerts — 구독 신청과 해지. 이 사이트에서 사용자가 쓰기를 하는 유일한 경로다.
//
// 규율 넷.
//   1. 메일 설정이 없으면 이 엔드포인트는 **존재하지 않는다**(404). 폼도 그려지지 않는다.
//   2. 응답은 주소의 상태를 알려 주지 않는다 — "가입돼 있음"과 "처음"을 구분해 답하면
//      그 자체가 주소 존재 확인 도구가 된다. 항상 같은 문구로 답한다.
//   3. 확인도 해지도 POST 로만 받는다. 메일 클라이언트와 회사 보안 스캐너는 링크를 미리 열어 본다 —
//      GET 으로 처리하면 본인이 누르지도 않은 구독이 확정되고(더블 옵트인이 아니게 된다)
//      멋대로 구독이 끊긴다(RFC 8058 이 One-Click 해지를 POST 로 정한 이유다).
//      메일의 링크는 /alerts/confirm 페이지로 가고, 그 페이지의 버튼이 여기로 POST 한다.
//   4. JS 없이도 동작한다. 폼 전송이면 303 으로 안내 페이지에 보낸다.
// =============================================================================

const ALERT_STATES = {
  sent: '/alerts?state=sent',
  invalid: '/alerts?state=invalid',
  busy: '/alerts?state=busy',
  limit: '/alerts?state=limit',
  confirmed: '/alerts?state=confirmed',
  already: '/alerts?state=already',
  unsubscribed: '/alerts?state=unsubscribed',
  unknown: '/alerts?state=unknown'
};

// Vercel 은 본문을 미리 파싱해 req.body 에 넣어 주고, 로컬 서버는 스트림 그대로 준다.
// 양쪽을 다 받아야 같은 코드가 두 진입점에서 돈다.
async function readBody(req, limit = 4096) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8')
    : typeof req.body === 'string' ? req.body
      : await new Promise((resolve, reject) => {
        let text = '';
        req.on('data', chunk => {
          text += chunk;
          if (text.length > limit) { reject(new Error('본문이 너무 깁니다.')); req.destroy(); }
        });
        req.on('end', () => resolve(text));
        req.on('error', reject);
      });

  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

const wantsHtml = req =>
  String(req.headers['content-type'] || '').includes('form-urlencoded') ||
  String(req.headers.accept || '').includes('text/html');

export async function handleAlerts(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex');

  const json = (status, payload) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  };
  const finish = (state, status = 200) => {
    if (wantsHtml(req)) {
      res.statusCode = 303;
      res.setHeader('Location', ALERT_STATES[state] || ALERT_STATES.unknown);
      res.end();
      return;
    }
    json(status, { state });
  };

  // 설정이 없으면 기능 자체가 없다. 폼이 없으니 여기에 닿을 일도 없지만, 직접 부를 수는 있다.
  if (!mailEnabled()) return json(404, { error: '이 사이트는 이메일 알림을 제공하지 않습니다.' });

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(405, { error: 'POST 요청만 지원합니다.' });
  }

  const url = new URL(req.url, 'http://localhost');
  let body;
  try {
    body = await readBody(req);
  } catch {
    return finish('invalid', 400);
  }

  const action = String(body.action || url.searchParams.get('action') || 'subscribe');

  try {
    // getSql() 은 DATABASE_URL 이 없으면 던진다. 반드시 try 안에서 부른다 —
    // 밖에서 부르면 로컬 서버 프로세스가 통째로 죽고, 배포에서는 함수가 크래시한다.
    const sql = getSql();
    if (action === 'confirm') {
      // 더블 옵트인의 완료 지점. 여기서만 구독이 실제로 시작된다.
      const token = body.token || url.searchParams.get('token');
      const result = await sub.confirmSubscription(sql, token);
      return finish(result.state === 'unknown' ? 'unknown' : result.state === 'already' ? 'already' : 'confirmed');
    }

    if (action === 'unsubscribe') {
      // 토큰은 본문에도 쿼리에도 올 수 있다. 메일 클라이언트의 One-Click 해지는 쿼리로 온다.
      const token = body.token || url.searchParams.get('token');
      const result = await sub.unsubscribeByToken(sql, token);
      return finish(result.state === 'unknown' ? 'unknown' : 'unsubscribed');
    }

    if (action !== 'subscribe') return finish('invalid', 400);

    const appid = body.appid === undefined || body.appid === null || body.appid === ''
      ? null : sub.parseAppid(body.appid);
    if (body.appid && appid === null) return finish('invalid', 400);

    const target = sub.parseTargetPrice(body.target);
    if (!target.ok) return finish('invalid', 400);

    const weekly = body.weekly === true || body.weekly === '1' || body.weekly === 'on' || body.weekly === 'true';
    const result = await sub.subscribe(sql, { email: body.email, appid, targetPrice: target.value, weekly });

    if (!result.ok) {
      if (result.reason === 'busy') return finish('busy', 429);
      if (result.reason === 'limit') return finish('limit', 400);
      return finish('invalid', 400);
    }

    // 확인 메일은 미확인 주소에만, 10분에 한 통만. 발송 실패해도 사용자에게는 같은 문구로 답한다
    // — 실패 여부까지 알려 주면 그것도 주소 존재 확인 신호가 된다.
    if (result.needsConfirm) {
      const { subscriber } = result;
      const claim = await sub.claimDelivery(sql, {
        subscriberId: subscriber.id,
        kind: 'confirm',
        dedupeKey: `confirm:${subscriber.id}:${Math.floor(Date.now() / sub.CONFIRM_RESEND_MS)}`
      });
      if (claim) {
        const what = appid !== null ? '가격 하락 알림' : '주간 리포트';
        try {
          await sendMail({
            to: subscriber.email,
            unsubscribeToken: subscriber.unsubscribe_token,
            ...confirmTemplate({
              confirmToken: subscriber.confirm_token,
              unsubscribeToken: subscriber.unsubscribe_token,
              what
            })
          });
          await sub.finishDelivery(sql, claim, { status: 'sent' });
          await sub.markConfirmSent(sql, subscriber.id);
        } catch (error) {
          console.error('[alerts] 확인 메일 발송 실패', error);
          await sub.finishDelivery(sql, claim, { status: 'error', error: error?.message || error });
        }
      }
    }

    return finish('sent');
  } catch (error) {
    console.error('[alerts]', action, error);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: '처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' }));
  }
}
