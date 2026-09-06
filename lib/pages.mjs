// SSR 페이지 본문. 각 핸들러는 { status, headers, body } 를 돌려주고 HTTP 를 모른다.
// 그래서 Vercel 함수(api/page.js)와 로컬 서버(server.mjs)가 같은 코드를 쓴다.
import * as q from './queries.mjs';
import {
  SITE_NAME, config, layout, esc, escXml, num, won, isNum, formatDay, formatMoment, toIso,
  gamePath, genrePath, steamStoreUrl, safeImage, gameCell, reviewCell, priceCell,
  metaScoreCell, lineChart, emptyState, siteOrigin, adSlot, dataTable, COL
} from './render.mjs';
import { LEGAL_HANDLERS, staticDocPaths } from './legal.mjs';
// 계정 페이지가 쓰는 것만 가져온다. 이 파일은 여전히 HTTP 를 모른다 —
// '지금 누구인가'는 진입점(api/page.js · server.mjs)이 params.user 로 넘겨준다.
import * as accounts from './accounts.mjs';
import { MIN_PASSWORD, MAX_PASSWORD } from './accounts.mjs';

// 목록 페이지는 10분, 상세는 5분 CDN 캐시. 수집 주기가 10분이라 그보다 짧게 잡을 이유가 없고,
// stale-while-revalidate 덕분에 만료 순간에도 사용자는 기다리지 않는다.
const CACHE_LIST = 'public, max-age=0, s-maxage=600, stale-while-revalidate=3600';
const CACHE_DETAIL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=1800';
const CACHE_MISS = 'public, max-age=0, s-maxage=60';

const html = (body, { status = 200, cache = CACHE_LIST } = {}) => ({
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cache },
  body
});

const reviewTotal = row =>
  isNum(row?.total_positive) && isNum(row?.total_negative) ? row.total_positive + row.total_negative : null;

// 숫자 지표 한 칸. 값이 없으면 0 이 아니라 '아직 없음'을 적는다.
const metric = (label, value, sub) =>
  `<div class="metric"><span>${esc(label)}</span><strong>${value === null || value === undefined ? '<em class="missing">아직 없음</em>' : value}</strong>${sub ? `<small>${sub}</small>` : ''}</div>`;

const listSection = (title, note, inner) =>
  `<section class="panel"><div class="section-heading"><div class="title-group"><h2>${esc(title)}</h2></div>${note ? `<span class="section-note">${esc(note)}</span>` : ''}</div>${inner}</section>`;

// 목록에 7일 스파크라인을 붙인다. 행마다 질의하면 목록 하나에 왕복이 40번 나므로
// appid 를 모아 한 번만 묻는다. 표본이 없는 게임은 spark 가 null 로 남고,
// 화면은 빈 칸이 아니라 '표본 부족'이라고 적는다.
// 값과 함께 '그 값을 뭐라고 부를지'도 돌려준다. 적재 초기에는 일 롤업이 얇아서
// 시간 롤업으로 내려가는데, 그때 열 이름을 '7일 추이'로 두면 거짓말이 되기 때문이다.
async function withSparks(sql, rows, days = 7) {
  if (!rows.length) return { rows, sparkLabel: `${days}일 추이` };
  const { points, label } = await q.sparkSeries(sql, rows.map(row => row.appid), { days });
  return { rows: rows.map(row => ({ ...row, spark: points.get(row.appid) ?? null })), sparkLabel: label };
}

// 표는 전부 render.mjs 의 dataTable 로 만든다. 열 순서를 페이지마다 손으로 적으면
// 반드시 어긋나고, td 의 data-label 이 빠지면 좁은 화면의 카드가 라벨 없는 숫자 나열이 된다.

// =============================================================================
// 게임 상세 — /game/:appid-:slug
// =============================================================================

// URL 의 슬러그에서 appid 를 뽑는다. '730-counter-strike-2' 도 '730' 도 받는다.
export function parseGameSlug(slug) {
  const match = /^(\d{1,10})(?:-|$)/.exec(String(slug ?? ''));
  if (!match) return null;
  const appid = Number(match[1]);
  return Number.isSafeInteger(appid) && appid > 0 ? appid : null;
}

export async function gamePage(sql, { slug }) {
  const appid = parseGameSlug(slug);
  if (appid === null) return notFound('게임을 찾을 수 없습니다.');

  const [app] = await q.appById(sql, appid);
  if (!app) return notFound('게임을 찾을 수 없습니다.');

  // 정규 URL 로 모으지 않으면 같은 내용이 여러 주소로 색인돼 서로의 순위를 깎는다.
  const canonicalSlug = app.slug || String(app.appid);
  if (slug !== canonicalSlug) {
    return { status: 301, headers: { Location: gamePath(app.appid, canonicalSlug), 'Cache-Control': CACHE_LIST }, body: '' };
  }

  const genres = Array.isArray(app.genres) ? app.genres : [];
  const [hourly, daily, peak, low, trend, related] = await Promise.all([
    q.playerHourly(sql, appid, 7),
    q.playerDaily(sql, appid, 90),
    q.peakAllTime(sql, appid),
    q.priceLow(sql, appid),
    q.reviewTrend(sql, appid, 30),
    genres.length ? q.relatedByGenre(sql, appid, genres, 6) : Promise.resolve([])
  ]);

  const total = reviewTotal(app);
  const allTimePeak = peak[0] ?? null;

  // --- 차트: 시간 롤업이 우선, 표본이 얇으면 일 롤업으로 내려간다 -------------
  const hourFormatter = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: 'numeric' });
  let chart = null;
  let chartNote = '';
  if (hourly.length >= 2) {
    chart = lineChart(hourly.map(row => ({ y: row.avg_players, label: hourFormatter.format(new Date(row.bucket)) })), { label: '최근 7일 시간별 평균 동시접속자' });
    chartNote = `최근 7일 · 시간별 평균 · 표본 ${hourly.length}시간`;
  } else if (daily.length >= 2) {
    chart = lineChart(daily.map(row => ({ y: row.avg_players, label: formatDay(row.day) })), { label: '일별 평균 동시접속자' });
    chartNote = `일별 평균 · 표본 ${daily.length}일`;
  }

  const sampleHint = hourly.length + daily.length === 0
    ? '10분마다 동시접속자를 기록하고 있습니다. 첫 그래프는 두 시간 뒤부터 그려집니다.'
    : '표본이 쌓일수록 그래프가 촘촘해집니다.';

  // --- 최근 30일 신규 리뷰: 누적값의 차분이라 이틀 이상 쌓여야 의미가 생긴다 ---
  const t = trend[0] ?? null;
  const newReviews = t && t.samples >= 2 ? t.new_positive + t.new_negative : 0;
  const newRatio = newReviews > 0 ? Math.round((t.new_positive / newReviews) * 100) : null;

  const title = `${app.title} 동시접속자·가격 추이`;
  const descriptionParts = [
    isNum(app.players) ? `현재 동시접속자 ${num(app.players)}명` : null,
    allTimePeak ? `역대 최고 ${num(allTimePeak.peak_reported)}명` : null,
    isNum(app.positive_ratio) ? `Steam 평가 ${app.positive_ratio}%${total ? ` (리뷰 ${num(total)}개)` : ''}` : null,
    isNum(app.final_price) ? (app.final_price === 0 ? '무료 플레이' : `현재 ${won(app.final_price)}`) : null
  ].filter(Boolean);
  const description = `${app.title} — ${descriptionParts.join(' · ') || 'Steam 동시접속자와 가격을 추적합니다'}. Steam Pulse 가 10분마다 기록한 자체 시계열로 확인하세요.`;

  const image = safeImage(app.header_image);
  const heroImage = image
    ? `<img class="hero-image" src="${esc(image)}" alt="${esc(app.title)} 대표 이미지" width="460" height="215" fetchpriority="high" decoding="async">`
    : '';

  const genreLinks = genres.length
    ? `<p class="hero-genres">${genres.map(g => `<a href="${esc(genrePath(g))}">${esc(g)}</a>`).join('')}</p>`
    : '';

  const facts = [
    ['발매일', app.release_date ? formatDay(app.release_date) : app.release_date_text],
    ['개발사', app.developers?.length ? app.developers.join(', ') : null],
    ['배급사', app.publishers?.length ? app.publishers.join(', ') : null],
    ['메타크리틱', isNum(app.metacritic_score) ? `${app.metacritic_score} / 100` : null]
  ].filter(([, value]) => value);

  // --- 가격 ------------------------------------------------------------------
  let priceBlock;
  if (!isNum(app.final_price)) {
    priceBlock = emptyState('가격 정보를 아직 받지 못했습니다.', '상세 수집이 이 게임 차례에 도달하면 채워집니다.');
  } else if (app.final_price === 0) {
    priceBlock = `<p class="price-headline free">무료 플레이</p>`;
  } else {
    const now = app.price_formatted || won(app.final_price);
    const original = isNum(app.initial_price) && app.initial_price > app.final_price ? won(app.initial_price) : null;
    const isLow = low[0] && app.final_price <= low[0].final_price;
    priceBlock = `<p class="price-headline">${app.discount_percent > 0 ? `<span class="discount">-${app.discount_percent}%</span>` : ''}${esc(now)}` +
      `${original ? ` <span class="original-price">${esc(original)}</span>` : ''}</p>` +
      `<ul class="fact-list">` +
      `<li><span>역대 최저가</span><strong>${low[0] ? `${esc(won(low[0].final_price))}${isLow ? ' <em class="badge-low">지금이 최저가</em>' : ''}` : '<em class="missing">기록 없음</em>'}</strong></li>` +
      `<li><span>가격 확인 시각</span><strong>${esc(formatMoment(app.price_at) || '—')}</strong></li>` +
      `</ul>` +
      (low[0] ? '' : '<p class="muted">가격 변동은 관측한 시점부터 기록합니다. 기록이 없으면 아직 변동을 본 적이 없다는 뜻이지, 할인이 없었다는 뜻은 아닙니다.</p>');
  }

  // --- JSON-LD ---------------------------------------------------------------
  const origin = siteOrigin();
  const videoGame = {
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    name: app.title,
    url: `${origin}${gamePath(app.appid, canonicalSlug)}`,
    gamePlatform: 'PC',
    ...(image ? { image } : {}),
    ...(app.short_description ? { description: app.short_description } : {}),
    ...(genres.length ? { genre: genres } : {}),
    ...(app.release_date ? { datePublished: app.release_date } : {}),
    ...(app.developers?.length ? { author: app.developers.map(name => ({ '@type': 'Organization', name })) } : {}),
    ...(app.publishers?.length ? { publisher: app.publishers.map(name => ({ '@type': 'Organization', name })) } : {}),
    ...(isNum(app.positive_ratio) && total > 0
      ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: app.positive_ratio, bestRating: 100, worstRating: 0, ratingCount: total } }
      : {}),
    ...(isNum(app.final_price)
      ? {
        offers: {
          '@type': 'Offer',
          price: (app.final_price / 100).toFixed(0),
          priceCurrency: app.currency || 'KRW',
          availability: 'https://schema.org/InStock',
          url: steamStoreUrl(app.appid)
        }
      }
      : {})
  };

  const body = `
<article class="game-detail">
  <header class="hero">
    ${heroImage}
    <div class="hero-text">
      ${isNum(app.rank) ? `<div class="eyebrow"><span class="live-dot"></span> 현재 인기 ${app.rank}위</div>` : '<div class="eyebrow">STEAM PULSE</div>'}
      <h1>${esc(app.title)}</h1>
      ${app.short_description ? `<p class="hero-desc">${esc(app.short_description)}</p>` : ''}
      ${genreLinks}
      <p class="hero-actions">
        <a class="button primary" href="${esc(steamStoreUrl(app.appid))}" target="_blank" rel="noopener noreferrer">Steam 스토어에서 보기 ↗</a>
        <button class="button watch-button" type="button" data-watch="${app.appid}" aria-pressed="false" hidden><span aria-hidden="true">☆</span> <span class="watch-label">위시리스트에 담기</span></button>
      </p>
    </div>
  </header>

  <section class="metrics" aria-label="주요 지표">
    ${metric('현재 동시접속자', num(app.players), app.players_at ? esc(formatMoment(app.players_at)) : '')}
    ${metric('오늘 최고 동접', num(app.peak_today), 'Steam 제공')}
    ${metric('역대 최고 동접', allTimePeak ? num(allTimePeak.peak_reported) : null, allTimePeak ? esc(formatDay(allTimePeak.day)) : '기록 시작 이후')}
    ${metric('Steam 평가', isNum(app.positive_ratio) ? `<span class="review-score">${app.positive_ratio}%</span>` : null, total ? `리뷰 ${esc(num(total))}개` : '')}
  </section>

  ${listSection('동시접속자 추이', chartNote, chart || emptyState('그래프를 그릴 표본이 아직 부족합니다.', sampleHint))}

  <div class="two-col">
    ${listSection('가격', app.currency ? `${app.currency} · 한국 스토어` : '', priceBlock)}
    ${listSection('리뷰', '전체 언어 · 전체 구매 유형', `
      <ul class="fact-list">
        <li><span>누적 긍정률</span><strong>${isNum(app.positive_ratio) ? `${app.positive_ratio}%` : '<em class="missing">집계 전</em>'}</strong></li>
        <li><span>긍정 / 부정</span><strong>${isNum(app.total_positive) ? `${esc(num(app.total_positive))} / ${esc(num(app.total_negative))}` : '<em class="missing">집계 전</em>'}</strong></li>
        <li><span>Steam 표기</span><strong>${app.review_desc ? esc(app.review_desc) : '<em class="missing">—</em>'}</strong></li>
        <li><span>최근 30일 신규 리뷰</span><strong>${newReviews > 0 ? `${esc(num(newReviews))}개 · 긍정 ${newRatio}%` : '<em class="missing">차분 표본 부족</em>'}</strong></li>
      </ul>
      ${newReviews > 0
    // 리뷰 추이 페이지로 가는 링크는 **볼 게 있을 때만** 건다.
    // 차분 표본이 없으면 그 페이지도 빈 화면이라, 링크가 곧 실망이 된다.
    ? `<p><a class="button" href="${esc(gamePath(app.appid, canonicalSlug))}/reviews">리뷰 추이 자세히 보기</a></p>`
    : '<p class="muted">신규 리뷰 긍정률은 누적값의 차분이라 이틀 이상 기록이 쌓여야 계산됩니다.</p>'}
    `)}
  </div>

  ${facts.length ? listSection('게임 정보', '', `<ul class="fact-list">${facts.map(([k, v]) => `<li><span>${esc(k)}</span><strong>${esc(v)}</strong></li>`).join('')}</ul>`) : ''}

  ${related.length ? listSection('같은 장르의 인기작', genres.slice(0, 2).join(' · '), `<div class="card-grid">${related.map(row => `
    <a class="mini-card" href="${esc(gamePath(row.appid, row.slug))}">
      ${safeImage(row.header_image) ? `<img src="${esc(safeImage(row.header_image))}" alt="" width="96" height="47" loading="lazy" decoding="async">` : '<span class="game-image fallback" aria-hidden="true">▦</span>'}
      <span><strong>${esc(row.title)}</strong><small>${isNum(row.players) ? `${esc(num(row.players))}명 플레이 중` : '동접 미확인'}</small></span>
    </a>`).join('')}</div>`) : ''}

  ${priceAlertForm(app)}

  ${adSlot(process.env.ADSENSE_SLOT_DETAIL, { label: '광고', minHeight: 280 })}

  <section class="panel source-note">
    <h2>이 숫자는 어디서 왔나</h2>
    <p class="muted">동시접속자는 Steam 공개 차트를 10분마다 기록한 <strong>Steam Pulse 자체 시계열</strong>입니다. 가격과 리뷰는 Steam 스토어의 한국 지역 값이며, 게임마다 순서대로 갱신되므로 스토어와 최대 한 시간까지 차이가 날 수 있습니다. 구매 전 실제 가격을 확인하세요.</p>
    <p class="muted">마지막 갱신 — 동접 ${esc(formatMoment(app.players_at) || '기록 없음')} · 가격 ${esc(formatMoment(app.price_at) || '기록 없음')} · 리뷰 ${esc(formatMoment(app.reviews_at) || '기록 없음')}</p>
  </section>
</article>
<script type="module" src="/watch-button.js"></script>`;

  return html(layout({
    title: `${title} | ${SITE_NAME}`,
    description,
    path: gamePath(app.appid, canonicalSlug),
    image,
    jsonLd: [videoGame],
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: app.title }],
    body
  }), { cache: CACHE_DETAIL });
}

