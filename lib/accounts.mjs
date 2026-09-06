// 회원 계정. lib/alerts.mjs 와 함께 **사용자 요청 경로에서 쓰기를 하는 두 파일 중 하나**다.
//
// 이 사이트는 오랫동안 계정을 만들지 않았다(docs/PRODUCT.md §7). 2026-09-06 에 운영자가
// 방향을 바꿨고, 그래서 지켜야 할 선이 늘었다. 아래 규율은 전부 "안 지키면 조용히 사고가 나는" 것들이다.
//
//   1. **비밀번호 원문은 어디에도 남기지 않는다.** 로그도 포함이다.
//      scrypt 해시 문자열 안에 파라미터와 솔트를 함께 담아, 나중에 비용을 올려도
//      기존 계정이 계속 로그인되게 한다.
//   2. **세션 토큰 원문을 저장하지 않는다.** 쿠키에는 난수, DB 에는 그 SHA-256 만 남는다.
//   3. **주소가 존재하는지 알려 주지 않는다.** 가입·로그인·비밀번호 재설정이 전부
//      같은 문구로 답해야 한다. 다르게 답하는 순간 그게 주소 확인 도구가 된다.
//   4. **IP 를 저장하지 않는다.** subscribers 와 같은 규율이라, 남용 방지는
//      계정별 실패 횟수와 잠금 시각으로만 한다.
//   5. **비교는 timingSafeEqual 로 한다.** 문자열 === 는 다른 첫 글자에서 바로 끝나
//      비교 시간이 정보를 흘린다.
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

// scrypt 비용. N 은 2의 거듭제곱이어야 한다. 16384 는 한 번에 ~50ms 로,
// Vercel 함수 예산 안에서 무차별 대입을 충분히 비싸게 만든다.
export const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// 세션 수명. 짧으면 로그인이 자주 풀리고, 길면 훔친 쿠키가 오래 산다.
export const SESSION_DAYS = 30;
// 잠금 정책. IP 를 저장하지 않으므로 이것이 유일한 남용 방지선이다.
export const MAX_FAILED_LOGINS = 8;
export const LOCK_MINUTES = 15;
// 비밀번호 길이. 복잡도 규칙(대문자·기호)을 요구하지 않는 것은 의도다 —
// 그 규칙은 사람에게 'Password1!' 을 쓰게 만들 뿐이고, 길이가 훨씬 효과가 크다.
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200;
// 계정 위시리스트 상한. 브라우저 목록(20개)보다 넉넉하되 무한은 아니다.
export const MAX_WATCHLIST = 200;

const b64 = buffer => buffer.toString('base64url');

// --- 비밀번호 ---------------------------------------------------------------

export async function hashPassword(password, { salt = randomBytes(16), ...cost } = {}) {
  const params = { ...SCRYPT, ...cost };
  const derived = await scrypt(String(password), salt, params.keylen, { N: params.N, r: params.r, p: params.p });
  return `scrypt$${params.N}$${params.r}$${params.p}$${b64(salt)}$${b64(derived)}`;
}

// 저장된 해시 문자열이 자기 파라미터를 들고 있으므로, 비용을 올려도 예전 계정이 그대로 열린다.
export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, expected] = parts;
  try {
    const saltBuffer = Buffer.from(salt, 'base64url');
    const expectedBuffer = Buffer.from(expected, 'base64url');
    const derived = await scrypt(String(password), saltBuffer, expectedBuffer.length, {
      N: Number(N), r: Number(r), p: Number(p),
      // 기본 maxmem 은 N 이 커지면 부족해진다. 파라미터에 맞춰 넉넉히 잡는다.
      maxmem: 256 * Number(N) * Number(r) * 2
    });
    return derived.length === expectedBuffer.length && timingSafeEqual(derived, expectedBuffer);
  } catch {
    return false;
  }
}

// --- 입력 검증 ---------------------------------------------------------------

