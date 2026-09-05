# 데이터 파이프라인 설계

Steam Pulse 를 "요청마다 Steam 을 긁는 실시간 미러"에서 "자체 시계열을 가진 사이트"로 바꾸는 층이다.
지금 구조의 한계 네 가지를 한 번에 푼다.

| 지금 문제 | 이 설계의 답 |
| --- | --- |
| 인메모리 캐시가 서버리스 인스턴스마다 따로라 트래픽이 늘면 Steam 을 N배로 때린다 | 크론만 Steam 을 호출한다. 사용자 요청은 DB 만 읽는다 |
| 스토어 HTML 스크래핑이 상시 경로에 있다 | 스크래핑은 10분에 한 번, 실패해도 DB 에 남은 값으로 서비스가 산다 |
| 과거가 없어 추세·급상승·역대 최저가를 만들 수 없다 | 동접/가격/리뷰를 시계열로 적재한다 |
| URL 이 1개뿐이라 검색 유입이 없다 | 앱 마스터가 TOP 100 에 갇히지 않는다. 게임별 페이지를 만들 재료가 쌓인다 |

---

## 1. 구조

```
GitHub Actions (스케줄러, curl 1회)
        │  Authorization: Bearer CRON_SECRET
        ▼
/api/cron  ──►  lib/collect.mjs  ──►  Steam 공개 API
                      │
                      ▼
                 Neon Postgres
                      │
                      ▼
              사용자 요청 (읽기 전용)
```

스케줄러와 워커를 나눈 이유는 §5 에 있다.

### 파일

| 경로 | 역할 |
| --- | --- |
| [db/schema.sql](../db/schema.sql) | 테이블·인덱스 |
| [db/functions.sql](../db/functions.sql) | 롤업·보관정책 함수 |
| [lib/db.mjs](../lib/db.mjs) | Neon 클라이언트, 실행 로그 래퍼 |
| [lib/collect.mjs](../lib/collect.mjs) | 수집 잡 5종 |
| [api/cron.js](../api/cron.js) | 크론 엔드포인트 (시크릿 인증) |
| [scripts/collect.mjs](../scripts/collect.mjs) | CLI (로컬·수동·비상용) |

---

## 2. 스키마 결정 요약

**시계열을 3단으로 나눈다.** 이게 이 설계에서 가장 중요한 한 줄이다.

| 테이블 | 주기 | 보관 | 용도 |
| --- | --- | --- | --- |
| `player_snapshots` | 10분 | **7일** | 롤업 원재료. 오래 두지 않는다 |
| `player_hourly` | 1시간 | **90일** | 상세 페이지의 최근 7~30일 차트 |
| `player_daily` | 1일 | **영구** | 장기 추세, 역대 최고, SEO 본문 |

원시 스냅샷을 그냥 쌓으면 100개 × 144회 × 365일 = **526만 행 ≈ 580MB** 로 Neon 무료 0.5GB 를 1년 안에 넘긴다.
3단 계층 + `prune_timeseries()` 를 넣으면 1년 뒤에도 **70MB 안쪽**이다. 보관정책은 선택이 아니라 부품이다.

**"지금 값"과 "이력"을 테이블로 나눈다.**
`apps` 는 제목·설명·장르 같은 SEO 본문이라 거의 안 바뀌고, `app_stats` 는 매 사이클 UPDATE 된다.
한 테이블에 두면 설명 텍스트까지 10분마다 다시 쓰여 dead tuple 이 쌓인다. 좁은 테이블에 가둔다.

**멱등성은 `captured_at` 이 보장한다.**
스냅샷의 시각은 우리 시계가 아니라 Steam 이 준 `last_update` 다.
크론이 두 번 돌든, GitHub 스케줄이 밀려 몰려 오든, `ON CONFLICT DO NOTHING` 이 조용히 흡수한다.

**가격은 스냅샷이 아니라 변경 로그다.**
`price_events` 는 값이 실제로 바뀔 때만 행을 넣는다. "역대 최저가"가 정확히 나오면서 연간 수천 행에 그친다.

**결측을 0 으로 만들지 않는다.**
기존 코드의 규율을 DB 까지 끌고 왔다. 리뷰 0건이면 `positive_ratio` 는 `NULL` 이지 0 이 아니고,
`has_detail` / `has_reviews` 표식으로 한쪽만 실패했을 때 멀쩡한 값을 `NULL` 로 덮지 않는다.

---

## 3. 수집 잡

| 잡 | 주기 | Steam 호출 | 하는 일 |
| --- | --- | --- | --- |
| `chart` | 10분 | 2 | TOP 100 순위·동접 적재, 신규 앱 등록 |
| `details` | 10분 | 40 | 가장 오래 안 본 앱 20개의 가격·리뷰·메타데이터 |
| `rollup-hourly` | 1시간 | 0 | 최근 3시간 재집계 |
| `rollup-daily` | 1일 | 0 | 최근 2일 재집계 (KST 기준) |
| `prune` | 1일 | 0 | 보관정책 적용 |

