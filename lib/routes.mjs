// SSR 라우트 정의. 한곳에만 적는다.
//
// 배포(Vercel)에서는 vercel.json 의 rewrites 가, 로컬(server.mjs)에서는 matchRoute 가 경로를 해석한다.
// 두 곳이 어긋나면 "로컬에서는 되는데 배포하면 404" 가 나므로,
// vercel.json 에 들어갈 문장까지 여기서 만들고 tests/routes.test.mjs 가 실제 파일과 대조한다.

export const ROUTES = [
  {
    name: 'game',
    source: '/game/:slug',
    pattern: /^\/game\/([^/]+)$/,
    params: match => ({ slug: decodeURIComponent(match[1]) }),
    query: ['slug']
  },
  { name: 'rising', source: '/rising', pattern: /^\/rising$/, params: () => ({}), query: [] },
  { name: 'deals', source: '/deals', pattern: /^\/deals$/, params: () => ({}), query: [] },
  { name: 'weekly', source: '/charts/weekly', pattern: /^\/charts\/weekly$/, params: () => ({}), query: [] },
  { name: 'genres', source: '/genre', pattern: /^\/genre$/, params: () => ({}), query: [] },
  {
    name: 'genre',
    source: '/genre/:genre',
    pattern: /^\/genre\/([^/]+)$/,
    params: match => ({ genre: decodeURIComponent(match[1]) }),
    query: ['genre']
  }
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