// =============================================================================
// 리뷰 추이 — /game/:slug/reviews
//
// 이 페이지가 존재하는 이유는 하나다. Steam 이 보여 주는 것은 **누적** 긍정률이고,
// 그 값은 출시 초의 평가에 영원히 끌려다닌다. 우리는 리뷰 누적값을 매일 적어 두므로
// 그 차분으로 "요즘 들어오는 리뷰"의 긍정률을 만들 수 있다 — 둘의 간격이 이야기다.
//
// 차분은 **저장된 이웃한 두 날 사이**로 계산한다. 수집이 하루 빠지면 그 구간은
// 이틀치가 한 행에 들어오는데, 없는 날을 0 으로 채워 이야기를 지어내는 것보다 낫다.
// =============================================================================

// 누적값의 차분. Steam 이 리뷰를 지우면 음수가 나오므로 0 으로 막는다.
export function reviewDeltas(series) {
  const out = [];
  for (let i = 1; i < series.length; i += 1) {
    const positive = Math.max((series[i].total_positive ?? 0) - (series[i - 1].total_positive ?? 0), 0);
    const negative = Math.max((series[i].total_negative ?? 0) - (series[i - 1].total_negative ?? 0), 0);
    const total = positive + negative;
    out.push({
      day: series[i].day,
      from: series[i - 1].day,
      positive,
      negative,
      total,
      // 그날 리뷰가 하나도 안 들어왔으면 0% 가 아니라 '없음'이다.
      ratio: total > 0 ? Math.round((positive / total) * 100) : null
    });
  }
  return out;
}

const ratioOf = row => {
  const total = (row.total_positive ?? 0) + (row.total_negative ?? 0);
  return total > 0 ? Math.round((row.total_positive / total) * 100) : null;
};

