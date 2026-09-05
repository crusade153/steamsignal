# 인수인계 — Steam Pulse

갱신 2026-09-05 · 기준 커밋 `main`

새 세션은 이 문서부터 읽으면 된다. 설계 근거와 읽기 쿼리는 [docs/DATA-PIPELINE.md](docs/DATA-PIPELINE.md) 에 있다.

---

## 0. 한 줄 요약

**P0 는 전부 닫혔다.** 파이프라인이 돌고, 페이지가 늘었고, 배포에서 검증했다.
남은 건 P1(수익화 실장)부터다. 다만 **애드센스 신청은 히스토리가 쌓인 뒤**여야 한다(§4).

라이브: https://steamsignal.vercel.app

---

## 1. 지금 돌고 있는 것

```
GitHub Actions (10분마다 curl 1회)
      │  Authorization: Bearer CRON_SECRET
      ▼
/api/cron ──► lib/collect.mjs ──► Steam 공개 API
                    │
                    ▼
              Neon Postgres (ap-southeast-1)
                    │
                    ▼
      사용자 요청 (읽기 전용, Steam 을 호출하지 않는다)
```

| 잡 | 주기 | 하는 일 |
| --- | --- | --- |
| `chart` + `details` | 10분 | TOP 100 순위·동접, 앱 20개의 가격·리뷰·메타데이터 |
| `rollup-hourly` | 매시 05분 | 최근 3시간 재집계 |
| `rollup-daily` + `prune` | 매일 03:20 KST | 최근 2일 재집계 + 보관정책 |

상세 수집은 라운드로빈이라 앱 100개를 한 바퀴 도는 데 약 50분 걸린다.

### 설정된 값 (2026-09-05 기준)

| 위치 | 키 |
| --- | --- |
| Vercel `steamsignal` | `DATABASE_URL`(pooler) · `CRON_SECRET` · `SITE_URL` |
| GitHub `crusade153/steamsignal` secrets | `CRON_SECRET` · `SITE_URL` |

`CRON_SECRET` 은 Vercel 과 GitHub 에 **같은 값**이어야 한다. 로컬에는 저장돼 있지 않으니
바꿔야 하면 새로 만들어 양쪽에 다시 넣는다(`openssl rand -hex 32`).

---

## 2. 페이지 지도

| 경로 | 렌더링 | 내용 |
| --- | --- | --- |
| `/` | 클라이언트 | TOP 100. `/api/games` 한 번으로 평가·가격까지 받는다 |
| `/game/<appid>-<slug>` | SSR | 동접 차트, 역대 최고 동접, 가격·역대 최저가, 리뷰 추이, 같은 장르 추천 |
| `/rising` | SSR | 두 시간대 평균 동접 비교. Steam 이 안 주는 우리 콘텐츠 |
| `/deals` | SSR | 긍정률 75%↑ 할인 + 역대 최저가 판정 |
| `/charts/weekly` | SSR | 7일 평균 동접 순위 |
| `/genre`, `/genre/<장르>` | SSR | 장르 허브 |
| `/sitemap.xml`, `/robots.txt` | SSR / 정적 | 색인 |

라우트는 [lib/routes.mjs](lib/routes.mjs) 한곳에 있고, `vercel.json` 의 rewrites 를 거기서 만든다.
`npm run build` 가 둘의 일치를 검사한다 — **어긋나면 로컬은 되는데 배포에서만 404 가 난다.**

---

## 3. 검증된 것 / 아직 아닌 것

| 대상 | 상태 |
| --- | --- |
| 스키마·함수 실제 실행 | 검증됨 (2026-09-05) |
| 종단 수집 (Steam → Neon) | 검증됨 — 잡 5종 전부 성공 |
| `/api/cron` 배포 동작 | **검증됨** — 인증 401/200 양쪽, 잡 실행까지 확인 |
| GitHub Actions 스케줄러 | **검증됨** — workflow_dispatch 로 종단 성공 (11초) |
| SSR 페이지·사이트맵·구조화 데이터 | **검증됨** — `node check.mjs --live` 가 배포를 직접 확인 |
| CDN 캐시 | **검증됨** — `X-Vercel-Cache: HIT`. DB 는 페이지당 10분에 한 번만 읽힌다 |
| 단위 테스트 | 32개 통과 (`npm test`) |
| **장시간 누적 동작** | **미검증** — 롤업 겹치기와 `prune` 의 실제 삭제는 데이터가 더 쌓여야 확인된다 |
| **급상승 순위의 실제 산출** | **미검증** — 시간 롤업이 최소 몇 시간은 쌓여야 첫 순위가 나온다 |

