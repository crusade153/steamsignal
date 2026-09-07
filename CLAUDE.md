# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Steam Pulse — Steam 동시접속자·평가·한국 가격을 10분마다 적재하고 그 자체 시계열로 페이지를 만드는 사이트.
Node 22+ / ESM(`type: module`) / 런타임 의존성은 `@neondatabase/serverless` 하나. 빌드 도구·프레임워크 없음.
테스트에만 `playwright`(e2e)와 `@electric-sql/pglite`(내장 Postgres 로 `db/*.sql` 을 실제 실행)를 쓴다.
문서와 주석은 한국어다. 커밋 메시지도 한국어 서술형(`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`)으로 쓴다.

## 명령어

```sh
npm run dev            # 로컬 서버 (--watch), http://127.0.0.1:5174, PORT 로 변경 가능
npm run build          # 문법 검사 + vercel.json↔routes 대조 + collect.yml cron 대조 (아래 참고)
npm test               # 단위 테스트 (node --test tests/*.test.mjs)
node --test tests/rollup.test.mjs                      # db/*.sql 을 PGlite(내장 Postgres)로 실제 실행
node --test tests/pages.test.mjs                       # 파일 하나만
node --test --test-name-pattern '급상승' tests/pages.test.mjs   # 케이스 하나만
npm run test:e2e       # playwright e2e. /api/games 를 픽스처로 가로채므로 DB 불필요
TEST_URL=https://steamsignal.vercel.app node check.mjs --live   # 배포를 직접 검증(SSR·사이트맵·구조화 데이터)
npm run collect -- chart details    # 수동 수집. 잡: chart details rollup-hourly rollup-daily prune
npm run db:migrate     # DATABASE_URL_DIRECT(pooler 아님)로 schema.sql + functions.sql 적용
npm run db:apply       # psql 이 없을 때. DATABASE_URL 로 같은 파일을 드라이버로 적용
npm run db:apply -- db/functions.sql          # 한 파일만
node scripts/og-image.mjs                     # 브랜드 마크를 바꾸면 og-cover.png 도 다시 뽑는다
```

e2e 는 처음 한 번 `npx playwright install chromium` 이 필요하다.
`.env` 는 사람이 직접 만든다 — 에이전트 도구로 만든 `.env`/`.env.local` 이 자동 삭제된 적이 있다.

## 구조에서 먼저 알아야 할 것

**Steam 은 크론만 호출한다.** 사용자 요청 경로(`lib/http.mjs`, `lib/queries.mjs`, `lib/pages.mjs`)에서
`lib/steam.mjs` 를 부르는 코드는 없어야 한다. 예전엔 인메모리 캐시가 서버리스 인스턴스마다 따로라
트래픽이 늘면 Steam 호출도 같이 늘었다. 지금은 트래픽과 무관하게 Steam 호출량이 고정이다.

```
cron-job.org(주) + GitHub Actions(예비) → /api/cron → lib/collect.mjs → Steam 공개 API
                                                      ↓
                                                Neon Postgres → 사용자 요청(읽기 전용)
```

**같은 코드가 두 진입점을 통해 돈다.** 로컬은 `server.mjs`, 배포는 `api/*.js`(Vercel Functions).
`api/games.js`·`api/game-details.js`·`api/health.js` 는 전부 `lib/http.mjs` 의 `handleApi` 를 재수출한 한 줄짜리다.
그래서 로직은 항상 `lib/` 에 넣고 `api/` 와 `server.mjs` 는 HTTP 껍데기로 남긴다.