export async function gameReviewsPage(sql, { slug }) {
  const appid = parseGameSlug(slug);
  if (appid === null) return notFound('게임을 찾을 수 없습니다.');

  const [app] = await q.appById(sql, appid);
  if (!app) return notFound('게임을 찾을 수 없습니다.');

  const canonicalSlug = app.slug || String(app.appid);
  if (slug !== canonicalSlug) {
    return { status: 301, headers: { Location: `${gamePath(app.appid, canonicalSlug)}/reviews`, 'Cache-Control': CACHE_LIST }, body: '' };
  }

  const series = await q.reviewSeries(sql, appid, 180);
  const deltas = reviewDeltas(series).filter(row => row.total > 0);
  const path = `${gamePath(app.appid, canonicalSlug)}/reviews`;
  const total = reviewTotal(app);
  const cumulative = isNum(app.positive_ratio) ? app.positive_ratio : (series.length ? ratioOf(series[series.length - 1]) : null);

  // 표본이 얇으면 색인하지 않는다. 링크는 살려 둔다 — 404 로 만들면 나중에 데이터가 쌓여도
  // 그사이에 크롤러가 본 404 가 남는다.
  const thin = deltas.length < 2;

  // 최근 신규 리뷰 긍정률. 구간은 저장된 날짜 기준이라 '최근 30일'이 아니라
  // '최근 30개 구간'이다 — 그래서 화면에도 실제 기간을 함께 적는다.
  const recent = deltas.slice(-30);
  const recentPositive = recent.reduce((sum, row) => sum + row.positive, 0);
  const recentNegative = recent.reduce((sum, row) => sum + row.negative, 0);
  const recentTotal = recentPositive + recentNegative;
  const recentRatio = recentTotal > 0 ? Math.round((recentPositive / recentTotal) * 100) : null;
  const gap = isNum(recentRatio) && isNum(cumulative) ? recentRatio - cumulative : null;

  // 누적 긍정률 추이. 누적이라 완만하지만, 꺾이는 지점이 곧 사건이다.
  const chart = lineChart(
    series.map(row => ({ y: ratioOf(row), label: formatDay(row.day) })),
    { label: `${app.title} 누적 긍정률`, valueLabel: '%' }
  );

  // 판정 문구. 5%p 는 임의의 선이므로 '차이가 크다/작다'로만 말하고 단정하지 않는다.
  let verdict;
  if (!isNum(gap)) {
    verdict = '최근 구간에 들어온 리뷰가 아직 충분하지 않아 누적값과 비교할 수 없습니다.';
  } else if (gap >= 5) {
    verdict = `<strong>요즘 평이 더 좋습니다.</strong> 최근 들어온 리뷰의 긍정률(${recentRatio}%)이 누적 긍정률(${cumulative}%)보다 ${gap}%p 높습니다. 누적값은 출시 초의 평가를 계속 안고 가므로, 지금 이 게임의 상태는 누적 점수보다 낫다고 볼 근거가 있습니다.`;
  } else if (gap <= -5) {
    verdict = `<strong>최근 평가가 누적보다 낮습니다.</strong> 최근 들어온 리뷰의 긍정률(${recentRatio}%)이 누적 긍정률(${cumulative}%)보다 ${Math.abs(gap)}%p 낮습니다. 업데이트·가격 정책·서버 문제 등 최근에 생긴 일이 있는지 살펴볼 만합니다.`;
  } else {
    verdict = `최근 들어온 리뷰의 긍정률(${recentRatio}%)과 누적 긍정률(${cumulative}%)의 차이가 ${Math.abs(gap)}%p 로 크지 않습니다. 평가가 안정적이라는 뜻입니다.`;
  }

  const rows = [...deltas].reverse().slice(0, 30);
  const body = `
<article class="game-detail">
  <section class="page-intro">
    <div class="eyebrow">REVIEW TREND</div>
    <h1>${esc(app.title)} 리뷰 추이</h1>
    <p>Steam 이 보여 주는 긍정률은 <strong>출시 이후 전체</strong>의 누적값입니다. 이 페이지는 그 누적값을 매일 적어 둔 기록의 <strong>차분</strong>으로, 요즘 들어오는 리뷰만의 긍정률을 따로 계산합니다.</p>
    <p class="page-links"><a class="button" href="${esc(gamePath(app.appid, canonicalSlug))}">${esc(app.title)} 상세로</a> <a class="button" href="${esc(steamStoreUrl(app.appid))}" target="_blank" rel="noopener noreferrer">Steam 스토어 ↗</a></p>
  </section>

  <section class="metrics" aria-label="리뷰 지표">
    ${metric('누적 긍정률', isNum(cumulative) ? `<span class="review-score">${cumulative}%</span>` : null, total ? `리뷰 ${esc(num(total))}개` : '')}
    ${metric('최근 신규 긍정률', isNum(recentRatio) ? `<span class="review-score">${recentRatio}%</span>` : null, recentTotal ? `신규 ${esc(num(recentTotal))}개` : '차분 표본 부족')}
    ${metric('누적 대비', isNum(gap) ? `${gap > 0 ? '+' : ''}${gap}%p` : null, isNum(gap) ? '최근 − 누적' : '')}
    ${metric('기록 구간', deltas.length ? `${deltas.length}일` : null, deltas.length ? `${esc(formatDay(deltas[0].from) || '')} 이후` : '수집 시작 다음 날부터')}
  </section>

  ${listSection('누적 긍정률 추이', series.length ? `표본 ${series.length}일` : '',
    chart || emptyState('그래프를 그릴 표본이 아직 부족합니다.', '리뷰는 하루 한 번 기록합니다. 첫 그래프는 이틀치가 쌓인 뒤부터 그려집니다.'))}

  ${listSection('무엇이 달라졌나', '', `<p>${verdict}</p>`)}

  ${rows.length ? listSection('일자별 신규 리뷰', '최신순 · 최대 30구간', dataTable(
    [
      { label: '기간', cellClass: 'game-cell', cell: row => `${esc(formatDay(row.day))}${row.from !== row.day ? `<span class="cell-sub">${esc(formatDay(row.from))} 이후</span>` : ''}` },
      { label: '신규 리뷰', headClass: 'numeric', cellClass: 'numeric', cell: row => `<span class="player-number">${esc(num(row.total))}</span>` },
      { label: '긍정', headClass: 'numeric', cellClass: 'numeric peak-number', cell: row => esc(num(row.positive)) },
      { label: '부정', headClass: 'numeric', cellClass: 'numeric peak-number', cell: row => esc(num(row.negative)) },
      { label: '그 구간 긍정률', headClass: 'numeric', cellClass: 'numeric', cell: row => (isNum(row.ratio) ? `<span class="review-score ${row.ratio >= 75 ? '' : row.ratio >= 50 ? 'mixed' : 'negative'}">${row.ratio}%</span>` : '<span class="missing">—</span>') }
    ],
    rows
  ) + '<p class="muted table-footnote">각 행은 <b>저장된 두 기록 사이</b>의 차이입니다. 수집이 하루 빠지면 그 구간은 이틀치를 담습니다 — 없는 날을 0 으로 채워 넣지 않기 때문입니다. Steam 은 이미 쓴 리뷰를 지울 수도 있어 차분이 음수가 될 수 있는데, 그런 구간은 0 으로 처리합니다.</p>')
    : listSection('일자별 신규 리뷰', '', emptyState('아직 비교할 구간이 없습니다.',
      '리뷰 누적값을 하루 한 번 기록합니다. 첫 구간은 기록이 이틀 쌓인 뒤에 생깁니다.'))}

  <section class="panel source-note">
    <h2>이 숫자는 어디서 왔나</h2>
    <p class="muted">누적 긍정률과 리뷰 수는 Steam 이 공개한 전체 언어·전체 구매 유형 기준 값입니다. 신규 리뷰 긍정률은 그 누적값을 저희가 매일 기록해 두고 <strong>차분한 결과</strong>이므로, Steam 화면에는 없는 숫자입니다. 마지막 리뷰 갱신 — ${esc(formatMoment(app.reviews_at) || '기록 없음')}.</p>
  </section>
</article>`;

  return html(layout({
    title: `${app.title} 리뷰 추이 — 최근 평가는 어떤가 | ${SITE_NAME}`,
    description: `${app.title} 의 누적 긍정률${isNum(cumulative) ? ` ${cumulative}%` : ''}과 최근 들어온 리뷰만의 긍정률${isNum(recentRatio) ? ` ${recentRatio}%` : ''}을 비교합니다. Steam 이 보여 주지 않는 평가 추이입니다.`,
    path,
    image: safeImage(app.header_image),
    noindex: thin,
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: app.title, href: gamePath(app.appid, canonicalSlug) }, { label: '리뷰 추이' }],
    body
  }), { cache: CACHE_DETAIL });
}

// =============================================================================
// 급상승 — /rising
// =============================================================================

// 적재 초기에는 8일치 시간 롤업이 없다. 넓은 창부터 시도해 결과가 나오는 창에서 멈추고,
// 실제로 사용한 창을 화면에 적는다. "24시간 대비"라고 써 놓고 3시간을 비교하면 거짓말이 된다.
export const RISING_WINDOWS = [
  { recentHours: 24, pastHours: 192, minPlayers: 1000, label: '최근 24시간 평균 vs 직전 7일 평균' },
  { recentHours: 12, pastHours: 72, minPlayers: 500, label: '최근 12시간 평균 vs 직전 3일 평균' },
  { recentHours: 3, pastHours: 24, minPlayers: 200, label: '최근 3시간 평균 vs 직전 24시간 평균' }
];

export async function risingPage(sql) {
  let rows = [];
  let used = RISING_WINDOWS[RISING_WINDOWS.length - 1];
  for (const window of RISING_WINDOWS) {
    rows = await q.rising(sql, window);
    used = window;
    if (rows.length >= 5) break;
  }
  const { rows: sparked, sparkLabel } = await withSparks(sql, rows);
  rows = sparked;

  const body = rows.length
    ? dataTable(
      [
        COL.rank('순위'),
        COL.game(),
        { label: '증가율', headClass: 'numeric', cellClass: 'numeric', cell: row => `<span class="change-up">+${esc(row.change_pct?.toFixed(1))}%</span>` },
        { label: '현재 구간 평균', headClass: 'numeric', cellClass: 'numeric', cell: row => `<span class="player-number">${esc(num(row.now_players))}</span>` },
        { label: '직전 구간 평균', headClass: 'numeric', cellClass: 'numeric peak-number', cell: row => esc(num(row.past_players)) },
        COL.spark(sparkLabel),
        COL.review()
      ],
      rows
    ) + `<p class="muted table-footnote">비교 구간 — ${esc(used.label)}. 직전 구간 평균 ${esc(num(used.minPlayers))}명 이상인 게임만 포함합니다.</p>`
    : emptyState('아직 비교할 구간이 없습니다.',
      '급상승은 두 시간대의 평균을 비교해 계산합니다. 동시접속자 기록이 최소 몇 시간은 쌓여야 첫 순위가 나옵니다.');

  return html(layout({
    title: `급상승 게임 — 동시접속자가 오르고 있는 스팀 게임 | ${SITE_NAME}`,
    description: '동시접속자가 직전 구간보다 빠르게 늘고 있는 스팀 게임 순위. Steam Pulse 가 10분마다 기록한 자체 시계열로 계산합니다.',
    path: '/rising',
    active: '/rising',
    image: safeImage(rows[0]?.header_image),
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '급상승' }],
    body: `<section class="page-intro"><div class="eyebrow"><span class="live-dot"></span> RISING</div><h1>지금 오르고 있는 게임</h1><p>Steam 순위는 '많이 하는 게임'을 보여 줍니다. 이 페이지는 <strong>빠르게 늘고 있는 게임</strong>을 보여 줍니다 — 두 시간대의 평균 동시접속자를 직접 비교해 만든, Steam 이 제공하지 않는 순위입니다.</p></section>${body}`
  }));
}

// =============================================================================
// 할인 — /deals
// =============================================================================

export async function dealsPage(sql) {
  const rows = await q.deals(sql, { minRatio: 75, limit: 40 });

  const body = rows.length
    ? dataTable(
      [
        COL.game(),
        { label: '할인', headClass: 'numeric', cellClass: 'numeric', cell: row => `<span class="discount">-${row.discount_percent}%</span>${row.at_lowest ? '<span class="cell-sub badge-low">역대 최저가</span>' : ''}` },
        COL.price(),
        COL.review(),
        COL.meta(),
        COL.players()
      ],
      rows
    ) + '<p class="muted table-footnote">Steam 긍정률이 75% 미만인 할인은 제외했습니다. 아직 평가를 수집하지 못한 게임은 <b>집계 전</b>으로 표시되며 목록 뒤쪽에 놓입니다 — 평가가 나쁘다는 뜻이 아닙니다. 역대 최저가 판정은 Steam Pulse 가 기록을 시작한 이후의 최저가 기준이라, 그 이전에 더 쌌던 적이 있을 수 있습니다. 가격은 한국 스토어 기준이며 구매 전 실제 가격을 확인하세요.</p>'
    : emptyState('지금 조건에 맞는 할인이 없습니다.',
      '평가 75% 이상 + 할인 중인 게임만 싣습니다. 가격은 게임마다 순서대로 확인하므로 전체를 한 바퀴 도는 데 시간이 걸립니다.');

  return html(layout({
    title: `할인 중인 고평가 게임 — Steam 평가 75% 이상 | ${SITE_NAME}`,
    description: 'Steam 긍정률 75% 이상인 게임 중 지금 할인 중인 목록. 역대 최저가 여부까지 함께 확인하세요.',
    path: '/deals',
    active: '/deals',
    image: safeImage(rows[0]?.header_image),
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '할인' }],
    body: `<section class="page-intro"><div class="eyebrow">DEALS</div><h1>할인 중인 고평가 게임</h1><p>할인율만 높은 게임은 걸러냈습니다. <strong>Steam 긍정률 75% 이상</strong>인 게임만 싣고, 우리가 기록한 가격 이력으로 <strong>지금이 역대 최저가인지</strong> 함께 표시합니다.</p></section>${body}`
  }));
}

// =============================================================================
// 기간 차트 — /charts/weekly · /charts/monthly
//
// 두 페이지는 창(7일/30일)만 다르고 나머지가 같다. 같은 표를 두 번 적으면
// 한쪽만 고치는 사고가 반드시 나므로 정의를 한곳에 모은다.
// =============================================================================