### 하루 뒤에 꼭 볼 것

```sql
-- 1. 스케줄러가 계속 돌고 있나
SELECT job, status, processed, failed, started_at, error
  FROM collector_runs ORDER BY started_at DESC LIMIT 20;

-- 2. 롤업이 실제로 쌓이나 (여기가 비어 있으면 /rising 과 /charts/weekly 가 빈 페이지다)
SELECT COUNT(*), MIN(bucket), MAX(bucket) FROM player_hourly;
SELECT COUNT(*), MIN(day), MAX(day) FROM player_daily;

-- 3. 원시 스냅샷이 7일 뒤 실제로 지워지나 (prune 검증)
SELECT COUNT(*), MIN(captured_at) FROM player_snapshots;
```

그리고 브라우저로 https://steamsignal.vercel.app/rising 을 열어 순위가 나오는지 본다.
안 나오면 §5-2 의 창 좁히기 로직을 보면 된다.

---

## 4. 다음 할 일

### P1 — 수익화 실장

- [ ] 개인정보처리방침 · 이용약관 · `ads.txt` · 문의 페이지 (애드센스 심사 필수)
- [ ] GA4 또는 Plausible
- [ ] 광고 슬롯 — **`min-height` 를 미리 예약해 CLS 방어.** 위치는 목록 20개마다 in-feed 1개 +
      게임 상세 상하단. 지금 CLS 는 좋은데 광고를 그냥 넣으면 무너진다
- [ ] 어필리에이트 검토 (Humble/Fanatical 등이 애드센스보다 RPM 이 높은 경우가 많다)
- [ ] Google Search Console 에 `https://steamsignal.vercel.app/sitemap.xml` 제출
      — 사이트맵은 이미 나오고 있지만 아무도 제출하지 않았다

> **애드센스는 히스토리가 쌓인 뒤에 신청한다.** 지금 게임 페이지의 차트는 표본이 몇 시간뿐이라
> "데이터가 쌓이는 중"이 많이 보인다. 최소 1~2주는 돌린 뒤가 승산이 높다.

### P2 — 재방문

- [ ] 가격 하락 알림 / 위시리스트 (계정 필요) → 이메일 리스트는 광고보다 가치 있는 자산
- [ ] 주간 리포트 뉴스레터

### P3 — 운영

- [ ] 레이트리밋, Sentry, 스테이징, DB 백업
- [ ] `ci.yml` 의 Node 24 와 로컬 22.18.0 을 맞추기

### 별도 — TypeScript 전환

SSR 은 Next.js 없이 바닐라 함수로 넣었다(2026-09-05 결정). 지금 구조에서 TS 로 가려면
`tsconfig.json` 에 `allowJs` + `checkJs` + `strict` 를 켜고 `scripts/build.mjs` 에 `tsc --noEmit` 을
추가하면 된다. 배포 방식은 바뀌지 않는다.

---

## 5. 설계에서 기억할 것

새 세션이 맥락 없이 고치다 깨뜨리기 쉬운 지점들이다.

### 5-1. 수집 (기존)

1. **시계열 3단 계층은 선택이 아니다.** 원시를 그냥 쌓으면 100개 × 144회/일 × 365일 =
   526만 행 ≈ 580MB 로 Neon 무료 0.5GB 를 1년 안에 넘긴다. 원시(7일) → 시간(90일) → 일(영구) +
   `prune_timeseries()` 로 1년 뒤에도 70MB 안쪽이다. **보관정책 함수를 지우지 말 것.**

2. **멱등성 키는 Steam 의 `last_update` 다.** `player_snapshots.captured_at` 에 우리 시계(`NOW()`)를
   넣으면 크론이 밀리거나 두 번 돌 때 중복 행이 생긴다. 절대 바꾸지 말 것.
   (실제로 확인됐다 — 배포 검증 때 같은 `capturedAt` 으로 두 번 돌자 `snapshots: 0` 이 나왔다.)

3. **상세 수집 커서는 성공·실패 모두 전진시킨다.** 실패 시 `details_fetched_at` 을 안 밀면
   죽은 앱이 큐 맨 앞에서 영원히 재시도되어 파이프라인이 멈춘다.

4. **결측을 0 으로 만들지 않는다.** 리뷰 0건이면 `positive_ratio` 는 `NULL` 이지 0 이 아니다.
   `has_detail` / `has_reviews` 표식은 한쪽만 실패했을 때 멀쩡한 값을 `NULL` 로 덮지 않기 위한 것이다.

