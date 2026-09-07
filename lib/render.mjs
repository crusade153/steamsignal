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

// 사이트 설정. 전부 환경변수라 코드를 고치지 않고 켜고 끌 수 있다.
//
// 셋 다 '없으면 아무것도 렌더링하지 않는다'가 원칙이다. 자리만 잡아 둔 빈 광고 칸이나
// 아직 못 받는 문의 주소를 화면에 내보내는 것보다, 없는 편이 낫다.
export const config = {
  // Vercel Web Analytics.
  //
  // /_vercel/insights/script.js 는 **대시보드에서 Web Analytics 를 켠 프로젝트에만** 존재한다.
  // 켜지 않은 상태로 스크립트 태그를 내보내면 방문자마다 404 요청이 하나씩 나가고
  // 콘솔에 MIME 오류가 남는다. 그래서 기본값은 꺼짐이고, 명시적으로 켜야 나간다.
  //
  // 켜는 순서: Vercel 대시보드 > Analytics > Enable  →  환경변수 VERCEL_WEB_ANALYTICS=1
  // 순서를 바꾸면 그사이에 404 가 나간다.
  analytics: process.env.VERCEL_WEB_ANALYTICS === '1',
  // 애드센스 게시자 ID (ca-pub-...). 승인 전에는 비워 둔다.
  adsensePublisherId: process.env.ADSENSE_PUBLISHER_ID || null,
  // 문의 주소. 애드센스 심사는 연락 수단을 요구한다.
  contactEmail: process.env.CONTACT_EMAIL || null,
  // 메일 발송 가능 여부. 두 값이 다 있어야 기능이 존재한다 —
  // 폼만 보이고 메일은 안 오는 '반쯤 켜진' 상태가 가장 나쁘다.
  // 이 플래그가 유일한 판정 기준이고 lib/mail.mjs 의 mailEnabled() 도 이걸 읽는다.
  mail: Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM),
  repoUrl: 'https://github.com/crusade153/steamsignal'
};

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

const kstDayNumber = value => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric'
  }).formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;
};