**읽기 경로의 층은 서로를 모른다.**
`lib/routes.mjs`(경로 정의) → `lib/pages.mjs`(본문, `{status, headers, body}` 만 반환하고 HTTP 를 모름)
→ `lib/queries.mjs`(읽기 전용 SQL) / `lib/render.mjs`(레이아웃·포맷터·인라인 SVG 차트, DB 도 Steam 도 모름).
법적 고정 문서는 `lib/legal.mjs`. 수집은 `lib/collect.mjs`(잡 11종, `discover`·`watchdog`·`platforms`·`gamepass` 포함) + `lib/steam.mjs`(수집·검증·동시성) + `lib/db.mjs`.
멀티플랫폼 층위는 `lib/platforms.mjs`(Wikidata SPARQL) + `game_sources`·`platform_releases`·`identity_candidates`.
Game Pass 층위는 `lib/gamepass.mjs`(카탈로그 + Xbox Wire) + `gamepass_catalog`·`gamepass_events`·`gamepass_upcoming`.
**기존 Steam 경로와 분리돼 있다** — 이 층위가 통째로 죽어도 기존 화면은 한 칸도 달라지지 않는다.
이메일 알림은 `lib/alerts.mjs`(구독 SQL) + `lib/mail.mjs`(Resend 발송·템플릿) + `lib/http.mjs` 의 `handleAlerts`.
계정은 `lib/accounts.mjs` + `lib/http.mjs` 의 `handleAccount`.
**사용자 요청 경로에서 쓰기를 하는 파일은 `lib/alerts.mjs` 와 `lib/accounts.mjs` 둘뿐이다.**
표는 전부 `lib/render.mjs` 의 `dataTable`+`COL` 로 만든다 — 열 정의가 한곳에 있어야
페이지마다 순서가 어긋나지 않고, td 의 `data-label` 이 빠지지 않는다(그게 모바일 카드의 열 이름이다).

**시계열은 3단이다.** `player_snapshots`(10분/7일) → `player_hourly`(1시간/90일) → `player_daily`(1일/영구),
`prune_timeseries()` 가 보관정책을 집행한다. 원시를 그냥 쌓으면 Neon 무료 0.5GB 를 1년 안에 넘긴다.
`db/functions.sql` 의 롤업·보관정책 함수를 지우지 말 것.

## 깨뜨리기 쉬운 규칙

이 항목들은 어겨도 테스트가 아니라 **배포에서만**, 또는 며칠 뒤에 조용히 드러난다.

1. **라우트는 `lib/routes.mjs` 한곳에만 적는다.** 거기서 `vercel.json` 의 rewrites 를 만들고
   `npm run build` 가 실제 파일과 `deepEqual` 로 대조한다. 손으로 `vercel.json` 을 고치면 빌드가 막는다.
   어긋난 채 배포하면 로컬은 되는데 프로덕션만 404 가 난다.
2. **크론 문자열은 `.github/workflows/collect.yml` 안에 두 번 적힌다** — `schedule` 블록과 잡 선택 `case`.
   어긋나면 워크플로는 성공하면서 조용히 `chart,details` 로 떨어져 롤업이 영영 안 돈다. 빌드가 이것도 대조한다.
   시각이 `3,13,23,33,43,53`·`37`·`41 18` 로 어중간한 것은 의도다 — `*/10` 은 전 세계가 몰려 자동 발화가 안 떴다.
3. **멱등성 키는 Steam 의 `last_update` 다.** `player_snapshots.captured_at` 에 `NOW()` 를 넣으면
   크론이 밀리거나 두 번 돌 때 중복 행이 생긴다.
4. **결측을 0 으로 만들지 않는다.** 리뷰가 없으면 `positive_ratio` 는 `NULL` 이고 화면에는 `집계 전`이라 쓴다.
   이 규율이 이 사이트를 다른 Steam 미러와 구분하는 유일한 지점이다. `has_detail`/`has_reviews` 표식은
   한쪽만 실패했을 때 멀쩡한 값을 `NULL` 로 덮지 않기 위한 것이다.
5. **`apps.header_image` 는 `COALESCE(apps.header_image, EXCLUDED.header_image)` 순서를 지킨다.**
   차트가 주는 건 231x87 캡슐, 상세가 받는 건 460x215 헤더다. 뒤집으면 10분마다 이미지가 작아진다.
6. **상세 수집 커서는 성공·실패 모두 전진시킨다.** 안 그러면 죽은 앱이 큐 맨 앞에서 영원히 재시도된다.
7. **DATE 컬럼은 SQL 에서 `TO_CHAR(..., 'YYYY-MM-DD')` 로 꺼낸다.** 드라이버가 DATE 를 로컬 자정 `Date` 로
   주기 때문에 화면에서 `toISOString()` 을 한 번만 잘못 쓰면 하루가 밀린다. `formatDay()` 도 문자열만 다룬다.
8. **DB 를 읽지 않는 페이지에는 `lazySql()` 을 넘긴다.** 라우터가 `getSql()` 을 미리 부르면
   `DATABASE_URL` 이 없을 때 방침·약관·문의·위시리스트까지 503 이 된다.
