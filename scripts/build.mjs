import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

for (const file of ['server.mjs', 'lib/steam.mjs', 'lib/http.mjs', 'public/app.js', 'api/games.js', 'api/game-details.js', 'api/health.js', 'api/cron.js', 'lib/db.mjs', 'lib/collect.mjs', 'lib/queries.mjs', 'lib/render.mjs', 'lib/routes.mjs', 'lib/pages.mjs', 'api/page.js', 'api/sitemap.js', 'scripts/collect.mjs']) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
for (const file of ['public/index.html', 'public/styles.css', 'public/pages.css', 'public/favicon.svg', 'public/robots.txt', 'public/og-cover.png']) await access(file);
// rewrites 가 라우트 정의와 어긋나면 배포에서만 404 가 난다. 빌드에서 먼저 잡는다.
const { rewrites } = await import('../lib/routes.mjs');
const config = JSON.parse(await readFile('vercel.json', 'utf8'));
assert.deepEqual(config.rewrites, rewrites(), 'vercel.json 의 rewrites 가 lib/routes.mjs 와 다릅니다.');

console.log('Build verified: public/ static assets + api/ Vercel Functions + SSR rewrites.');