// Steam은 할인 종료 '시각'이 아니라 한국시간 상점에 렌더링된 달력 날짜만 제공한다.
// 가짜 시각을 붙이지 않고 날짜와 남은 일수만 보여 준다.
export function discountDeadlineCell(row, now = Date.now()) {
  const formatted = formatDay(row.discount_end_date);
  if (!formatted) {
    return row.discount_end_checked_at
      ? '<span class="missing">Steam 미제공</span>'
      : '<span class="missing">확인 중</span>';
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(row.discount_end_date));
  const endDay = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000;
  const left = Math.round(endDay - kstDayNumber(now));
  const urgency = left <= 3 ? ' deadline-soon' : '';
  const relative = left < 0 ? '종료일 지남' : left === 0 ? '오늘 종료' : left === 1 ? '내일 종료' : `${left}일 남음`;
  return `<span class="sale-deadline">${esc(formatted)}까지</span><span class="cell-sub${urgency}">${esc(relative)}</span>`;
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

// --- 표 ---------------------------------------------------------------------

// 표 하나를 만든다. 열 정의를 한곳에 모으는 이유가 둘 있다.
//
//   1. **열 순서가 어느 페이지에서나 같아야 한다.** 페이지마다 표를 손으로 적으면
//      반드시 어긋나고, 오가는 사람의 눈이 매번 열을 다시 찾게 된다(docs/PRODUCT.md §2-2).
//   2. **td 마다 data-label 이 붙는다.** 720px 아래에서 표는 카드가 되는데,
//      그때 thead 를 숨기므로 각 칸이 스스로 이름을 대야 한다(public/styles.css §7).
//      라벨 없이 카드로 만들면 숫자만 나열돼 무슨 값인지 알 수 없다.
//
// column = { label, head, headClass, cellClass, cell(row, index) }
//   label     열 이름. 헤더와 data-label 에 함께 쓴다. 비우면 라벨을 붙이지 않는다(동작 버튼 열).
//   head      헤더 칸의 HTML. 기본은 esc(label). 아이콘·툴팁이 붙는 열만 따로 준다.
//   cellClass 문자열 또는 (row, index) => 문자열.
const classAttr = value => (value ? ` class="${value}"` : '');

export function dataTable(columns, rows) {
  const head = columns.map(col =>
    `<th scope="col"${classAttr(col.headClass)}>${col.head ?? esc(col.label)}</th>`).join('');
  const body = rows.map((row, i) => `<tr>${columns.map(col => {
    const klass = typeof col.cellClass === 'function' ? col.cellClass(row, i) : col.cellClass;
    return `<td${classAttr(klass)}${col.label ? ` data-label="${esc(col.label)}"` : ''}>${col.cell(row, i)}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="table-scroll" tabindex="0"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const sparkHelp = label => label === '추적군 내 비중 변화'
  ? '전체 추적 게임의 동접 합계에서 이 게임이 차지하는 비중이 첫 표본보다 얼마나 변했는지 보여 줍니다.'
  : label === '전일 동시간 대비'
    ? '각 시각의 동접을 정확히 24시간 전 같은 시각과 비교한 변화율입니다.'
    : '각 날짜의 평균 동접을 바로 전날 평균과 비교한 변화율입니다.';

// 여러 페이지가 공유하는 열. 새 목록 페이지는 여기서 골라 쓰고, 정말 그 페이지에만
// 있는 열만 직접 적는다. 이게 "새 페이지당 CSS 추가 5줄 이하"를 지키는 실제 방법이다.
export const COL = {
  // 순위는 지표가 아니라 행의 머리다. 카드에서도 이름 위에 작게 얹힌다.
  rank: (label = '순위') => ({
    label,
    headClass: 'rank-column',
    cellClass: (row, i) => (i < 3 ? 'rank-cell top' : 'rank-cell'),
    cell: (row, i) => String(i + 1)
  }),
  game: (label = '게임') => ({
    label,
    headClass: 'game-column',
    cellClass: 'game-cell',
    // 첫 세 개만 eager 다. 나머지를 미리 받으면 첫 화면이 느려진다.
    cell: (row, i) => gameCell(row, { eager: i < 3 })
  }),
  players: (label = '현재 동접') => ({
    label,
    headClass: 'numeric',
    cellClass: 'numeric',
    cell: row => (isNum(row.players)
      ? `<span class="player-number">${esc(num(row.players))}</span>`
      : '<span class="missing">차트 밖</span>')
  }),
  review: (label = 'Steam 평가') => ({
    label, headClass: 'numeric review-column', cellClass: 'numeric review-column', cell: row => reviewCell(row)
  }),
  meta: (label = '메타크리틱') => ({
    label, headClass: 'numeric', cellClass: 'numeric', cell: row => metaScoreCell(row.metacritic_score, null)
  }),
  // 전일 대비 변화율. 표본이 얇으면 칸을 비우지 않고 '비교 준비 중'이라고 적는다 —
  // 빈 칸은 "추세가 없다"로 읽히지만 사실은 "아직 모른다"이다.
  spark: (label = '전일 대비') => ({
    label,
    head: `${esc(label)} <span title="${esc(sparkHelp(label))}" class="info-mark">ⓘ</span>`,
    headClass: 'spark-column',
    cellClass: 'spark-cell',
    cell: row => sparkline(row.spark, { label: `${row.title} ${label}` })
      || '<span class="missing">비교 준비 중</span>'
  }),
  // 콘솔 출시 배지. **없음과 모름을 구분한다** — 항목을 확정하지 못한 게임은 회색 물음표이고,
  // 확정했는데 그 기계에 없으면 아예 흐린 글자다. 둘을 같게 그리면
  // "안 나왔다"와 "우리가 모른다"가 한 칸이 되는데, 그건 정반대의 뜻이다.
  platforms: (label = '콘솔') => ({
    label,
    headClass: 'platform-column',
    cellClass: 'platform-cell',
    cell: row => {
      if (!row.platforms) return '<span class="missing">미확인</span>';
      const owned = new Set(row.platforms.map(item => item.platform));
      if (!owned.size) return '<span class="missing">PC 전용</span>';
      return `<span class="platform-badges">${CONSOLES
        .filter(console => owned.has(console.key))
        .map(console => `<span class="platform-badge ${console.key}">${esc(console.short)}</span>`)
        .join('')}</span>`;
    }
  }),
  price: (label = '가격') => ({
    label,
    headClass: 'numeric price-column',
    cellClass: 'numeric price-column',
    cell: row => priceCell(row) + (isNum(row.initial_price) && isNum(row.final_price) && row.initial_price > row.final_price
      ? `<span class="cell-sub original-price">${esc(won(row.initial_price))}</span>` : '')
  })
};

export function metaScoreCell(score, url) {
  if (!isNum(score)) return '<span class="missing">미제공</span>';
  const klass = score >= 75 ? '' : score >= 50 ? 'mixed' : 'negative';
  const badge = `<span class="meta-score ${klass}">${score}</span>`;
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${badge}</a>` : badge;
}

// 빈 상태. 형식이 하나여야 한다 — "없다"가 아니라 "**언제** 채워지는지"를 쓴다.
//
// 적재 초기에는 사용자가 이 화면을 자주 본다. 그래서 이건 예외 처리가 아니라
// 정식 화면이고, 여기서 "데이터가 없습니다"라고만 쓰면 사이트가 고장 난 것처럼 읽힌다.
// 첫 줄은 무엇이 없는지, 둘째 줄은 언제 생기는지다. 둘째 줄이 없으면 부르지 말 것.
export function emptyState(message, hint) {
  return '<div class="empty-panel">' +
    '<span class="empty-mark" aria-hidden="true">기록 중</span>' +
    `<p>${esc(message)}</p>${hint ? `<p class="muted">${esc(hint)}</p>` : ''}</div>`;
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

// 목록 한 행에 들어가는 미니 차트. 값은 전일 대비 증감률이며 모든 행이 같은 ±50% 축을 쓴다.
//
// 이게 있으면 목록에서 판단이 끝난다 — "이 게임 지금 할 만한가"에 답하는 데 필요한
// 클릭 수가 1에서 0이 된다(docs/PRODUCT.md §2-2). 그게 이 함수의 존재 이유다.
//
// 표본이 셋 미만이면 그리지 않는다. 두 점을 이으면 무조건 직선이 나오는데,
// 그 직선은 추세처럼 보이면서 아무것도 말해 주지 않는다 — 없는 편이 낫다.
export function sparkline(values, { label = '' } = {}) {
  const clean = (values ?? []).filter(isNum);
  if (clean.length < 3) return '';

  const max = Math.max(...clean);
  const min = Math.min(...clean);
  const limit = 50;
  const x = i => (i / (clean.length - 1)) * 100;
  const y = v => 50 - (Math.max(-limit, Math.min(limit, v)) / limit) * 50;

  const line = clean.map((value, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(value).toFixed(1)}`).join(' ');
  const latest = clean[clean.length - 1];
  const direction = latest > 0 ? 'up' : latest < 0 ? 'down' : 'flat';
  const signed = `${latest > 0 ? '+' : ''}${num(latest)}%`;
  const title = `${label || '전일 대비'} · 현재 ${signed}, 범위 ${num(min)}%~${num(max)}%, 표본 ${clean.length}개`;

  return `<span class="spark-wrap ${direction}" title="${esc(title)}">` +
    `<svg class="spark" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="${esc(title)}">` +
    `<line class="spark-zero" x1="0" y1="50" x2="100" y2="50"/><path d="${line}"/></svg>` +
    `<span class="spark-delta">${esc(signed)}</span></span>`;
}

// 표에 쓰는 콘솔 이름. lib/platforms.mjs 의 PLATFORMS 와 키가 같아야 한다 —
// render.mjs 는 DB 도 Steam 도 모르는 파일이라 그쪽을 import 하지 않고, 대신
// tests/pages.test.mjs 가 두 목록이 어긋나지 않는지 지킨다.
export const CONSOLES = [
  { key: 'playstation', short: 'PS', name: '플레이스테이션' },
  { key: 'xbox', short: 'Xbox', name: '엑스박스' },
  { key: 'switch', short: 'NS', name: '닌텐도 스위치' }
];

// --- 문서 -------------------------------------------------------------------

const NAV = [
  { href: '/', label: '인기 차트' },
  { href: '/rising', label: '급상승' },
  { href: '/deals', label: '할인' },
  { href: '/charts/weekly', label: '주간 차트' },
  { href: '/platform', label: '콘솔 출시' },
  { href: '/gamepass', label: 'Game Pass' },
  { href: '/genre', label: '장르' },
  { href: '/watchlist', label: '위시리스트' }
];

// 메일이 설정되지 않았으면 /alerts 는 404 이므로 링크도 내보내지 않는다.
export const footerLinks = () =>
  (config.mail ? FOOTER_LINKS : FOOTER_LINKS.filter(item => item.href !== '/alerts'));

export const FOOTER_LINKS = [
  { href: '/rising', label: '급상승' },
  { href: '/deals', label: '할인' },
  { href: '/deals/all-time-low', label: '역대 최저가' },
  { href: '/charts/weekly', label: '주간 차트' },
  { href: '/charts/monthly', label: '월간 차트' },
  { href: '/platform', label: '콘솔 출시' },
  { href: '/gamepass', label: 'Game Pass' },
  { href: '/genre', label: '장르' },
  { href: '/releases', label: '발매 연도' },
  { href: '/watchlist', label: '위시리스트' },
  { href: '/alerts', label: '가격 알림' },
  { href: '/status', label: '수집 상태' },
  // 계정은 자율 기능이라 주 메뉴(NAV)에 넣지 않는다. 상단에 두면 '가입해야 쓰는 사이트'로 읽힌다.
  { href: '/account/login', label: '로그인' },
  { href: '/privacy', label: '개인정보처리방침' },
  { href: '/terms', label: '이용약관' },
  { href: '/contact', label: '문의' },
  { href: '/sitemap.xml', label: '사이트맵' }
];

// Vercel Web Analytics. 쿠키를 쓰지 않고 개인 식별자를 남기지 않으므로
// 쿠키 동의 배너가 필요 없다 — 그래서 이걸 골랐다.
const analyticsScript = () => (config.analytics
  ? '<script defer src="/_vercel/insights/script.js"></script>'
  : '');

// 광고 슬롯. **높이를 미리 잡아 두는 게 이 함수의 존재 이유다.**
// 광고는 늦게 로드되면서 아래 내용을 밀어내는데, 그게 CLS 점수를 무너뜨리고
// 사용자가 누르려던 링크를 어긋나게 만든다. 자리를 먼저 비워 두면 둘 다 안 생긴다.
//
// 게시자 ID 가 없으면 빈 상자조차 그리지 않는다. 승인 전에 회색 네모를 띄울 이유가 없다.
export function adSlot(slotId, { label = '광고', minHeight = 280 } = {}) {
  if (!config.adsensePublisherId || !slotId) return '';
  return `<aside class="ad-slot" style="min-height:${Number(minHeight)}px" aria-label="${esc(label)}">` +
    `<ins class="adsbygoogle" style="display:block" data-ad-client="${esc(config.adsensePublisherId)}" ` +
    `data-ad-slot="${esc(slotId)}" data-ad-format="auto" data-full-width-responsive="true"></ins>` +
    '<script>(adsbygoogle=window.adsbygoogle||[]).push({});</script></aside>';
}

const adsenseLoader = () => (config.adsensePublisherId
  ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(config.adsensePublisherId)}" crossorigin="anonymous"></script>`
  : '');

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
${adsenseLoader()}
</head>
<body>
<a class="skip-link" href="#main">본문으로 건너뛰기</a>
<header class="site-header">
  <div class="header-inner">
    <a class="brand" href="/" aria-label="${esc(SITE_NAME)} 홈"><img class="brand-mark" src="/favicon.svg" alt="" width="33" height="33" decoding="async"><span>steam<span class="brand-light">pulse</span><span class="brand-period">.</span></span></a>
    <nav aria-label="주 메뉴">${nav(active)}</nav>
    <span class="header-caption">FIND YOUR NEXT GAME</span>
  </div>
</header>
<main class="container" id="main">
${breadcrumbHtml(breadcrumb)}
${body}
</main>
<footer class="site-footer"><div class="container footer-inner"><a class="brand footer-brand" href="/">steam<span class="brand-light">pulse</span><span class="brand-period">.</span></a><p>Steam 공개 데이터로 발견하는 다음 게임.<br><span>Valve 및 Metacritic과 무관한 독립 프로젝트입니다.</span></p><nav class="footer-links" aria-label="사이트 메뉴">${footerLinks().map(item => `<a href="${item.href}">${esc(item.label)}</a>`).join('')}</nav></div></footer>
${analyticsScript()}
</body>
</html>`;
}