export const CHART_VIEWS = {
  weekly: {
    days: 7, path: '/charts/weekly', eyebrow: 'WEEKLY', word: '주간',
    heading: '주간 인기 게임',
    title: '주간 인기 게임 차트 — 7일 평균 동시접속자',
    description: '최근 7일 평균 동시접속자 기준 스팀 인기 게임 순위. 하루짜리 이벤트에 흔들리지 않는 주간 차트입니다.',
    lead: "지금 이 순간의 순위는 시간대와 이벤트에 크게 흔들립니다. 이 차트는 <strong>최근 7일 평균 동시접속자</strong>로 줄을 세워, 한 주 동안 실제로 가장 많이 플레이된 게임을 보여 줍니다.",
    other: { href: '/charts/monthly', label: '30일 평균으로 보기' }
  },
  monthly: {
    days: 30, path: '/charts/monthly', eyebrow: 'MONTHLY', word: '월간',
    heading: '월간 인기 게임',
    title: '월간 인기 게임 차트 — 30일 평균 동시접속자',
    description: '최근 30일 평균 동시접속자 기준 스팀 인기 게임 순위. 한 달 내내 사람이 남아 있는 게임과 잠깐 몰렸다 빠진 게임이 갈립니다.',
    lead: "출시 주에 몰렸다가 빠지는 게임과, 한 달 내내 사람이 남아 있는 게임은 다릅니다. 이 차트는 <strong>최근 30일 평균 동시접속자</strong>로 줄을 세워 그 둘을 갈라 놓습니다.",
    other: { href: '/charts/weekly', label: '7일 평균으로 보기' }
  }
};

async function chartsPage(sql, view) {
  const { rows, sparkLabel } = await withSparks(sql, await q.weekly(sql, { days: view.days, limit: 50 }));
  const covered = rows.length ? Math.max(...rows.map(row => row.days)) : 0;

  const body = rows.length
    ? dataTable(
      [
        COL.rank(),
        COL.game(),
        { label: `${view.word} 평균 동접`, headClass: 'numeric', cellClass: 'numeric', cell: row => `<span class="player-number">${esc(num(row.avg_players))}</span><span class="cell-sub">${row.days}일 집계</span>` },
        { label: '기간 내 최고', headClass: 'numeric', cellClass: 'numeric peak-number', cell: row => esc(num(row.peak_players)) },
        COL.spark(sparkLabel),
        { label: '현재 순위', headClass: 'numeric', cellClass: 'numeric', cell: row => (isNum(row.current_rank) ? `${row.current_rank}위` : '<span class="missing">차트 밖</span>') },
        COL.review()
      ],
      rows
    ) + `<p class="muted table-footnote">최근 ${covered}일치 일별 평균을 집계했습니다. ${view.days}일이 모두 쌓이기 전에는 그만큼의 기간만 반영됩니다. 표본 일수가 적은 게임은 그만큼 평균이 거칠다는 뜻이므로 '${view.days}일 집계'가 아닌 행은 함께 감안해 주세요.</p>`
    : emptyState(`${view.word} 집계가 아직 없습니다.`,
      '일 롤업은 매일 새벽 한 번 계산됩니다. 첫 순위는 수집 시작 다음 날부터 나옵니다.');

  return html(layout({
    title: `${view.title} | ${SITE_NAME}`,
    description: view.description,
    path: view.path,
    active: view.path,
    image: safeImage(rows[0]?.header_image),
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: `${view.word} 차트` }],
    body: `<section class="page-intro"><div class="eyebrow">${esc(view.eyebrow)}</div><h1>${esc(view.heading)}</h1><p>${view.lead}</p>` +
      `<p class="page-links"><a class="button" href="${esc(view.other.href)}">${esc(view.other.label)}</a> <a class="button" href="/rising">급상승 보기</a></p></section>${body}`
  }));
}

export const weeklyPage = sql => chartsPage(sql, CHART_VIEWS.weekly);
export const monthlyPage = sql => chartsPage(sql, CHART_VIEWS.monthly);

// =============================================================================
// 역대 최저가 — /deals/all-time-low
//
// /deals 가 '지금 할인 중 + 평가 좋은 것'이라면 여기는 '우리가 본 것 중 가장 싼 지금'이다.
// 가격 변경을 두 번 이상 본 게임만 싣는다 — 쿼리 주석 참고.
// =============================================================================

export async function dealsLowPage(sql) {
  const rows = await q.allTimeLows(sql, { limit: 40 });

  const body = rows.length
    ? dataTable(
      [
        COL.game(),
        { label: '할인', headClass: 'numeric', cellClass: 'numeric', cell: row => `<span class="discount">-${row.discount_percent}%</span>` },
        { label: '현재가 = 최저가', headClass: 'numeric price-column', cellClass: 'numeric price-column', cell: row => `${priceCell(row)}<span class="cell-sub badge-low">역대 최저가</span>` },
        { label: '정가', headClass: 'numeric', cellClass: 'numeric', cell: row => (isNum(row.initial_price) ? `<span class="original-price">${esc(won(row.initial_price))}</span>` : '<span class="missing">—</span>') },
        COL.review(),
        { label: '관측', headClass: 'numeric', cellClass: 'numeric peak-number', cell: row => `${row.observations}회<span class="cell-sub">${esc(formatMoment(row.first_seen)?.slice(0, 12) || '')}부터</span>` }
      ],
      rows
    ) + '<p class="muted table-footnote">여기서 <b>역대</b>는 Steam Pulse 가 기록을 시작한 이후입니다. 그 이전에 더 쌌던 적이 있을 수 있습니다. 가격 변동을 <b>두 번 이상</b> 관측한 게임만 싣습니다 — 한 번밖에 못 본 가격은 자동으로 최저가가 되어 버려 아무것도 알려 주지 못하기 때문입니다. 가격은 한국 스토어 기준이며 구매 전 실제 가격을 확인하세요.</p>'
    : emptyState('아직 역대 최저가로 판정할 게임이 없습니다.',
      '가격은 변동이 있을 때만 기록합니다. 판정하려면 한 게임의 가격이 최소 두 번 바뀌는 것을 봐야 하므로, 첫 목록은 세일이 한 번 돌고 난 뒤에 생깁니다.');

  return html(layout({
    title: `역대 최저가 스팀 게임 — 지금이 가장 쌉니다 | ${SITE_NAME}`,
    description: 'Steam Pulse 가 기록한 가격 이력에서, 지금 가격이 관측 이래 가장 낮은 게임만 모았습니다. 할인율이 아니라 실제 최저가 여부로 고른 목록입니다.',
    path: '/deals/all-time-low',
    active: '/deals',
    image: safeImage(rows[0]?.header_image),
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '할인', href: '/deals' }, { label: '역대 최저가' }],
    body: `<section class="page-intro"><div class="eyebrow">ALL-TIME LOW</div><h1>지금이 역대 최저가</h1><p>할인율 숫자는 정가를 어떻게 매겼느냐에 따라 얼마든지 커집니다. 이 목록은 다릅니다 — <strong>우리가 직접 기록한 가격 이력</strong>에서 지금 값이 가장 낮은 게임만 골랐습니다.</p><p class="page-links"><a class="button" href="/deals">할인 전체 보기</a></p></section>${body}`
  }));
}

// =============================================================================
// 장르 — /genre · /genre/:genre · /genre/:genre/free · /genre/:genre/discounted
// =============================================================================

// 조합 페이지(무료·할인)의 최소 게임 수. 이보다 적으면 페이지를 만들지 않는다.
// 내용이 얇은 URL 을 색인에 흘리면 사이트 전체의 품질 평가가 내려간다 —
// URL 을 늘리는 것보다 얇은 URL 을 만들지 않는 쪽이 이득이다.
export const MIN_COMBO_GAMES = 5;

export async function genresPage(sql) {
  const rows = await q.genreList(sql, 60);
  const body = rows.length
    ? `<div class="genre-grid">${rows.map(row => `<a class="genre-tile" href="${esc(genrePath(row.genre))}"><strong>${esc(row.genre)}</strong><small>${row.games}개 게임</small></a>`).join('')}</div>`
    : emptyState('장르 정보가 아직 없습니다.', '장르는 게임 상세 수집이 채웁니다.');

  return html(layout({
    title: `장르별 스팀 인기 게임 | ${SITE_NAME}`,
    description: '액션, RPG, 전략 등 장르별로 지금 가장 많이 플레이되는 스팀 게임을 확인하세요.',
    path: '/genre',
    active: '/genre',
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '장르' }],
    body: `<section class="page-intro"><div class="eyebrow">GENRES</div><h1>장르별로 찾기</h1><p>지금 인기 차트에 올라 있는 게임들을 장르로 묶었습니다.</p><p class="page-links"><a class="button" href="/releases">발매 연도별로 보기</a></p></section><section class="panel">${body}</section>`
  }));
}

// 장르·연도 목록이 공유하는 표. 열 구성이 같아야 페이지를 오갈 때 눈이 헤매지 않는다.
const listingTable = (rows, { showRelease = false, sparkLabel = '7일 추이' } = {}) => dataTable(
  [
    COL.rank(),
    COL.game(),
    showRelease
      ? { label: '발매일', headClass: 'numeric', cellClass: 'numeric', cell: row => (row.release_date ? esc(formatDay(row.release_date)) : '<span class="missing">미상</span>') }
      : COL.players(),
    COL.spark(sparkLabel),
    COL.review(),
    COL.meta(),
    COL.price()
  ],
  rows
);

// 조합 페이지로 가는 링크는 **그 페이지가 실제로 존재할 때만** 그린다.
// 세는 쿼리를 따로 돌리지 않고 이미 받아 온 목록에서 센다 — 링크와 페이지의 판정 기준이 같아야
// "눌렀더니 404" 가 생기지 않는다.
// 장르 목록의 상한. 조합 페이지도 같은 값을 쓴다.
const GENRE_LIMIT = 60;

// 조합 페이지로 가는 링크. 판정 조건은 queries.mjs 의 genreFreeGames / genreDiscountedGames 와
// **글자 그대로** 같아야 한다 — 한쪽만 고치면 링크와 목록이 어긋난다.
//
// 개수는 이미 받아 온 60개 안에서 센 것이라, 장르에 게임이 60개를 넘으면 실제보다 적게 나온다.
// 그래서 목록이 상한에 닿았을 때는 숫자를 아예 적지 않는다 — 틀린 숫자보다 없는 편이 낫다.
const comboLinks = (name, rows) => {
  const truncated = rows.length >= GENRE_LIMIT;
  const label = (text, count) => (truncated ? text : `${text} ${count}개`);
  const free = rows.filter(row => row.is_free === true || row.final_price === 0).length;
  const discounted = rows.filter(row => isNum(row.discount_percent) && row.discount_percent > 0 && isNum(row.final_price)).length;
  const links = [
    free >= MIN_COMBO_GAMES ? `<a class="button" href="${esc(genrePath(name))}/free">${label('무료', free)}</a>` : '',
    discounted >= MIN_COMBO_GAMES ? `<a class="button" href="${esc(genrePath(name))}/discounted">${label('할인 중', discounted)}</a>` : '',
    '<a class="button" href="/genre">다른 장르</a>'
  ].filter(Boolean);
  return `<p class="page-links">${links.join(' ')}</p>`;
};

export async function genrePage(sql, { genre }) {
  const name = String(genre ?? '').slice(0, 60);
  if (!name) return notFound('장르를 찾을 수 없습니다.');

  const found = await q.genreGames(sql, name, GENRE_LIMIT);
  if (!found.length) return notFound(`'${name}' 장르에 해당하는 게임이 아직 없습니다.`);
  const { rows, sparkLabel } = await withSparks(sql, found);

  const players = rows.filter(row => isNum(row.players));

  return html(layout({
    title: `${name} 장르 인기 게임 — 동시접속자 순 | ${SITE_NAME}`,
    description: `${name} 장르에서 지금 가장 많이 플레이되는 스팀 게임 ${rows.length}개. 동시접속자, Steam 평가, 가격을 함께 비교하세요.`,
    path: genrePath(name),
    active: '/genre',
    image: safeImage(rows[0]?.header_image),
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '장르', href: '/genre' }, { label: name }],
    body: `<section class="page-intro"><div class="eyebrow">GENRE</div><h1>${esc(name)}</h1><p>${esc(name)} 장르 ${rows.length}개 게임을 현재 동시접속자 순으로 정렬했습니다.${players.length ? ` 지금 이 장르에서 ${esc(num(players.reduce((sum, row) => sum + row.players, 0)))}명이 플레이 중입니다.` : ''}</p>${comboLinks(name, rows)}</section>${listingTable(rows, { sparkLabel })}`
  }));
}