9. **DB 에서 온 값은 예외 없이 `esc()` 를 통과시킨다** (`escXml()` 은 sitemap, JSON-LD 는 별도 이스케이프).
   제목·설명·개발사는 전부 Steam 이 준 외부 문자열이다.
10. **`/watchlist` 는 `no-store` + `noindex` 이고, 담김 여부를 서버가 렌더링하지 않는다.**
    상태는 브라우저 localStorage 에만 있다. 서버가 그리면 CDN 이 남의 상태를 다른 사람에게 보여 준다.
11. **환경변수는 "없으면 아무것도 렌더링하지 않는다"가 원칙이다.** 빈 광고 칸, 못 받는 문의 주소,
    ID 없는 `ads.txt`(404 여야 한다), 대시보드에서 켜지 않은 분석 스크립트는 전부 없는 편이 낫다.
12. **캐시 적중은 응답 헤더로 알 수 없다.** Vercel 이 `s-maxage`/`stale-while-revalidate` 를
    클라이언트 응답에서 지우고 CDN 에서만 쓴다. `X-Vercel-Cache` 로 확인한다.
13. **메일은 보내기 전에 `mail_deliveries` 에 자리를 잡는다.** `dedupe_key` 의 UNIQUE 가 중복 판정의 전부다.
    워터마크(`notified_price`)는 **발송에 성공한 뒤에만** 올린다 — 먼저 올리면 실패한 하락을 영영 못 알린다.
14. **구독 확인·해지는 GET 으로 처리하지 않는다.** 메일 클라이언트와 보안 스캐너가 링크를 미리 열기 때문에
    본인이 누르지 않은 확정·해지가 생긴다. `/alerts/confirm` 은 버튼만 그리고 쓰기는 POST 에서만 일어난다.
15. **얇은 조합 페이지를 만들지 않는다.** `/genre/<장르>/free`·`/discounted` 는 게임이
    `MIN_COMBO_GAMES`(5) 미만이면 404 다. 그리고 **링크·페이지·사이트맵이 이 상수 하나를 공유한다** —
    기준이 갈라지면 사이트맵에 있는데 404 인 URL 이 생겨 색인 전체가 손해를 본다.
16. **`watchdog` 잡은 이상이 있으면 일부러 던진다.** 실패가 곧 경보다 — 워크플로가 빨개지고
    GitHub 이 소유자에게 메일을 보낸다. "크론이 실패하네" 하고 스케줄을 끄면 경보를 끄는 것이다.
17. **계정은 자율이다. 로그인을 요구하는 화면을 만들지 않는다.** 운영자가 정한 선이다 —
    "회원 가입과 관리는 강제사항이 아니고 자율사항이고, 사이트는 누구나 이용 가능해야 한다."
    계정이 주는 것은 위시리스트를 기기 사이에서 이어 주는 것 하나뿐이고, 상단 내비에도 올리지 않는다
    (맨 위의 '로그인'은 '가입해야 쓰는 사이트'로 읽힌다). `check.mjs` 가 익명 접근을 검사한다.
    근거와 측정 지표는 [docs/PRODUCT.md §8](docs/PRODUCT.md).
18. **로그인 여부를 CDN 이 캐싱하는 페이지에 렌더링하지 않는다.** 규칙 10 과 같은 이유다.
    계정 화면 셋(`/account`, `/account/login`, `/account/signup`)만 `no-store` + `noindex` 이고,
    '지금 누구인가'는 진입점(`api/page.js` · `server.mjs`)이 그 셋에만 `params.user` 로 넘긴다.
19. **차트 밖 게임의 `captured_at` 은 차트와 같은 값이어야 한다.** 차트는 100개만 주므로
    나머지는 `GetNumberOfCurrentPlayers` 로 하나씩 묻는데, 시각이 어긋나면 롤업이 같은 10분을
    두 버킷에 나눠 담아 표본 수가 부풀려진다. 차트 밖 게임에 `rank` 를 적지도 않는다.
20. **목록 스파크라인은 원시 동접을 그리지 않는다.** 원시 48시간은 게임마다 같은 하루 주기를
    보여 주고, 게임별 최소~최대 정규화는 작은 변화를 과장한다. 첫 24시간은 `추적군 내 비중 변화`,
    이후 `전일 동시간 대비`, 일 롤업이 충분하면 `일평균 전일 대비`를 쓴다. 세 모드 모두 같은
    ±50% 축·0% 기준선·현재 변화율을 유지한다. `sparkSeries()` 가 값과 이름을 함께 돌려준다.
