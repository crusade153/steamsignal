// SSR 페이지 본문. 각 핸들러는 { status, headers, body } 를 돌려주고 HTTP 를 모른다.
// 그래서 Vercel 함수(api/page.js)와 로컬 서버(server.mjs)가 같은 코드를 쓴다.
import * as q from './queries.mjs';
import {
  SITE_NAME, config, layout, esc, escXml, num, won, isNum, formatDay, formatMoment, toIso,
  gamePath, genrePath, steamStoreUrl, safeImage, gameCell, reviewCell, priceCell,
  metaScoreCell, lineChart, emptyState, siteOrigin, adSlot
} from './render.mjs';
import { LEGAL_HANDLERS, staticDocPaths } from './legal.mjs';

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

const table = (headers, rows) =>
  `<div class="table-scroll" tabindex="0"><table><thead><tr>${headers.join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;

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
      ${newReviews > 0 ? '' : '<p class="muted">신규 리뷰 긍정률은 누적값의 차분이라 이틀 이상 기록이 쌓여야 계산됩니다.</p>'}
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

  const body = rows.length
    ? table(
      ['<th scope="col" class="rank-column">#</th>', '<th scope="col" class="game-column">게임</th>',
        '<th scope="col" class="numeric">증가율</th>', '<th scope="col" class="numeric">현재 구간 평균</th>',
        '<th scope="col" class="numeric">직전 구간 평균</th>', '<th scope="col" class="numeric">Steam 평가</th>'],
      rows.map((row, i) => `<tr>
        <td class="rank-cell${i < 3 ? ' top' : ''}">${i + 1}</td>
        <td>${gameCell(row, { eager: i < 3 })}</td>
        <td class="numeric"><span class="change-up">+${esc(row.change_pct?.toFixed(1))}%</span></td>
        <td class="numeric"><span class="player-number">${esc(num(row.now_players))}</span></td>
        <td class="numeric peak-number">${esc(num(row.past_players))}</td>
        <td class="numeric">${reviewCell(row)}</td>
      </tr>`)
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
    ? table(
      ['<th scope="col" class="game-column">게임</th>', '<th scope="col" class="numeric">할인</th>',
        '<th scope="col" class="numeric price-column">가격</th>', '<th scope="col" class="numeric">Steam 평가</th>',
        '<th scope="col" class="numeric">메타크리틱</th>', '<th scope="col" class="numeric">현재 동접</th>'],
      rows.map((row, i) => `<tr>
        <td>${gameCell(row, { eager: i < 3 })}</td>
        <td class="numeric"><span class="discount">-${row.discount_percent}%</span>${row.at_lowest ? '<span class="cell-sub badge-low">역대 최저가</span>' : ''}</td>
        <td class="numeric price-column">${priceCell(row)}${isNum(row.initial_price) && row.initial_price > row.final_price ? `<span class="cell-sub original-price">${esc(won(row.initial_price))}</span>` : ''}</td>
        <td class="numeric">${reviewCell(row)}</td>
        <td class="numeric">${metaScoreCell(row.metacritic_score, null)}</td>
        <td class="numeric">${isNum(row.players) ? `<span class="player-number">${esc(num(row.players))}</span>` : '<span class="missing">—</span>'}</td>
      </tr>`)
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
// 주간 차트 — /charts/weekly
// =============================================================================

export async function weeklyPage(sql) {
  const rows = await q.weekly(sql, { days: 7, limit: 50 });
  const covered = rows.length ? Math.max(...rows.map(row => row.days)) : 0;

  const body = rows.length
    ? table(
      ['<th scope="col" class="rank-column">순위</th>', '<th scope="col" class="game-column">게임</th>',
        '<th scope="col" class="numeric">주간 평균 동접</th>', '<th scope="col" class="numeric">기간 내 최고</th>',
        '<th scope="col" class="numeric">현재 순위</th>', '<th scope="col" class="numeric">Steam 평가</th>'],
      rows.map((row, i) => `<tr>
        <td class="rank-cell${i < 3 ? ' top' : ''}">${i + 1}</td>
        <td>${gameCell(row, { eager: i < 3 })}</td>
        <td class="numeric"><span class="player-number">${esc(num(row.avg_players))}</span><span class="cell-sub">${row.days}일 집계</span></td>
        <td class="numeric peak-number">${esc(num(row.peak_players))}</td>
        <td class="numeric">${isNum(row.current_rank) ? `${row.current_rank}위` : '<span class="missing">차트 밖</span>'}</td>
        <td class="numeric">${reviewCell(row)}</td>
      </tr>`)
    ) + `<p class="muted table-footnote">최근 ${covered}일치 일별 평균을 집계했습니다. 7일이 모두 쌓이기 전에는 그만큼의 기간만 반영됩니다.</p>`
    : emptyState('주간 집계가 아직 없습니다.',
      '일 롤업은 매일 새벽 한 번 계산됩니다. 첫 순위는 수집 시작 다음 날부터 나옵니다.');

  return html(layout({
    title: `주간 인기 게임 차트 — 7일 평균 동시접속자 | ${SITE_NAME}`,
    description: '최근 7일 평균 동시접속자 기준 스팀 인기 게임 순위. 하루짜리 이벤트에 흔들리지 않는 주간 차트입니다.',
    path: '/charts/weekly',
    active: '/charts/weekly',
    image: safeImage(rows[0]?.header_image),
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '주간 차트' }],
    body: `<section class="page-intro"><div class="eyebrow">WEEKLY</div><h1>주간 인기 게임</h1><p>지금 이 순간의 순위는 시간대와 이벤트에 크게 흔들립니다. 이 차트는 <strong>최근 7일 평균 동시접속자</strong>로 줄을 세워, 한 주 동안 실제로 가장 많이 플레이된 게임을 보여 줍니다.</p></section>${body}`
  }));
}

// =============================================================================
// 장르 — /genre, /genre/:genre
// =============================================================================

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
    body: `<section class="page-intro"><div class="eyebrow">GENRES</div><h1>장르별로 찾기</h1><p>지금 인기 차트에 올라 있는 게임들을 장르로 묶었습니다.</p></section><section class="panel">${body}</section>`
  }));
}

export async function genrePage(sql, { genre }) {
  const name = String(genre ?? '').slice(0, 60);
  if (!name) return notFound('장르를 찾을 수 없습니다.');

  const rows = await q.genreGames(sql, name, 60);
  if (!rows.length) return notFound(`'${name}' 장르에 해당하는 게임이 아직 없습니다.`);

  const players = rows.filter(row => isNum(row.players));
  const body = table(
    ['<th scope="col" class="rank-column">#</th>', '<th scope="col" class="game-column">게임</th>',
      '<th scope="col" class="numeric">현재 동접</th>', '<th scope="col" class="numeric">Steam 평가</th>',
      '<th scope="col" class="numeric">메타크리틱</th>', '<th scope="col" class="numeric price-column">가격</th>'],
    rows.map((row, i) => `<tr>
      <td class="rank-cell${i < 3 ? ' top' : ''}">${i + 1}</td>
      <td>${gameCell(row, { eager: i < 3 })}</td>
      <td class="numeric">${isNum(row.players) ? `<span class="player-number">${esc(num(row.players))}</span>` : '<span class="missing">차트 밖</span>'}</td>
      <td class="numeric">${reviewCell(row)}</td>
      <td class="numeric">${metaScoreCell(row.metacritic_score, null)}</td>
      <td class="numeric price-column">${priceCell(row)}</td>
    </tr>`)
  );

  return html(layout({
    title: `${name} 장르 인기 게임 — 동시접속자 순 | ${SITE_NAME}`,
    description: `${name} 장르에서 지금 가장 많이 플레이되는 스팀 게임 ${rows.length}개. 동시접속자, Steam 평가, 가격을 함께 비교하세요.`,
    path: genrePath(name),
    image: safeImage(rows[0]?.header_image),
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '장르', href: '/genre' }, { label: name }],
    body: `<section class="page-intro"><div class="eyebrow">GENRE</div><h1>${esc(name)}</h1><p>${esc(name)} 장르 ${rows.length}개 게임을 현재 동시접속자 순으로 정렬했습니다.${players.length ? ` 지금 이 장르에서 ${esc(num(players.reduce((sum, row) => sum + row.players, 0)))}명이 플레이 중입니다.` : ''}</p></section>${body}`
  }));
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
  rising: risingPage,
  deals: dealsPage,
  weekly: weeklyPage,
  genres: genresPage,
  genre: genrePage,
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
  { path: '/charts/weekly', priority: '0.8', changefreq: 'daily' },
  { path: '/genre', priority: '0.6', changefreq: 'weekly' },
  ...staticDocPaths()
];

export async function sitemap(sql) {
  const origin = siteOrigin();
  const [apps, genres] = await Promise.all([q.sitemapApps(sql, 5000), q.genreList(sql, 60)]);

  const entry = (loc, { lastmod, changefreq, priority } = {}) =>
    `<url><loc>${escXml(loc)}</loc>` +
    (lastmod ? `<lastmod>${lastmod}</lastmod>` : '') +
    (changefreq ? `<changefreq>${changefreq}</changefreq>` : '') +
    (priority ? `<priority>${priority}</priority>` : '') +
    '</url>';

  const urls = [
    ...STATIC_PATHS.map(item => entry(`${origin}${item.path}`, { changefreq: item.changefreq, priority: item.priority })),
    ...genres.map(row => entry(`${origin}${genrePath(row.genre)}`, { changefreq: 'daily', priority: '0.6' })),
    ...apps.map(row => entry(`${origin}${gamePath(row.appid, row.slug)}`, {
      lastmod: toIso(row.updated_at)?.slice(0, 10), changefreq: 'daily', priority: '0.7'
    }))
  ];

  return {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' },
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`
  };
}
