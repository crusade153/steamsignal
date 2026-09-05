// 구독·발송 테스트.
//
// 여기서 지키려는 것은 화면이 아니라 **사고**다. 이 파일의 케이스는 전부
// "틀려도 테스트가 아니라 남의 메일함에서 드러나는" 종류다 —
// 같은 메일이 두 번 가는 것, 발송이 실패했는데 보낸 것으로 표시되는 것,
// 확인하지 않은 주소로 메일이 나가는 것, 토큰이 화면에 그대로 박히는 것.
//
import test from 'node:test';
import assert from 'node:assert/strict';

// 메일 설정은 모듈이 로드되는 순간 config 로 굳는다(lib/render.mjs).
// 그런데 ESM 의 import 는 이 파일의 첫 줄보다 **먼저** 실행되므로,
// process.env 를 위에 적어 두고 정적 import 를 쓰면 설정이 없는 상태로 굳어 버린다
// — 그러면 페이지가 전부 404 가 되고, 원인이 테스트 코드에 안 보인다.
// 그래서 여기서만 동적 import 를 쓴다.
process.env.RESEND_API_KEY = 'test-key';
process.env.MAIL_FROM = 'Steam Pulse <alerts@example.com>';
process.env.SITE_URL = 'https://steamsignal.vercel.app';

const { createCollector } = await import('../lib/collect.mjs');
const { normalizeEmail, parseTargetPrice, parseAppid, isoWeekKey } = await import('../lib/alerts.mjs');
const { confirmTemplate, alertTemplate, weeklyTemplate } = await import('../lib/mail.mjs');
const { alertsPage, alertsConfirmPage, priceAlertForm } = await import('../lib/pages.mjs');

// --- 입력 검증 --------------------------------------------------------------

test('이메일은 소문자로 정규화하고, 보낼 수 없는 모양만 거절한다', () => {
  // 대소문자만 다른 중복 가입이 생기면 같은 사람에게 두 번 발송된다.
  assert.equal(normalizeEmail('  User@Example.COM '), 'user@example.com');
  assert.equal(normalizeEmail('a+tag@sub.example.co.kr'), 'a+tag@sub.example.co.kr');

  for (const bad of ['', 'a@b', 'no-at-sign.com', 'two@@example.com', 'sp ace@example.com',
    'quote"@example.com', 'comma,@example.com', `${'x'.repeat(250)}@example.com`]) {
    assert.equal(normalizeEmail(bad), null, `거절해야 한다: ${bad}`);
  }
});

test('목표 가격은 원 단위로 받아 통화 최소단위 x100 으로 저장한다', () => {
  // app_stats.final_price 와 단위가 어긋나면 20,000원 알림이 200원 알림이 된다.
  assert.deepEqual(parseTargetPrice('20,000원'), { ok: true, value: 2_000_000 });
  assert.deepEqual(parseTargetPrice(' '), { ok: true, value: null });   // 비우면 '할인 시작하면 언제든'
  assert.deepEqual(parseTargetPrice(null), { ok: true, value: null });
  assert.equal(parseTargetPrice('-1').ok, false);
  assert.equal(parseTargetPrice('99999999').ok, false);
  assert.equal(parseTargetPrice('공짜').ok, false);
});

test('appid 는 정수만 통과시킨다', () => {
  assert.equal(parseAppid('730'), 730);
  assert.equal(parseAppid('730; DROP TABLE apps'), null);
  assert.equal(parseAppid('0'), null);
  assert.equal(parseAppid('1e9'), 1_000_000_000);
});

test('주차 키는 KST 기준이라 일요일 밤에 다음 주로 넘어가지 않는다', () => {
  // 발송이 월요일 아침(KST)이므로 UTC 로 세면 일요일 오후에 이미 다음 주가 되어
  // 같은 사람에게 한 주에 두 통이 갈 수 있다.
  assert.equal(isoWeekKey(new Date('2026-01-04T15:30:00Z')), isoWeekKey(new Date('2026-01-04T20:00:00Z')));
  // KST 월요일 0시(= UTC 일요일 15시)를 넘기면 주차가 바뀐다.
  assert.notEqual(isoWeekKey(new Date('2026-01-04T14:00:00Z')), isoWeekKey(new Date('2026-01-04T15:30:00Z')));
  assert.match(isoWeekKey(new Date('2026-09-06T00:00:00Z')), /^2026-W\d\d$/);
});

// --- 템플릿 -----------------------------------------------------------------

