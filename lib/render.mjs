// SSR 페이지의 공용 렌더러. 문자열을 만들 뿐 DB 도 Steam 도 모른다.
//
// 규율 하나만 지키면 된다: DB 에서 온 값은 예외 없이 esc() 를 통과시킨다.
// 제목·설명·개발사는 전부 Steam 이 준 외부 문자열이고, 우리는 그것을 HTML 안에 넣는다.

export const SITE_NAME = 'Steam Pulse';
export const SITE_TAGLINE = '지금 가장 핫한 스팀 게임';

// 배포 주소. Vercel 은 VERCEL_PROJECT_PRODUCTION_URL 을 프로덕션 도메인으로 채워 준다.
// canonical 과 sitemap 이 프리뷰 도메인을 가리키면 색인이 갈라지므로 프로덕션 값을 우선한다.
export function siteOrigin() {
  const explicit = process.env.SITE_URL || process.env.PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${vercel}`;
  return 'http://127.0.0.1:5174';
}

// --- 이스케이프 -------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = value =>
  value === null || value === undefined ? '' : String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);

// XML 은 &apos; 를 쓴다(HTML 의 &#39; 도 유효하지만 sitemap 은 XML 규칙을 따른다).
export const escXml = value =>
  value === null || value === undefined ? '' : String(value).replace(/[&<>"']/g, ch => ({ ...HTML_ESCAPES, "'": '&apos;' })[ch]);

// JSON-LD 는 <script> 안에 들어가므로 </script> 와 HTML 주석 시작을 깨뜨려야 한다.
export const jsonLdScript = data =>
  `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

// Steam 이미지 외에는 링크하지 않는다. DB 가 오염돼도 남의 서버로 요청이 나가지 않는다.
export function safeImage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)steamstatic\.com$/.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

// --- 포맷 -------------------------------------------------------------------

export const isNum = value => typeof value === 'number' && Number.isFinite(value);
export const num = value => (isNum(value) ? value.toLocaleString('ko-KR') : null);

// Steam 의 price_overview.final 은 통화 최소단위 x100 이다 (₩15,000 -> 1500000).
export function won(raw) {
  if (!isNum(raw)) return null;
  if (raw === 0) return '무료';
  return `₩${Math.round(raw / 100).toLocaleString('ko-KR')}`;
}

export const pct = value => (isNum(value) ? `${value}%` : null);

// 'YYYY-MM-DD' 문자열을 그대로 다룬다. Date 로 바꾸지 않는 게 핵심이다 —
// 발매일과 일 롤업의 day 는 '시각'이 아니라 '달력 날짜'라 시간대를 태우면 하루가 밀린다.
export function formatDay(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day ?? ''));
  return match ? `${match[1]}년 ${Number(match[2])}월 ${Number(match[3])}일` : null;
}

// TIMESTAMPTZ 는 진짜 '시각'이므로 KST 로 변환해 보여 준다.
export function formatMoment(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short'
  }).format(date);
}

export function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// --- URL --------------------------------------------------------------------

// 슬러그에 한글이 들어간다(예: 1172470-apex-레전드). 퍼센트 인코딩은 하되
// 경로 구분자로 오해될 문자만 막고 하이픈은 그대로 둔다.
export const gamePath = (appid, slug) => `/game/${encodeURIComponent(slug || String(appid))}`;
export const genrePath = genre => `/genre/${encodeURIComponent(genre)}`;
export const steamStoreUrl = appid => `https://store.steampowered.com/app/${Number(appid)}/`;

// --- 조각 -------------------------------------------------------------------

export function reviewClass(ratio) {
  if (!isNum(ratio)) return '';
  if (ratio >= 75) return '';
  return ratio >= 50 ? 'mixed' : 'negative';
}

// 리뷰 셀. 비율이 없으면 0% 가 아니라 '집계 전'이다 — 결측을 0 으로 만들지 않는다.
export function reviewCell(row) {
  const total = isNum(row.total_positive) && isNum(row.total_negative) ? row.total_positive + row.total_negative : null;
  if (!isNum(row.positive_ratio)) return '<span class="missing">집계 전</span>';
  return `<span class="review-score ${reviewClass(row.positive_ratio)}">${row.positive_ratio}%</span>` +
    (total !== null ? `<span class="cell-sub">리뷰 ${num(total)}</span>` : '');
}

