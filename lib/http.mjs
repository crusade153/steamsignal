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
import { chartTop, appById, changeContext, sparkSeries } from './queries.mjs';

import { mailEnabled, sendMail, confirmTemplate } from './mail.mjs';
import * as sub from './alerts.mjs';
import * as accounts from './accounts.mjs';
import { gamePath, isNum, safeImage, siteOrigin } from './render.mjs';

// 수집 주기가 10분이다. 25분을 넘겼다면 크론이 밀렸거나 죽은 것이므로 응답에 그렇게 적는다.
const STALE_AFTER_MS = 25 * 60_000;

const iso = value => (value ? new Date(value).toISOString() : null);
const reviewTotal = row =>
  isNum(row.total_positive) && isNum(row.total_negative) ? row.total_positive + row.total_negative : null;

// '어제와 무엇이 달라졌나'. 이 사이트의 존재 이유이자 재방문의 조건이라
// 목록·위시리스트가 전부 이 모양을 읽는다(docs/PRODUCT.md §3).
//
// 규율은 다른 값과 같다 — **비교할 근거가 없으면 만들어 내지 않는다.**
// 직전 순위가 없으면 change 는 null 이고, 화면은 그걸 'NEW' 로 읽는다.
// 비교한 날짜를 함께 실어 "어제 대비"라고 써 놓고 사흘 전과 비교하는 일이 없게 한다.
export function serializeChange(row) {
  const rankChange = isNum(row.prev_rank) && isNum(row.rank) ? row.prev_rank - row.rank : null;
  const playersChangePct = isNum(row.prev_avg_players) && row.prev_avg_players > 0 && isNum(row.players)
    ? Math.round(((row.players - row.prev_avg_players) / row.prev_avg_players) * 1000) / 10
    : null;
  const priceChange = isNum(row.prev_price) && isNum(row.final_price)
    ? row.final_price - row.prev_price
    : null;
  if (rankChange === null && playersChangePct === null && priceChange === null && !row.prev_day) return null;
  return {
    since: row.prev_day ?? null,
    rankChange,
    prevRank: row.prev_rank ?? null,
    playersChangePct,
    prevAvgPlayers: row.prev_avg_players ?? null,
    priceChange,
    prevPrice: row.prev_price ?? null,
    priceChangedAt: iso(row.prev_price_at)
  };
}

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
    reviewsAt: iso(row.reviews_at),
    change: serializeChange(row),
    // 목록 행의 미니 차트 재료. 없으면 화면이 '표본 부족'이라고 적는다.
    spark: Array.isArray(row.spark) ? row.spark : null
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
      const rows = await chartTop(sql, 100);
      // 스파크라인은 목록을 받은 뒤에 한 번 더 묻는다. 차트 쿼리에 넣으면 100행마다
      // 배열이 딸려 나와 JOIN 이 무거워지고, 어차피 두 질문은 성격이 다르다.
      // sparkLabel 을 함께 보내는 이유는 sparkSeries 주석에 있다 —
      // 적재 초기에는 시간 롤업으로 내려가는데 그걸 '7일 추이'라고 부르면 거짓말이 된다.
      const { points, label } = await sparkSeries(sql, rows.map(row => row.appid), { days: 7 });
      payload = {
        ...chartPayload(rows.map(row => ({ ...row, spark: points.get(row.appid) ?? null }))),
        sparkLabel: label
      };
    } else if (url.pathname === '/api/game-details') {
      const ids = parseIds(url.searchParams.get('ids'));
      // 변화(Δ)는 한 번에 묻는다. 게임마다 따로 물으면 왕복이 담아 둔 개수만큼 늘어난다.
      const [rows, changes] = await Promise.all([
        Promise.all(ids.map(id => appById(sql, id))).then(list => list.flat()),
        changeContext(sql, ids)
      ]);
      const byId = new Map(changes.map(row => [row.appid, row]));
      payload = {
        games: rows.map(row => serializeGame({ ...byId.get(row.appid), ...row })),
        retrievedAt: new Date().toISOString()
      };
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

// =============================================================================
// /api/account — 가입 · 로그인 · 계정 관리. 사용자가 쓰기를 하는 두 번째 경로다.
//
// **계정은 자율이다.** 이 사이트의 어떤 화면도 로그인을 요구하지 않는다.
// 순위·급상승·할인·게임 상세·위시리스트는 계정 없이 지금까지와 똑같이 동작하고,
// 계정은 위시리스트를 기기 사이에서 이어 주는 편의 하나만 더한다.
// 로그인해야 볼 수 있는 페이지를 만드는 순간 이 사이트는 다른 물건이 된다.
//
// 규율 여섯. 앞의 셋은 /api/alerts 와 같고, 뒤의 셋은 계정 때문에 새로 생겼다.
//
//   1. **쓰기는 POST 로만.** 링크 미리 열기·프리페치가 로그아웃이나 탈퇴를 일으키면 안 된다.
//   2. **응답이 주소의 존재를 알려 주지 않는다.** 가입도 로그인도 실패 문구가 하나다.
//   3. **JS 없이 동작한다.** 폼 전송이면 303 으로 안내 페이지에 보낸다.
//   4. **Origin 을 확인한다.** 쿠키가 SameSite=Lax 라 폼 POST 는 이미 교차 사이트에서
//      막히지만, 그건 브라우저의 선의에 기대는 것이다. 헤더로 한 번 더 못을 박는다.
//   5. **세션 쿠키는 HttpOnly.** 스크립트가 읽을 수 있으면 XSS 하나로 계정이 넘어간다.
//      배포(https)에서는 Secure 도 함께 건다.
//   6. **비밀번호는 로그에 절대 남기지 않는다.** 이 파일에서 body 를 통째로 찍지 않는 이유다.
// =============================================================================

const ACCOUNT_STATES = {
  'signed-up': '/account?state=signed-up',
  'signed-in': '/account',
  'signed-out': '/account/login?state=signed-out',
  'password-changed': '/account/login?state=password-changed',
  deleted: '/?state=deleted',
  invalid: '/account/login?state=invalid',
  taken: '/account/signup?state=taken',
  short: '/account/signup?state=short',
  long: '/account/signup?state=long',
  locked: '/account/login?state=locked',
  'signin-required': '/account/login?state=signin-required'
};

export const SESSION_COOKIE = 'sp_session';

// 쿠키 파싱. 값에 '=' 이 들어갈 수 있으므로 첫 '=' 에서만 자른다.
export function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

// Secure 는 https 일 때만 건다. 로컬(http)에서 걸면 브라우저가 쿠키를 아예 저장하지 않아
// 로그인이 조용히 안 되는 상태가 된다 — 원인을 찾기 어려운 종류의 사고다.
const cookieAttributes = maxAgeSeconds => [
  'Path=/',
  'HttpOnly',
  'SameSite=Lax',
  ...(siteOrigin().startsWith('https:') ? ['Secure'] : []),
  `Max-Age=${maxAgeSeconds}`
].join('; ');

export const sessionCookie = (token, days) =>
  `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttributes(days * 86400)}`;
export const clearedCookie = () => `${SESSION_COOKIE}=; ${cookieAttributes(0)}`;

// 요청을 보낸 사람. 페이지 렌더러가 이걸 받아 화면을 가른다.
// 세션이 없거나 만료면 null 이고, 그 경우 화면은 로그인 상태를 **아무것도** 그리지 않는다.
export async function currentUser(sql, req) {
  try {
    return await accounts.findSession(sql, readCookie(req, SESSION_COOKIE));
  } catch (error) {
    // 계정 테이블이 아직 없을 수도 있다(마이그레이션 미적용). 그때 페이지가 통째로 죽으면 안 된다 —
    // 계정은 자율 기능이므로, 없으면 없는 대로 사이트 전체는 그대로 돌아야 한다.
    console.error('[account] 세션 조회 실패', error?.message || error);
    return null;
  }
}

// 교차 사이트에서 온 폼 전송을 막는다. Origin 이 없는 요청(오래된 클라이언트, curl)은
// 통과시킨다 — 브라우저가 아닌 요청에는 쿠키도 자동으로 붙지 않기 때문이다.
function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return new URL(origin).host === String(host);
  } catch { return false; }
}