// 주소 검증은 느슨하게 한다. 엄격한 정규식은 유효한 주소를 거절하는 쪽으로 틀리고,
// 그 실패는 사용자에게 '이 사이트가 고장 났다'로 보인다. 진짜 검증은 확인 메일이 한다.
export function parseEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length < 5 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}

export function checkPassword(value) {
  const password = String(value ?? '');
  if (password.length < MIN_PASSWORD) return { ok: false, reason: 'short' };
  if (password.length > MAX_PASSWORD) return { ok: false, reason: 'long' };
  return { ok: true, password };
}

// --- 세션 -------------------------------------------------------------------

export const hashToken = token => createHash('sha256').update(String(token)).digest('base64url');
export const newSessionToken = () => b64(randomBytes(32));

export async function createSession(sql, userId, { days = SESSION_DAYS } = {}) {
  const token = newSessionToken();
  await sql`
    INSERT INTO user_sessions (token_hash, user_id, expires_at)
    VALUES (${hashToken(token)}, ${userId}, NOW() + (${days} || ' days')::interval)`;
  return { token, days };
}

// 세션 조회. 만료된 세션은 없는 것으로 친다 — 정리는 prune 잡이 따로 한다.
// last_seen_at 은 여기서 갱신하지 않는다. 페이지를 열 때마다 UPDATE 하면
// 읽기 요청이 전부 쓰기가 되고, 그러면 CDN 이 있는 의미가 없다.
export async function findSession(sql, token) {
  if (!token) return null;
  const [row] = await sql`
    SELECT u.id, u.email, u.created_at, u.last_login_at, u.subscriber_id, s.expires_at
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ${hashToken(token)}
       AND s.expires_at > NOW()`;
  return row ?? null;
}

export function destroySession(sql, token) {
  return sql`DELETE FROM user_sessions WHERE token_hash = ${hashToken(token)}`;
}

export function destroyAllSessions(sql, userId) {
  return sql`DELETE FROM user_sessions WHERE user_id = ${userId}`;
}

// --- 가입 · 로그인 ------------------------------------------------------------

// 가입. 이미 있는 주소면 **가입된 것처럼 답하지 않고, 실패한 것처럼도 답하지 않는다** —
// 호출부가 두 경우를 같은 화면으로 처리하도록 reason 만 돌려준다.
export async function signUp(sql, { email, password }) {
  const address = parseEmail(email);
  if (!address) return { ok: false, reason: 'invalid' };
  const checked = checkPassword(password);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  const passwordHash = await hashPassword(checked.password);
  const [row] = await sql`
    INSERT INTO users (email, password_hash)
    VALUES (${address}, ${passwordHash})
        ON CONFLICT (email) DO NOTHING
     RETURNING id, email, created_at`;
  if (!row) return { ok: false, reason: 'taken' };
  return { ok: true, user: row };
}

// 로그인. 주소가 없을 때와 비밀번호가 틀릴 때의 답이 같아야 한다.
// 없는 주소여도 해시를 한 번 계산해 응답 시간을 맞춘다 — 시간 차이도 신호다.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export async function logIn(sql, { email, password }) {
  const address = parseEmail(email);
  if (!address) return { ok: false, reason: 'invalid' };

  const [user] = await sql`
    SELECT id, email, password_hash, locked_until, failed_logins
      FROM users WHERE email = ${address}`;

  if (!user) {
    await verifyPassword(String(password ?? ''), DUMMY_HASH);
    return { ok: false, reason: 'invalid' };
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return { ok: false, reason: 'locked', until: user.locked_until };
  }

  const valid = await verifyPassword(String(password ?? ''), user.password_hash);
  if (!valid) {
    // 실패가 쌓이면 잠근다. 성공하면 0 으로 되돌린다.
    await sql`
      UPDATE users
         SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= ${MAX_FAILED_LOGINS}
                                 THEN NOW() + (${LOCK_MINUTES} || ' minutes')::interval
                                 ELSE locked_until END
       WHERE id = ${user.id}`;
    return { ok: false, reason: 'invalid' };
  }

  await sql`
    UPDATE users SET last_login_at = NOW(), failed_logins = 0, locked_until = NULL
     WHERE id = ${user.id}`;
  return { ok: true, user: { id: user.id, email: user.email } };
}

