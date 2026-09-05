import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

for (const file of ['server.mjs', 'lib/steam.mjs', 'lib/http.mjs', 'public/app.js', 'api/games.js', 'api/game-details.js', 'api/health.js']) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
for (const file of ['public/index.html', 'public/styles.css', 'public/favicon.svg']) await access(file);
JSON.parse(await readFile('vercel.json', 'utf8'));
console.log('Build verified: public/ static assets + api/ Vercel Functions.');
