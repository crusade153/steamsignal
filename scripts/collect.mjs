#!/usr/bin/env node
// 수집기 CLI. GitHub Actions·로컬·어떤 호스팅에서든 이 한 줄로 돈다.
//   node scripts/collect.mjs chart details
//   node scripts/collect.mjs rollup-hourly
//   node scripts/collect.mjs rollup-daily prune
import { getSql } from '../lib/db.mjs';
import { createCollector } from '../lib/collect.mjs';

const names = process.argv.slice(2);
const collector = createCollector({ sql: getSql() });

if (!names.length) {
  console.error(`사용법: node scripts/collect.mjs <잡...>\n가능한 잡: ${collector.jobNames.join(', ')}`);
  process.exit(2);
}

let failed = false;
for (const name of names) {
  const started = Date.now();
  try {
    const result = await collector.run(name);
    console.log(JSON.stringify({ ...result, ms: Date.now() - started }));
  } catch (error) {
    failed = true;
    console.error(JSON.stringify({ job: name, status: 'error', ms: Date.now() - started, error: String(error?.message || error) }));
  }
}
process.exit(failed ? 1 : 0);
