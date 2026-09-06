# 인수인계 — Steam Pulse

갱신 2026-09-06 (3차) · 기준 커밋 `main`

새 세션은 이 문서부터 읽으면 된다. 설계 근거와 읽기 쿼리는 [docs/DATA-PIPELINE.md](docs/DATA-PIPELINE.md) 에 있다.

---

## 0. 한 줄 요약

**P0 는 전부 닫혔다.** 파이프라인이 돌고, 페이지가 늘었고, 배포에서 검증했다.
남은 건 P1(수익화 실장)부터다. 다만 **애드센스 신청은 히스토리가 쌓인 뒤**여야 한다(§4).

**2026-09-06 2차 작업** — 운영자가 정한 방향(PC·모바일 동등, 재방문, 커버리지 200)을 실장했다.
[TODO.md §9](TODO.md) 의 Phase 1~6 이 닫혔고, 요약은 이렇다.

| 한 것 | 결과 |
| --- | --- |
| 모바일 내비 회귀 수정 + 표→카드 전환 | 390/768/1440 세 폭 e2e 통과. 현재 첫 화면 게임 4 / 5 / 6개 |
| 순위 변동(▲▼NEW) · 위시리스트 Δ | 목록과 위시리스트가 '어제와 무엇이 달라졌나'에 답한다 |
| 목록 스파크라인 · 홈 '오늘의 변화' · `/status` | 판단까지의 클릭이 1 → 0 |
| 커버리지 **118 → 200개** | 차트 밖 게임의 동접을 직접 기록. 사이트맵 160 → 259 URL |
| 로딩 스켈레톤 · 빈 상태 · CSS 미니파이 해제 | 새 페이지당 CSS 추가를 5줄 이하로 유지할 수 있게 됨 |
| **계정(가입·관리)** | **자율이다** — 로그인을 요구하는 화면은 하나도 없다(PRODUCT.md §8) |
| 스파크라인 의미 교정 | 원시 동접의 공통 일중 곡선을 버리고 **추적군 비중 변화 → 전일 동시간 대비**로 전환. 모든 행은 같은 ±50% 축 |
| 할인 종료일 | 할인 중인 앱의 Steam 한국시간 상점 페이지를 확인해 `/deals`·역대 최저가·게임 상세에 한국 날짜와 남은 일수를 표시 |

**2026-09-06 3차 작업.** 운영자는 장기적으로 Xbox·PS5·Nintendo Switch 2를 별도 카테고리로
확장하되, Steam 같은 공개 동접 API가 있다고 가정하지 않기로 했다. 공통 게임 ID를 먼저 만들고
Twitch·Wikimedia 같은 합법적 공개 데이터로 `플레이·시청·검색 관심`을 분리해 결합한다.
기획은 [PRODUCT.md §9](docs/PRODUCT.md), 할 일은 [TODO.md Phase 7](TODO.md)에 있다.

**DB 는 테이블 14개 · 함수 6개가 됐다.** 계정 관련 3개 테이블과 `prune_sessions()` 를
추가 적용했다(§3-2 의 대조 숫자도 함께 갱신했다).

라이브: https://steamsignal.vercel.app

---

## 1. 지금 돌고 있는 것