### 상세 수집의 라운드로빈 커서

```sql
SELECT appid FROM apps WHERE details_failures < 5
 ORDER BY details_fetched_at NULLS FIRST LIMIT 20
```

이 한 줄이 파이프라인의 확장성을 결정한다.

- 앱이 100개든 10,000개든 **크론 설정을 바꿀 필요가 없다.** 처리량이 고정이라 Steam 부하도 고정된다.
- 20앱 × 2요청 = 10분당 40요청. Steam 스토어 API 의 통상 한계(5분당 200요청)의 20% 수준이다.
- 앱 800개 기준으로 각 앱이 하루 약 3.6회 갱신된다. 가격 추적에 충분하다.
- **성공이든 실패든 커서를 전진시킨다.** 안 그러면 죽은 앱이 큐 맨 앞에서 영원히 재시도된다.
  5회 연속 실패하면 부분 인덱스에서 빠지고, 90일 뒤 `prune_timeseries()` 가 정리한다.

> `lib/steam.mjs` 의 `getDetails()` 는 현재 TOP 100 밖 ID 를 400 으로 거부한다(공개 API 남용 방지).
> 수집기는 차트에서 내려간 게임도 계속 봐야 하므로 그 경로를 쓰지 않고 직접 호출한다.

---

## 4. 설치

```bash
npm install
```

```bash
psql "$DATABASE_URL_DIRECT" -f db/schema.sql -f db/functions.sql
```

`.env` 는 [.env.example](../.env.example) 참고. Vercel 에는 `DATABASE_URL`(pooler) 과 `CRON_SECRET` 을,
GitHub 저장소 secrets 에는 `SITE_URL` 과 `CRON_SECRET` 을 넣는다.

첫 적재를 손으로 돌려 확인한다.

```bash
node scripts/collect.mjs chart details
```

---

## 5. 스케줄러 선택 — 여기가 비용 함정이다

Vercel **Hobby 의 내장 크론은 하루 1회만** 돈다. 10분 주기가 필요하므로 외부 스케줄러가 필요하다.

| 방식 | 비용 | 최소 주기 | 판단 |
| --- | --- | --- | --- |
| GitHub Actions + **공개 저장소** | 무료 | 5분 | **권장.** 지금 워크플로가 이 방식 |
| GitHub Actions + 비공개 저장소 | 월 ~5,000분 청구 (무료 2,000분 초과) | 5분 | 권장하지 않음 |
| Vercel Cron (Pro $20/월) | 플랜 포함 | 1분 | 가장 안정적. 트래픽이 붙으면 이쪽으로 |
| cron-job.org / Upstash QStash | 무료 티어 | 1분 | 외부 의존이 하나 늘어남 |

> GitHub Actions 는 **잡 하나를 1분 단위로 올림 과금**한다. 5초짜리 curl 도 1분으로 계산된다.
> 하루 169회면 169분/일 = 월 5,070분이라 비공개 저장소의 무료 2,000분을 넘긴다.
> 그래서 워크플로를 체크아웃 없는 curl 한 줄로 만들었지만, **공개 저장소가 아니면 여전히 유료다.**

### 워커 쪽 예산 (Vercel Hobby)

| 항목 | 예상 | 월 한도 |
| --- | --- | --- |
| Function Invocations | ~5,100/월 (169/일) | 1,000,000 |
| Fast Origin Transfer | 무시 가능 (응답이 작은 JSON) | 10 GB |
| Fluid Active CPU | 대부분 네트워크 대기라 낮음 — **배포 후 첫 주에 실측할 것** | 4시간 |

Active CPU 만은 추정이다. 첫 주 Usage 그래프를 보고 필요하면 `details` 의 `batch` 를 줄인다.

### Pro 로 올린 뒤

`.github/workflows/collect.yml` 을 지우고 `vercel.json` 에 넣는다.

```json
"crons": [
  { "path": "/api/cron?jobs=chart,details", "schedule": "*/10 * * * *" },
  { "path": "/api/cron?jobs=rollup-hourly", "schedule": "5 * * * *" },
  { "path": "/api/cron?jobs=rollup-daily,prune", "schedule": "20 18 * * *" }
]
```

Vercel Cron 은 `Authorization: Bearer $CRON_SECRET` 을 자동으로 붙여 준다. `api/cron.js` 가 이미 그 형식을 받는다.

---

## 6. 읽기 쿼리

앞으로 만들 페이지들이 이 DB 를 어떻게 읽는지. 전부 `SELECT *` 없이 컬럼을 명시하고 `LIMIT` 을 건다.