21. **할인 종료일에 시각을 지어내지 않는다.** `appdetails.price_overview`에는 종료일이 없다.
    할인 중인 앱만 `timezoneOffset=32400` 쿠키를 붙인 공식 상점 페이지에서 본편 현재가·할인율과
    일치하는 블록을 읽어 `DATE`로 저장한다. 에디션·번들 날짜를 붙이지 않고, 정확한 시각도 추정하지 않는다.
22. **메일 관련 테스트는 동적 import 를 쓴다.** 설정은 모듈 로드 시점에 `config.mail` 로 굳는데
    ESM 의 `import` 는 파일 첫 줄보다 먼저 실행돼서, `process.env` 를 위에 적어도 늦는다.
23. **롤업 창은 버킷 경계로 스냅한다.** `NOW()` 에서 그냥 빼면 창의 시작점이 버킷 한가운데에
    떨어져 가장 오래된 버킷이 조각만으로 집계되고, `ON CONFLICT DO UPDATE` 가 온전한 값을
    그 조각으로 덮는다. 다음 실행 때는 창 밖이라 **영영 복구되지 않는다.**
    실제로 시간 롤업이 매시 마지막 2표본(17분)만 담아 평균이 7% 어긋난 채 며칠을 돌았다.
    시간은 `date_trunc('hour', ...)`, 일은 KST 자정으로 자른다. 불변식은 하나다 —
    **롤업이 쓴 버킷은 그 버킷의 원시 스냅샷 전부를 요약한 값이어야 한다.**
24. **`db/*.sql` 을 고치면 마이그레이션이 반드시 따라온다.** 그 파일들은 저절로 실행되지 않고,
    테스트는 통과하는데 화면의 숫자만 틀린 상태가 만들어진다. `psql` 이 없는 환경에서는
    `npm run db:apply` 가 드라이버로 같은 일을 한다(전부 `IF NOT EXISTS`/`OR REPLACE` 라 반복 적용이 안전하다).
    적용 뒤 **테이블 20개 · 함수 6개**를 대조한다. 기록은 [HANDOFF §3-2](HANDOFF.md)·[§3-3](HANDOFF.md).
25. **브랜드 마크는 `public/favicon.svg` 하나다.** 파비콘과 헤더(`lib/render.mjs`·`public/index.html`)가
    그 파일을 직접 참조하므로 고치면 함께 바뀐다. **`og-cover.png` 만 예외로 생성물이라
    `node scripts/og-image.mjs` 를 다시 돌려야 한다** — 안 돌리면 링크 공유 카드에만 옛 마크가 남는다.
    그리고 SVG 안에서는 XML 주석에 하이픈 두 개를 못 쓴다(CSS 변수명을 그대로 적으면 파싱이 깨진다).

26. **Game Pass 의 입점·퇴점은 우리가 만든 기록이다.** 마이크로소프트는 '지금 목록'만 공개하고
    변경 이력을 주지 않으므로, 하루 한 번 카탈로그를 통째로 찍어 전날과 비교한다. 안전장치 셋을
    지운 채로 두면 하루 만에 기록이 오염된다 — **첫 실행은 기준선만 잡고 입점을 만들지 않는다**
    (처음 본 728개를 '오늘 입점'이라 적으면 거짓 기록이다), **목록이 비면 아무것도 쓰지 않는다**
    (요청이 막힌 것을 전부 퇴점으로 적으면 복구가 안 된다), **상세를 절반도 못 받으면 비교하지 않는다.**
    입점 예정은 카탈로그에 없어서(미출시 1건, 나머지는 9998년 자리표시자) Xbox Wire 공식 글을
    파싱한다 — 산문이므로 **놓치는 것은 받아들이고 틀리는 것은 받아들이지 않는다.**
    엔드포인트가 미문서라 이 층위는 절대 핵심 의존성이 아니다.

