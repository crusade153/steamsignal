// db/*.sql 을 DATABASE_URL 로 적용한다. `npm run db:migrate` 의 psql 없는 판이다.
//
// **왜 필요한가.** db/schema.sql 과 db/functions.sql 은 저절로 실행되지 않는데,
// 이 저장소를 다루는 PC 에 psql 도 DATABASE_URL_DIRECT 도 없는 경우가 있다.
// 그때 "코드는 고쳤는데 DB 는 그대로"인 상태가 조용히 만들어진다 — 실제로 두 번 났다
// (이메일 알림 테이블 누락: HANDOFF §3-2 / 롤업 창: HANDOFF §3-3).
//
// 두 파일 모두 CREATE TABLE IF NOT EXISTS · CREATE OR REPLACE FUNCTION ·
// CREATE INDEX IF NOT EXISTS 뿐이라 몇 번을 돌려도 안전하고 기존 데이터를 건드리지 않는다.
//
//   npm run db:apply                 # schema.sql + functions.sql 둘 다
//   npm run db:apply -- db/functions.sql
//
// pooler 연결로도 DDL 은 문제없이 나간다. 마이그레이션 전용 직접 연결이 필요한 것은
// 장시간 잠금이 걸리는 작업뿐이고 여기엔 그런 게 없다.
import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

// 드라이버에 query() 가 없어서 태그드 템플릿 인자 모양을 직접 만든다(보간값 없음).
// 이 파일이 보내는 것은 우리 저장소의 .sql 뿐이므로 외부 입력이 섞일 자리가 없다.
const raw = (sql, text) => sql(Object.assign([text], { raw: [text] }));

// 세미콜론으로 그냥 자르면 안 된다 — 함수 본문($$ ... $$)과 COMMENT ON 의 문자열 안에
// 세미콜론이 들어 있다. 작은따옴표와 달러 인용을 건너뛰며 자른다.
export function splitStatements(source) {
  const statements = [];
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const rest = source.slice(i);
    if (rest.startsWith('--')) { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (source[i] === "'") { i = source.indexOf("'", i + 1); if (i < 0) break; continue; }
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
    if (dollar) {
      const end = source.indexOf(dollar[0], i + dollar[0].length);
      if (end < 0) break;
      i = end + dollar[0].length - 1;
      continue;
    }
    if (source[i] === ';') {
      const statement = source.slice(start, i + 1).trim();
      if (statement.replace(/--[^\n]*/g, '').trim()) statements.push(statement);
      start = i + 1;
    }
  }
  return statements;
}

// 첫 두 단어로 무엇을 했는지 한 줄씩 알린다. 조용히 끝나면 돌았는지 알 수 없다.
const label = statement =>
  statement.replace(/--[^\n]*/g, '').trim().split(/\s+/).slice(0, 4).join(' ').slice(0, 60);

export async function apply(sql, files) {
  for (const file of files) {
    const statements = splitStatements(await readFile(file, 'utf8'));
    console.log(`\n${file} — 문장 ${statements.length}개`);
    for (const statement of statements) {
      await raw(sql, statement);
      console.log('  ok', label(statement));
    }
  }
}

// 직접 실행할 때만 돈다. 이 가드가 없으면 splitStatements 를 import 하는 것만으로
// 프로덕션 DB 에 DDL 이 나간다 — 테스트가 그걸 하게 되는 순간이 가장 나쁘다.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const files = process.argv.slice(2);
  const sql = neon(process.env.DATABASE_URL);
  await apply(sql, files.length ? files : ['db/schema.sql', 'db/functions.sql']);

  // 적용 뒤 대조는 생략하지 않는다 — 숫자를 눈으로 봐야 '적용됐다'가 검증이 된다.
  const [{ n: functions }] = await sql`
    SELECT COUNT(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'`;
  const [{ n: tables }] = await sql`SELECT COUNT(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`;
  console.log(`\n대조: 테이블 ${tables}개 · 함수 ${functions}개 (기대 20 · 6 — HANDOFF §3-2)`);
}