// 장르 조합 페이지 둘은 쿼리와 문구만 다르고 뼈대가 같다.
async function genreListing(sql, genre, view) {
  const name = String(genre ?? '').slice(0, 60);
  if (!name) return notFound('장르를 찾을 수 없습니다.');

  const found = await view.fetch(sql, name);
  if (found.length < MIN_COMBO_GAMES) return notFound(view.thin(name));
  const { rows, sparkLabel } = await withSparks(sql, found);

  const players = rows.filter(row => isNum(row.players));
  const playing = players.length
    ? ` 이 목록에서 지금 ${esc(num(players.reduce((sum, row) => sum + row.players, 0)))}명이 플레이 중입니다.` : '';

  return html(layout({
    title: `${view.title(name)} | ${SITE_NAME}`,
    description: view.description(name, rows.length),
    path: view.path(name),
    active: '/genre',
    image: safeImage(rows[0]?.header_image),
    breadcrumb: view.breadcrumb(name),
    body: `<section class="page-intro"><div class="eyebrow">${esc(view.eyebrow)}</div><h1>${esc(view.heading(name))}</h1>` +
      `<p>${view.lead(name, rows.length)}${playing}</p>${view.links(name)}</section>` +
      listingTable(rows, { sparkLabel }) + `<p class="muted table-footnote">${view.footnote}</p>`
  }));
}

const GENRE_FREE = {
  eyebrow: 'FREE TO PLAY',
  fetch: (sql, name) => q.genreFreeGames(sql, name, GENRE_LIMIT),
  path: name => `${genrePath(name)}/free`,
  heading: name => `무료 ${name} 게임`,
  title: name => `무료 ${name} 게임 — 지금 바로 시작할 수 있는 것들`,
  description: (name, n) => `결제 없이 지금 시작할 수 있는 ${name} 장르 스팀 게임 ${n}개. 동시접속자와 Steam 평가로 실제로 사람이 있는 게임을 고르세요.`,
  lead: (name, n) => `무료로 시작할 수 있는 <strong>${esc(name)}</strong> 게임 ${n}개입니다. 무료라도 사람이 없으면 매칭이 잡히지 않으므로, 동시접속자를 함께 보고 고르세요.`,
  links: name => `<p class="page-links"><a class="button" href="${esc(genrePath(name))}">${esc(name)} 전체</a> <a class="button" href="/genre">다른 장르</a></p>`,
  footnote: '무료 판정은 Steam 이 <b>무료 플레이</b>로 표시했거나 한국 스토어 가격이 0원인 경우입니다. 게임 내 결제 여부는 판정에 넣지 않았습니다.',
  thin: name => `'${name}' 장르에는 아직 무료 게임이 충분히 모이지 않았습니다.`,
  breadcrumb: name => [{ label: '인기 차트', href: '/' }, { label: '장르', href: '/genre' }, { label: name, href: genrePath(name) }, { label: '무료' }]
};

const GENRE_DISCOUNTED = {
  eyebrow: 'ON SALE',
  fetch: (sql, name) => q.genreDiscountedGames(sql, name, GENRE_LIMIT),
  path: name => `${genrePath(name)}/discounted`,
  heading: name => `할인 중인 ${name} 게임`,
  title: name => `할인 중인 ${name} 게임 — 지금 세일 중인 목록`,
  description: (name, n) => `지금 할인 중인 ${name} 장르 스팀 게임 ${n}개. 할인율과 Steam 평가를 함께 놓고 비교하세요.`,
  lead: (name, n) => `지금 할인 중인 <strong>${esc(name)}</strong> 게임 ${n}개를 할인율 순으로 놓았습니다.`,
  links: name => `<p class="page-links"><a class="button" href="${esc(genrePath(name))}">${esc(name)} 전체</a> <a class="button" href="/deals/all-time-low">역대 최저가</a></p>`,
  footnote: '한국 스토어 기준이며, 게임마다 순서대로 가격을 확인하므로 스토어와 최대 한 시간까지 차이가 날 수 있습니다. 구매 전 실제 가격을 확인하세요.',
  thin: name => `'${name}' 장르에는 지금 할인 중인 게임이 충분하지 않습니다.`,
  breadcrumb: name => [{ label: '인기 차트', href: '/' }, { label: '장르', href: '/genre' }, { label: name, href: genrePath(name) }, { label: '할인' }]
};

export const genreFreePage = (sql, { genre }) => genreListing(sql, genre, GENRE_FREE);
export const genreDiscountedPage = (sql, { genre }) => genreListing(sql, genre, GENRE_DISCOUNTED);

// =============================================================================
// 발매 연도 — /releases · /releases/:year
//
// apps.release_date 는 수집이 이미 파싱해 둔 DATE 다. 파싱에 실패한 앱은 NULL 이라
// 목록에서 자동으로 빠진다 — 원문(release_date_text)으로 억지 추정하지 않는다.
// =============================================================================

export async function releasesPage(sql) {
  const rows = await q.releaseYears(sql, 40);

  const body = rows.length
    ? `<div class="genre-grid">${rows.map(row => `<a class="genre-tile" href="/releases/${row.year}"><strong>${row.year}년</strong><small>${row.games}개 게임</small></a>`).join('')}</div>`
    : emptyState('발매 연도 정보가 아직 없습니다.', '발매일은 게임 상세 수집이 채웁니다. 상세는 게임마다 순서대로 돌기 때문에 전체를 한 바퀴 도는 데 시간이 걸립니다.');

  return html(layout({
    title: `발매 연도별 스팀 인기 게임 | ${SITE_NAME}`,
    description: '어느 해에 나온 게임이 지금도 사람을 붙잡고 있는지 연도별로 확인하세요. 발매 연도별 동시접속자와 Steam 평가.',
    path: '/releases',
    active: '/genre',
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '발매 연도' }],
    body: `<section class="page-intro"><div class="eyebrow">RELEASES</div><h1>발매 연도별로 찾기</h1><p>올해 나온 게임만 사람이 많은 것은 아닙니다. 10년 전 게임이 지금도 상위권에 있는지, 어느 해가 유독 오래가는 게임을 냈는지 확인해 보세요.</p><p class="page-links"><a class="button" href="/genre">장르별로 보기</a></p></section><section class="panel">${body}</section>`
  }));
}

export async function releasePage(sql, { year }) {
  const parsed = Number(String(year ?? '').trim());
  // 연도는 네 자리 숫자만 받는다. 라우트 패턴이 이미 막지만 핸들러가 직접 불릴 수도 있다.
  if (!Number.isInteger(parsed) || parsed < 1990 || parsed > 2100) return notFound('연도를 찾을 수 없습니다.');

  const found = await q.releaseYearGames(sql, parsed, 60);
  if (!found.length) return notFound(`${parsed}년에 발매된 게임이 아직 목록에 없습니다.`);
  const { rows, sparkLabel } = await withSparks(sql, found);

  const players = rows.filter(row => isNum(row.players));

  return html(layout({
    title: `${parsed}년 발매 스팀 게임 — 지금도 사람이 있는가 | ${SITE_NAME}`,
    description: `${parsed}년에 발매된 스팀 게임 ${rows.length}개와 지금의 동시접속자·평가·가격. 그해의 게임이 지금도 플레이되는지 확인하세요.`,
    path: `/releases/${parsed}`,
    active: '/genre',
    image: safeImage(rows[0]?.header_image),
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '발매 연도', href: '/releases' }, { label: `${parsed}년` }],
    body: `<section class="page-intro"><div class="eyebrow">RELEASED ${parsed}</div><h1>${parsed}년에 나온 게임</h1>` +
      `<p>${parsed}년 발매작 ${rows.length}개입니다.${players.length ? ` 그중 ${players.length}개는 <strong>지금도 사람이 접속해 있고</strong>, 합쳐서 ${esc(num(players.reduce((sum, row) => sum + row.players, 0)))}명이 플레이 중입니다.` : ' 지금 접속자가 잡힌 게임은 없습니다.'}</p>` +
      `<p class="page-links"><a class="button" href="/releases">다른 연도</a> <a class="button" href="/genre">장르별로 보기</a></p></section>` +
      listingTable(rows, { showRelease: true, sparkLabel }) +
      '<p class="muted table-footnote">발매일은 Steam 스토어가 준 값을 파싱한 것이며, 원문 형식이 지역·언어마다 달라 파싱하지 못한 게임은 이 목록에 없습니다. 얼리 액세스 게임은 정식 출시일이 아니라 최초 공개일로 잡힐 수 있습니다.</p>'
  }));
}

// =============================================================================
// 수집 상태 — /status
//
// 데이터를 파는 사이트가 아니라 데이터를 **기록하는** 사이트라면, 그 기록이 어떤
// 상태인지 감추지 않는 편이 낫다. 그래프가 끊겼을 때 "왜 끊겼지" 하는 사람에게
// 답할 곳이 여기 하나뿐이다(docs/PRODUCT.md §2-1).
//
// 숨기고 싶은 숫자(결손 구간, 죽은 앱)를 특히 그대로 적는다. 좋을 때만 공개하는
// 상태 페이지는 상태 페이지가 아니다.
// =============================================================================

// 10분 간격이므로 하루에 144번이 만점이다.
export const TICKS_PER_DAY = 144;