27. **플랫폼 층위는 제목으로 잇지 않는다.** Wikidata 의 `P1733`(Steam application ID) 역방향
    조회만 쓴다. 한 appid 에 항목이 둘 이상이면 고르지 않고 `identity_candidates` 로 보낸다 —
    고르면 남의 게임 출시일이 화면에 뜨는데 그건 조용히 틀린다. 두 가지가 더 있다:
    **출시일은 P577 진술의 `pq:P400` 한정어에서만 읽고**(따로 조회하면 카테시안 곱이 나와
    2020년 게임이 스위치 2에도 2020년에 나온 것처럼 보인다), **`wikibase:timePrecision` 이
    11(일) 이상일 때만 날짜로 쓴다**(연도만 아는 값이 `2027-01-01` 로 와서 1월 1일 출시로 굳는다).
    셋 다 실제로 났던 사고다. QID 는 추측하지 말고 확인할 것 — `Q11208` 은 Xbox 가 아니라
    'The Pentagon' 이다. 이 층위는 Steam 수집과 분리돼 있어서 하루 종일 실패해도 기존 화면은 그대로다.

28. **저장소 예산은 코드에 못 박지 않는다.** `prune` 은 매번 `pg_database_size()` 를 재고
    `planRetention()` 이 사용률로 그 회차의 보관 기간을 정해 `prune_timeseries()` 에 인자로 넘긴다
    (70% 넘으면 원시 5일·시간 60일, 85% 넘으면 3일·30일). 예산과 평상시 기간은 환경변수라
    요금제를 올리거나 커버리지를 늘려도 마이그레이션이 필요 없다.
    **셋만 지키면 된다 — 일 롤업은 어느 단계에서도 줄이지 않는다. 원시는 3일 밑으로 내려가지 않는다**
    (`rollup_player_daily(2)` 가 이틀 치 원시를 다시 읽어 온전한 하루를 조각으로 덮는다 — 규칙 23 과 같은 사고).
    **용량을 못 쟀으면 조이지 않는다.** 근거는 [docs/DATA-PIPELINE.md §2-1](docs/DATA-PIPELINE.md).

## 환경변수

`DATABASE_URL`(**반드시 `-pooler`**) · `DATABASE_URL_DIRECT`(마이그레이션 전용) · `CRON_SECRET`(없으면 `/api/cron` 은 항상 401)
· `SITE_URL` · `ADSENSE_PUBLISHER_ID` · `ADSENSE_SLOT_DETAIL` · `CONTACT_EMAIL` · `VERCEL_WEB_ANALYTICS=1`
· `RESEND_API_KEY` + `MAIL_FROM`(둘 다 있어야 이메일 알림이 켜진다. 하나만 넣으면 꺼진 것과 같다).
플랫폼 층위(Wikidata)에는 키가 필요 없다 — 공개 SPARQL 엔드포인트다.
자세한 동작은 [.env.example](.env.example) 과 README 의 설정 표에 있다.
저장소: `DB_SIZE_BUDGET_MB`(기본 512) · `RETENTION_SNAPSHOT_DAYS`(기본 7) · `RETENTION_HOURLY_DAYS`(기본 90).
셋 다 없어도 돌아가며, 넣으면 보관정책·`/status`·감시 경보가 함께 따라간다(규칙 26).
`VERCEL_WEB_ANALYTICS` 는 **Vercel 대시보드에서 Analytics 를 켠 뒤에** 넣는다 — 순서를 바꾸면 방문자마다 404 가 나간다.

## 문서

작업 전에 목적에 맞는 것을 읽는다. 네 문서는 역할이 겹치지 않게 나뉘어 있으니 그대로 유지한다.

- [HANDOFF.md](HANDOFF.md) — 현재 상태, 검증된 것/아직 아닌 것, 설계에서 기억할 것, 비용
- [TODO.md](TODO.md) — 할 일 **한곳**. 다른 문서에 할 일을 복사하지 않는다(반드시 어긋난다)
- [docs/PRODUCT.md](docs/PRODUCT.md) — **제품 기획**. 운영자가 정한 방향과 "무엇이 되면 된 것인가".
  "엔터프라이즈급"의 정의(신뢰성·정보밀도·일관성·응답성), 재방문 설계, 커버리지 300개의 비용 계산,
  측정 지표, Phase 순서가 여기 있다. **화면이나 커버리지를 건드리는 작업은 개별 항목보다 이걸 먼저 읽는다.**
  체크박스는 여기 만들지 않는다 — 할 일은 TODO.md §9 에만 있다
- [docs/DATA-PIPELINE.md](docs/DATA-PIPELINE.md) — 스키마 결정 근거, 수집 잡, 읽기 쿼리, 경보 조건