test('모든 메일에 수신 거부 경로가 있고, Steam 이 준 제목은 이스케이프된다', () => {
  const confirm = confirmTemplate({ confirmToken: 'c-tok', unsubscribeToken: 'u-tok', what: '가격 하락 알림' });
  assert.ok(confirm.html.includes('/alerts/confirm?token=c-tok'));
  assert.ok(confirm.html.includes('/alerts/unsubscribe?token=u-tok'));
  assert.ok(confirm.text.includes('/alerts/confirm?token=c-tok'), 'text 판이 없으면 스팸 점수가 오른다');

  const rows = [{ appid: 730, slug: '730-cs2', title: '<img src=x onerror=alert(1)>', final_price: 1000, notified_price: 2000, discount_percent: 50, price_formatted: '₩10,000', at_lowest: true }];
  const alert = alertTemplate({ rows, unsubscribeToken: 'u-tok' });
  assert.ok(alert.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!alert.html.includes('<img src=x'));
  assert.ok(alert.html.includes('/alerts/unsubscribe?token=u-tok'));
  assert.ok(alert.text.includes('/alerts/unsubscribe?token=u-tok'));

  // 여러 건은 한 통으로 묶는다. 세일 첫날 20통은 스팸 신고감이다.
  const many = alertTemplate({ rows: [...rows, { ...rows[0], appid: 570, title: 'Dota 2' }], unsubscribeToken: 'u' });
  assert.match(many.subject, /2개/);

  const weekly = weeklyTemplate({ rising: [{ appid: 1, slug: '1-a', title: 'A', change_pct: 12.34, now_players: 5000 }], deals: [], unsubscribeToken: 'u-tok' });
  assert.ok(weekly.html.includes('+12.3%'));
  assert.ok(!weekly.html.includes('할인 중인 고평가작'), '값이 없는 구획은 통째로 뺀다');
});

// --- 페이지 -----------------------------------------------------------------

test('알림 페이지는 캐시하지 않고 토큰을 이스케이프한다', () => {
  const page = alertsPage(null, { state: 'sent' });
  assert.equal(page.status, 200);
  // 토큰이 주소에 들어 있어 CDN 이 캐싱하면 남의 토큰이 새고, 색인되면 공개된다.
  assert.equal(page.headers['Cache-Control'], 'no-store');
  assert.ok(page.body.includes('noindex'));
  assert.ok(page.body.includes('확인 메일을 보냈습니다'));

  const confirm = alertsConfirmPage(null, { token: '"><script>alert(1)</script>' });
  assert.ok(confirm.body.includes('&quot;&gt;&lt;script&gt;'));
  assert.ok(!confirm.body.includes('<script>alert(1)'));
  // 확인은 POST 로만 일어난다 — 메일 스캐너가 링크를 미리 열어도 구독이 확정되면 안 된다.
  assert.ok(confirm.body.includes('method="post"'));
  assert.ok(confirm.body.includes('name="action" value="confirm"'));

  assert.equal(alertsConfirmPage(null, {}).body.includes('name="token"'), false, '토큰이 없으면 폼을 그리지 않는다');
  assert.ok(priceAlertForm({ appid: 730, final_price: 2_200_000 }).includes('name="appid" value="730"'));
});

// --- 발송 잡 ----------------------------------------------------------------

// 태그드 템플릿 sql 을 흉내낸다. 발송 원장 INSERT 는 '자리 잡기 성공'을 뜻하는 id 를 돌려준다.
function fakeSql({ drops = [], recipients = [], claim = true, rising = [], deals = [] } = {}) {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    if (text.startsWith('INSERT INTO collector_runs')) return Promise.resolve([{ id: 1 }]);
    if (text.startsWith('INSERT INTO mail_deliveries')) return Promise.resolve(claim ? [{ id: 99 }] : []);
    if (text.includes('FROM price_alerts pa')) return Promise.resolve(drops);
    if (text.includes('FROM subscribers') && text.includes('weekly_report')) return Promise.resolve(recipients);
    if (text.includes('player_hourly') || text.includes('rising')) return Promise.resolve(rising);
    if (text.includes('discount_percent')) return Promise.resolve(deals);
    return Promise.resolve([]);
  };
  sql.calls = calls;
  sql.find = fragment => calls.filter(call => call.text.includes(fragment));
  sql.order = fragment => calls.findIndex(call => call.text.includes(fragment));
  return sql;
}

const drop = (subscriberId, appid, price) => ({
  alert_id: appid, subscriber_id: subscriberId, target_price: null, notified_price: price * 2,
  email: `u${subscriberId}@example.com`, unsubscribe_token: `tok-${subscriberId}`,
  appid, title: `게임 ${appid}`, slug: `${appid}-game`,
  final_price: price, initial_price: price * 2, discount_percent: 50, price_formatted: '₩10,000', at_lowest: false
});