5. **`apps.header_image` 는 차트가 덮어쓰지 않는다.** 차트가 주는 건 231x87 캡슐이고
   상세 수집이 받는 건 460x215 헤더다. `COALESCE(apps.header_image, EXCLUDED.header_image)` 순서를
   뒤집으면 10분마다 좋은 이미지가 작은 캡슐로 되돌아간다 — OG 이미지와 상세 히어로가 그걸 쓴다.

### 5-2. 읽기 (신규)

6. **라우트 정의는 [lib/routes.mjs](lib/routes.mjs) 한곳이다.** `vercel.json` 의 rewrites 를
   거기서 만들고 빌드가 대조한다. 손으로 `vercel.json` 을 고치면 빌드가 막는다.

7. **DATE 컬럼은 SQL 에서 `TO_CHAR` 로 문자열로 꺼낸다.** 드라이버가 DATE 를 로컬 자정 `Date` 로
   돌려주기 때문에 화면에서 `toISOString()` 을 한 번만 잘못 쓰면 하루가 밀린다.
   `formatDay()` 도 문자열만 다룬다. 이 두 규칙이 시간대 버그를 구조적으로 막는다.

8. **급상승은 창을 좁혀 가며 계산하고, 실제로 쓴 창을 화면에 적는다.**
   적재 초기에는 8일치가 없다. "24시간 대비"라고 써 놓고 3시간을 비교하면 거짓말이 된다.
   `RISING_WINDOWS` 순서대로 시도해 결과가 5개 이상 나오는 창에서 멈춘다.

9. **게임 상세는 정규 슬러그로 301 한다.** `decodeParam` 이 슬러그를 한 번 더 디코딩하는 이유는
   경로 세그먼트의 퍼센트 디코딩 시점이 로컬 서버와 Vercel 에서 다르기 때문이다.
   이게 없으면 한글 슬러그가 자기 자신으로 무한 리다이렉트할 수 있다.

10. **차트 SVG 안에 글자를 넣지 않는다.** 선을 가로로 늘려 채우려면
    `preserveAspectRatio="none"` 이 필요한데 그 배율이 글자에도 걸린다. 축 라벨은 HTML 로 뺐다.

11. **캐시 헤더는 응답에서 확인할 수 없다.** Vercel 이 `s-maxage` 와 `stale-while-revalidate` 를
    클라이언트 응답에서 지우고 CDN 에서만 쓴다. 적중 여부는 `X-Vercel-Cache` 로 본다.

---

## 6. 비용 — 왜 지금 구조여야 하나

| 항목 | 현재 | 한도 |
| --- | --- | --- |
| GitHub Actions | 하루 169회 × 1분 = 월 ~5,070분 | **공개 저장소라 무료** |
| Vercel Function Invocations | 수집 ~5,100/월 + 사용자 요청(CDN 뒤) | 1,000,000/월 |
| Vercel Fluid Active CPU | 대부분 네트워크 대기 — **첫 주 실측 필요** | 4시간/월 |
| Neon 스토리지 | 3단 롤업 + prune 으로 1년 뒤 70MB 안쪽 | 0.5GB |

**저장소를 비공개로 돌리면 Actions 가 유료가 된다**(월 ~3,000분 초과 청구).
그때는 Vercel Pro 의 크론이나 외부 크론(cron-job.org, Upstash QStash)으로 옮겨야 한다.
Pro 로 올릴 때의 `vercel.json` crons 블록은 [docs/DATA-PIPELINE.md §5](docs/DATA-PIPELINE.md) 에 있다.

SSR 페이지는 CDN 에 5~10분 캐시된다. 트래픽이 100배가 돼도 DB 읽기는 거의 늘지 않는다.

---

## 7. 명령어 모음

```bash
npm ci                                             # 의존성
npm test                                           # 단위 32개
npm run build                                      # 문법 검사 + rewrites 일치 검사
npm run test:e2e                                   # e2e (DB 불필요, 픽스처)
TEST_URL=https://steamsignal.vercel.app node check.mjs --live   # 배포 직접 검증

node --env-file=.env scripts/collect.mjs chart details
node --env-file=.env scripts/collect.mjs rollup-hourly rollup-daily prune

gh workflow run collect.yml -R crusade153/steamsignal -f jobs=chart,details   # 수동 트리거
npx vercel --prod --yes                            # 배포
```

> **`.env` 는 사람이 직접 만들어야 한다.** 에이전트 도구로 만든 `.env` / `.env.local` 이 자동 삭제된 적이 있다
> (자격증명 파일 보호 장치로 보인다). 양식은 [.env.example](.env.example).
