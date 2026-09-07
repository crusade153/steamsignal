# 데이터 파이프라인 설계

Steam Pulse 를 "요청마다 Steam 을 긁는 실시간 미러"에서 "자체 시계열을 가진 사이트"로 바꾸는 층이다.
지금 구조의 한계 네 가지를 한 번에 푼다.

| 지금 문제 | 이 설계의 답 |
| --- | --- |
| 인메모리 캐시가 서버리스 인스턴스마다 따로라 트래픽이 늘면 Steam 을 N배로 때린다 | 크론만 Steam 을 호출한다. 사용자 요청은 DB 만 읽는다 |
| 스토어 HTML 스크래핑이 상시 경로에 있다 | 스크래핑은 10분에 한 번, 실패해도 DB 에 남은 값으로 서비스가 산다 |
| 과거가 없어 추세·급상승·역대 최저가를 만들 수 없다 | 동접/가격/리뷰를 시계열로 적재한다 |
| URL 이 1개뿐이라 검색 유입이 없다 | 앱 마스터가 TOP 100 에 갇히지 않는다. 이 재료로 게임별·파생 페이지를 만들었다 (§6) |

---

## 1. 구조

```
cron-job.org (주 스케줄러) + GitHub Actions (예비 트리거)
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
| [lib/collect.mjs](../lib/collect.mjs) | 잡 9종 (수집 6 + 메일 2 + 감시 1) |
| [lib/mail.mjs](../lib/mail.mjs) | Resend 발송 + 메일 템플릿. 설정이 없으면 아무것도 하지 않는다 |
| [api/cron.js](../api/cron.js) | 크론 엔드포인트 (시크릿 인증) |
| [scripts/collect.mjs](../scripts/collect.mjs) | CLI (로컬·수동·비상용) |

읽기 쪽(§6 의 쿼리를 실제로 쓰는 코드)은 이렇게 나뉜다.

| 경로 | 역할 |
| --- | --- |
| [lib/queries.mjs](../lib/queries.mjs) | 읽기 전용 쿼리. 여기서 Steam 을 부르는 코드는 없다 |
| [lib/alerts.mjs](../lib/alerts.mjs) | 구독 SQL. **사용자 요청 경로에서 쓰기를 하는 유일한 파일** |
| [lib/render.mjs](../lib/render.mjs) | 레이아웃·포맷터·인라인 SVG 차트 |
| [lib/pages.mjs](../lib/pages.mjs) | 페이지 본문. `{status, headers, body}` 만 돌려주고 HTTP 를 모른다 |
| [lib/routes.mjs](../lib/routes.mjs) | 라우트 정의 한곳. `vercel.json` 의 rewrites 를 여기서 만든다 |
| [api/page.js](../api/page.js), [api/sitemap.js](../api/sitemap.js) | Vercel 함수 진입점 |

---

## 2. 스키마 결정 요약

**시계열을 3단으로 나눈다.** 이게 이 설계에서 가장 중요한 한 줄이다.

| 테이블 | 주기 | 보관 | 용도 |
| --- | --- | --- | --- |
| `player_snapshots` | 10분 | **7일**(압박 시 3일까지) | 롤업 원재료. 오래 두지 않는다 |
| `player_hourly` | 1시간 | **90일**(압박 시 30일까지) | 상세 페이지의 최근 7~30일 차트 |
| `player_daily` | 1일 | **영구** | 장기 추세, 역대 최고, SEO 본문 |

원시 스냅샷을 그냥 쌓으면 100개 × 144회 × 365일 = **526만 행 ≈ 580MB** 로 Neon 무료 0.5GB 를 1년 안에 넘긴다.
3단 계층 + `prune_timeseries()` 를 넣으면 1년 뒤에도 **70MB 안쪽**이다. 보관정책은 선택이 아니라 부품이다.

### 2-1. 저장소 예산은 고정값이 아니라 조절되는 값이다

0.5GB 는 "지키면 좋은 목표"가 아니라 **넘으면 쓰기가 막히는 벽**이다. 그런데 증가 속도는
자주 바뀐다 — 커버리지를 200 → 300 으로 올리거나, Twitch·Wikipedia 같은 새 지표를 붙이면
행 수가 통째로 달라진다. 그때마다 사람이 알아채고 손으로 기간을 줄이는 것은 늦다.

그래서 `prune` 잡은 돌 때마다 `pg_database_size()` 를 재고, `planRetention()` 이 사용률로
그 회차의 보관 기간을 정해 `prune_timeseries(원시일, 시간일)` 에 **인자로 넘긴다.**

| 사용률 | 단계 | 원시 | 시간 롤업 | 일 롤업 |
| --- | --- | --- | --- | --- |
| < 70% | `ok` | 설정값(기본 7일) | 설정값(기본 90일) | 영구 |
| 70% ~ 85% | `tight` | 최대 5일 | 최대 60일 | 영구 |
| ≥ 85% | `critical` | **3일**(하한) | 30일 | 영구 |
| 측정 실패 | `unknown` | 설정값 | 설정값 | 영구 |

규율 넷.

1. **일 롤업은 어느 단계에서도 줄이지 않는다.** 게임당 하루 1행이라 용량 문제를 일으키지 않고,
   그게 이 사이트가 파는 유일한 영구 자산이다.
2. **원시 하한 3일을 뚫지 않는다.** `rollup_player_daily(2)` 가 이틀 치 원시를 다시 읽어
   일 롤업을 덮어쓴다. 원시가 먼저 사라지면 온전한 하루가 조각으로 덮이고, 일 롤업은
   `prune` 대상이 아니라 그 조각이 영구 보관된다 — §23 의 사고와 같은 모양이다.
3. **못 쟀으면 조이지 않는다.** 측정 실패를 위험으로 읽어 데이터를 지우는 쪽이 더 나쁘다.
4. **`DELETE` 는 논리 크기를 즉시 줄이지 않는다.** 죽은 행은 autovacuum 이 지난 뒤 다음
   `INSERT` 가 재사용한다. 그러니 `prune` 의 목적은 '지금 줄이는 것'이 아니라 **증가를 멈추는 것**이다.

예산·기간은 전부 환경변수(`DB_SIZE_BUDGET_MB` · `RETENTION_SNAPSHOT_DAYS` · `RETENTION_HOURLY_DAYS`)라
요금제를 올리거나 커버리지를 늘릴 때 **마이그레이션 없이 배포만으로** 따라간다.
현재 사용량과 실제 적용 중인 기간은 `/status` 가 그대로 보여 주고,
예산의 90% 를 넘으면 `watchdog` 이 던져 운영자에게 메일이 간다.

**"지금 값"과 "이력"을 테이블로 나눈다.**
`apps` 는 제목·설명·장르 같은 SEO 본문이라 거의 안 바뀌고, `app_stats` 는 매 사이클 UPDATE 된다.
할인 종료일은 `discount_end_date`에 달력 날짜로, 확인 여부는 `discount_end_checked_at`에 둔다.
Steam이 종료 시각을 제공하지 않으므로 임의의 자정이나 마감 시각을 만들어 저장하지 않는다.
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
| `chart` | 10분 | 2 + N | TOP 100 순위·동접 적재, 신규 앱 등록, **차트 밖 추적 게임 N개의 동접** |
| `details` | 10분 | 80 + 현재 할인 앱 수 | 가장 오래 안 본 앱 40개의 가격·리뷰·메타데이터. 할인 중인 앱만 상점 종료일 추가 확인 |
| `rollup-hourly` | 1시간 | 0 | 최근 3시간 재집계 (**버킷 경계로 스냅한 창** — 아래) |
| `rollup-daily` | 1일 | 0 | 최근 2일 재집계 (KST 자정으로 스냅한 창) |
| `prune` | 1일 | 0 | 보관정책 적용 (시계열 + 구독 데이터) |
| `alerts` | 30분 | 0 | 가격 하락 알림 메일. 설정이 없으면 즉시 끝난다 |
| `newsletter` | 1주 | 0 | 주간 리포트 메일 (월요일 09:23 KST) |
| `discover` | 1일 | ~60 | 스토어 판매 상위에서 후보를 받아 로스터를 200개까지 채운다 |
| `watchdog` | 2시간 | 0 | 파이프라인 감시. 이상이 있으면 **일부러 실패한다** (§7) |

### 롤업 창은 버킷 경계로 스냅한다

겹쳐 돌리는 것(3시간·2일)은 진행 중인 버킷을 갱신하기 위해서다. 그런데 창의 **시작점**을
`NOW()` 에서 그냥 빼면 그 지점이 버킷 한가운데에 떨어지고, 가장 오래된 버킷은 조각만으로
집계된 뒤 `ON CONFLICT DO UPDATE` 가 **온전한 값을 그 조각으로 덮는다.** 다음 실행 때는
이미 창 밖이라 영영 복구되지 않는다.

```sql
WHERE captured_at >= NOW() - make_interval(hours => p_hours)                 -- 틀림
WHERE captured_at >= date_trunc('hour', NOW() - make_interval(hours => p_hours))  -- 맞음
```

실제로 이 잡이 매시 37분에 도는 동안 모든 시간 버킷이 6표본이 아니라 **마지막 2표본(17분)만**
담아 평균이 최대 7% 어긋났다(HANDOFF §3-3). 일 롤업도 같은 이유로 KST 자정으로 자른다.

불변식은 하나이고 `tests/rollup.test.mjs` 가 PGlite 로 실제 SQL 을 돌려 지킨다 —
**롤업이 쓴 버킷은 그 버킷의 원시 스냅샷 전부를 요약한 값이어야 한다.**

### 커버리지 200개 — 차트 밖 게임을 어떻게 붙잡나

Steam 의 `mostplayed` 차트는 **정확히 100개만** 준다. 그래서 200개를 추적하려면
나머지 100개는 `ISteamUserStats/GetNumberOfCurrentPlayers` 로 **appid 하나씩** 물어야 한다.

```
chart 잡 = 차트 응답 1회(100개) + 개별 동접 요청 최대 100회
```

`captured_at` 은 두 무리가 **같은 값**을 쓴다(Steam 이 준 차트 갱신 시각). 어긋나면 롤업이
같은 10분을 두 버킷에 나눠 담아 표본 수가 부풀려진다. 차트 밖 게임에는 `rank` 를 적지 않는다 —
순위가 없는 게 사실이고, 적으면 그건 우리가 지어낸 값이다.

**이게 커버리지 숫자보다 중요한 이유:** 지금까지는 게임이 100위 밖으로 내려가는 순간
동접 기록이 끊겨서 상세 페이지의 그래프가 어느 날 갑자기 잘렸다. "예전엔 잘나갔는데 지금은"
이라는 우리만의 이야기는 그 끊긴 자리에서만 나올 수 있다.

`discover` 잡은 로스터를 채운다. `apps` 는 지금까지 '차트에 든 적이 있는 게임'으로만 늘었고
그 방식으로 200개를 채우려면 몇 달이 걸린다. 스토어 판매 상위(이미 차트 메타데이터를 읽고 있는
그 호스트다)에서 후보를 받아 **부족한 만큼만** 넣는다. 넣기 전에 `appdetails` 로 `type === 'game'`
을 확인한다 — DLC·사운드트랙이 한 번 들어오면 목록·장르·사이트맵에 전부 나타나고,
그때 빼는 것은 이미 색인된 URL 을 죽이는 일이 된다.

메일 잡 둘은 **Steam 을 부르지 않는다.** 이미 적재된 `app_stats`·`price_events` 만 읽는다.
한 번에 보내는 통 수는 알림 40통·주간 90통으로 막아 두었다 — Vercel 함수 시간(60초)과
Resend 일일 한도가 둘 다 걸리기 때문이고, 남은 대상은 다음 실행이 이어서 가져간다.

### 상세 수집의 라운드로빈 커서

```sql
SELECT appid FROM apps WHERE details_failures < 5
 ORDER BY details_fetched_at NULLS FIRST LIMIT 40