test('메일 설정이 없으면 발송 잡은 아무것도 하지 않는다', async () => {
  const sql = fakeSql({ drops: [drop(1, 730, 1000)] });
  let sends = 0;
  const collector = createCollector({ sql, mailer: async () => { sends++; }, mailReady: () => false });

  const alerts = await collector.run('alerts');
  const weekly = await collector.run('newsletter');
  assert.equal(sends, 0);
  assert.equal(alerts.skipped, 'mail-disabled');
  assert.equal(weekly.skipped, 'mail-disabled');
  // 대상 조회조차 하지 않아야 한다. 못 보낼 메일을 계산하느라 DB 를 두드릴 이유가 없다.
  assert.equal(sql.find('FROM price_alerts pa').length, 0);
});

test('한 사람의 여러 하락은 한 통으로 묶이고, 워터마크는 발송에 성공한 뒤에만 오른다', async () => {
  const sql = fakeSql({ drops: [drop(1, 730, 1000), drop(1, 570, 2000), drop(2, 730, 1000)] });
  const sent = [];
  const collector = createCollector({ sql, mailer: async payload => { sent.push(payload); }, mailReady: () => true });

  const result = await collector.run('alerts');

  assert.equal(result.processed, 2, '사람이 둘이므로 두 통');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, 'u1@example.com');
  assert.match(sent[0].subject, /2개/, '한 사람의 두 건은 한 통에 묶는다');
  assert.equal(sent[0].unsubscribeToken, 'tok-1');

  // 보내기 전에 원장에 자리를 잡아야 크론이 겹쳐 돌아도 두 번 나가지 않는다.
  assert.ok(sql.order('INSERT INTO mail_deliveries') < sql.order('UPDATE price_alerts pa SET notified_at'),
    '자리 잡기가 워터마크보다 먼저여야 한다');
  const keys = sql.find('INSERT INTO mail_deliveries').map(call => call.values[2]);
  assert.equal(new Set(keys).size, 2, '사람마다 서로 다른 dedupe_key');
  assert.ok(keys.every(key => key.startsWith('alert:')));

  // 워터마크는 방금 알린 가격으로 갱신된다. 이게 없으면 10분 뒤 같은 메일이 다시 간다.
  const marked = JSON.parse(sql.find('UPDATE price_alerts pa SET notified_at')[0].values[0]);
  assert.deepEqual(marked, [{ id: 730, price: 1000 }, { id: 570, price: 2000 }]);
});

test('발송이 실패하면 워터마크를 올리지 않고 실패만 센다', async () => {
  // 여기서 워터마크를 올리면 그 하락은 영영 알리지 못한다. 중복 발송보다 나쁜 유일한 경우다.
  const sql = fakeSql({ drops: [drop(1, 730, 1000)] });
  const collector = createCollector({
    sql, mailReady: () => true,
    mailer: async () => { throw new Error('Resend HTTP 429'); }
  });

  const result = await collector.run('alerts');
  assert.equal(result.processed, 0);
  assert.equal(result.failed, 1);
  assert.equal(sql.find('UPDATE price_alerts pa SET notified_at').length, 0);
  assert.ok(sql.find('UPDATE mail_deliveries')[0].values.includes('error'));
  assert.equal(sql.find('send_failures = send_failures + 1').length, 1);
});

test('이미 원장에 있는 발송은 조용히 건너뛴다', async () => {
  // 크론이 겹쳐 돌거나 재시도될 때 같은 메일이 두 번 나가지 않게 하는 마지막 방어선.
  const sql = fakeSql({ drops: [drop(1, 730, 1000)], claim: false });
  let sends = 0;
  const collector = createCollector({ sql, mailer: async () => { sends++; }, mailReady: () => true });

  const result = await collector.run('alerts');
  assert.equal(sends, 0);
  assert.equal(result.processed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(sql.find('UPDATE price_alerts pa SET notified_at').length, 0);
});

test('주간 리포트는 실을 내용이 없으면 보내지 않는다', async () => {
  const sql = fakeSql({ recipients: [{ id: 1, email: 'a@example.com', unsubscribe_token: 't' }] });
  let sends = 0;
  const collector = createCollector({ sql, mailer: async () => { sends++; }, mailReady: () => true });

  const result = await collector.run('newsletter');
  assert.equal(sends, 0, '빈 뉴스레터는 해지 사유가 된다');
  assert.equal(result.skipped, 'no-content');
  assert.equal(sql.find('FROM subscribers').length, 0, '대상 조회도 하지 않는다');
});

test('주간 리포트의 중복 판정 기준은 주차 하나다', async () => {
  const sql = fakeSql({
    recipients: [{ id: 7, email: 'a@example.com', unsubscribe_token: 't' }],
    rising: [{ appid: 1, slug: '1-a', title: 'A', change_pct: 10, now_players: 5000 }]
  });
  const collector = createCollector({ sql, mailer: async () => {}, mailReady: () => true });

  const result = await collector.run('newsletter');
  assert.equal(result.processed, 1);
  assert.equal(sql.find('INSERT INTO mail_deliveries')[0].values[2], `weekly:7:${isoWeekKey()}`);
});