```
cron-job.org (주 스케줄러) + GitHub Actions (예비 트리거)
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
| `chart` + `details` | 10분 (매시 3·13·23·33·43·53분) | TOP 100 순위·동접, 앱 40개의 가격·리뷰·메타데이터. 할인 중인 앱만 종료일 페이지 추가 확인 |
| `rollup-hourly` | 매시 37분 | 최근 3시간 재집계 |
| `rollup-daily` + `prune` | 매일 03:41 KST | 최근 2일 재집계 + 보관정책 |

시각이 어중간한 건 의도다. GitHub 스케줄은 전 세계가 공유하는 큐라 `*/10` 처럼 딱 떨어지는
시각에 몰리고, 혼잡하면 밀리거나 건너뛴다 — 실제로 `*/10` 으로는 자동 발화가 한 번도 안 떴다.

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
| `/game/<appid>-<slug>` | SSR | 동접 차트, 역대 최고 동접, 가격·할인 종료일·역대 최저가, 리뷰 추이, 같은 장르 추천 |
| `/rising` | SSR | 두 시간대 평균 동접 비교. Steam 이 안 주는 우리 콘텐츠 |
| `/deals` | SSR | 긍정률 75%↑ 할인 + 역대 최저가 판정 + 한국시간 할인 종료일 |
| `/charts/weekly`, `/charts/monthly` | SSR | 7일·30일 평균 동접 순위 |
| `/genre`, `/genre/<장르>` | SSR | 장르 허브 |
| `/watchlist` | SSR 껍데기 + JS | 담아 둔 게임의 현재가·평가. localStorage 에만 저장, noindex, `no-store` |
| `/alerts`, `/alerts/confirm`, `/alerts/unsubscribe` | SSR | 이메일 알림 안내·확인·해지. **메일 설정이 없으면 셋 다 404.** noindex, `no-store` |
| `/status` | SSR | **수집 상태 공개** — 마지막 수집, 24시간 기록 횟수, 잡별 성패, 결손 구간 |
| `/account`, `/account/login`, `/account/signup` | SSR | 계정. **자율이다** — 로그인을 요구하는 화면은 없다. noindex, `no-store` |
| `/privacy`, `/terms`, `/contact` | SSR | 애드센스 심사에 필요한 고정 문서 |
| `/ads.txt` | SSR | `ADSENSE_PUBLISHER_ID` 가 있을 때만 200, 없으면 404 |
| `/sitemap.xml`, `/robots.txt` | SSR / 정적 | 색인 |

라우트는 [lib/routes.mjs](lib/routes.mjs) 한곳에 있고, `vercel.json` 의 rewrites 를 거기서 만든다.
`npm run build` 가 둘의 일치를 검사한다 — **어긋나면 로컬은 되는데 배포에서만 404 가 난다.**

---

## 3. 검증된 것 / 아직 아닌 것

| 대상 | 상태 |
| --- | --- |
| 스키마·함수 실제 실행 | 검증됨 (2026-09-06 2차) — **테이블 14개, 함수 6개**. §3-2 를 반드시 읽을 것 |
| 종단 수집 (Steam → Neon) | 검증됨 — 잡 5종 전부 성공 |
| `/api/cron` 배포 동작 | **검증됨** — 인증 401/200 양쪽, 잡 실행까지 확인 |
| GitHub Actions 스케줄러 (수동 실행) | **검증됨** — workflow_dispatch 로 종단 성공 (11초) |
| 스케줄 자동 발화 | **해결됨 (2026-09-06)** — GitHub 스케줄을 버리고 cron-job.org 로 옮겼다. §3-1 참고 |
| SSR 페이지·사이트맵·구조화 데이터 | **검증됨** — `node check.mjs --live` 가 배포를 직접 확인 |
| CDN 캐시 | **검증됨** — `X-Vercel-Cache: HIT`. DB 는 페이지당 10분에 한 번만 읽힌다 |
| 고정 문서 · 위시리스트 왕복 | 검증됨 — e2e 가 담기→목록→빼기까지 확인 |
| `DATABASE_URL` 없이도 뜨는 페이지 | 검증됨 — 방침·약관·문의·위시리스트 200 |
| 단위 테스트 | 87개 통과 (`npm test`) |
| 파이프라인 감시 (`watchdog`) | 검증됨 — 실제 DB 에서 스냅샷 지연 2건을 잡아냈다 (2026-09-06) |
| 새 SSR 페이지 6종 | 로컬 DB 로 200/404/301 확인. 라이브 확인은 배포 뒤 `check.mjs --live` |
| **광고 실제 게재** | **미검증** — 애드센스 승인 전이라 슬롯이 렌더링되지 않는다 |
| **장시간 누적 동작** | **미검증** — 롤업 겹치기와 `prune` 의 실제 삭제는 데이터가 더 쌓여야 확인된다 |
| 급상승 쿼리의 실제 산출 | 검증됨 — 창을 좁혀(1h vs 4h) 돌리자 실제 순위가 나왔다 (War Thunder +8.4% 등) |
| **`/rising` 의 기본 창(24h vs 7일)** | **미검증** — 시간 롤업이 그만큼 쌓여야 첫 순위가 뜬다. 그전까지는 창을 좁혀 표기한다 |

### 3-1. 스케줄러를 cron-job.org 로 옮긴 기록 (2026-09-06 해결)

**증상.** 워크플로는 `active` 이고 수동 실행은 늘 성공하는데, `schedule` 이벤트가 거의 안 떴다.
시간당 9번(10분×6 + 1시간×1 + 30분×2)이 떠야 하는데 **5시간에 2번**만 떴다 — 약 4%.
DB 로 보면 더 분명했다. 서로 다른 `captured_at` 이 하루 종일 **5개**뿐이었고(10분 간격이면 144개)
그마저 대부분 수동 실행분이었다.

**시도한 것과 결과.**

1. ~~GitHub 스케줄 지연을 기다린다~~ — 며칠 기다려도 그대로였다.
2. ~~cron 을 어긋난 분으로 바꾼다~~ — `3,13,23,33,43,53` · `37` · `41 18` 로 바꿨다. **효과 없었다.**
3. **외부 크론으로 옮긴다** — 이걸로 해결했다.

**지금 구성 (cron-job.org, 무료).** 코드는 한 줄도 안 고쳤다. `/api/cron` 이 원래
헤더 하나 붙은 GET 이라 어떤 크론 서비스든 부를 수 있다.

| 작업 | URL | 일정 (Asia/Seoul) |
| --- | --- | --- |
| 수집 | `/api/cron?jobs=chart,details` | `*/10 * * * *` |
| 시간 롤업 | `/api/cron?jobs=rollup-hourly` | `37 * * * *` |
| 일 롤업+정리 | `/api/cron?jobs=rollup-daily,prune` | `41 3 * * *` |
| 감시 | `/api/cron?jobs=watchdog` | `7 */2 * * *` · **실패 알림 켤 것** |

인증 헤더는 `X-Cron-Secret: <CRON_SECRET>` 이다. `Authorization: Bearer <CRON_SECRET>` 도 되지만
값만 붙여넣으면 되는 앞쪽이 실수가 적다(`api/cron.js` 의 `authorized()` 가 둘 다 받는다).

**GitHub Actions 는 지우지 않았다.** `captured_at` 이 Steam 의 `last_update` 라서 두 스케줄러가
겹쳐 불러도 행이 중복되지 않는다. 저장소가 공개라 Actions 분도 무료다 — 4%짜리 공짜 예비 트리거로 남겨 둔다.

**확인 방법은 워크플로 실행 목록이 아니라 DB 다.**

```bash
node --env-file=.env -e "import('./lib/db.mjs').then(async({getSql})=>{const s=getSql();console.table(await s\`SELECT MAX(captured_at) AS latest, COUNT(DISTINCT captured_at)::int AS ticks FROM player_snapshots\`)})"
```

최신 `captured_at` 이 20분 안쪽이면 정상이다. 하루가 지나면 `ticks` 가 144 근처여야 한다.

### 3-2. 코드에 스키마를 추가하면 마이그레이션도 반드시 돌린다 (2026-09-06 사고)

**`prune` 잡이 500 을 냈다.** 원인은 `function prune_subscriptions() does not exist` 였다.
확인해 보니 이메일 알림 마이그레이션이 **DB 에 한 번도 적용된 적이 없었다** —
`subscribers` · `price_alerts` · `mail_deliveries` 세 테이블과 `prune_subscriptions()` 함수가 통째로 없었다.

코드에는 다 있었다. `db/schema.sql` 과 `db/functions.sql` 을 고쳤고 테스트도 통과했지만,
그 파일들은 **저절로 실행되지 않는다.** 아무도 `npm run db:migrate` 를 돌리지 않았고,
그 기능을 아직 켜지 않아서(`RESEND_API_KEY` 미설정) 몇 주 동안 아무도 눈치채지 못했다.

**이 항목의 교훈은 "이 표를 믿지 말라"가 아니라 "이 표를 갱신하라"다.**
위 §3 의 "스키마·함수 실제 실행 | 검증됨" 이 사고 당시에도 적혀 있었고, 그래서 아무도 의심하지 않았다.
숫자(테이블 14개 · 함수 6개)를 함께 적어 둔 이유가 이것이다 — 대조할 수 있어야 검증이다.

**앞으로.** `db/*.sql` 을 건드리는 커밋에는 마이그레이션 실행이 따라와야 한다.
`npm run db:migrate` 는 `psql` 과 `DATABASE_URL_DIRECT` 를 요구하는데 둘 다 없는 환경이면
**Neon 콘솔의 SQL Editor 에 두 파일을 통째로 붙여넣으면 된다.** 전부
`CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE FUNCTION` / `CREATE INDEX IF NOT EXISTS` 라
여러 번 돌려도 안전하고 기존 데이터를 건드리지 않는다.

현재 상태를 대조하는 명령:

```bash
node --env-file=.env -e "import('./lib/db.mjs').then(async({getSql})=>{const s=getSql();const f=await s\`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'\`;const t=await s\`SELECT tablename FROM pg_tables WHERE schemaname='public'\`;console.log('함수',f.length,'개 / 테이블',t.length,'개')})"
```

**함수 6개 · 테이블 14개**가 나와야 한다.

## 4. 다음 할 일

**[TODO.md](TODO.md) 에 있다.** 할 일 목록이 두 곳에 있으면 반드시 어긋나므로 여기서는 옮겨 두지 않는다.

가장 급한 것 하나만 옮겨 적으면 — **24시간 뒤 `captured_at` 이 144개 근처인지, 7일째 `prune` 이 실제로 지우는지 확인하는 것**(§3-1).
그게 안 돌면 추이·급상승·주간 차트가 영원히 빈 페이지다.

---

## 5. 설계에서 기억할 것

새 세션이 맥락 없이 고치다 깨뜨리기 쉬운 지점들이다.

### 5-0. 이메일 알림 (2026-09-06 추가, 아직 켜지지 않음)

1. **설정이 없으면 기능 자체가 없다.** `RESEND_API_KEY`·`MAIL_FROM` 둘 다 있어야 켜진다.
   판정 기준은 `lib/render.mjs` 의 `config.mail` **하나**이고 `mailEnabled()` 도 그걸 읽는다.
   화면과 발송이 서로 다른 기준으로 켜지면 폼은 보이는데 메일은 안 오는 상태가 만들어진다.
2. **확인도 해지도 GET 으로 처리하지 않는다.** 메일 클라이언트와 회사 보안 스캐너는 링크를 미리 열어 본다.
   `/alerts/confirm` 은 버튼만 그리고, 쓰기는 그 버튼이 `/api/alerts` 로 POST 할 때만 일어난다.
   GET 이 쓰기를 하면 본인이 누르지 않은 구독 확정·해지가 생긴다.
3. **보내기 전에 `mail_deliveries` 에 자리를 잡는다.** `dedupe_key` 의 UNIQUE 가 중복 판정의 전부다.
   발송 도중 죽으면 `pending` 으로 남고 재발송하지 않는다 — **중복 발송보다 누락이 낫다.**
4. **워터마크(`notified_price`)는 발송에 성공한 뒤에만 올린다.** 먼저 올리면 실패한 하락을 영영 못 알린다.
5. **응답으로 주소의 상태를 알려 주지 않는다.** "이미 가입됨"과 "처음"을 구분해 답하면
   그 엔드포인트가 주소 존재 확인 도구가 된다. 항상 같은 문구로 답한다.
6. **개인정보는 이 기능이 유일하다.** 보관 기간(미확인 30일 · 해지 30일 · 발송원장 90일)은
   `prune_subscriptions()` 와 `/privacy` 양쪽에 적혀 있다. **한쪽만 고치면 방침이 거짓말이 된다.**

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

11. **크론 문자열은 두 곳에 적힌다.** `.github/workflows/collect.yml` 의 `schedule` 블록과
    잡 선택 `case` 문. 어긋나면 워크플로는 정상 실행되고 조용히 기본값(`chart,details`)으로
    떨어져 롤업이 영영 안 돈다 — 실패가 아니라 침묵이라 눈에 안 띈다. `npm run build` 가 대조한다.

12. **캐시 헤더는 응답에서 확인할 수 없다.** Vercel 이 `s-maxage` 와 `stale-while-revalidate` 를
    클라이언트 응답에서 지우고 CDN 에서만 쓴다. 적중 여부는 `X-Vercel-Cache` 로 본다.

13. **목록 스파크라인에 원시 동접을 다시 넣지 않는다.** 모든 게임은 지역별 하루 주기를 공유하므로
    원시값을 게임별 최소~최대로 늘리면 거의 같은 산 모양이 되고 작은 변화도 큰 변화처럼 보인다.
    첫 24시간에는 `추적군 내 비중 변화`, 비교 표본이 생기면 `전일 동시간 대비`, 일 롤업이 쌓이면
    `일평균 전일 대비`를 쓴다. 세 모드 모두 같은 ±50% 축이며 0% 기준선과 현재 변화율을 함께 표시한다.

### 5-3. 수익화 · 위시리스트

14. **DB 를 읽지 않는 페이지가 DB 때문에 죽지 않게 한다.** 라우터는 `lazySql()` 을 넘긴다.
    `getSql()` 을 미리 부르면 `DATABASE_URL` 이 없을 때 방침·약관·문의·위시리스트까지 503 이 된다.

15. **`/watchlist` 는 `Cache-Control: no-store` 다.** 내용은 브라우저에만 있지만 껍데기라도
    CDN 이 캐시하면 안 된다 — 그리고 `noindex` 다. 사람마다 다른 화면은 색인 대상이 아니다.

16. **담김 여부를 서버가 렌더링하지 않는다.** 그 정보는 브라우저에만 있고, 서버가 그렸다면
    CDN 이 남의 상태를 다른 사람에게 보여 준다. 버튼은 항상 '담기'로 나가고 JS 가 칠한다.

17. **`ads.txt` 는 게시자 ID 가 없으면 404 여야 한다.** 내용이 틀린 `ads.txt` 는 없는 것보다
    나쁘다 — 크롤러가 이 파일을 권위 있는 목록으로 읽어 정상 광고 요청까지 거부한다.

18. **광고 슬롯은 `min-height` 를 먼저 잡는다.** 광고가 늦게 로드되며 아래를 밀어내면
    CLS 가 무너지고, 사용자가 누르려던 링크가 손가락 아래에서 어긋난다.

19. **분석 스크립트는 명시적으로 켰을 때만 나간다.** `/_vercel/insights/script.js` 는
    **대시보드에서 Web Analytics 를 켠 프로젝트에만** 존재한다. 배포 환경이라는 것만으로
    내보내면 방문자마다 404 요청이 하나씩 나간다 — 실제로 그렇게 배포했다가 live e2e 에서 잡혔다.

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
npm test                                           # 단위 87개
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
