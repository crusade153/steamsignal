import { neon } from '@neondatabase/serverless';

// Vercel 서버리스에서는 반드시 pooler(-pooler.<region>) 연결 문자열을 쓴다.
// 직접 연결은 마이그레이션 전용이며, 함수가 스케일아웃하면 커넥션이 고갈된다.
export function createSql(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL 이 없습니다. .env 또는 Vercel 환경변수를 확인하세요.');
  return neon(url);
}

let shared;
export const getSql = () => (shared ??= createSql());

// 페이지 핸들러 중에는 DB 를 전혀 읽지 않는 것들이 있다 — 개인정보처리방침·이용약관·문의,
// 그리고 내용이 브라우저에만 있는 위시리스트 껍데기.
// 라우터가 getSql() 을 미리 부르면 DATABASE_URL 이 없을 때 그 페이지들까지 503 이 된다.
// 실제로 질의를 보내는 순간에 클라이언트를 만든다.
export const lazySql = () => (strings, ...values) => getSql()(strings, ...values);

// 배치 적재는 전부 이 형태로 보낸다. 파라미터 1개 = 왕복 1회, NULL 도 그대로 보존된다.
// 컬럼별 배열(unnest)보다 안전하고, 행이 100개든 1000개든 쿼리 텍스트가 변하지 않아 계획이 캐시된다.
export const rowsAsJson = rows => JSON.stringify(rows);

// 실행 로그를 남기며 잡을 감싼다. 관측 없는 크론은 조용히 죽어도 아무도 모른다.
export async function withRun(sql, job, task) {
  const [{ id }] = await sql`INSERT INTO collector_runs (job) VALUES (${job}) RETURNING id`;
  try {
    const result = (await task()) || {};
    const { processed = 0, failed = 0, ...detail } = result;
    const status = failed > 0 ? 'partial' : 'ok';
    await sql`
      UPDATE collector_runs
         SET finished_at = NOW(), status = ${status}, processed = ${processed},
             failed = ${failed}, detail = ${JSON.stringify(detail)}::jsonb
       WHERE id = ${id}`;
    return { job, status, processed, failed, ...detail };
  } catch (error) {
    await sql`
      UPDATE collector_runs
         SET finished_at = NOW(), status = 'error', error = ${String(error?.message || error).slice(0, 2000)}
       WHERE id = ${id}`;
    throw error;
  }
}
