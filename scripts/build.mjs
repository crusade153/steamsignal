import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

for (const file of ['server.mjs', 'lib/steam.mjs', 'lib/http.mjs', 'public/app.js', 'public/watchlist.js', 'public/watch-button.js', 'api/games.js', 'api/game-details.js', 'api/health.js', 'api/cron.js', 'lib/db.mjs', 'lib/collect.mjs', 'lib/queries.mjs', 'lib/render.mjs', 'lib/routes.mjs', 'lib/pages.mjs', 'lib/legal.mjs', 'lib/alerts.mjs', 'lib/mail.mjs', 'lib/accounts.mjs', 'api/page.js', 'api/sitemap.js', 'api/alerts.js', 'api/account.js', 'scripts/collect.mjs', 'scripts/db-apply.mjs']) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
for (const file of ['public/index.html', 'public/styles.css', 'public/pages.css', 'public/account.js', 'public/favicon.svg', 'public/robots.txt', 'public/og-cover.png']) await access(file);
// rewrites 가 라우트 정의와 어긋나면 배포에서만 404 가 난다. 빌드에서 먼저 잡는다.
const { rewrites } = await import('../lib/routes.mjs');
const config = JSON.parse(await readFile('vercel.json', 'utf8'));
assert.deepEqual(config.rewrites, rewrites(), 'vercel.json 의 rewrites 가 lib/routes.mjs 와 다릅니다.');

// 크론 문자열은 schedule 블록과 잡 선택 case 두 곳에 적힌다. 어긋나면 워크플로는 정상 실행되고
// 조용히 기본값(chart,details)으로 떨어져 롤업이 영영 안 돈다 — 실패가 아니라 침묵이라 눈에 안 띈다.
const workflow = await readFile('.github/workflows/collect.yml', 'utf8');
const schedules = [...workflow.matchAll(/- cron: '([^']+)'/g)].map(m => m[1]);
const branches = [...workflow.matchAll(/^\s+'([^']+)'\)\s+jobs=/gm)].map(m => m[1]);
assert.ok(schedules.length, 'collect.yml 에 schedule 이 없습니다.');
assert.deepEqual([...schedules].sort(), [...branches].sort(),
  'collect.yml 의 schedule cron 과 잡 선택 case 의 문자열이 다릅니다.');

console.log('Build verified: public/ static assets + api/ Vercel Functions + SSR rewrites + cron branches.');
