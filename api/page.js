// SSR 페이지 함수. vercel.json 의 rewrites 가 /game/... · /rising · /deals 등을
// 이 함수로 넘기면서 ?route=<이름> 을 붙여 준다.
//
// 이 파일은 HTTP 만 담당한다. 무엇을 그릴지는 lib/pages.mjs 가, 무엇을 읽을지는 lib/queries.mjs 가 안다.
import { lazySql } from '../lib/db.mjs';
import { HANDLERS, notFound, serverError } from '../lib/pages.mjs';
import { decodeParam } from '../lib/routes.mjs';

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
      ? await handle(lazySql(), {
        slug: decodeParam(url.searchParams.get('slug')),
        genre: decodeParam(url.searchParams.get('genre'))
      })
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
