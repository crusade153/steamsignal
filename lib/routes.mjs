// SSR 라우트 정의. 한곳에만 적는다.
//
// 배포(Vercel)에서는 vercel.json 의 rewrites 가, 로컬(server.mjs)에서는 matchRoute 가 경로를 해석한다.
// 두 곳이 어긋나면 "로컬에서는 되는데 배포하면 404" 가 나므로,
// vercel.json 에 들어갈 문장까지 여기서 만들고 tests/routes.test.mjs 가 실제 파일과 대조한다.

export const ROUTES = [
  // 하위 경로가 있는 라우트는 항상 먼저 적는다. matchRoute 는 위에서부터 훑고,
  // Vercel 의 rewrites 도 배열 순서대로 판정하기 때문이다.
  // (`:slug` 는 어느 쪽에서도 '/' 를 넘지 않지만, 순서로 한 번 더 못을 박아 둔다.)
  {
    name: 'gameReviews',
    source: '/game/:slug/reviews',
    pattern: /^\/game\/([^/]+)\/reviews$/,
    params: match => ({ slug: decodeURIComponent(match[1]) }),
    query: ['slug']
  },
  {
    name: 'game',
    source: '/game/:slug',
    pattern: /^\/game\/([^/]+)$/,
    params: match => ({ slug: decodeURIComponent(match[1]) }),
    query: ['slug']
  },
  { name: 'rising', source: '/rising', pattern: /^\/rising$/, params: () => ({}), query: [] },
  { name: 'dealsLow', source: '/deals/all-time-low', pattern: /^\/deals\/all-time-low$/, params: () => ({}), query: [] },
  { name: 'deals', source: '/deals', pattern: /^\/deals$/, params: () => ({}), query: [] },
  { name: 'weekly', source: '/charts/weekly', pattern: /^\/charts\/weekly$/, params: () => ({}), query: [] },
  { name: 'monthly', source: '/charts/monthly', pattern: /^\/charts\/monthly$/, params: () => ({}), query: [] },
  { name: 'genres', source: '/genre', pattern: /^\/genre$/, params: () => ({}), query: [] },
  // 장르 조합 페이지. 게임이 적으면 얇은 페이지가 되므로 pages.mjs 가 최소 개수를 지키고,
  // 그 미만이면 404 를 내 색인에 얇은 URL 을 흘리지 않는다.
  {
    name: 'genreFree',
    source: '/genre/:genre/free',
    pattern: /^\/genre\/([^/]+)\/free$/,
    params: match => ({ genre: decodeURIComponent(match[1]) }),
    query: ['genre']
  },
  {
    name: 'genreDiscounted',
    source: '/genre/:genre/discounted',
    pattern: /^\/genre\/([^/]+)\/discounted$/,
    params: match => ({ genre: decodeURIComponent(match[1]) }),
    query: ['genre']
  },
  {
    name: 'genre',
    source: '/genre/:genre',
    pattern: /^\/genre\/([^/]+)$/,
    params: match => ({ genre: decodeURIComponent(match[1]) }),
    query: ['genre']
  },
  // 발매 연도. 연도는 숫자 네 자리만 받는다 — 아무 문자열이나 받으면 크롤러가
  // /releases/abc 같은 주소를 무한히 만들어 낸다.
  { name: 'releases', source: '/releases', pattern: /^\/releases$/, params: () => ({}), query: [] },
  {
    name: 'release',
    source: '/releases/:year',
    pattern: /^\/releases\/(\d{4})$/,
    params: match => ({ year: match[1] }),
    query: ['year']
  },
  // 수집 상태 공개. 데이터를 숨기지 않는다는 신호이자, 사고가 났을 때 사용자가
  // 스스로 확인할 수 있는 곳이다(docs/PRODUCT.md §2-1).
  { name: 'status', source: '/status', pattern: /^\/status$/, params: () => ({}), query: [] },
  // 위시리스트는 브라우저에만 저장된다. 주소는 있어야 하지만(공유·북마크·뒤로가기)
  // 내용은 사람마다 다르므로 색인 대상이 아니다 — pages.mjs 가 noindex 를 붙인다.
  { name: 'watchlist', source: '/watchlist', pattern: /^\/watchlist$/, params: () => ({}), query: [] },
  // 이메일 알림. 확인·해지 페이지는 토큰을 쿼리로 받는다(경로에 넣으면 메일 본문에서 잘린다).
  // 셋 다 사람마다 다른 화면이라 색인 대상이 아니다 — pages.mjs 가 noindex 를 붙인다.
  { name: 'alerts', source: '/alerts', pattern: /^\/alerts$/, params: () => ({}), query: [] },
  { name: 'alertsConfirm', source: '/alerts/confirm', pattern: /^\/alerts\/confirm$/, params: () => ({}), query: [] },
  { name: 'alertsUnsubscribe', source: '/alerts/unsubscribe', pattern: /^\/alerts\/unsubscribe$/, params: () => ({}), query: [] },
  // 애드센스 심사에 필요한 고정 문서들.
  { name: 'privacy', source: '/privacy', pattern: /^\/privacy$/, params: () => ({}), query: [] },
  { name: 'terms', source: '/terms', pattern: /^\/terms$/, params: () => ({}), query: [] },
  { name: 'contact', source: '/contact', pattern: /^\/contact$/, params: () => ({}), query: [] },
  // ads.txt 는 HTML 이 아니라 text/plain 이고, 게시자 ID 가 없으면 404 여야 한다.
  // 내용이 틀린 ads.txt 는 없는 것보다 나쁘다 — 광고 요청이 거부된다.
  { name: 'ads', source: '/ads.txt', pattern: /^\/ads\.txt$/, params: () => ({}), query: [] }
];

export const SITEMAP_REWRITE = { source: '/sitemap.xml', destination: '/api/sitemap' };

// vercel.json 에 넣을 rewrite 한 줄. destination 은 /api/page 가 읽는 쿼리스트링 형태다.
export const rewriteFor = route => ({
  source: route.source,
  destination: `/api/page?route=${route.name}${route.query.map(key => `&${key}=:${key}`).join('')}`
});

export const rewrites = () => [...ROUTES.map(rewriteFor), SITEMAP_REWRITE];

// 슬러그에는 한글이 들어간다(예: 1172470-apex-레전드). 경로 세그먼트가 어느 단계에서
// 퍼센트 디코딩되는지는 로컬 서버와 Vercel 이 다르므로, 핸들러에 넘기기 전에 한 번 더 편다.
// slugify 가 '%' 를 남기지 않으므로 이미 디코딩된 값에는 아무 일도 일어나지 않는다
// — 그래서 301 정규화가 무한 반복에 빠지지 않는다.
export function decodeParam(value) {
  if (value === null || value === undefined) return null;
  try { return decodeURIComponent(String(value)); } catch { return String(value); }
}

// 로컬 개발 서버용. 배포에서는 Vercel 이 같은 일을 rewrites 로 한다.
export function matchRoute(pathname) {
  // 끝의 슬래시는 canonical 이 아니다. /rising/ 은 /rising 과 같은 페이지여야 한다.
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  for (const route of ROUTES) {
    const match = route.pattern.exec(path);
    if (match) return { name: route.name, params: route.params(match) };
  }
  return null;
}