```

이 한 줄이 파이프라인의 확장성을 결정한다.

- 앱이 100개든 10,000개든 **크론 설정을 바꿀 필요가 없다.** 처리량이 고정이라 Steam 부하도 고정된다.
- 40앱 × 2요청 = 10분당 80요청. Steam 스토어 API 의 통상 한계(5분당 200요청) 안이다.
- 앱 200개 기준으로 한 바퀴가 약 50분, 각 앱이 하루 약 28회 갱신된다.
- 할인 종료일은 `appdetails` JSON에 없어서 한국시간(`timezoneOffset=32400`) 공식 상점 HTML의
  본편 현재가·할인율과 일치하는 블록만 읽는다. 에디션·번들 가격 블록은 일치하지 않으면 버린다.
- 상점 페이지 조회가 실패하면 기존 종료일을 보존하고 가격·리뷰 수집은 계속한다. 할인이 끝나면 종료일을 지운다.
  batch 를 20 으로 두면 같은 200개가 1.7시간에 한 바퀴다 — 목표(2시간 이내)에는 들지만
  커버리지를 더 넓히면 곧 넘긴다. 그래서 커버리지와 함께 올렸다.
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
>
> `crusade153/steamsignal` 은 공개 저장소이므로 현재는 무료다. 비공개로 전환할 일이 생기면 이 표를 다시 볼 것.

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

페이지들이 이 DB 를 어떻게 읽는지. 전부 `SELECT *` 없이 컬럼을 명시하고 `LIMIT` 을 건다.
실제 구현은 [lib/queries.mjs](../lib/queries.mjs) 에 있고, 아래는 그 뼈대다.

> **DATE 컬럼은 `TO_CHAR(day, 'YYYY-MM-DD')` 로 문자열로 꺼낸다.**
> 드라이버가 DATE 를 로컬 자정 `Date` 객체로 돌려주기 때문에, 화면단에서 `toISOString()` 을
> 한 번만 잘못 쓰면 하루가 밀린다. 문자열로 받으면 그 실수 자체가 불가능해진다.

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

적재 초기에는 8일치가 없다. 실제 구현은 창을 좁혀 가며 결과가 나오는 구간에서 멈추고,
**실제로 사용한 창을 화면에 적는다** — "24시간 대비"라고 써 놓고 3시간을 비교하면 거짓말이 된다.

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

### 목록 스파크라인 — 원시값이 아니라 비교값

원시 시간 동접은 거의 모든 게임이 지역별 하루 주기를 따라 같은 산 모양이 된다. 게다가 게임별
최소~최대를 각각 0~100으로 늘리면 2% 변화와 200% 변화가 같은 높이가 된다. 그래서 목록에서는
원시 플레이어 수를 그리지 않는다.

1. 데이터가 첫 24시간보다 얇으면 각 게임의 `플레이어 수 ÷ 같은 버킷의 추적군 전체 플레이어 수`를
   첫 표본과 비교한 **추적군 내 비중 변화**를 쓴다. 공통 일중 주기가 분모에서 빠진다.
2. 24시간 전 같은 버킷이 세 개 이상 생기면 **전일 동시간 대비 증감률**로 자동 전환한다.
3. 일 롤업 증감률이 게임 80% 이상에서 세 점 이상이면 **일평균 전일 대비**로 전환한다.

세 모드 모두 화면에서는 고정 ±50% 축을 쓰고 0% 기준선·현재 변화율을 함께 표시한다. ±50%를 넘는
선은 경계에서 자르되 실제 숫자는 그대로 적는다. 이렇게 해야 행 사이의 변화 크기를 비교할 수 있다.

### 파생 페이지 쿼리

`/game/:slug/reviews` · `/charts/monthly` · `/deals/all-time-low` · `/genre/:g/free` ·
`/genre/:g/discounted` · `/releases/:year` 가 쓰는 쿼리는 전부 `lib/queries.mjs` 에 있다.
여기에 전문을 옮겨 적지 않는다 — 두 곳에 적으면 반드시 어긋난다. 대신 판정 규칙만 적어 둔다.

- **역대 최저가**(`allTimeLows`) — `price_events` 에서 가격 변경을 **2회 이상** 본 앱만 판정한다.
- **할인 종료** — 한국 날짜와 남은 일수를 함께 표시한다. 날짜 미표시는 `Steam 미제공`, 아직 수집 전은 `확인 중`이다.
  1회만 본 앱은 그 값이 자동으로 최저가라 "언제나 참"이 되어 아무것도 알려 주지 못한다.
- **장르 조합**(`genreFreeGames` / `genreDiscountedGames`) — 게임이 `MIN_COMBO_GAMES`(5) 미만이면
  페이지를 만들지 않는다. 링크·페이지·사이트맵이 이 상수 하나를 공유한다.
- **무료 판정** — `apps.is_free IS TRUE` 이거나 `app_stats.final_price = 0`.
  `is_free` 가 NULL 인(상세 미수집) 앱은 값이 0원이어도 넣지 않는다.
- **발매 연도**(`releaseYears`) — `apps.release_date` 가 NULL 인 앱은 자동으로 빠진다.
  원문(`release_date_text`)으로 억지 추정하지 않는다.
- **리뷰 추이**(`reviewSeries`) — 하루 1행이라 180일을 다 꺼내도 400행 이하다.
  차분은 화면단(`reviewDeltas()`)에서 하고, 빠진 날을 0 으로 채우지 않는다.

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

경보 조건은 **`watchdog` 잡이 자동으로 본다**(2시간 간격). 임계값은
`lib/collect.mjs` 의 `HEALTH_LIMITS` 하나에 모여 있고, 판정은 순수 함수 `evaluateHealth()` 가 한다.

| 조건 | 임계값 | 뜻 |
| --- | --- | --- |
| `player_snapshots` 의 `MAX(captured_at)` 이 멈춤 | 25분 | 파이프라인 정지 (한 사이클 지연은 정상) |
| `chart` 잡이 `ok` 를 못 냄 | 30분 | Steam 차트 API 또는 스케줄러 문제 |
| `details` 의 `failed` 가 `processed` 만큼 많음 | 최근 6시간 합계 | IP 차단 또는 스토어 API 변경 |
| `details_failures >= 5` 인 앱 수 | 20개 | 위와 같음 |

**통보 방법이 특이하다. 경보가 걸리면 잡이 일부러 예외를 던진다.**
`withRun` 이 `collector_runs` 에 `error` 로 남기고 → `/api/cron` 이 500 을 내고 →
GitHub Actions 의 `curl` 이 실패해 워크플로가 빨개지고 → GitHub 이 저장소 소유자에게 메일을 보낸다.
Slack·Resend 없이 **설정 0개로** 도는 경보 경로가 이것뿐이라 이렇게 했다.
나중에 Slack 웹훅을 붙이려면 `evaluateHealth()` 의 반환값을 던지는 대신 보내면 된다 —
판정과 통보는 이미 분리돼 있다.

감시 자체는 **아무것도 쓰지 않는다.** 읽기 5개를 한 쿼리로 묶어 왕복 1회다.

---

## 8. 검증 상태

정직하게 적는다. (갱신 2026-09-06)

| 대상 | 상태 |
| --- | --- |
| 적재 로직 (페이로드 모양, 커서 전진, 덮어쓰기 방지, 멱등 키) | [tests/collect.test.mjs](../tests/collect.test.mjs) |
| 읽기·렌더링 (라우팅, 이스케이프, 시간대, 결측 표기, 정규화 301) | [tests/pages.test.mjs](../tests/pages.test.mjs) |
| `db/schema.sql`, `db/functions.sql` 실제 실행 | 검증됨 — 테이블 20개, 함수 6개 |
| 종단 수집 (Steam → Neon) | 검증됨 — 잡 5종 전부 성공 |
| `/api/cron` 배포 동작 | 검증됨 — 401/200 양쪽과 잡 실행 |
| cron-job.org 주 스케줄러 | 검증됨 — 10분 간격 적재 중. 24시간·7일 누적은 아직 확인 필요 |
| SSR 페이지·사이트맵·구조화 데이터 | 검증됨 — `node check.mjs --live` |
| CDN 캐시 적중 | 검증됨 — `X-Vercel-Cache: HIT` |
| **장시간 누적 동작** (롤업 겹치기, `prune` 의 실제 삭제) | **미검증** — 지울 만큼 쌓이지 않았다 |
| 급상승 쿼리의 실제 산출 | 검증됨 — 창을 좁혀(1h vs 4h) 돌리자 실제 순위가 나왔다 |
| **기본 창(24h vs 7일)의 산출** | **미검증** — 시간 롤업이 그만큼 쌓여야 한다 |
| 파이프라인 감시 (`watchdog`) | 검증됨 — 실제 DB 에서 스냅샷 지연을 잡아냈다 (2026-09-06) |
| 파생 페이지 6종 (리뷰 추이·월간·역대 최저가·장르 조합·발매 연도) | 로컬 DB 로 검증됨 — 200/404/301 |

멱등 키는 배포 검증 중에 실제로 확인됐다. 같은 `capturedAt` 으로 두 번 돌리자
두 번째 실행이 `snapshots: 0` 을 냈다 — `ON CONFLICT DO NOTHING` 이 의도대로 흡수한 것이다.