export async function statusPage(sql) {
  const [[status], jobs, gaps] = await Promise.all([
    q.collectionStatus(sql),
    q.jobStatus(sql),
    q.snapshotGaps(sql, { hours: 24, minutes: 20 })
  ]);

  const ticks = status?.ticks_24h ?? 0;
  const coverage = Math.round((ticks / TICKS_PER_DAY) * 1000) / 10;
  const staleMinutes = status?.latest_snapshot
    ? Math.round((Date.now() - new Date(status.latest_snapshot).getTime()) / 60_000) : null;
  // 상세 수집은 라운드로빈이다. 가장 오래 안 본 앱의 시각이 곧 '한 바퀴' 길이다.
  const cycleHours = status?.oldest_detail
    ? Math.round(((Date.now() - new Date(status.oldest_detail).getTime()) / 3_600_000) * 10) / 10 : null;

  const jobRows = jobs.length
    ? dataTable(
      [
        { label: '잡', cellClass: 'game-cell', cell: row => `<strong>${esc(row.job)}</strong>` },
        {
          label: '마지막 결과',
          cell: row => {
            const tone = row.last_status === 'error' ? 'negative' : row.last_status === 'running' ? 'mixed' : '';
            return `<span class="review-score ${tone}">${esc(row.last_status ?? '—')}</span>`;
          }
        },
        { label: '마지막 실행', headClass: 'numeric', cellClass: 'numeric', cell: row => esc(formatMoment(row.last_run) || '—') },
        { label: '마지막 성공', headClass: 'numeric', cellClass: 'numeric', cell: row => esc(formatMoment(row.last_ok) || '기록 없음') },
        { label: '24시간 실행', headClass: 'numeric', cellClass: 'numeric', cell: row => `${row.runs_24h}회` },
        {
          label: '24시간 실패',
          headClass: 'numeric',
          cellClass: 'numeric',
          cell: row => (row.errors_24h > 0 ? `<span class="review-score negative">${row.errors_24h}회</span>` : '0회')
        }
      ],
      jobs
    )
    : emptyState('실행 기록이 아직 없습니다.', '수집이 한 번 돌면 여기에 남습니다.');

  const gapRows = gaps.length
    ? dataTable(
      [
        { label: '구간 시작', cellClass: 'game-cell', cell: row => esc(formatMoment(row.from_at) || '—') },
        { label: '다시 기록된 시각', cell: row => esc(formatMoment(row.to_at) || '—') },
        { label: '벌어진 시간', headClass: 'numeric', cellClass: 'numeric', cell: row => `<span class="review-score ${row.minutes > 60 ? 'negative' : 'mixed'}">${row.minutes}분</span>` },
        { label: '빠진 기록', headClass: 'numeric', cellClass: 'numeric', cell: row => `약 ${Math.max(Math.round(row.minutes / 10) - 1, 1)}회` }
      ],
      gaps
    )
    : '<p class="muted">최근 24시간에는 20분 넘게 벌어진 구간이 없습니다.</p>';

  const body = `
<section class="page-intro">
  <div class="eyebrow"><span class="live-dot"></span> PIPELINE STATUS</div>
  <h1>수집 상태</h1>
  <p>이 사이트의 숫자는 전부 <strong>10분마다 저희가 직접 기록한 것</strong>입니다. 그 기록이 지금 어떤 상태인지 그대로 공개합니다 — 빠진 구간과 실패한 잡까지 포함해서입니다.</p>
  <p class="page-links"><a class="button" href="/">인기 차트</a> <a class="button" href="/rising">급상승</a></p>
</section>

<section class="metrics" aria-label="수집 지표">
  ${metric('마지막 기록', esc(formatMoment(status?.latest_snapshot) || null),
    staleMinutes === null ? '기록 없음' : `${esc(num(staleMinutes))}분 전`)}
  ${metric('24시간 기록 횟수', ticks ? `${esc(num(ticks))} / ${TICKS_PER_DAY}` : null,
    ticks ? `${coverage}% · 10분 간격 기준` : '아직 하루가 지나지 않았습니다')}
  ${metric('추적 중인 게임', esc(num(status?.tracked)), `그중 ${esc(num(status?.ranked))}개가 지금 순위 안에 있습니다`)}
  ${metric('상세 한 바퀴', cycleHours === null ? null : `${cycleHours}시간`,
    '가격·평가를 게임마다 순서대로 갱신하는 주기')}
</section>

${listSection('수집 잡', '10분 · 1시간 · 하루 주기가 섞여 있습니다', jobRows)}

${listSection('최근 24시간의 결손 구간', gaps.length ? `${gaps.length}건` : '없음', gapRows)}

${listSection('보관 중인 기록', '', `<ul class="fact-list">
  <li><span>원시 동접 (10분 간격 · 7일 보관)</span><strong>${esc(num(status?.snapshot_rows))}행</strong></li>
  <li><span>시간 롤업 (1시간 · 90일 보관)</span><strong>${esc(num(status?.hourly_rows))}행</strong></li>
  <li><span>일 롤업 (하루 · 영구 보관)</span><strong>${esc(num(status?.daily_rows))}행</strong></li>
  <li><span>기록 시작일</span><strong>${esc(formatDay(status?.first_day) || '아직 없음')}</strong></li>
  <li><span>연속 실패로 큐에서 빠진 앱</span><strong>${esc(num(status?.dead ?? 0))}개</strong></li>
</ul>`)}

<section class="panel source-note">
  <h2>이 표를 어떻게 읽나</h2>
  <p class="muted"><strong>24시간 기록 횟수</strong>가 144에 가까울수록 시계열이 촘촘합니다. 몇 번 빠져도 값이 왜곡되지는 않습니다 — 저희는 기록 시각을 Steam 이 알려 준 갱신 시각으로 쓰기 때문에, 수집이 밀려도 없는 시각이 만들어지지 않고 빠진 구간은 그냥 빈 채로 남습니다.</p>
  <p class="muted"><strong>결손 구간</strong>은 그 사이의 값을 추정해 채우지 않습니다. 그래서 그래프가 그 자리에서 이어지지 않고 벌어져 보일 수 있는데, 그게 실제로 일어난 일입니다.</p>
  <p class="muted"><strong>상세 한 바퀴</strong>는 가격·평가를 전체 게임에 한 번씩 갱신하는 데 걸리는 시간입니다. 그래서 스토어 가격과 최대 그 시간만큼 차이가 날 수 있습니다. 구매 전 Steam 에서 실제 가격을 확인하세요.</p>
  <p class="muted">수집이 멈추면 감시 잡이 먼저 실패하고 운영자에게 메일이 갑니다. 이 페이지는 그 판정과 <strong>같은 데이터</strong>를 봅니다.</p>
</section>`;

  return html(layout({
    title: `수집 상태 — 이 숫자가 어떻게 만들어지나 | ${SITE_NAME}`,
    description: 'Steam Pulse 가 동시접속자·가격·평가를 어떻게 기록하고 있는지, 마지막 수집 시각과 빠진 구간까지 그대로 공개합니다.',
    path: '/status',
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '수집 상태' }],
    body
  }), { cache: CACHE_DETAIL });
}


// =============================================================================
// 계정 — /account · /account/login · /account/signup
//
// **계정은 자율이다.** 이 사이트의 어떤 화면도 로그인을 요구하지 않는다.
// 순위·급상승·할인·게임 상세·위시리스트·가격 알림은 계정 없이 지금까지와 똑같이 동작한다.
// 계정이 더해 주는 것은 하나뿐이다 — 위시리스트를 기기 사이에서 이어 준다.
// 이 문장이 화면에도 그대로 적혀 있어야 한다. 로그인 화면은 사용자가 "안 하면 못 쓰나"를
// 가장 크게 의심하는 자리이고, 거기서 답하지 않으면 그냥 나가 버린다.
//
// 셋 다 no-store + noindex 다. 사람마다 다른 화면이라 CDN 이 캐싱하면 남의 계정이 보이고,
// 검색엔진이 색인하면 아무 의미 없는 로그인 폼이 결과에 뜬다.
// =============================================================================

const ACCOUNT_NOTES = {
  'signed-up': ['가입이 끝났습니다', '이제 담아 둔 게임이 이 계정에 함께 저장됩니다. 다른 기기에서 로그인하면 그대로 이어집니다.'],
  'signed-out': ['로그아웃했습니다', '이 브라우저의 위시리스트는 그대로 남아 있습니다 — 로그아웃해도 사라지지 않습니다.'],
  'password-changed': ['비밀번호를 바꿨습니다', '보안을 위해 <strong>모든 기기의 로그인이 해제</strong>되었습니다. 새 비밀번호로 다시 로그인해 주세요.'],
  'signin-required': ['로그인이 필요한 동작입니다', '계정 설정을 바꾸려면 먼저 로그인해 주세요. 사이트의 다른 화면은 로그인 없이 그대로 쓸 수 있습니다.'],
  invalid: ['입력을 확인해 주세요', '이메일 주소나 비밀번호가 맞지 않습니다.'],
  taken: ['가입하지 못했습니다', '입력하신 주소로는 계정을 만들 수 없습니다. 이미 가입한 주소라면 <a href="/account/login">로그인</a>해 주세요.'],
  short: ['비밀번호가 너무 짧습니다', `${MIN_PASSWORD}자 이상으로 정해 주세요. 대문자·기호를 섞는 것보다 <strong>긴 것</strong>이 훨씬 안전합니다.`],
  long: ['비밀번호가 너무 깁니다', `${MAX_PASSWORD}자 이내로 정해 주세요.`],
  locked: ['잠시 뒤에 다시 시도해 주세요', '비밀번호를 여러 번 잘못 입력해 이 계정을 잠시 잠갔습니다. 15분 뒤에 다시 시도할 수 있습니다.']
};

const accountNote = state => {
  const note = ACCOUNT_NOTES[state];
  if (!note) return '';
  const tone = ['signed-up', 'signed-out', 'password-changed'].includes(state) ? 'ok' : 'warn';
  return `<div class="notice ${tone}" role="status"><strong>${esc(note[0])}</strong><p>${note[1]}</p></div>`;
};

// 로그인 화면과 가입 화면이 공유하는 설명. 이걸 빼면 "가입해야 쓸 수 있는 사이트"로 읽힌다.
const OPTIONAL_NOTE =
  '<p class="muted">계정은 <strong>선택 사항</strong>입니다. 로그인하지 않아도 순위·급상승·할인·게임 상세·위시리스트·가격 알림을 ' +
  '지금까지와 똑같이 쓸 수 있습니다. 계정이 더해 주는 것은 하나입니다 — <strong>담아 둔 게임을 기기 사이에서 이어 주는 것</strong>.</p>';

const passwordField = (name, label, { hint = '', autocomplete = 'current-password' } = {}) =>
  `<label class="field"><span>${esc(label)}${hint ? ` <small>${esc(hint)}</small>` : ''}</span>` +
  `<input type="password" name="${esc(name)}" required autocomplete="${esc(autocomplete)}" ` +
  `minlength="${MIN_PASSWORD}" maxlength="${MAX_PASSWORD}"></label>`;

const emailField = () =>
  '<label class="field"><span>이메일</span>' +
  '<input type="email" name="email" required autocomplete="email" placeholder="you@example.com" maxlength="254"></label>';

const accountLayout = ({ title, description, path, heading, lead, body, breadcrumb }) =>
  html(layout({
    title: `${title} | ${SITE_NAME}`,
    description,
    path,
    noindex: true,
    breadcrumb,
    body: `<section class="page-intro"><div class="eyebrow">ACCOUNT</div><h1>${esc(heading)}</h1><p>${lead}</p></section>${body}`
  }), { cache: 'no-store' });

export function accountSignupPage(_sql, { state, user } = {}) {
  // 이미 로그인한 사람에게 가입 폼을 보여 줄 이유가 없다.
  if (user) return { status: 303, headers: { Location: '/account', 'Cache-Control': 'no-store' }, body: '' };

  return accountLayout({
    title: '회원 가입',
    description: 'Steam Pulse 계정을 만들면 담아 둔 게임이 기기 사이에서 이어집니다. 계정 없이도 사이트의 모든 화면을 쓸 수 있습니다.',
    path: '/account/signup',
    heading: '계정 만들기',
    lead: '담아 둔 게임을 <strong>다른 기기에서도</strong> 보고 싶을 때만 만들면 됩니다.',
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '계정', href: '/account/login' }, { label: '가입' }],
    body: `
${accountNote(state)}
<section class="panel">
  <form class="alert-form" method="post" action="/api/account">
    <input type="hidden" name="action" value="signup">
    <div class="field-row">${emailField()}${passwordField('password', '비밀번호', { hint: `(${MIN_PASSWORD}자 이상)`, autocomplete: 'new-password' })}</div>
    <button class="button primary" type="submit">계정 만들기</button>
    ${OPTIONAL_NOTE}
    <p class="muted">비밀번호는 <strong>원문을 저장하지 않습니다</strong>(scrypt 해시만 남습니다). 접속 IP 와 브라우저 정보도 기록하지 않습니다. 자세한 내용은 <a href="/privacy">개인정보처리방침</a>에 있습니다.</p>
    <p class="muted">이미 계정이 있다면 <a href="/account/login">로그인</a>하세요.</p>
  </form>
</section>`
  });
}

