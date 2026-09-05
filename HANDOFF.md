# 인수인계 — Steam Pulse 데이터 파이프라인

작성 2026-09-05 · 기준 커밋 `main`

새 세션은 이 문서부터 읽으면 된다. 설계 근거와 읽기 쿼리는 [docs/DATA-PIPELINE.md](docs/DATA-PIPELINE.md) 에 있다.

---

## 0. 한 줄 요약

취미 수준 MVP 를 광고 수익이 나는 사이트로 만들려면 **URL 개수와 자체 시계열**이 필요하다.
그 토대인 DB 스키마와 크론 수집기를 만들어 `main` 에 올렸다. **아직 DB 는 만들지 않았다.**

---

## 1. 왜 이걸 먼저 했나

광고 수익 = 페이지뷰 × RPM 인데, 기존 사이트는 구조적으로 페이지뷰가 나올 수 없었다.

| 기존 문제 | 파이프라인이 푸는 방식 |
| --- | --- |
| 인메모리 캐시가 서버리스 인스턴스마다 따로라 트래픽이 늘면 Steam 을 N배로 호출 | 크론만 Steam 을 호출, 사용자 요청은 DB 만 읽음 |
| 스토어 HTML 스크래핑이 상시 경로에 있음 | 스크래핑은 10분에 1회, 실패해도 DB 값으로 서비스 유지 |
| 과거 데이터가 없어 추세·급상승·역대 최저가 불가 | 동접/가격/리뷰를 시계열로 적재 |
| URL 이 1개뿐이라 검색 유입 ≈ 0 | 앱 마스터가 TOP 100 에 갇히지 않음 → 게임별 페이지 재료 확보 |

---

## 2. 완료된 것

- [x] `db/schema.sql` — 테이블 8개 + 인덱스
- [x] `db/functions.sql` — 롤업 2종, 보관정책 2종
- [x] `lib/db.mjs` — Neon 클라이언트, 실행 로그 래퍼
- [x] `lib/collect.mjs` — 수집 잡 5종 (`chart` `details` `rollup-hourly` `rollup-daily` `prune`)
- [x] `api/cron.js` — 크론 엔드포인트 (시크릿 인증, 미설정 시 401)
- [x] `scripts/collect.mjs` — CLI
- [x] `.github/workflows/collect.yml` — 스케줄러
- [x] `tests/collect.test.mjs` — 신규 테스트 5개
- [x] `docs/DATA-PIPELINE.md` — 설계 근거 + 읽기 쿼리 모음
- [x] `npm run build` 통과, `npm test` **13개 전부 통과**

### 작업 중 고친 실제 버그

`parseReleaseDate` 가 `Date.parse` 결과에 `toISOString()` 을 쓰고 있었다.
발매일은 '시각'이 아니라 '달력 날짜'라 로컬 자정이 UTC 로 밀리면서 **하루가 어긋났다**
(`Aug 21, 2012` → `2012-08-20`). 시간대 4곳(UTC/KST/뉴욕/오클랜드)에서 동일 결과가 나오도록 고치고 테스트로 고정했다.

### 기존 파일 변경

- `lib/steam.mjs` — `appDetailsUrl` / `appReviewsUrl` 추출 (지역·언어 파라미터가 API 서버와 수집기에서 어긋나면 통화가 달라지므로 한곳에서만 생성). 동작 변경 없음, 기존 테스트 8개 그대로 통과
- `package.json` — `@neondatabase/serverless` 의존성, `collect` / `db:migrate` 스크립트
- `scripts/build.mjs` — 신규 파일 문법 검사 대상 추가
- `vercel.json` — `api/*.js` 함수 설정

---

## 3. 지금 당장 해야 할 것 — DB 생성과 첫 적재

**이게 다음 세션의 첫 번째 관문이다.** SQL 은 검토만 했고 실행해본 적이 없다.

### 3-1. Neon 프로젝트 생성

