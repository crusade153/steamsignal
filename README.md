# Steam Pulse

현재 가장 많이 플레이하는 Steam 게임 TOP 100을 탐색하고, 유저 평가·메타크리틱·한국 가격을 함께 비교하는 게이머용 웹앱입니다. 기존 6개 고정 게임과 합산 신호 점수를 실시간 인기 차트로 교체했습니다.

## 실행

Node.js 24 LTS를 권장합니다. 런타임 의존 패키지와 API 키는 필요하지 않습니다.

```sh
npm ci
npm run dev
```

[http://127.0.0.1:5174](http://127.0.0.1:5174)에서 확인합니다. `npm start`는 watch 없이 실행합니다. `PORT` 환경변수로 포트를 바꿀 수 있습니다.

## 제공 기능

- 현재 동시접속자 TOP 100, 20개씩 5페이지. Steam 응답이 100개 미만이면 실제 개수를 표시합니다.
- TOP 100 전체 이름·App ID 검색, 현재 동접자 / 오늘 최고 동접자 / 이름 정렬.
- 검색·정렬·페이지를 URL에 보존. 예: `/?page=5`, `/?q=Stardew`.
- Steam 전체 긍정 리뷰 비율과 리뷰 수, Steam 스토어에 수록된 메타크리틱 PC 평론가 점수.
- 한국 스토어 가격·할인, 게임 상세 정보, Steam과 메타크리틱 원문 링크.
- 현재 페이지 내 유저 평가 우수 게임, 유저·평론가 공통 호평 게임, 평가가 좋은 할인 게임.
- 모바일 가로 스크롤 표, 키보드 검색(`/`), 키보드 지원 상세 대화상자(`Escape`로 닫기).
- 페이지가 보이는 동안 1분마다 순위 자동 갱신. 상세창이 열려 있거나 조회 중이면 건너뜁니다.

## 데이터 기준과 한계

| 항목 | 출처 | 해석 |
| --- | --- | --- |
| 순위 / 현재 동접자 / 오늘 최고 | [Steam Charts API](https://api.steampowered.com/ISteamChartsService/GetGamesByConcurrentPlayers/v1/) | 현재 동시접속자 내림차순. 일일 이용자 순위나 급상승 순위가 아닙니다. |
| 게임 이름 / 목록 이미지 | [Steam 공개 차트 페이지](https://store.steampowered.com/charts/mostplayed) | 첫 조회에서 100개 이름을 확보하기 위한 보조 메타데이터. CSS 클래스와 독립적인 HTML 어댑터를 사용합니다. |
| 장르 / 한국 가격 / 메타크리틱 | [Steam Store App Details](https://store.steampowered.com/api/appdetails?appids=413150&cc=kr&l=koreana) | Steam이 제공한 값만 표시합니다. 메타크리틱 직접 수집 API를 사용하지 않습니다. |
| 유저 평가 | [Steam Reviews API](https://partner.steamgames.com/doc/store/getreviews?l=english) | 전체 언어·전체 구매 유형, `filter=all`, `purchase_type=all`. 긍정 ÷ (긍정 + 부정), 정수 반올림. |

순위는 전 세계 Steam 차트 기준입니다. 차트에 포함된 소프트웨어·플레이테스트도 원본 그대로 표시합니다. 스토어가 한국 지역에서 게임 정보를 제공하지 않는 경우 순위는 유지하고 가격·평론가 점수는 `조회 불가`로 표시합니다. 점수를 제공하지 않는 정상 응답은 `미제공`으로 구분하며, 누락된 값을 0점이나 무료로 처리하지 않습니다.

Steam 긍정 비율과 메타크리틱은 서로 다른 지표입니다. 이 둘을 합산한 순위나 ‘신호 점수’는 없습니다. 리뷰가 적은 게임이 인사이트를 과도하게 차지하지 않도록 리뷰 1,000개 이상을 기준으로 비교합니다. 인사이트는 현재 페이지 범위이고, 실패하거나 오래된 데이터는 인사이트 비교에서 제외합니다.

과거 데이터베이스는 아직 없습니다. 상승률, 순위 변동, 동접자 추세를 만들어 표시하지 않습니다. 공개 차트·스토어 엔드포인트는 버전 고정 계약이 아니므로 응답 변경 시 어댑터 유지보수가 필요합니다. 특히 보조 차트 HTML 구조가 변경되면 일부 제목이 App ID로 표시될 수 있습니다.

## 구조

```text
public/                 HTML, CSS, 브라우저 앱 (정적 배포)
lib/steam.mjs           Steam 수집, 검증, 동시성 제한, 캐시
lib/http.mjs            로컬 / Vercel 공유 API 핸들러
api/                    Vercel Node.js Functions
server.mjs              로컬 정적 서버 + 동일 API
tests/steam.test.mjs     집계/누락/캐시/실패/동시성 테스트
check.mjs               Playwright UI 통합 테스트
scripts/build.mjs        정적 자산과 서버 모듈 검증
vercel.json             Vercel 배포 설정
.github/workflows/ci.yml GitHub 자동 검증
```

### API

- `GET /api/games`: TOP 100 전체 순위, 이름, 동접자, 갱신 시각, 소스 상태.
- `GET /api/game-details?ids=730,570`: 현재 차트 안의 ID를 최대 20개까지 조회. 가격·리뷰·메타크리틱과 소스별 수신 시각.
- `GET /api/health`: 서비스 상태.

브라우저는 순위 전체를 먼저 받아 검색·정렬·페이지를 처리하고, 현재 페이지의 상세 데이터만 조회합니다. 서버는 같은 요청을 병합하고 인스턴스당 외부 요청을 최대 8개로 제한합니다. 외부 응답 제한 시간은 7초입니다. 요청 파라미터를 검증하고 임의의 외부 URL을 전달받지 않습니다.

순위는 1분, 이름은 10분, 스토어는 30분, 리뷰는 10분 캐시합니다. 조회 실패 시 최대 1시간 이내의 기존 수신값만 `stale` 상태로 반환합니다. 처음부터 실패하면 오류나 부분 누락 상태를 반환하며 예제 데이터를 대신 표시하지 않습니다. 실패 요청은 30초 동안 재요청을 억제합니다.

캐시는 인스턴스 메모리이며 영속 저장소가 아닙니다. Vercel의 서로 다른 인스턴스 간에는 공유되지 않습니다. 정상 응답에는 CDN 캐시 60초와 stale-while-revalidate 120초를 적용하므로 표시 시각은 반드시 확인해야 합니다. 트래픽이 커지면 공유 캐시와 중앙 수집 작업을 도입하는 것이 다음 확장 단계입니다.

## GitHub / Vercel

저장소 업로드와 실제 배포는 아직 수행하지 않았습니다. 준비된 코드를 GitHub에 올린 다음 Vercel에서 해당 저장소를 Import하면 됩니다.

1. 프로젝트를 GitHub 저장소에 올립니다. `.gitignore`는 의존 패키지·로그·스크린샷·로컬 환경 파일을 제외합니다.
2. Vercel에서 Framework Preset **Other**, Node.js **24.x**를 선택합니다.
3. `vercel.json`이 지정한 Build Command `npm run build`, Output Directory `public`을 사용합니다.
4. 프로젝트 루트의 `api/*.js`는 Node.js Functions로 처리됩니다. `server.mjs` 프로세스를 Vercel에서 상시 실행하지 않습니다.
5. 환경변수나 API 키 없이 배포할 수 있습니다. 배포 후 `/api/health`, `/api/games` 및 첫/마지막 페이지를 확인합니다.

[Vercel Node.js Functions 문서](https://vercel.com/docs/functions/runtimes/node-js) · [Vercel 설정 문서](https://vercel.com/docs/project-configuration/vercel-json)

## 검증

```sh
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

기본 UI 테스트는 독립적인 로컬 서버와 **명시적인 테스트 픽스처**를 사용하며 외부 Steam 상태에 의존하지 않습니다. 100위까지의 페이지 이동, 전체 검색, 누락 점수, API 실패, 입력 이스케이프, 상세창·키보드, 모바일 넘침을 검증합니다. 앱의 실제 실행에는 이 픽스처를 사용하지 않습니다.

개발 서버가 실행 중일 때 실데이터 검사:

```sh
node check.mjs --live
```

`TEST_URL` 환경변수로 다른 개발/배포 주소도 확인할 수 있습니다. 실데이터 검사에는 Steam 네트워크 접근이 필요합니다. 스크린샷은 `screenshots/`에 저장합니다.

Valve 및 Metacritic과 무관한 독립 프로젝트입니다. 게임 이미지와 상표는 각 권리자에게 속합니다.