export function accountLoginPage(_sql, { state, user } = {}) {
  if (user) return { status: 303, headers: { Location: '/account', 'Cache-Control': 'no-store' }, body: '' };

  return accountLayout({
    title: '로그인',
    description: 'Steam Pulse 계정으로 로그인하면 담아 둔 게임이 기기 사이에서 이어집니다. 계정 없이도 사이트의 모든 화면을 쓸 수 있습니다.',
    path: '/account/login',
    heading: '로그인',
    lead: '계정이 있으면 담아 둔 게임이 <strong>기기 사이에서 이어집니다</strong>.',
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '로그인' }],
    body: `
${accountNote(state)}
<section class="panel">
  <form class="alert-form" method="post" action="/api/account">
    <input type="hidden" name="action" value="login">
    <div class="field-row">${emailField()}${passwordField('password', '비밀번호')}</div>
    <button class="button primary" type="submit">로그인</button>
    ${OPTIONAL_NOTE}
    <p class="muted">계정이 없다면 <a href="/account/signup">가입</a>하거나, 그냥 <a href="/">둘러보세요</a>.</p>
  </form>
</section>`
  });
}

export async function accountPage(sql, { state, user } = {}) {
  // 로그인하지 않았으면 막지 않고 안내한다. 이 사이트에서 '차단'되는 화면은 없다.
  if (!user) return accountLoginPage(sql, { state: state || 'signin-required' });

  // 계정에 저장된 위시리스트 개수. 목록 자체는 브라우저가 그린다 —
  // 서버가 그리면 no-store 라도 뒤로가기 캐시에 남고, 그 화면은 남의 것일 수 있다.
  let saved = 0;
  try {
    saved = (await accounts.readWatchlist(sql, user.id)).length;
  } catch { saved = 0; }

  const body = `
${accountNote(state)}

<section class="metrics" aria-label="계정 요약">
  ${metric('이메일', esc(user.email), '')}
  ${metric('가입일', esc(formatMoment(user.created_at) || null), '')}
  ${metric('마지막 로그인', esc(formatMoment(user.last_login_at) || null), user.last_login_at ? '' : '이번이 처음입니다')}
  ${metric('계정에 저장된 게임', esc(num(saved)), `<a href="/watchlist">위시리스트 보기</a>`)}
</section>

${listSection('위시리스트 동기화', '이 브라우저 ↔ 계정', `
  <p class="muted">담아 둔 게임은 이 브라우저에도, 계정에도 저장됩니다. 두 목록은 <strong>합쳐집니다</strong> — 다른 기기에서 담은 게임이 이 기기에 없다고 해서 사라지지 않습니다. 빼기는 직접 누를 때만 일어납니다.</p>
  <p id="syncStatus" class="muted" role="status">확인 중…</p>
  <p><a class="button" href="/watchlist">위시리스트로 가기</a></p>`)}

${listSection('비밀번호 변경', '바꾸면 모든 기기의 로그인이 해제됩니다', `
  <form class="alert-form" method="post" action="/api/account">
    <input type="hidden" name="action" value="change-password">
    <div class="field-row">
      ${passwordField('current', '현재 비밀번호')}
      ${passwordField('next', '새 비밀번호', { hint: `(${MIN_PASSWORD}자 이상)`, autocomplete: 'new-password' })}
    </div>
    <button class="button primary" type="submit">비밀번호 바꾸기</button>
    <p class="muted">현재 비밀번호를 함께 묻는 이유는, 남이 이 화면을 열었을 때 그것만으로 계정을 가져가지 못하게 하기 위해서입니다.</p>
  </form>`)}

${listSection('로그인 관리', '', `
  <div class="page-links">
    <form method="post" action="/api/account"><input type="hidden" name="action" value="logout"><button class="button" type="submit">이 브라우저에서 로그아웃</button></form>
    <form method="post" action="/api/account"><input type="hidden" name="action" value="logout-all"><button class="button" type="submit">모든 기기에서 로그아웃</button></form>
  </div>
  <p class="muted">로그아웃해도 <strong>이 브라우저의 위시리스트는 그대로 남습니다.</strong> 계정에 저장된 목록도 지워지지 않습니다.</p>`)}

${listSection('계정 삭제', '되돌릴 수 없습니다', `
  <form class="alert-form" method="post" action="/api/account">
    <input type="hidden" name="action" value="delete">
    ${passwordField('password', '확인을 위해 비밀번호를 입력하세요')}
    <button class="button" type="submit">계정 삭제</button>
    <p class="muted">계정과 계정에 저장된 위시리스트가 <strong>즉시 삭제</strong>됩니다. 흔적을 남기지 않습니다. 이 브라우저에 담아 둔 목록은 그대로 남고, 따로 신청하신 이메일 알림은 건드리지 않습니다 — 그건 <a href="/alerts">알림 화면</a>에서 해지합니다.</p>
  </form>`)}

<section class="panel source-note">
  <h2>계정은 무엇을 저장하나</h2>
  <ul class="doc-list">
    <li><strong>이메일 주소</strong> — 로그인 식별용입니다.</li>
    <li><strong>비밀번호 해시</strong> — 원문은 저장하지 않습니다(scrypt).</li>
    <li><strong>담아 둔 게임의 appid 목록</strong> — 기기 사이에서 이어 주기 위한 것입니다.</li>
    <li><strong>세션</strong> — 쿠키에는 무작위 값이 들어가고, 서버에는 그 해시만 남습니다.</li>
  </ul>
  <p class="muted">접속 IP 와 브라우저 정보는 기록하지 않습니다. 자세한 내용은 <a href="/privacy">개인정보처리방침</a>에 있습니다.</p>
</section>

<script type="module" src="/account.js"></script>`;

  return html(layout({
    title: `계정 | ${SITE_NAME}`,
    description: '계정 설정과 위시리스트 동기화.',
    path: '/account',
    noindex: true,
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '계정' }],
    body
  }), { cache: 'no-store' });
}

// =============================================================================
// 이메일 알림 — /alerts · /alerts/confirm · /alerts/unsubscribe
//
// 이 세 페이지는 **아무것도 쓰지 않는다.** 확인도 해지도 버튼을 눌러 /api/alerts 로
// POST 될 때만 일어난다(lib/http.mjs 의 handleAlerts). 메일 클라이언트와 회사 보안 스캐너는
// 링크를 미리 열어 보기 때문에, GET 이 쓰기를 하면 본인이 누르지 않은 확인·해지가 발생한다.
//
// 셋 다 no-store + noindex 다. 토큰이 주소에 들어 있어 CDN 이 캐싱하면 남의 토큰이 새고,
// 검색엔진이 색인하면 그 토큰이 그대로 공개된다.
// =============================================================================

const ALERT_NOTES = {
  sent: ['확인 메일을 보냈습니다', '받은 편지함에서 <strong>구독 확인</strong> 버튼을 눌러 주세요. 그 전까지는 아무 메일도 보내지 않습니다. 몇 분이 지나도 오지 않으면 스팸함을 확인해 주세요.'],
  confirmed: ['구독이 시작되었습니다', '이제 조건이 맞으면 메일로 알려 드립니다. 모든 메일 맨 아래에 수신 거부 링크가 있습니다.'],
  already: ['이미 확인된 주소입니다', '추가로 하실 일은 없습니다.'],
  unsubscribed: ['수신을 거부했습니다', '이 주소로는 더 이상 메일을 보내지 않습니다. 담아 두신 알림은 함께 삭제되었고, 남은 기록은 30일 뒤 사라집니다.'],
  invalid: ['입력을 확인해 주세요', '이메일 주소 형식이나 목표 가격을 다시 확인해 주세요.'],
  busy: ['잠시 뒤에 다시 시도해 주세요', '짧은 시간에 신청이 몰렸습니다. 메일 발송 한도를 지키려고 잠시 새 신청을 받지 않습니다.'],
  limit: ['알림이 너무 많습니다', '한 주소에 담을 수 있는 게임 알림은 50개까지입니다. 기존 알림을 정리한 뒤 다시 시도해 주세요.'],
  unknown: ['처리하지 못했습니다', '주소가 만료되었거나 이미 처리된 요청입니다. 필요하면 아래에서 다시 신청해 주세요.']
};

const alertNote = state => {
  const note = ALERT_NOTES[state];
  if (!note) return '';
  const tone = ['sent', 'confirmed', 'already', 'unsubscribed'].includes(state) ? 'ok' : 'warn';
  return `<div class="notice ${tone}" role="status"><strong>${esc(note[0])}</strong><p>${note[1]}</p></div>`;
};

// 개인정보 고지는 폼 옆에 붙어 있어야 고지다. 방침 페이지에만 적어 두는 것으로는 부족하다.
const CONSENT_LINE =
  '보내 주신 주소는 <strong>알림 발송에만</strong> 사용하고 다른 곳에 제공하지 않습니다. ' +
  '확인하지 않은 주소와 수신 거부한 주소는 30일 뒤 삭제됩니다. ' +
  '자세한 내용은 <a href="/privacy">개인정보처리방침</a>에 있습니다.';

// 게임 상세의 가격 알림 폼. 목표가는 비워 둘 수 있고, 비우면 '할인이 시작되면 언제든'이다.
// 설정이 없으면 아무것도 그리지 않는다 — 받을 수 없는 신청을 받는 폼이 가장 나쁘다.
export function priceAlertForm(app) {
  if (!config.mail) return '';
  const hint = isNum(app.final_price) && app.final_price > 0
    ? `예: ${Math.floor(app.final_price / 100 / 2) * 100}` : '예: 20000';
  return listSection('가격이 내려가면 알려 드립니다', '이메일 · 언제든 수신 거부', `
    <form class="alert-form" method="post" action="/api/alerts">
      <input type="hidden" name="appid" value="${app.appid}">
      <div class="field-row">
        <label class="field"><span>이메일</span>
          <input type="email" name="email" required autocomplete="email" placeholder="you@example.com" maxlength="254"></label>
        <label class="field"><span>목표 가격 <small>(선택)</small></span>
          <input type="text" name="target" inputmode="numeric" placeholder="${esc(hint)}" maxlength="12"></label>
      </div>
      <button class="button primary" type="submit">가격 알림 받기</button>
      <p class="muted">목표 가격을 비워 두면 <strong>할인이 시작될 때</strong> 알려 드립니다. 적어 두면 그 가격 이하로 내려갔을 때만 보냅니다. 신청 뒤 확인 메일의 버튼을 눌러야 구독이 시작됩니다.</p>
      <p class="muted">${CONSENT_LINE}</p>
    </form>`);
}

