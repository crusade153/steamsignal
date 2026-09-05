# Steam Pulse

Steam 게임의 동시접속자·유저 평가·한국 가격을 10분마다 기록하고, 그 시계열로 추이를 보여 주는 웹앱입니다.

**배포:** [steamsignal.vercel.app](https://steamsignal.vercel.app)

Steam 이 보여 주는 건 '지금'뿐입니다. 이 사이트는 그 '지금'을 계속 적어 두었다가
어제와 지난주를 함께 보여 줍니다 — 급상승, 역대 최고 동접, 역대 최저가는 전부 거기서 나옵니다.

## 실행

Node.js 22 이상. 런타임 의존 패키지는 Neon 드라이버 하나뿐입니다.

```sh
npm ci
npm run dev
```

읽기 경로가 전부 DB 를 거치므로 `.env` 에 `DATABASE_URL` 이 필요합니다
([.env.example](.env.example) 참고, 반드시 `-pooler` 엔드포인트). 없으면 화면이 안내 페이지로 대체됩니다.
[http://127.0.0.1:5174](http://127.0.0.1:5174) 에서 확인합니다. `PORT` 로 포트를 바꿀 수 있습니다.

## 페이지

| 경로 | 내용 |
| --- | --- |
| `/` | 현재 동접 TOP 100. 검색·정렬·페이지가 URL 에 남습니다 (`/?page=5`, `/?q=Stardew`) |
| `/game/<appid>-<slug>` | 동접 추이 차트, 역대 최고 동접, 가격과 역대 최저가, 리뷰 추이, 같은 장르 추천 |
| `/game/<appid>-<slug>/reviews` | 누적 긍정률 vs **최근 신규 리뷰**의 긍정률. Steam 화면에 없는 숫자입니다 |
| `/rising` | 두 시간대의 평균 동접을 비교한 급상승 순위. **Steam 이 제공하지 않는 우리 콘텐츠** |
| `/deals` | Steam 긍정률 75% 이상인 할인. 우리 가격 이력으로 역대 최저가 여부를 표시 |
| `/deals/all-time-low` | 가격 변동을 2회 이상 관측한 게임 중 **지금이 최저가**인 것만 |
| `/charts/weekly`, `/charts/monthly` | 7일·30일 평균 동접 순위. 하루짜리 이벤트에 흔들리지 않습니다 |
| `/genre`, `/genre/<장르>` | 장르 허브 |
| `/genre/<장르>/free`, `/genre/<장르>/discounted` | 장르 조합. 게임 5개 미만이면 만들지 않습니다 |
| `/releases`, `/releases/<연도>` | 발매 연도별. 그해 게임이 지금도 플레이되는지 |
| `/watchlist` | 담아 둔 게임의 현재가·할인·평가. **계정 없이 브라우저에만 저장**됩니다 |
| `/privacy`, `/terms`, `/contact` | 개인정보처리방침 · 이용약관 · 문의 |
| `/sitemap.xml`, `/robots.txt`, `/ads.txt` | 색인·광고용 |

`/` 를 뺀 나머지는 전부 서버에서 HTML 로 렌더링합니다. JavaScript 없이도 내용이 보이고,
`VideoGame`·`BreadcrumbList` 구조화 데이터와 canonical·OG 메타가 붙습니다.

## 구조

```text
GitHub Actions (10분마다 curl 1회)
      │  Authorization: Bearer CRON_SECRET
      ▼
/api/cron ──► lib/collect.mjs ──► Steam 공개 API
                    │
                    ▼
              Neon Postgres
                    │
                    ▼
      사용자 요청 (읽기 전용, Steam 을 호출하지 않음)
```

**사용자 요청은 Steam 을 호출하지 않습니다.** 크론만 호출합니다.
예전에는 인메모리 캐시가 서버리스 인스턴스마다 따로라 트래픽이 늘면 Steam 호출도 같이 늘었지만,
지금은 트래픽이 얼마든 Steam 호출량이 고정입니다.

```text
public/            정적 자산 (index.html, app.js, styles.css, pages.css)
lib/queries.mjs    DB 읽기 전용 쿼리
lib/render.mjs     공용 레이아웃 · 포맷터 · 인라인 SVG 차트
lib/pages.mjs      SSR 페이지 본문 (HTTP 를 모른다)
lib/routes.mjs     라우트 정의 한곳 — vercel.json 의 rewrites 를 여기서 만든다
lib/http.mjs       읽기 API 핸들러
lib/collect.mjs    수집 잡 8종 (chart / details / rollup-hourly / rollup-daily / prune / alerts / newsletter / watchdog)
lib/steam.mjs      Steam 수집·검증·동시성 제한
lib/db.mjs         Neon 클라이언트, 실행 로그 래퍼
db/                스키마와 롤업·보관정책 함수
api/               Vercel Node.js Functions
server.mjs         로컬 서버 (배포와 같은 렌더러·라우트를 쓴다)
```

설계 근거와 읽기 쿼리는 [docs/DATA-PIPELINE.md](docs/DATA-PIPELINE.md), 현재 상태와 건드리면 깨지는
지점은 [HANDOFF.md](HANDOFF.md), 앞으로 할 일은 [TODO.md](TODO.md) 에 있습니다.

### API

- `GET /api/games` — TOP 100. 순위·동접과 함께 평가·가격·메타크리틱까지 한 번에 옵니다.
- `GET /api/game-details?ids=730,570` — 최대 20개. 같은 모양의 개별 조회.
- `GET /api/health` — 서비스 상태.
- `GET /api/cron?jobs=chart,details` — 수집 트리거. `CRON_SECRET` 없이는 401.

정상 응답에는 `s-maxage=300, stale-while-revalidate=600` 을 붙입니다.
Vercel 은 이 지시를 CDN 에서 쓰고 클라이언트에는 `public, max-age=0` 만 내려 주므로,
캐시 적중은 응답 헤더가 아니라 `X-Vercel-Cache` 로 확인합니다.
수집이 25분 이상 갱신되지 않으면 응답에 `stale: true` 를 실어 그대로 알립니다 — 낡은 값을 새 값인 척하지 않습니다.

## 설정 (환경변수)

전부 **없으면 아무것도 렌더링하지 않는다**가 원칙입니다. 자리만 잡아 둔 빈 광고 칸이나
아직 받을 수 없는 문의 주소를 화면에 내보내는 것보다, 없는 편이 낫습니다.

| 변수 | 없을 때 | 용도 |
| --- | --- | --- |
| `DATABASE_URL` | 목록·SSR 페이지가 안내 페이지로 대체 (방침·약관·문의·위시리스트는 그대로 뜸) | Neon pooler 연결 |
| `CRON_SECRET` | `/api/cron` 이 항상 401 | 수집 트리거 인증 |
| `SITE_URL` | canonical 이 배포 도메인 추정값 | canonical · sitemap · OG |
| `ADSENSE_PUBLISHER_ID` | 광고 스크립트도 슬롯도 렌더링되지 않고 `/ads.txt` 는 404 | 애드센스 (`ca-pub-...`) |
| `ADSENSE_SLOT_DETAIL` | 게임 상세 하단 슬롯 없음 | 애드센스 슬롯 ID |
| `CONTACT_EMAIL` | 문의 페이지가 GitHub 이슈만 안내 | 문의 주소 |
| `VERCEL_WEB_ANALYTICS=1` | 분석 스크립트가 나가지 않음 (기본) | Vercel Web Analytics |
| `RESEND_API_KEY` + `MAIL_FROM` | 구독 폼이 그려지지 않고 `/alerts` 는 404, 발송 잡은 그냥 끝남 | 이메일 알림 (Resend) |

이메일 알림은 **두 값이 다 있어야** 켜집니다. 하나만 넣으면 꺼진 것과 같습니다 —
폼은 보이는데 메일은 오지 않는 상태가 가장 나쁘기 때문입니다.
켜기 전에 Resend 에서 **도메인 인증(SPF·DKIM)을 끝내세요.** 인증 없이 보내면 Gmail 이 스팸함으로 보내고,
그 상태가 며칠 쌓이면 도메인 평판은 되돌리기 어렵습니다.
켜는 순간 `/privacy` 에 이메일 수집·보관·파기 항목이 함께 나타납니다(끄면 다시 사라집니다).

Vercel Web Analytics 는 쿠키를 쓰지 않으므로 쿠키 동의 배너가 필요 없습니다.
**켜는 순서가 중요합니다** — 대시보드 > Analytics > Enable 을 먼저 하고, 그다음 `VERCEL_WEB_ANALYTICS=1` 을 넣습니다.
`/_vercel/insights/script.js` 는 대시보드에서 켠 프로젝트에만 존재하므로, 순서를 바꾸면 그사이에 방문자마다 404 요청이 나갑니다.

## 데이터 기준과 한계

| 항목 | 출처 | 해석 |
| --- | --- | --- |
| 순위 / 현재 동접 / 오늘 최고 | [Steam Charts API](https://api.steampowered.com/ISteamChartsService/GetGamesByConcurrentPlayers/v1/) | 현재 동시접속자 내림차순. 일일 이용자 순위가 아닙니다 |
| 동접 추이 / 역대 최고 / 급상승 / 주간 차트 | **Steam Pulse 자체 시계열** | 10분 간격 기록의 롤업입니다. 기록 시작 이전은 알 수 없습니다 |
| 장르 / 한국 가격 / 메타크리틱 | [Steam Store App Details](https://store.steampowered.com/api/appdetails?appids=413150&cc=kr&l=koreana) | Steam 이 제공한 값만 표시합니다 |
| 유저 평가 | [Steam Reviews API](https://partner.steamgames.com/doc/store/getreviews?l=english) | 전체 언어·전체 구매 유형. 긍정 ÷ (긍정 + 부정), 정수 반올림 |

**결측을 0 으로 만들지 않습니다.** 리뷰가 없으면 긍정률은 `집계 전`이지 0% 가 아니고,
메타크리틱 미제공은 `미제공`이지 0점이 아닙니다. 표본이 이틀 미만이면 '최근 30일 신규 리뷰 긍정률'을
계산하지 않고 그렇게 적습니다.

**역대 최저가·역대 최고 동접은 우리가 기록을 시작한 이후 기준입니다.** 기록이 없다는 것은
할인이 없었다는 뜻이 아니라 아직 본 적이 없다는 뜻이며, 화면에도 그렇게 씁니다.

상세 수집은 라운드로빈이라 게임마다 순서대로 갱신됩니다. 가격은 스토어와 최대 한 시간까지
차이가 날 수 있으므로 구매 전 실제 가격을 확인해야 합니다.

## 운영

수집 상태는 이 쿼리 하나로 봅니다.

```sql
SELECT job, status, processed, failed, started_at, finished_at, error
  FROM collector_runs ORDER BY started_at DESC LIMIT 20;
```

수동 수집:

```sh
node --env-file=.env scripts/collect.mjs chart details
node --env-file=.env scripts/collect.mjs rollup-hourly rollup-daily prune
```

경보 조건은 [docs/DATA-PIPELINE.md §7](docs/DATA-PIPELINE.md) 에 있습니다.

## 검증

```sh
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

`npm run build` 는 문법 검사와 함께 **`vercel.json` 의 rewrites 가 `lib/routes.mjs` 와 일치하는지**
검사합니다. 어긋나면 로컬에서는 되는데 배포에서만 404 가 나기 때문입니다.

기본 e2e 는 `/api/games` 를 고정 픽스처로 가로채므로 DB 없이도 돌아갑니다.
20행·100위·검색·정렬·모바일 넘침·이스케이프·결측 표기·API 실패·SSR 오류 페이지를 확인합니다.

배포를 그대로 확인하려면:

```sh
TEST_URL=https://steamsignal.vercel.app node check.mjs --live
```

이 모드는 SSR 페이지 9종, 구조화 데이터, canonical, 404, sitemap, robots 까지 확인합니다.
스크린샷은 `screenshots/` 에 저장됩니다.

## 배포

- Vercel 프로젝트: `steamsignal` (Framework **Other**, Build `npm run build`, Output `public`)
- Vercel 환경변수: `DATABASE_URL`(pooler), `CRON_SECRET`, `SITE_URL`
- GitHub 저장소 secrets: `SITE_URL`, `CRON_SECRET`
- 스케줄러: [.github/workflows/collect.yml](.github/workflows/collect.yml) — 공개 저장소라 Actions 는 무료입니다

`CRON_SECRET` 은 `openssl rand -hex 32` 로 만들고 Vercel 과 GitHub 양쪽에 같은 값을 넣습니다.
없거나 틀리면 `/api/cron` 은 401 을 냅니다(설정 누락 시 열리지 않습니다).

[Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js) · [vercel.json](https://vercel.com/docs/project-configuration/vercel-json)

Valve 및 Metacritic과 무관한 독립 프로젝트입니다. 게임 이미지와 상표는 각 권리자에게 속합니다.
