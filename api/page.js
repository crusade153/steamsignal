// SSR 페이지 함수. vercel.json 의 rewrites 가 /game/... · /rising · /deals 등을
// 이 함수로 넘기면서 ?route=<이름> 을 붙여 준다.
//
// 이 파일은 HTTP 만 담당한다. 무엇을 그릴지는 lib/pages.mjs 가, 무엇을 읽을지는 lib/queries.mjs 가 안다.
import { lazySql } from '../lib/db.mjs';
import { HANDLERS, notFound, serverError } from '../lib/pages.mjs';
import { decodeParam } from '../lib/routes.mjs';

// 경로에서 온 값(slug·genre)과 쿼리에서 온 값(token·state)을 한 모양으로 만들어 넘긴다.
// token·state 는 rewrite 의 destination 에 적혀 있지 않다 — Vercel 이 원래 요청의 쿼리스트링을
// 목적지에 그대로 합쳐 주기 때문이고, 그래서 lib/routes.mjs 의 query 목록에도 없다.
// (로컬 server.mjs 는 같은 값을 직접 만들어 넘긴다.)
export const pageParams = url => ({
  slug: decodeParam(url.searchParams.get('slug')),
  genre: decodeParam(url.searchParams.get('genre')),
  token: url.searchParams.get('token'),
  state: url.searchParams.get('state')
});

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const route = url.searchParams.get('route');
  const handle = Object.hasOwn(HANDLERS, route ?? '') ? HANDLERS[route] : null;

  let result;
  try {
    result = handle
      ? await handle(lazySql(), pageParams(url))
      : notFound();
  } catch (error) {
    // DB 가 잠깐 흔들려도 스택을 사용자에게 보여 주지 않는다. 원인은 서버 로그에만 남긴다.
    console.error('[page]', route, error);
    result = serverError();
  }

  res.statusCode = result.status;
  for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(req.method === 'HEAD' ? undefined : result.body);
}