export function alertsPage(_sql, { state } = {}) {
  if (!config.mail) return notFound('이 사이트는 이메일 알림을 제공하지 않습니다.');

  const body = `
<section class="page-intro">
  <div class="eyebrow">ALERTS</div>
  <h1>가격 알림과 주간 리포트</h1>
  <p>담아 둔 게임이 <strong>할인을 시작하거나 목표 가격 아래로 내려가면</strong> 메일로 알려 드립니다. 주간 리포트는 매주 월요일 아침, 급상승한 게임과 지금 할인 중인 고평가작을 정리해 보냅니다.</p>
</section>

${alertNote(state)}

<section class="panel">
  <div class="section-heading"><div class="title-group"><h2>주간 리포트 신청</h2></div><span class="section-note">매주 월요일 · 1통</span></div>
  <form class="alert-form" method="post" action="/api/alerts">
    <input type="hidden" name="weekly" value="1">
    <label class="field"><span>이메일</span>
      <input type="email" name="email" required autocomplete="email" placeholder="you@example.com" maxlength="254"></label>
    <button class="button primary" type="submit">주간 리포트 받기</button>
    <p class="muted">${CONSENT_LINE}</p>
  </form>
</section>

<section class="panel">
  <div class="section-heading"><div class="title-group"><h2>게임별 가격 알림</h2></div></div>
  <p>게임 하나하나의 알림은 <strong>그 게임의 상세 페이지</strong>에서 신청합니다. 목표 가격을 함께 적어 두면 그 아래로 내려갔을 때만 메일이 갑니다.</p>
  <p><a class="button" href="/deals">지금 할인 중인 게임 보기</a> <a class="button" href="/watchlist">내 위시리스트</a></p>
</section>

<section class="panel source-note">
  <h2>어떤 메일이, 얼마나 오나요</h2>
  <ul class="doc-list">
    <li><strong>확인 메일</strong> — 신청 직후 1통. 이 메일의 버튼을 누르기 전에는 어떤 메일도 보내지 않습니다.</li>
    <li><strong>가격 하락 알림</strong> — 조건이 맞을 때만. 여러 게임이 동시에 걸리면 <strong>한 통으로 묶어</strong> 보냅니다.</li>
    <li><strong>주간 리포트</strong> — 신청한 경우 주 1통. 실을 내용이 없는 주에는 보내지 않습니다.</li>
  </ul>
  <p class="muted">같은 할인으로 같은 메일이 두 번 가지 않도록, 한 번 알린 가격보다 <strong>더 내려갔을 때만</strong> 다시 알립니다. 가격은 저희가 마지막으로 확인한 한국 스토어 값이므로 구매 전 Steam 에서 실제 가격을 확인하세요.</p>
</section>`;

  return html(layout({
    title: `가격 알림 | ${SITE_NAME}`,
    description: '스팀 게임이 할인을 시작하거나 목표 가격 아래로 내려가면 메일로 알려 드립니다. 매주 월요일 급상승·할인 리포트도 함께.',
    path: '/alerts',
    active: '/alerts',
    noindex: true,
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '가격 알림' }],
    body
  }), { cache: 'no-store' });
}

// 토큰을 다시 화면에 내보내는 페이지 둘. 값은 반드시 esc() 를 통과시킨다 —
// 주소창에서 온 문자열이라 그대로 넣으면 링크 하나로 스크립트가 심긴다.
function tokenActionPage({ token, state, heading, lead, action, submit, caution }) {
  if (!config.mail) return notFound('이 사이트는 이메일 알림을 제공하지 않습니다.');

  const form = token
    ? `<form class="alert-form" method="post" action="/api/alerts">
         <input type="hidden" name="action" value="${esc(action)}">
         <input type="hidden" name="token" value="${esc(token)}">
         <button class="button primary" type="submit">${esc(submit)}</button>
         ${caution ? `<p class="muted">${caution}</p>` : ''}
       </form>`
    : `<p>주소에 확인 값이 없습니다. 메일에 있는 링크를 <strong>그대로</strong> 열어 주세요. 메일 앱이 주소를 줄바꿈으로 잘랐다면 전체를 복사해 붙여 넣어야 합니다.</p>
       <p><a class="button" href="/alerts">알림 안내로 가기</a></p>`;

  const body = `
<section class="page-intro">
  <div class="eyebrow">ALERTS</div>
  <h1>${esc(heading)}</h1>
  <p>${lead}</p>
</section>

${alertNote(state)}

<section class="panel">${form}</section>`;

  return html(layout({
    title: `${heading} | ${SITE_NAME}`,
    description: '이메일 알림 구독 설정을 확인합니다.',
    path: '/alerts',
    noindex: true,
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '가격 알림', href: '/alerts' }, { label: heading }],
    body
  }), { cache: 'no-store' });
}

export function alertsConfirmPage(_sql, { token, state } = {}) {
  return tokenActionPage({
    token,
    state,
    action: 'confirm',
    heading: '구독 확인',
    lead: '아래 버튼을 누르면 구독이 시작됩니다. <strong>이 버튼을 누르기 전까지는 어떤 메일도 보내지 않습니다.</strong>',
    submit: '구독 확인하기',
    caution: '신청한 적이 없다면 이 창을 닫으면 됩니다. 확인하지 않은 주소는 30일 뒤 자동으로 삭제됩니다.'
  });
}

export function alertsUnsubscribePage(_sql, { token, state } = {}) {
  return tokenActionPage({
    token,
    state,
    action: 'unsubscribe',
    heading: '수신 거부',
    lead: '아래 버튼을 누르면 이 주소로 오는 메일이 <strong>모두</strong> 중단됩니다.',
    submit: '수신 거부하기',
    caution: '담아 두신 게임 알림도 함께 삭제됩니다. 마음이 바뀌면 언제든 다시 신청할 수 있습니다.'
  });
}

// =============================================================================

export function notFound(message = '페이지를 찾을 수 없습니다.') {
  return html(layout({
    title: `페이지를 찾을 수 없습니다 | ${SITE_NAME}`,
    description: '요청하신 페이지가 없습니다.',
    path: '/404',
    noindex: true,
    body: `<section class="page-intro"><h1>404</h1><p>${esc(message)}</p><p><a class="button" href="/">인기 차트로 돌아가기</a></p></section>`
  }), { status: 404, cache: CACHE_MISS });
}

export function serverError(message = '잠시 후 다시 시도해 주세요.') {
  return html(layout({
    title: `일시적인 오류 | ${SITE_NAME}`,
    description: '데이터를 불러오지 못했습니다.',
    path: '/error',
    noindex: true,
    body: `<section class="page-intro"><h1>데이터를 불러오지 못했습니다</h1><p>${esc(message)}</p><p><a class="button" href="/">인기 차트로 돌아가기</a></p></section>`
  }), { status: 503, cache: 'no-store' });
}

export const HANDLERS = {
  game: gamePage,
  gameReviews: gameReviewsPage,
  rising: risingPage,
  deals: dealsPage,
  dealsLow: dealsLowPage,
  weekly: weeklyPage,
  monthly: monthlyPage,
  genres: genresPage,
  genre: genrePage,
  genreFree: genreFreePage,
  genreDiscounted: genreDiscountedPage,
  releases: releasesPage,
  release: releasePage,
  status: statusPage,
  account: accountPage,
  accountLogin: accountLoginPage,
  accountSignup: accountSignupPage,
  // 알림 페이지는 DB 를 읽지 않는다. lazySql() 을 받아도 아무 일도 일어나지 않는다.
  alerts: alertsPage,
  alertsConfirm: alertsConfirmPage,
  alertsUnsubscribe: alertsUnsubscribePage,
  // 고정 문서는 DB 를 읽지 않는다. sql 인자를 받지만 쓰지 않는다.
  ...Object.fromEntries(Object.entries(LEGAL_HANDLERS).map(([name, handler]) => [name, () => handler()]))
};

// =============================================================================
// sitemap.xml
// =============================================================================

const STATIC_PATHS = [
  { path: '/', priority: '1.0', changefreq: 'hourly' },
  { path: '/rising', priority: '0.9', changefreq: 'hourly' },
  { path: '/deals', priority: '0.8', changefreq: 'daily' },
  { path: '/deals/all-time-low', priority: '0.8', changefreq: 'daily' },
  { path: '/charts/weekly', priority: '0.8', changefreq: 'daily' },
  { path: '/charts/monthly', priority: '0.8', changefreq: 'daily' },
  { path: '/genre', priority: '0.6', changefreq: 'weekly' },
  { path: '/releases', priority: '0.6', changefreq: 'weekly' },
  // 색인 가치는 낮지만 숨길 이유도 없다. 데이터를 공개한다는 신호 자체가 신뢰다.
  { path: '/status', priority: '0.3', changefreq: 'hourly' },
  ...staticDocPaths()
];

export async function sitemap(sql) {
  const origin = siteOrigin();
  const [apps, genres, reviewApps, combos, years] = await Promise.all([
    q.sitemapApps(sql, 5000),
    q.genreList(sql, 60),
    q.sitemapReviewApps(sql, 5000),
    q.genreComboCounts(sql, MIN_COMBO_GAMES),
    q.releaseYears(sql, 40)
  ]);

  const entry = (loc, { lastmod, changefreq, priority } = {}) =>
    `<url><loc>${escXml(loc)}</loc>` +
    (lastmod ? `<lastmod>${lastmod}</lastmod>` : '') +
    (changefreq ? `<changefreq>${changefreq}</changefreq>` : '') +
    (priority ? `<priority>${priority}</priority>` : '') +
    '</url>';

  // 조합 페이지는 **실제로 열리는 것만** 싣는다. 판정 기준(MIN_COMBO_GAMES)이 페이지·링크와
  // 같은 값이라, 사이트맵에 있는데 404 인 URL 이 생기지 않는다.
  const comboUrls = combos.flatMap(row => [
    row.free_games >= MIN_COMBO_GAMES ? entry(`${origin}${genrePath(row.genre)}/free`, { changefreq: 'daily', priority: '0.5' }) : null,
    row.discounted_games >= MIN_COMBO_GAMES ? entry(`${origin}${genrePath(row.genre)}/discounted`, { changefreq: 'daily', priority: '0.5' }) : null
  ].filter(Boolean));

  const urls = [
    ...STATIC_PATHS.map(item => entry(`${origin}${item.path}`, { changefreq: item.changefreq, priority: item.priority })),
    ...genres.map(row => entry(`${origin}${genrePath(row.genre)}`, { changefreq: 'daily', priority: '0.6' })),
    ...comboUrls,
    ...years.map(row => entry(`${origin}/releases/${row.year}`, { changefreq: 'weekly', priority: '0.5' })),
    ...apps.map(row => entry(`${origin}${gamePath(row.appid, row.slug)}`, {
      lastmod: toIso(row.updated_at)?.slice(0, 10), changefreq: 'daily', priority: '0.7'
    })),
    ...reviewApps.map(row => entry(`${origin}${gamePath(row.appid, row.slug)}/reviews`, {
      lastmod: row.last_day, changefreq: 'daily', priority: '0.5'
    }))
  ];

  return {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' },
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`
  };
}