[neon.tech](https://neon.tech) 에서 프로젝트를 만든다. 리전은 `ap-southeast-1` (싱가포르) 이 한국에서 가장 가깝다.

### 3-2. SQL 실행 — 순서가 중요하다

이 PC 에 `psql` 이 없다(Git Bash·Windows PATH 양쪽 확인). 그래서 `npm run db:migrate` 는 지금 실패한다.
**Neon 웹 콘솔의 SQL Editor** 에 붙여넣는 게 가장 빠르다. 설치할 게 없다.

1. `db/schema.sql` 전체를 붙여넣고 실행
2. 이어서 `db/functions.sql` 전체를 붙여넣고 실행 (테이블이 먼저 있어야 한다)

두 파일 모두 `CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE FUNCTION` 이라 **여러 번 실행해도 안전하다.**

### 3-3. 환경변수

프로젝트 루트에 `.env` 를 만든다. `.gitignore` 에 이미 들어 있다. 양식은 `.env.example` 참고.

```
DATABASE_URL=postgresql://...@ep-xxx-pooler.<region>.aws.neon.tech/neondb?sslmode=require
```

**반드시 `-pooler` 가 붙은 엔드포인트를 쓴다.** 서버리스는 스케일아웃할 때마다 커넥션을 새로 열어서
직접 연결은 금방 고갈된다.

### 3-4. 첫 수집 확인

```bash
node --env-file=.env scripts/collect.mjs chart
```

기대 출력:

```json
{"job":"chart","status":"ok","processed":100,"snapshots":100,"capturedAt":"...","stale":false,"ms":...}
```

이어서 상세까지:

```bash
node --env-file=.env scripts/collect.mjs details
```

확인 쿼리:

```sql
SELECT COUNT(*) FROM player_snapshots;      -- 100 근처
SELECT COUNT(*) FROM apps;                  -- 100 근처
SELECT job, status, processed, failed, error FROM collector_runs ORDER BY started_at DESC LIMIT 5;
```

> **여기서 SQL 오타가 드러난다.** 에러가 나면 메시지를 그대로 들고 오면 된다.

---

## 4. 그다음 할 일 (우선순위 순)

### P0 — 수익의 전제조건

- [ ] **DB 생성 + 첫 적재 검증** (§3)
- [ ] **스케줄러 연결** — §6 의 비용 함정을 먼저 읽을 것
- [ ] **게임별 SSR 페이지** `/game/[appid]-[slug]` — 동접 추이 차트, 가격 이력, 리뷰 추이.
      읽기 쿼리는 [docs/DATA-PIPELINE.md §6](docs/DATA-PIPELINE.md) 에 이미 작성돼 있다
- [ ] **sitemap.xml + JSON-LD**(`VideoGame` 스키마) + OG 이미지
- [ ] **파생 페이지로 URL 확장** — `/rising`(급상승), `/deals`(고평가 할인), `/charts/weekly`, `/genre/[장르]`.
      급상승은 Steam 이 제공하지 않는 우리만의 콘텐츠라 SEO 가치가 가장 높다

### P1 — 수익화 실장

- [ ] 개인정보처리방침 · 이용약관 · `ads.txt` · 문의 페이지 (애드센스 심사 필수)
- [ ] GA4 또는 Plausible
- [ ] 광고 슬롯 — **`min-height` 를 미리 예약해 CLS 방어**. 현재 CLS 는 좋은데 광고 넣으면 무너진다.
      위치: 목록 20개마다 in-feed 1개 + 게임 상세 상하단
- [ ] 어필리에이트 검토 (Humble/Fanatical 등이 애드센스보다 RPM 이 높은 경우가 많다)

> 애드센스는 페이지 1개짜리 데이터 미러를 "가치가 낮은 콘텐츠"로 반려할 가능성이 높다.
> **P0 의 게임별 페이지와 히스토리가 쌓이기 전에는 신청하지 말 것.**

### P2 — 재방문

- [ ] 가격 하락 알림 / 위시리스트 (계정 필요) → 이메일 리스트는 광고보다 가치 있는 자산
- [ ] 주간 리포트 뉴스레터

### P3 — 운영

- [ ] 레이트리밋, Sentry, 스테이징, DB 백업

### 별도 — TypeScript 전환

전환은 해야 하지만 **지금 제자리에서 하지 말 것.** P0 의 SSR 이 들어오면 Next.js 로 가게 되는데,
바닐라 JS → 바닐라 TS → Next.js TS 로 두 번 옮기게 된다.

- 지금 당장 (1시간): `tsconfig.json` 에 `allowJs` + `checkJs` + `strict` 만 켜고
  `scripts/build.mjs` 에 `tsc --noEmit` 추가. 배포 방식은 안 바뀐다
- P0 착수 시 (1~2일): Next.js App Router + TS 로 이관.
  `normalizeRanks` / `normalizeDetails` / `parseIds` 는 순수 함수라 거의 1:1 로 옮겨진다

---

## 5. 설계에서 기억할 4가지

새 세션이 맥락 없이 코드를 고치다 깨뜨리기 쉬운 지점들이다.

1. **시계열 3단 계층은 선택이 아니다.** 원시를 그냥 쌓으면 100개 × 144회/일 × 365일 =
   526만 행 ≈ 580MB 로 Neon 무료 0.5GB 를 1년 안에 넘긴다. 원시(7일) → 시간(90일) → 일(영구) +
   `prune_timeseries()` 로 1년 뒤에도 70MB 안쪽이다. **보관정책 함수를 지우지 말 것.**

2. **멱등성 키는 Steam 의 `last_update` 다.** `player_snapshots.captured_at` 에 우리 시계(`NOW()`)를
   넣으면 크론이 밀리거나 두 번 돌 때 중복 행이 생긴다. 절대 바꾸지 말 것.

3. **상세 수집 커서는 성공·실패 모두 전진시킨다.** 실패 시 `details_fetched_at` 을 안 밀면
   죽은 앱이 큐 맨 앞에서 영원히 재시도되어 파이프라인이 멈춘다.

4. **결측을 0 으로 만들지 않는다.** 리뷰 0건이면 `positive_ratio` 는 `NULL` 이지 0 이 아니다.
   `has_detail` / `has_reviews` 표식은 한쪽만 실패했을 때 멀쩡한 값을 `NULL` 로 덮지 않기 위한 것이다.

---

## 6. 스케줄러 — 비용 함정

Vercel **Hobby 내장 크론은 하루 1회만** 돈다. 10분 주기가 필요해 GitHub Actions 로 뺐다.

그런데 **Actions 는 잡 하나를 1분 단위로 올림 과금한다.** 5초짜리 curl 도 1분이다.
하루 169회 = 월 5,070분이라 **비공개 저장소의 무료 2,000분을 넘긴다.**

| 방식 | 비용 | 판단 |
| --- | --- | --- |
| GitHub Actions + **공개 저장소** | 무료 | 현재 워크플로가 이 방식 |
| GitHub Actions + 비공개 저장소 | 월 ~3,000분 초과 청구 | 권장하지 않음 |
| Vercel Cron (Pro $20/월) | 플랜 포함, 1분 주기 | 트래픽이 붙으면 이쪽 |
| cron-job.org / Upstash QStash | 무료 티어 | 외부 의존 추가 |

**확인 결과 `crusade153/steamsignal` 은 공개 저장소다 → Actions 는 무료이고 이 결정은 끝났다.**
현재 워크플로를 그대로 켜면 된다. 나중에 저장소를 비공개로 돌린다면 그때 Vercel Pro 나 외부 크론으로 옮겨야 한다.

워크플로에 필요한 secrets: `SITE_URL`, `CRON_SECRET`.
Vercel 환경변수: `DATABASE_URL`(pooler), `CRON_SECRET`.
`CRON_SECRET` 은 `openssl rand -hex 32` 로 만든다. 없거나 틀리면 `/api/cron` 은 401 을 낸다.

---

## 7. 미검증 항목 — 정직하게

| 대상 | 상태 |
| --- | --- |
| `lib/collect.mjs` 적재 로직 (페이로드 모양, 커서 전진, 덮어쓰기 방지, 멱등 키) | 검증됨 — `tests/collect.test.mjs` |
| `parseReleaseDate` / `slugify` | 검증됨 — 시간대 4곳 확인 |
| 기존 API·UI 회귀 | 검증됨 — `npm test` 13개, `npm run build` |
| **`db/schema.sql`, `db/functions.sql` 실제 실행** | **미검증** — 개발 환경에 Postgres·Docker 없음 |
| **실제 Steam 응답에 대한 종단 수집** | **미검증** — §3-4 가 첫 확인 |
| **`api/cron.js` 배포 환경 동작** | **미검증** — Vercel 배포 후 확인 필요 |

---

## 8. 명령어 모음

```bash
npm install                                        # 의존성 (워크트리마다 별도)
npm test                                           # 13개
npm run build                                      # 정적 자산 + 문법 검사
node --env-file=.env scripts/collect.mjs chart     # 차트 수집
node --env-file=.env scripts/collect.mjs details   # 상세 수집
node --env-file=.env scripts/collect.mjs rollup-hourly rollup-daily prune
```

운영 상태는 이 쿼리 하나로 본다.

```sql
SELECT job, status, processed, failed, started_at, finished_at, error
  FROM collector_runs ORDER BY started_at DESC LIMIT 20;
```

경보를 걸 조건은 [docs/DATA-PIPELINE.md §7](docs/DATA-PIPELINE.md) 참고.