export function priceCell(row) {
  if (!isNum(row.final_price)) return '<span class="missing">가격 미확인</span>';
  const label = row.price_formatted ? esc(row.price_formatted) : esc(won(row.final_price));
  if (row.final_price === 0) return '<span class="price-value free">무료 플레이</span>';
  const discount = isNum(row.discount_percent) && row.discount_percent > 0
    ? `<span class="discount">-${row.discount_percent}%</span>` : '';
  return `<span class="price-value">${discount}${label}</span>`;
}

// 목록의 게임 칸. 이미지는 lazy, 링크는 항상 진짜 <a> 다 — 크롤러가 따라갈 수 있어야 한다.
export function gameCell(row, { eager = false } = {}) {
  const href = gamePath(row.appid, row.slug);
  const image = safeImage(row.header_image);
  const thumb = image
    ? `<img class="game-image" src="${esc(image)}" alt="" width="96" height="47" loading="${eager ? 'eager' : 'lazy'}" decoding="async">`
    : '<span class="game-image fallback" aria-hidden="true">▦</span>';
  const genres = Array.isArray(row.genres) ? row.genres.slice(0, 3).join(' · ') : '';
  return `<a class="game-button" href="${esc(href)}">${thumb}<span class="game-text">` +
    `<strong>${esc(row.title)}</strong>` +
    (genres ? `<small>${esc(genres)}</small>` : '') +
    '</span></a>';
}

export function metaScoreCell(score, url) {
  if (!isNum(score)) return '<span class="missing">미제공</span>';
  const klass = score >= 75 ? '' : score >= 50 ? 'mixed' : 'negative';
  const badge = `<span class="meta-score ${klass}">${score}</span>`;
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${badge}</a>` : badge;
}

export function emptyState(message, hint) {
  return `<div class="empty-panel"><p>${esc(message)}</p>${hint ? `<p class="muted">${esc(hint)}</p>` : ''}</div>`;
}

// --- 차트 -------------------------------------------------------------------

// 인라인 SVG 하나. 라이브러리를 붙이지 않는 이유는 이 페이지의 유일한 그림이기 때문이고,
// 스크립트 없이 그려져야 크롤러와 JS 차단 환경에서도 내용이 남기 때문이다.
//
// SVG 안에는 선과 격자만 넣고 축 글자는 HTML 로 뺀다.
// 선을 가로로 늘려 채우려면 preserveAspectRatio="none" 이 필요한데, 그러면 같은 배율이
// 글자에도 걸려 축 라벨이 옆으로 늘어난다. 글자를 밖으로 빼면 어느 너비에서도 또렷하다.
export function lineChart(points, { label = '', valueLabel = '명' } = {}) {
  const clean = points.filter(p => isNum(p.y));
  if (clean.length < 2) return null;

  const ys = clean.map(p => p.y);
  const maxY = Math.max(...ys);
  const minY = Math.min(...ys);
  // 값이 완전히 평평해도(적재 초기) 선이 상자 밖으로 나가지 않도록 폭을 최소 1 로 잡는다.
  const span = Math.max(maxY - minY, 1);
  const top = maxY + span * 0.12;
  const bottom = Math.max(0, minY - span * 0.12);
  const range = Math.max(top - bottom, 1);

  // 좌표계는 0~100 정규화. 실제 크기는 CSS 가 정한다.
  const x = i => (i / (clean.length - 1)) * 100;
  const y = v => 100 - ((v - bottom) / range) * 100;

  const line = clean.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)} ${y(p.y).toFixed(2)}`).join(' ');
  const area = `${line} L100 100 L0 100 Z`;

  const levels = [top, bottom + range / 2, bottom];
  const grid = levels.map(value => `<line class="chart-grid" x1="0" y1="${y(value).toFixed(2)}" x2="100" y2="${y(value).toFixed(2)}"/>`).join('');
  const axis = levels.map(value =>
    `<span style="top:${y(value).toFixed(2)}%">${esc(num(Math.round(value)))}</span>`).join('');

  const first = clean[0].label ? esc(clean[0].label) : '';
  const last = clean[clean.length - 1].label ? esc(clean[clean.length - 1].label) : '';
  const desc = `${label} 최저 ${num(minY)}${valueLabel}, 최고 ${num(maxY)}${valueLabel}, 표본 ${clean.length}개`;

  return `<figure class="chart">` +
    `<div class="chart-plot"><div class="chart-axis">${axis}</div>` +
    `<svg class="chart-svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="${esc(desc)}">` +
    `${grid}<path d="${area}" class="chart-area"/><path d="${line}" class="chart-line"/></svg></div>` +
    (first || last ? `<div class="chart-xaxis"><span>${first}</span><span>${last}</span></div>` : '') +
    `<figcaption class="muted">${esc(desc)}</figcaption></figure>`;
}