export async function handleAccount(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex');

  const json = (status, payload) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  };
  const finish = (state, { status = 200, cookie = null, to = null } = {}) => {
    if (cookie) res.setHeader('Set-Cookie', cookie);
    if (wantsHtml(req)) {
      res.statusCode = 303;
      res.setHeader('Location', to || ACCOUNT_STATES[state] || ACCOUNT_STATES.invalid);
      res.end();
      return;
    }
    json(status, { state });
  };

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(405, { error: 'POST 요청만 지원합니다.' });
  }
  if (!sameOrigin(req)) return json(403, { error: '허용되지 않은 요청입니다.' });

  let body;
  try {
    body = await readBody(req);
  } catch {
    return finish('invalid', { status: 400 });
  }

  const action = String(body.action || '');
  try {
    const sql = getSql();
    const token = readCookie(req, SESSION_COOKIE);

    if (action === 'signup') {
      const result = await accounts.signUp(sql, { email: body.email, password: body.password });
      // 이미 있는 주소라고 따로 알려 주지 않는다 — 그건 주소 확인 도구가 된다.
      // 길이 문제만 구분해서 답한다. 그건 입력한 사람이 이미 아는 사실이라 새어 나갈 정보가 없다.
      if (!result.ok) {
        return result.reason === 'short' || result.reason === 'long'
          ? finish(result.reason, { status: 400 })
          : finish('taken', { status: 400 });
      }
      const session = await accounts.createSession(sql, result.user.id);
      return finish('signed-up', { cookie: sessionCookie(session.token, session.days) });
    }

    if (action === 'login') {
      const result = await accounts.logIn(sql, { email: body.email, password: body.password });
      if (!result.ok) return finish(result.reason === 'locked' ? 'locked' : 'invalid', { status: 401 });
      const session = await accounts.createSession(sql, result.user.id);
      return finish('signed-in', { cookie: sessionCookie(session.token, session.days) });
    }

    if (action === 'logout') {
      if (token) await accounts.destroySession(sql, token);
      return finish('signed-out', { cookie: clearedCookie() });
    }

    // 여기부터는 로그인이 필요하다. 로그인해야 하는 것은 **자기 계정을 다루는 일**뿐이다.
    const user = await accounts.findSession(sql, token);
    if (!user) return finish('signin-required', { status: 401 });

    if (action === 'logout-all') {
      await accounts.destroyAllSessions(sql, user.id);
      return finish('signed-out', { cookie: clearedCookie() });
    }

    if (action === 'change-password') {
      const result = await accounts.changePassword(sql, user.id, { current: body.current, next: body.next });
      if (!result.ok) {
        return result.reason === 'short' || result.reason === 'long'
          ? finish(result.reason, { status: 400, to: `/account?state=${result.reason}` })
          : finish('invalid', { status: 400, to: '/account?state=invalid' });
      }
      // 비밀번호가 바뀌면 모든 세션이 끊긴다. 지금 쓰는 쿠키도 이미 무효라 지워 준다.
      return finish('password-changed', { cookie: clearedCookie() });
    }

    if (action === 'delete') {
      const result = await accounts.deleteAccount(sql, user.id, { password: body.password });
      if (!result.ok) return finish('invalid', { status: 400, to: '/account?state=invalid' });
      return finish('deleted', { cookie: clearedCookie() });
    }

    // 위시리스트 동기화는 JS 가 부른다(JSON). 폼 전송으로도 오면 계정 화면으로 돌려보낸다.
    if (action === 'watchlist-merge') {
      const appids = await accounts.mergeWatchlist(sql, user.id, body.appids);
      return wantsHtml(req) ? finish('signed-in') : json(200, { appids });
    }
    if (action === 'watchlist-remove') {
      const appids = await accounts.removeFromWatchlist(sql, user.id, body.appid);
      return wantsHtml(req) ? finish('signed-in') : json(200, { appids });
    }

    return finish('invalid', { status: 400 });
  } catch (error) {
    // body 를 통째로 찍지 않는다 — 비밀번호가 로그에 남는 가장 흔한 경로다.
    console.error('[account]', action, error?.message || error);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: '처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' }));
  }
}