### 목록 (현재 TOP 100) — 왕복 1회

```sql
SELECT a.appid, a.title, a.slug, a.header_image, a.metacritic_score,
       s.players, s.peak_today, s.rank,
       s.final_price, s.discount_percent, s.price_formatted,
       s.positive_ratio, s.total_positive + s.total_negative AS review_total
  FROM app_stats s
  JOIN apps a USING (appid)
 WHERE s.rank IS NOT NULL
 ORDER BY s.rank
 LIMIT 100;
```

### 게임 상세 — 최근 7일 동접 차트

```sql
SELECT bucket, avg_players, max_players
  FROM player_hourly
 WHERE appid = $1 AND bucket >= NOW() - INTERVAL '7 days'
 ORDER BY bucket;
```

### 역대 최고 동접

```sql
SELECT day, peak_reported
  FROM player_daily
 WHERE appid = $1 AND peak_reported IS NOT NULL
 ORDER BY peak_reported DESC
 LIMIT 1;
```

### 역대 최저가 — 어필리에이트/할인 페이지의 핵심

```sql
SELECT final_price, discount_percent, observed_at
  FROM price_events
 WHERE appid = $1 AND final_price IS NOT NULL AND final_price > 0
 ORDER BY final_price ASC, observed_at ASC
 LIMIT 1;
```

### 급상승 (24시간 vs 직전 7일) — Steam 이 안 주는 우리만의 콘텐츠

```sql
WITH recent AS (
  SELECT appid, AVG(avg_players)::int AS players FROM player_hourly
   WHERE bucket >= NOW() - INTERVAL '24 hours' GROUP BY appid
), past AS (
  SELECT appid, AVG(avg_players)::int AS players FROM player_hourly
   WHERE bucket >= NOW() - INTERVAL '8 days' AND bucket < NOW() - INTERVAL '1 day'
   GROUP BY appid
)
SELECT a.appid, a.title, a.slug, recent.players AS now_players, past.players AS past_players,
       ROUND((recent.players - past.players) * 100.0 / NULLIF(past.players, 0), 1) AS change_pct
  FROM recent JOIN past USING (appid) JOIN apps a USING (appid)
 WHERE past.players > 1000
 ORDER BY change_pct DESC NULLS LAST
 LIMIT 20;
```

### 최근 30일 신규 리뷰 긍정률

누적값의 차분이다. Steam 이 리뷰를 삭제하면 음수가 될 수 있어 `GREATEST` 로 막는다.

```sql
SELECT GREATEST(MAX(total_positive) - MIN(total_positive), 0) AS new_positive,
       GREATEST(MAX(total_negative) - MIN(total_negative), 0) AS new_negative
  FROM review_daily
 WHERE appid = $1 AND day >= CURRENT_DATE - 30;
```

---

## 7. 운영

수집 상태는 `collector_runs` 하나만 보면 된다.

```sql
SELECT job, status, processed, failed, started_at, finished_at, error
  FROM collector_runs
 ORDER BY started_at DESC
 LIMIT 20;
```

경보를 걸 만한 조건:

- `chart` 잡이 30분 이상 `ok` 를 못 냈다 → Steam 차트 API 또는 스케줄러 문제
- `details` 의 `failed` 가 `processed` 를 넘는다 → IP 차단 또는 스토어 API 변경
- `details_failures >= 5` 인 앱이 급증한다 → 위와 같음
- `player_snapshots` 의 `MAX(captured_at)` 이 20분 이상 안 움직인다 → 파이프라인 정지

---

## 8. 검증 상태

정직하게 적는다.

| 대상 | 상태 |
| --- | --- |
| `lib/collect.mjs` 의 적재 로직 (페이로드 모양, 커서 전진, 덮어쓰기 방지, 멱등 키) | [tests/collect.test.mjs](../tests/collect.test.mjs) 로 검증. `npm test` 13개 통과 |
| `parseReleaseDate` / `slugify` | 검증 완료. 시간대 4곳(UTC/KST/뉴욕/오클랜드)에서 동일 결과 확인 |
| 기존 API·UI 회귀 | `npm test` + `npm run build` 통과 |
| **`db/schema.sql`, `db/functions.sql` 의 실제 실행** | **미검증.** 이 환경에 Postgres 가 없어 문법·제약을 실행으로 확인하지 못했다 |
| **실제 Steam 응답에 대한 종단 수집** | **미검증.** Neon 인스턴스를 만든 뒤 `node scripts/collect.mjs chart` 로 첫 확인이 필요하다 |

먼저 할 일: Neon 프로젝트를 만들고 `npm run db:migrate` 후 `node scripts/collect.mjs chart` 를 돌려
`player_snapshots` 에 100행이 들어가는지 확인한다. 여기서 SQL 오타가 있다면 그때 드러난다.