// --- 문서 -------------------------------------------------------------------

const NAV = [
  { href: '/', label: '인기 차트' },
  { href: '/rising', label: '급상승' },
  { href: '/deals', label: '할인' },
  { href: '/charts/weekly', label: '주간 차트' },
  { href: '/genre', label: '장르' }
];

function nav(active) {
  return NAV.map(item =>
    `<a href="${item.href}"${item.href === active ? ' class="nav-active" aria-current="page"' : ''}>${esc(item.label)}</a>`
  ).join('');
}

function breadcrumbHtml(trail) {
  if (!trail?.length) return '';
  const items = trail.map((item, i) => {
    const last = i === trail.length - 1;
    const label = esc(item.label);
    return last ? `<li aria-current="page">${label}</li>` : `<li><a href="${esc(item.href)}">${label}</a></li>`;
  }).join('<li aria-hidden="true">/</li>');
  return `<nav class="breadcrumb" aria-label="현재 위치"><ol>${items}</ol></nav>`;
}

function breadcrumbLd(trail, origin) {
  if (!trail?.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((item, i) => ({
      '@type': 'ListItem', position: i + 1, name: item.label,
      ...(item.href ? { item: `${origin}${item.href}` } : {})
    }))
  };
}

export function layout({
  title, description, path, active = null, image = null,
  jsonLd = [], breadcrumb = [], body, noindex = false
}) {
  const origin = siteOrigin();
  const canonical = `${origin}${path}`;
  // 게임 페이지는 Steam 헤더를, 나머지는 브랜드 카드를 쓴다.
  // og:image 가 없으면 링크를 공유했을 때 그림 없이 글자만 나간다.
  // (og-cover.png 는 scripts/og-image.mjs 로 다시 뽑는다.)
  const ogImage = safeImage(image) || `${origin}/og-cover.png`;
  const structured = [...jsonLd, breadcrumbLd(breadcrumb, origin)].filter(Boolean);

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#101311">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex, follow">\n' : ''}<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:type" content="website">
<meta property="og:locale" content="ko_KR">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/pages.css">
${structured.map(jsonLdScript).join('\n')}
</head>
<body>
<a class="skip-link" href="#main">본문으로 건너뛰기</a>
<header class="site-header">
  <div class="header-inner">
    <a class="brand" href="/" aria-label="${esc(SITE_NAME)} 홈"><span class="brand-mark" aria-hidden="true">↗</span><span>steam<span class="brand-light">pulse</span><span class="brand-period">.</span></span></a>
    <nav aria-label="주 메뉴">${nav(active)}</nav>
    <span class="header-caption">FIND YOUR NEXT GAME</span>
  </div>
</header>
<main class="container" id="main">
${breadcrumbHtml(breadcrumb)}
${body}
</main>
<footer class="site-footer"><div class="container footer-inner"><a class="brand footer-brand" href="/">steam<span class="brand-light">pulse</span><span class="brand-period">.</span></a><p>Steam 공개 데이터로 발견하는 다음 게임.<br><span>Valve 및 Metacritic과 무관한 독립 프로젝트입니다.</span></p><a href="#main">맨 위로 ↑</a></div></footer>
</body>
</html>`;
}
