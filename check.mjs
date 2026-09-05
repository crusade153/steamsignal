import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

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
  const stamp = { status: 'ok', retrievedAt: '2026-09-05T03:00:00Z' };
  const games = Array.from({ length: 100 }, (_, i) => ({ appid: i + 1, title: i === 0 ? 'Fixture Game <img src=x onerror=alert(1)>' : `Fixture Game ${String(i + 1).padStart(3, '0')}`, headerImage: null, players: 100000 - i * 900, peakToday: 150000 - i * 500, rank: i + 1 }));
  if (!live) {
    await page.route('**/api/games', route => route.fulfill({ json: { games, total: 100, updatedAt: stamp.retrievedAt, retrievedAt: stamp.retrievedAt, stale: false, sources: { chart: stamp, names: stamp } } }));
    await page.route('**/api/game-details?*', async route => {
      const ids = new URL(route.request().url()).searchParams.get('ids').split(',').map(Number);
      await route.fulfill({ json: { games: ids.map(appid => ({ appid, title: games[appid - 1].title, headerImage: null, priceFormatted: '₩ 15,000', isFree: false, discount: 50, originalPrice: '₩ 30,000', positiveRatio: appid === 2 ? null : 95, reviewTotal: appid === 2 ? 0 : 10000, metacritic: appid === 2 ? null : { score: 85, url: 'https://www.metacritic.com/game/test/' }, genres: ['액션', '어드벤처'], sources: { details: stamp, reviews: stamp } })) } });
    });
  }
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('.game-row').first().waitFor({ timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('#detailsStatus').textContent.includes('확인 중'), null, { timeout: 60000 });
  assert.equal(await page.locator('.game-row').count(), 20);
  assert.equal(await page.locator('.spotlight').count(), 3);
  assert.equal(await page.locator('#gameRows img[src="x"]').count(), 0, 'API title is escaped');
  if (!live) {
    assert.match(await page.locator('.game-row').nth(1).textContent(), /미제공/);
    assert.match(await page.locator('.game-row').nth(1).textContent(), /리뷰 없음/);
  }
  await mkdir('screenshots', { recursive: true });
  await page.screenshot({ path: `screenshots/${live ? 'live' : 'test'}-desktop.png`, fullPage: true });
  await page.screenshot({ path: `screenshots/${live ? 'live' : 'test'}-viewport.png` });
  const imageResults = await page.locator('.spotlight img').evaluateAll(images => images.map(img => ({ src: img.src, complete: img.complete, width: img.naturalWidth })));
  await page.getByRole('button', { name: '5페이지', exact: true }).click();
  assert.equal(await page.locator('.rank-cell').first().textContent(), '81');
  assert.equal(await page.locator('.rank-cell').last().textContent(), '100');
  assert.equal(await page.getByRole('button', { name: '다음 페이지' }).isDisabled(), true);
  const query = live ? (await page.locator('.game-text strong').last().textContent()) : 'Fixture Game 100';
  await page.locator('#search').fill(query);
  await page.waitForFunction(() => document.querySelectorAll('.game-row').length === 1);
  await page.locator('.game-button').first().click();
  assert.equal(await page.locator('#gameDialog').isVisible(), true);
  assert.match(await page.locator('#modalTitle').textContent(), new RegExp(live ? '.+' : '100'));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#gameDialog').isVisible(), false);
  await page.locator('#search').fill('zzzz-no-such-game');
  await page.getByRole('button', { name: '검색 초기화' }).click();
  assert.equal(await page.locator('.game-row').count(), 20);
  await page.locator('#sort').selectOption('peak');
  await page.locator('#sort').selectOption('players');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `screenshots/${live ? 'live' : 'test'}-mobile.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page does not overflow on mobile');
  await page.locator('.game-button').first().click();
  assert.ok(await page.locator('#gameDialog').evaluate(el => el.getBoundingClientRect().width <= innerWidth));
  await page.screenshot({ path: `screenshots/${live ? 'live' : 'test'}-detail.png` });
  await page.keyboard.press('Escape');
  if (!live) {
    await page.route('**/api/game-details?*', route => route.fulfill({ status: 503, json: { error: '상세 정보를 가져오지 못했습니다.' } }));
    await page.locator('#refreshBtn').click();
    await page.waitForFunction(() => document.querySelector('#detailsStatus').textContent.includes('못했습니다'));
    assert.equal(await page.locator('.game-row').count(), 20, 'ranking survives detail failure');
    await page.route('**/api/games', route => route.fulfill({ status: 503, json: { error: 'Steam 연결 실패' } }));
    await page.reload();
    await page.locator('#notice').waitFor();
    assert.match(await page.locator('#notice').textContent(), /Steam 연결 실패/);
    assert.equal(await page.locator('.game-row').count(), 0, 'no fabricated fallback ranking');
    assert.equal(await page.locator('#refreshBtn').isEnabled(), true);
  }
  assert.deepEqual(errors, [], 'no JavaScript runtime errors');
  const externalFailures = failedResources.filter(item => !item.url.startsWith(origin) && !item.reason?.includes('ERR_ABORTED'));
  console.log(JSON.stringify({ mode: live ? 'live Steam' : 'deterministic fixtures', tested: ['20 rows', '100th rank', 'search', 'sorting', 'modal + Escape', 'mobile', ...(!live ? ['escaped titles', 'missing scores', 'API failure states'] : [])], runtimeErrors: errors, externalResourceFailures: externalFailures, httpErrors, imageResults }, null, 2));
} finally { await browser?.close(); child?.kill(); }