// 비밀번호 변경. 현재 비밀번호를 반드시 확인한다 — 세션이 탈취됐을 때
// 그것만으로 계정을 빼앗기지 않게 하는 마지막 방어선이다.
// 성공하면 다른 기기의 세션을 전부 끊는다.
export async function changePassword(sql, userId, { current, next }) {
  const checked = checkPassword(next);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  const [user] = await sql`SELECT id, password_hash FROM users WHERE id = ${userId}`;
  if (!user || !(await verifyPassword(String(current ?? ''), user.password_hash))) {
    return { ok: false, reason: 'invalid' };
  }

  await sql`UPDATE users SET password_hash = ${await hashPassword(checked.password)} WHERE id = ${userId}`;
  await destroyAllSessions(sql, userId);
  return { ok: true };
}

// 탈퇴. 행을 남기지 않는다. 세션·위시리스트는 CASCADE 로 함께 사라진다.
// 이 사람이 따로 신청한 이메일 구독은 건드리지 않는다 — 계정과 구독은 별개이고,
// 말없이 해지해 버리면 "왜 알림이 안 오지"의 답을 아무도 못 찾는다.
export async function deleteAccount(sql, userId, { password }) {
  const [user] = await sql`SELECT id, password_hash FROM users WHERE id = ${userId}`;
  if (!user || !(await verifyPassword(String(password ?? ''), user.password_hash))) {
    return { ok: false, reason: 'invalid' };
  }
  await sql`DELETE FROM users WHERE id = ${userId}`;
  return { ok: true };
}

// --- 계정 위시리스트 ----------------------------------------------------------

export const parseAppids = value => {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(list.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, MAX_WATCHLIST);
};

export async function readWatchlist(sql, userId) {
  const rows = await sql`
    SELECT appid FROM user_watchlist
     WHERE user_id = ${userId}
     ORDER BY added_at DESC
     LIMIT ${MAX_WATCHLIST}`;
  return rows.map(row => row.appid);
}

// 브라우저 목록과 계정 목록을 **합친다.** 빼지 않는다 —
// 다른 기기에서 담은 게임이 이 기기 목록에 없다고 사라지면,
// 사용자는 그걸 '동기화'가 아니라 '분실'로 겪는다. 빼는 것은 명시적인 remove 로만 한다.
//
// 우리가 추적하지 않는 appid 는 조용히 빠진다(외래키). 그래야 아무 숫자나 밀어 넣어
// 남의 테이블을 부풀리는 짓이 안 된다.
export async function mergeWatchlist(sql, userId, appids) {
  const ids = parseAppids(appids);
  if (ids.length) {
    // UNNEST 의 컬럼에 반드시 이름을 붙이고 항상 x.appid 로 쓴다.
    // AS appid 로만 두면 EXISTS 안의 `appid` 가 바깥이 아니라 apps 의 컬럼으로 해석돼
    // 조건이 언제나 참이 되고, 추적하지 않는 appid 가 그대로 INSERT 되어 외래키에서 터진다.
    // JOIN 으로 쓰면 그 실수 자체가 불가능해진다.
    await sql`
      INSERT INTO user_watchlist (user_id, appid)
      SELECT ${userId}, x.appid
        FROM UNNEST(${ids}::int[]) AS x(appid)
        JOIN apps a ON a.appid = x.appid
          ON CONFLICT (user_id, appid) DO NOTHING`;
  }
  return readWatchlist(sql, userId);
}

export async function removeFromWatchlist(sql, userId, appid) {
  const ids = parseAppids([appid]);
  if (ids.length) await sql`DELETE FROM user_watchlist WHERE user_id = ${userId} AND appid = ${ids[0]}`;
  return readWatchlist(sql, userId);
}
