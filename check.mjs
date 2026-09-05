import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

// 두 가지 모드로 돈다.
//   기본   — /api/games 를 고정 픽스처로 가로채고 프런트만 본다. DB 가 없는 CI 에서도 돈다.
//   --live — 실제 배포를 그대로 친다. SSR 페이지와 사이트맵까지 확인한다.
const live = process.argv.includes('--live');
let child;
let browser;
try {
  let origin = process.env.TEST_URL || 'http://127.0.0.1:5174';
  if (!live) {
    child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
    origin = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Test server did not start')), 15000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.stdout.on('data', chunk => { const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
    });
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], failedResources = [], httpErrors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => failedResources.push({ url: request.url(), reason: request.failure()?.errorText }));
  page.on('response', response => { if (response.status() >= 400) httpErrors.push({ url: response.url(), status: response.status() }); });

  // 목록 한 번에 평가·가격까지 다 온다. 예전의 /api/game-details 2차 호출은 없어졌다.
  const updatedAt = new Date().toISOString();
  const games = Array.from({ length: 100 }, (_, i) => ({
    appid: i + 1,
    title: i === 0 ? 'Fixture Game <img src=x onerror=alert(1)>' : `Fixture Game ${String(i + 1).padStart(3, '0')}`,
    slug: `${i + 1}-fixture-game`, path: `/game/${i + 1}-fixture-game`,
    headerImage: null, genres: ['액션', '어드벤처'],
    players: 100000 - i * 900, peakToday: 150000 - i * 500, rank: i + 1,
    // 두 번째 게임은 평가·가격이 아직 없는 상태다. 0 이 아니라 '없음'으로 그려져야 한다.
    positiveRatio: i === 1 ? null : 95, reviewTotal: i === 1 ? null : 10000, reviewLabel: 'Very Positive',
    metacritic: i === 1 ? null : { score: 85, url: 'https://www.metacritic.com/game/test/' },
    price: i === 1 ? null : 1500000, priceFormatted: i === 1 ? null : '₩ 15,000',
    initialPrice: 3000000, discount: i === 1 ? 0 : 50, isFree: i === 1 ? null : false,
    playersAt: updatedAt, priceAt: updatedAt, reviewsAt: updatedAt
  }));
  const chartJson = { games, total: 100, updatedAt, retrievedAt: updatedAt, stale: false, source: 'fixture' };
  if (!live) await page.route('**/api/games', route => route.fulfill({ json: chartJson }));

  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('.game-row').first().waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.game-row').count(), 20);
  assert.equal(await page.locator('.spotlight').count(), 3);
  assert.equal(await page.locator('#gameRows img[src="x"]').count(), 0, 'API title is escaped');

  // 게임은 모달이 아니라 주소가 있는 페이지로 열려야 한다. 크롤러가 따라갈 수 있어야 하고,
  // 클릭이 페이지뷰로 세어져야 광고 수익의 단위가 성립한다.
  const firstLink = page.locator('#gameRows .game-button').first();
  assert.match(await firstLink.getAttribute('href'), /^\/game\/\d+/, 'game rows link to a real URL');
  assert.match(await page.locator('.spotlight').first().getAttribute('href'), /^\/game\/\d+/);
  assert.equal(await page.locator('dialog').count(), 0, 'modal is gone');

  if (!live) {
    const second = await page.locator('.game-row').nth(1).textContent();
    assert.match(second, /집계 전/, 'missing review shows as pending, not 0%');
    assert.match(second, /미제공/);
    assert.match(second, /가격 미확인/);
  }

  await mkdir('screenshots', { recursive: true });
  await page.screenshot({ path: `screenshots/${live ? 'live' : 'test'}-desktop.png`, fullPage: true });
  await page.screenshot({ path: `screenshots/${live ? 'live' : 'test'}-viewport.png` });

  await page.getByRole('button', { name: '5페이지', exact: true }).click();
  assert.equal(await page.locator('.rank-cell').first().textContent(), '81');
  assert.equal(await page.locator('.rank-cell').last().textContent(), '100');
  assert.equal(await page.getByRole('button', { name: '다음 페이지' }).isDisabled(), true);

  const query = live ? (await page.locator('.game-text strong').last().textContent()) : 'Fixture Game 100';
  await page.locator('#search').fill(query);
  await page.waitForFunction(() => document.querySelectorAll('.game-row').length === 1);
  await page.locator('#search').fill('zzzz-no-such-game');
  await page.getByRole('button', { name: '검색 초기화' }).click();
  assert.equal(await page.locator('.game-row').count(), 20);
  await page.locator('#sort').selectOption('peak');
  await page.locator('#sort').selectOption('players');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `screenshots/${live ? 'live' : 'test'}-mobile.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page does not overflow on mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });

  // SSR 페이지는 DB 를 읽으므로 배포를 상대로만 확인한다.
  const ssrChecked = [];
  if (live) {
    const gameHref = await page.locator('#gameRows .game-button').first().getAttribute('href');
    for (const path of [gameHref, '/rising', '/deals', '/charts/weekly', '/genre']) {
      const response = await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 200, `${path} returned ${response.status()}`);
      assert.equal(await page.locator('h1').count(), 1, `${path} must have exactly one h1`);
      assert.ok(await page.locator('link[rel="canonical"]').count(), `${path} has no canonical`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${path} overflows`);
      ssrChecked.push(path);
    }
    await page.goto(origin + gameHref, { waitUntil: 'domcontentloaded' });
    const ld = await page.locator('script[type="application/ld+json"]').first().textContent();
    assert.equal(JSON.parse(ld)['@type'], 'VideoGame', 'game page ships VideoGame structured data');
    await page.screenshot({ path: 'screenshots/live-game.png', fullPage: true });

    const missing = await page.goto(`${origin}/game/999999999-nope`);
    assert.equal(missing.status(), 404, 'unknown game is a real 404');

    const sitemapResponse = await page.goto(`${origin}/sitemap.xml`);
    assert.equal(sitemapResponse.status(), 200);
    assert.match(await sitemapResponse.text(), /<urlset/, 'sitemap.xml is XML');
    assert.equal((await page.goto(`${origin}/robots.txt`)).status(), 200);
    ssrChecked.push('/sitemap.xml', '/robots.txt');
  }

  // 고정 문서와 위시리스트는 DB 를 읽지 않으므로 픽스처 모드에서도 확인할 수 있다.
  const docsChecked = [];
  for (const path of ['/privacy', '/terms', '/contact']) {
    const response = await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, `${path} returned ${response.status()}`);
    assert.equal(await page.locator('h1').count(), 1, `${path} must have exactly one h1`);
    // 애드센스 심사가 실제로 보는 조건 — 문서가 색인 가능하고 전역에서 닿아야 한다.
    assert.equal(await page.locator('meta[name="robots"]').count(), 0, `${path} must be indexable`);
    for (const href of ['/privacy', '/terms', '/contact']) {
      assert.ok(await page.locator(`footer a[href="${href}"]`).count(), `${path} footer missing ${href}`);
    }
    docsChecked.push(path);
  }

  // 위시리스트 왕복. 담기는 게임 상세에서, 목록은 /watchlist 에서 확인한다.
  const watched = { appid: 730, title: '위시리스트 픽스처', slug: '730-fixture', path: '/game/730-fixture', headerImage: null, genres: ['액션'], players: 900000, peakToday: 1000000, rank: 1, positiveRatio: 86, reviewTotal: 100, reviewLabel: 'Very Positive', metacritic: null, price: 0, priceFormatted: '무료 플레이', initialPrice: null, discount: 0, isFree: true, playersAt: updatedAt, priceAt: updatedAt, reviewsAt: updatedAt };
  await page.route('**/api/game-details*', route => route.fulfill({ json: { games: [watched], retrievedAt: updatedAt } }));

  await page.goto(`${origin}/watchlist`, { waitUntil: 'domcontentloaded' });
  await page.locator('#watchlistBody .empty-panel').waitFor({ timeout: 15000 });
  assert.match(await page.locator('#watchlistStatus').textContent(), /0개/, 'empty watchlist says zero');

  await page.evaluate(() => localStorage.setItem('steampulse:watchlist:v1', JSON.stringify([730])));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#watchlistBody tbody tr').first().waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#watchlistBody tbody tr').count(), 1);
  assert.match(await page.locator('#watchlistBody tbody tr').first().textContent(), /위시리스트 픽스처/);

  await page.locator('[data-remove]').first().click();
  await page.locator('#watchlistBody .empty-panel').waitFor({ timeout: 15000 });
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('steampulse:watchlist:v1'))), [],
    'removing empties the stored list');

  if (!live) {
    // 순위를 못 받았을 때 예전 값을 지어내지 않는지. 이 규율이 이 사이트의 신뢰다.
    await page.route('**/api/games', route => route.fulfill({ status: 503, json: { error: '데이터를 불러오지 못했습니다.' } }));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#notice').waitFor();
    assert.match(await page.locator('#notice').textContent(), /불러오지 못했습니다/);
    assert.equal(await page.locator('.game-row').count(), 0, 'no fabricated fallback ranking');
    assert.equal(await page.locator('#refreshBtn').isEnabled(), true);

    // 이 모드에는 DATABASE_URL 이 없다. SSR 라우트는 스택을 뱉는 대신 안내 페이지를 내야 한다.
    const dbDown = await page.goto(`${origin}/game/999999999-nope`);
    assert.equal(dbDown.status(), 503, 'SSR degrades to a served error page, not a crash');
    assert.match(await page.locator('h1').textContent(), /불러오지 못했습니다/);
    assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex, follow');
    assert.ok(!(await page.content()).includes('DATABASE_URL'), 'error page leaks no internals');
  }

  assert.deepEqual(errors, [], 'no JavaScript runtime errors');
  const externalFailures = failedResources.filter(item => !item.url.startsWith(origin) && !item.reason?.includes('ERR_ABORTED'));
  // 위에서 일부러 실패시킨 요청들이다. 남겨 두면 진짜 오류와 구분이 안 된다.
  const expected = ['/game/999999999-nope', '/api/games'];
  console.log(JSON.stringify({
    mode: live ? 'live deployment' : 'deterministic fixtures',
    tested: ['20 rows', '100th rank', 'search', 'sorting', 'real game links', 'mobile',
      ...docsChecked, 'watchlist round-trip',
      ...(live ? ssrChecked : ['escaped titles', 'missing values stay missing', 'API failure state', 'SSR error page'])],
    runtimeErrors: errors,
    externalResourceFailures: externalFailures,
    unexpectedHttpErrors: httpErrors.filter(item => !expected.some(path => item.url.endsWith(path)))
  }, null, 2));
} finally { await browser?.close(); child?.kill(); }
