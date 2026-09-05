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
| 아직 안 넣은 것 (넣으면 바로 켜짐) | `ADSENSE_PUBLISHER_ID` · `ADSENSE_SLOT_DETAIL` · `CONTACT_EMAIL` |
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
| `/watchlist` | SSR 껍데기 + JS | 담아 둔 게임의 현재가·평가. localStorage 에만 저장, noindex, `no-store` |
| `/privacy`, `/terms`, `/contact` | SSR | 애드센스 심사에 필요한 고정 문서 |
| `/ads.txt` | SSR | `ADSENSE_PUBLISHER_ID` 가 있을 때만 200, 없으면 404 |
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
| 고정 문서 · 위시리스트 왕복 | 검증됨 — e2e 가 담기→목록→빼기까지 확인 |
| `DATABASE_URL` 없이도 뜨는 페이지 | 검증됨 — 방침·약관·문의·위시리스트 200 |
| 단위 테스트 | 42개 통과 (`npm test`) |
| **광고 실제 게재** | **미검증** — 애드센스 승인 전이라 슬롯이 렌더링되지 않는다 |
| **장시간 누적 동작** | **미검증** — 롤업 겹치기와 `prune` 의 실제 삭제는 데이터가 더 쌓여야 확인된다 |
| 급상승 쿼리의 실제 산출 | 검증됨 — 창을 좁혀(1h vs 4h) 돌리자 실제 순위가 나왔다 (War Thunder +8.4% 등) |
| **`/rising` 의 기본 창(24h vs 7일)** | **미검증** — 시간 롤업이 그만큼 쌓여야 첫 순위가 뜬다. 그전까지는 창을 좁혀 표기한다 |

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

- [x] ~~개인정보처리방침 · 이용약관 · 문의 페이지~~ — `/privacy` `/terms` `/contact`
- [x] ~~`ads.txt`~~ — `ADSENSE_PUBLISHER_ID` 가 있을 때만 200 을 낸다(없으면 404)
- [x] ~~분석~~ — Vercel Web Analytics. 쿠키를 쓰지 않아 동의 배너가 필요 없다
- [x] ~~광고 슬롯 CLS 방어~~ — `adSlot()` 이 `min-height` 를 예약한다. 게임 상세 하단에 배치

**사람이 해야 할 것 (내가 대신 못 하는 것):**

- [ ] **Vercel 대시보드에서 Web Analytics 켜기** — 스크립트는 이미 나가지만 대시보드에서
      켜야 집계가 시작된다 (Hobby 무료)
- [ ] **Google Search Console 에 `https://steamsignal.vercel.app/sitemap.xml` 제출**
      — 사이트맵은 나오고 있지만 아무도 제출하지 않았다. 색인의 출발점이다
- [ ] **`CONTACT_EMAIL` 정하기** — 지금 문의 페이지는 GitHub 이슈만 안내한다.
      애드센스 심사는 보통 이메일 연락 수단을 기대하므로, 신청 전에 넣는 편이 안전하다.
      개인 메일을 공개하기 싫으면 별칭 주소를 쓰면 된다
- [ ] **애드센스 신청 → 승인되면 `ADSENSE_PUBLISHER_ID` + `ADSENSE_SLOT_DETAIL` 등록**
      두 값이 들어오는 순간 광고 스크립트·슬롯·`/ads.txt` 가 한꺼번에 살아난다. 코드 변경 없음
- [ ] 어필리에이트 검토 (Humble/Fanatical 등이 애드센스보다 RPM 이 높은 경우가 많다)

> **애드센스는 히스토리가 쌓인 뒤에 신청한다.** 지금 게임 페이지의 차트는 표본이 몇 시간뿐이라
> "데이터가 쌓이는 중"이 많이 보인다. 최소 1~2주는 돌린 뒤가 승산이 높다.

### P2 — 재방문

- [x] ~~위시리스트~~ — `/watchlist`. 계정 없이 localStorage 에만 저장한다.
      개인정보를 하나도 수집하지 않으면서 "담아 둔 게임이 지금 얼마인가"에 답한다
- [ ] 가격 하락 알림 (이메일) → 발송 서비스 키(Resend 등)가 필요하다.
      위시리스트가 이미 있으므로 남은 건 구독 테이블 + 하락 감지 크론 + 발송이다
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

### 5-3. 수익화 · 위시리스트

12. **DB 를 읽지 않는 페이지가 DB 때문에 죽지 않게 한다.** 라우터는 `lazySql()` 을 넘긴다.
    `getSql()` 을 미리 부르면 `DATABASE_URL` 이 없을 때 방침·약관·문의·위시리스트까지 503 이 된다.

13. **`/watchlist` 는 `Cache-Control: no-store` 다.** 내용은 브라우저에만 있지만 껍데기라도
    CDN 이 캐시하면 안 된다 — 그리고 `noindex` 다. 사람마다 다른 화면은 색인 대상이 아니다.

14. **담김 여부를 서버가 렌더링하지 않는다.** 그 정보는 브라우저에만 있고, 서버가 그렸다면
    CDN 이 남의 상태를 다른 사람에게 보여 준다. 버튼은 항상 '담기'로 나가고 JS 가 칠한다.

15. **`ads.txt` 는 게시자 ID 가 없으면 404 여야 한다.** 내용이 틀린 `ads.txt` 는 없는 것보다
    나쁘다 — 크롤러가 이 파일을 권위 있는 목록으로 읽어 정상 광고 요청까지 거부한다.

16. **광고 슬롯은 `min-height` 를 먼저 잡는다.** 광고가 늦게 로드되며 아래를 밀어내면
    CLS 가 무너지고, 사용자가 누르려던 링크가 손가락 아래에서 어긋난다.

17. **분석 스크립트는 배포 환경에서만 나간다.** `/_vercel/insights/script.js` 는 Vercel 이
    배포 시에만 주입하는 경로라, 로컬에서 켜면 404 HTML 을 스크립트로 읽으려다 콘솔 오류만 남는다.

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
