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

// --- 저장소 예산 -------------------------------------------------------------
//
// Neon 무료는 0.5GB 지만 그 숫자를 코드에 못 박지 않는다. 요금제를 올리거나(3GB)
// 내리면 DB_SIZE_BUDGET_MB 하나만 바꾸면 되고, 보관정책·경보·상태 페이지가 함께 따라온다.
// 보관 기간도 같은 이유로 환경변수다 — 기간을 바꾸려고 db/functions.sql 을 고치면
// 마이그레이션을 다시 돌려야 하지만(CLAUDE.md 규칙 24), 여기서 인자로 넘기면 배포만으로 바뀐다.
//
// **원시 보관은 3일 밑으로 내려가면 안 된다.** rollup_player_daily(2) 가 이틀 치 원시
// 스냅샷을 다시 읽어 일 롤업을 덮어쓰기 때문이다. 원시가 먼저 지워지면 온전한 하루가
// 조각으로 덮이고, 일 롤업은 prune 대상이 아니라 그 조각이 영구 보관된다(규칙 23 과 같은 사고).
const clampDays = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : fallback;
};

export const STORAGE_BUDGET_BYTES = clampDays(process.env.DB_SIZE_BUDGET_MB, 512, 64, 1_000_000) * 1024 * 1024;

export const RETENTION_FLOOR = { snapshotDays: 3, hourlyDays: 7 };

// 평상시 보관 기간. 압박이 없으면 이 값 그대로 쓴다.
export const RETENTION = {
  snapshotDays: clampDays(process.env.RETENTION_SNAPSHOT_DAYS, 7, RETENTION_FLOOR.snapshotDays, 365),
  hourlyDays: clampDays(process.env.RETENTION_HOURLY_DAYS, 90, RETENTION_FLOOR.hourlyDays, 3650)
};
