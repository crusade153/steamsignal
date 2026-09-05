// 고정 문서 페이지 — 개인정보처리방침 · 이용약관 · 문의 · ads.txt
//
// 애드센스 심사는 이 세 페이지(방침·약관·연락 수단)를 사실상 요구한다.
// 내용은 **이 사이트가 실제로 하는 일만** 적는다. 쓰지 않는 기술을 쓴다고 적으면
// 그건 방침이 아니라 거짓말이고, 심사에서도 코드와 대조되면 문제가 된다.
import { SITE_NAME, config, layout, esc, siteOrigin } from './render.mjs';

const CACHE_STATIC = 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';

const doc = (body, cache = CACHE_STATIC) => ({
  status: 200,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cache },
  body
});

// 마지막 개정일. 내용을 고치면 이 날짜도 같이 고친다.
export const POLICY_UPDATED = '2026-09-05';

const contactLine = () => (config.contactEmail
  ? `이메일 <a href="mailto:${esc(config.contactEmail)}">${esc(config.contactEmail)}</a>`
  : `<a href="${esc(config.repoUrl)}/issues" target="_blank" rel="noopener noreferrer">GitHub 이슈</a>`);

const section = (title, paragraphs) =>
  `<section class="doc-section"><h2>${esc(title)}</h2>${paragraphs.map(p => `<p>${p}</p>`).join('')}</section>`;

const list = items => `<ul class="doc-list">${items.map(item => `<li>${item}</li>`).join('')}</ul>`;

// --- 개인정보처리방침 -------------------------------------------------------

export function privacyPage() {
  const analytics = config.analytics
    ? '<strong>Vercel Web Analytics</strong>를 사용해 어떤 페이지가 얼마나 열렸는지 익명으로 집계합니다. 이 도구는 <strong>쿠키를 저장하지 않고</strong> 방문자를 식별하는 값을 남기지 않으므로, 이 사이트에는 쿠키 동의 배너가 없습니다.'
    : '현재 방문자 분석 도구를 사용하지 않습니다.';

  const ads = config.adsensePublisherId
    ? 'Google AdSense 광고를 게재합니다. Google 및 그 파트너는 광고 제공을 위해 쿠키를 사용할 수 있으며, 이는 <a href="https://policies.google.com/technologies/ads" target="_blank" rel="noopener noreferrer nofollow">Google 광고 정책</a>을 따릅니다. 광고 개인 최적화는 <a href="https://adssettings.google.com/" target="_blank" rel="noopener noreferrer nofollow">Google 광고 설정</a>에서 끌 수 있습니다.'
    : '현재 이 사이트에는 광고가 게재되지 않습니다. 향후 게재를 시작하면 이 항목을 먼저 갱신합니다.';

  const body = `
<article class="doc">
  <header class="page-intro">
    <div class="eyebrow">PRIVACY</div>
    <h1>개인정보처리방침</h1>
    <p>${SITE_NAME}(이하 "이 사이트")가 어떤 정보를 다루고 무엇을 다루지 않는지 적습니다. 최종 개정일 ${esc(POLICY_UPDATED)}.</p>
  </header>

  ${section('한 줄 요약', [
    '이 사이트는 <strong>회원가입이 없고, 이름·이메일·전화번호 같은 개인정보를 수집하지 않습니다.</strong> 위시리스트는 서버로 전송되지 않고 사용자의 브라우저 안에만 저장됩니다.'
  ])}

  ${section('1. 수집하지 않는 것', [
    '이 사이트는 계정 기능이 없습니다. 따라서 다음을 수집하거나 저장하지 않습니다.',
    list([
      '이름, 이메일 주소, 전화번호, 주소',
      '결제 수단이나 결제 이력 — 이 사이트에서는 아무것도 판매하지 않습니다',
      'Steam 계정 정보 — Steam 로그인을 요구하지 않으며 공개 데이터만 읽습니다',
      '주민등록번호 등 고유식별정보'
    ])
  ])}

  ${section('2. 브라우저에만 저장되는 것 — 위시리스트', [
    '위시리스트에 담은 게임 목록은 브라우저의 <code>localStorage</code>에 저장됩니다. 이 값은 <strong>서버로 전송되지 않고</strong>, 다른 기기나 다른 브라우저에서도 보이지 않으며, 운영자도 볼 수 없습니다.',
    '브라우저의 사이트 데이터를 지우거나 위시리스트 페이지에서 항목을 삭제하면 즉시 사라집니다. 별도의 요청 절차가 필요 없습니다.'
  ])}

  ${section('3. 자동으로 남는 것', [
    `<strong>접속 기록</strong> — 이 사이트는 Vercel Inc. 에서 호스팅됩니다. 웹 서버 특성상 요청 시각, 요청 경로, IP 주소, 브라우저 종류가 Vercel 의 서버 로그에 일시적으로 기록됩니다. 이는 서비스 운영과 장애 대응을 위한 것이며 운영자가 별도로 수집·보관하지 않습니다. Vercel 의 처리 방식은 <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer nofollow">Vercel 개인정보처리방침</a>을 따릅니다.`,
    `<strong>방문자 분석</strong> — ${analytics}`,
    `<strong>광고</strong> — ${ads}`
  ])}

  ${section('4. 이 사이트가 저장하는 데이터', [
    '이 사이트의 데이터베이스에는 <strong>게임에 관한 정보만</strong> 들어 있습니다. Steam 공개 API 에서 받은 게임 제목·장르·가격·리뷰 수와, 10분 간격으로 기록한 동시접속자 수치입니다. 방문자에 관한 정보는 들어 있지 않습니다.'
  ])}

  ${section('5. 외부로 나가는 요청', [
    '페이지를 열면 브라우저가 다음 도메인에 직접 요청을 보냅니다.',
    list([
      '<code>*.steamstatic.com</code> — 게임 대표 이미지 (Valve 의 CDN)',
      ...(config.analytics ? ['<code>/_vercel/insights</code> — 페이지뷰 집계 (같은 도메인)'] : []),
      ...(config.adsensePublisherId ? ['<code>pagead2.googlesyndication.com</code> — 광고'] : [])
    ]),
    '이 목록 밖의 제3자 스크립트는 사용하지 않습니다.'
  ])}

  ${section('6. 이용자의 권리', [
    `이 사이트가 보관하는 개인정보가 없으므로 열람·정정·삭제를 요청할 대상이 없습니다. 그럼에도 문의할 내용이 있으면 ${contactLine()}로 연락해 주세요.`,
    '만 14세 미만 아동을 대상으로 하지 않으며, 아동의 개인정보를 의도적으로 수집하지 않습니다.'
  ])}

  ${section('7. 방침의 변경', [
    '이 방침이 바뀌면 이 페이지의 최종 개정일을 함께 갱신합니다. 수집 항목이 늘어나는 변경(예: 이메일 구독 도입)은 시행 전에 이 페이지에 먼저 반영합니다.'
  ])}
</article>`;

  return doc(layout({
    title: `개인정보처리방침 | ${SITE_NAME}`,
    description: `${SITE_NAME}는 회원가입과 개인정보 수집이 없습니다. 위시리스트는 브라우저에만 저장되며 서버로 전송되지 않습니다.`,
    path: '/privacy',
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '개인정보처리방침' }],
    body
  }));
}

// --- 이용약관 ---------------------------------------------------------------

export function termsPage() {
  const body = `
<article class="doc">
  <header class="page-intro">
    <div class="eyebrow">TERMS</div>
    <h1>이용약관</h1>
    <p>${SITE_NAME} 이용에 적용되는 조건입니다. 최종 개정일 ${esc(POLICY_UPDATED)}.</p>
  </header>

  ${section('1. 서비스의 성격', [
    `${SITE_NAME}는 Steam 공개 데이터를 수집해 동시접속자·평가·가격의 추이를 보여 주는 무료 정보 사이트입니다. 회원가입이 없고 아무것도 판매하지 않습니다.`,
    '이 사이트는 <strong>Valve Corporation, Metacritic, Google 과 무관한 독립 프로젝트</strong>입니다. Steam 및 관련 상표는 Valve Corporation 의 자산이며, 게임 이미지와 상표는 각 권리자에게 속합니다.'
  ])}

  ${section('2. 데이터의 정확성과 한계', [
    '이 사이트의 수치는 Steam 이 공개한 값을 기계적으로 수집·집계한 것이며, <strong>정확성·완전성·최신성을 보증하지 않습니다.</strong>',
    list([
      '<strong>가격</strong>은 한국 스토어 기준이며 게임마다 순서대로 갱신되므로 실제 스토어 가격과 최대 한 시간까지 차이가 날 수 있습니다. <strong>구매 전 반드시 Steam 에서 실제 가격을 확인하세요.</strong>',
      '<strong>동시접속자 추이·역대 최고·역대 최저가</strong>는 이 사이트가 기록을 시작한 이후의 값입니다. 그 이전의 기록은 알 수 없으며, 기록이 없다는 것이 그런 일이 없었다는 뜻은 아닙니다.',
      '<strong>Steam 평가와 메타크리틱 점수</strong>는 서로 다른 지표입니다. 이 사이트는 둘을 합산한 점수를 만들지 않습니다.',
      'Steam 의 공개 엔드포인트가 바뀌거나 응답하지 않으면 일부 값이 비거나 갱신이 지연될 수 있습니다.'
    ]),
    '이 사이트의 정보에 근거한 구매 결정과 그 결과에 대해 운영자는 책임지지 않습니다.'
  ])}

  ${section('3. 이용 시 금지되는 행위', [
    list([
      '자동화된 수단으로 이 사이트에 과도한 요청을 보내 정상적인 운영을 방해하는 행위',
      '이 사이트나 연결된 시스템의 취약점을 이용하거나 무단으로 접근하려는 행위',
      '이 사이트의 내용을 출처 표시 없이 대량으로 복제해 동일한 성격의 서비스를 만드는 행위'
    ]),
    '연구·개인적 이용을 위한 인용은 출처를 밝히면 자유롭게 하셔도 됩니다.'
  ])}

  ${section('4. 외부 링크', [
    'Steam 스토어, 메타크리틱 등 외부 사이트로 연결되는 링크가 있습니다. 이 사이트는 외부 사이트의 내용이나 정책에 대해 책임지지 않습니다.'
  ])}

  ${section('5. 서비스의 변경과 중단', [
    '이 사이트는 개인이 운영하는 프로젝트로, 사전 고지 없이 기능이 바뀌거나 서비스가 중단될 수 있습니다. 무료로 제공되는 서비스이므로 이에 따른 손해를 배상하지 않습니다.'
  ])}

  ${section('6. 문의', [
    `약관에 관한 문의는 ${contactLine()}로 보내 주세요.`
  ])}
</article>`;

  return doc(layout({
    title: `이용약관 | ${SITE_NAME}`,
    description: `${SITE_NAME} 이용약관. 데이터의 한계와 책임 범위를 밝힙니다.`,
    path: '/terms',
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '이용약관' }],
    body
  }));
}

// --- 문의 -------------------------------------------------------------------

export function contactPage() {
  const channels = [
    config.contactEmail
      ? `<li><strong>이메일</strong><span><a href="mailto:${esc(config.contactEmail)}">${esc(config.contactEmail)}</a></span></li>`
      : null,
    `<li><strong>GitHub 이슈</strong><span><a href="${esc(config.repoUrl)}/issues" target="_blank" rel="noopener noreferrer">${esc(config.repoUrl.replace('https://', ''))}/issues</a></span></li>`
  ].filter(Boolean).join('');

  const body = `
<article class="doc">
  <header class="page-intro">
    <div class="eyebrow">CONTACT</div>
    <h1>문의</h1>
    <p>데이터가 이상하거나, 잘못된 정보를 발견했거나, 제안할 것이 있으면 알려 주세요. 개인이 운영하는 프로젝트라 답이 늦을 수 있습니다.</p>
  </header>

  ${section('연락 방법', ['<ul class="fact-list contact-list">' + channels + '</ul>'])}

  ${section('이런 제보가 특히 도움이 됩니다', [
    list([
      '<strong>숫자가 이상하다</strong> — 어느 게임의 어떤 값이 어떻게 이상한지, 본 시각과 함께 알려 주시면 기록과 대조할 수 있습니다',
      '<strong>가격이 스토어와 다르다</strong> — 게임 이름과 스토어의 실제 가격을 알려 주세요',
      '<strong>게임 정보가 비어 있다</strong> — 수집 순서상 아직 채워지지 않았을 수 있지만, 하루가 지나도 비어 있다면 알려 주세요',
      '<strong>권리 관련 요청</strong> — 이미지나 정보의 게재에 문제가 있다면 알려 주시는 대로 확인하고 조치하겠습니다'
    ])
  ])}

  ${section('자주 받는 질문', [
    '<strong>왜 어떤 게임은 평가나 가격이 비어 있나요?</strong> 게임 정보는 순서대로 돌아가며 갱신합니다. 한 바퀴에 약 한 시간이 걸리므로 새로 차트에 올라온 게임은 잠시 비어 보일 수 있습니다. 비어 있는 값을 0 이나 무료로 채우지 않는 것이 이 사이트의 원칙입니다.',
    '<strong>추이 그래프가 왜 짧은가요?</strong> 이 사이트는 자체적으로 기록한 시계열만 씁니다. 기록 이전의 과거는 만들어 낼 수 없어서, 시간이 지날수록 그래프가 길어집니다.',
    '<strong>순위가 Steam 과 다릅니다.</strong> 인기 차트는 Steam 이 공개한 현재 동시접속자 기준이고, 주간 차트는 최근 7일 평균이라 서로 다른 순위가 나옵니다.'
  ])}
</article>`;

  return doc(layout({
    title: `문의 | ${SITE_NAME}`,
    description: `${SITE_NAME}에 데이터 오류를 제보하거나 문의하는 방법.`,
    path: '/contact',
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '문의' }],
    body
  }));
}

// --- ads.txt ----------------------------------------------------------------

// 게시자 ID 가 없으면 404 다. 내용이 틀린 ads.txt 는 없는 것보다 나쁘다 —
// 크롤러가 이 파일을 권위 있는 목록으로 읽기 때문에, 잘못 적으면 정상 광고 요청까지 거부된다.
export function adsTxt() {
  if (!config.adsensePublisherId) {
    return {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=3600' },
      body: 'ads.txt not configured\n'
    };
  }
  const publisher = config.adsensePublisherId.replace(/^ca-/, '');
  return {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': CACHE_STATIC },
    body: `google.com, ${publisher}, DIRECT, f08c47fec0942fa0\n`
  };
}

// --- 위시리스트 -------------------------------------------------------------

// 내용은 브라우저 안에만 있으므로 서버는 껍데기만 그린다.
// 주소가 있어야 북마크·공유·뒤로가기가 되지만, 사람마다 다른 화면이라 색인 대상은 아니다.
export function watchlistPage() {
  const body = `
<section class="page-intro">
  <div class="eyebrow">WATCHLIST</div>
  <h1>내 위시리스트</h1>
  <p>담아 둔 게임의 <strong>현재 가격·할인·역대 최저가</strong>를 한 화면에서 봅니다. 목록은 이 브라우저에만 저장되며 서버로 전송되지 않습니다 — 계정도, 이메일도 필요 없습니다.</p>
</section>

<div id="watchlistStatus" class="table-status" role="status">위시리스트를 불러오는 중입니다…</div>
<div id="watchlistBody"></div>

<section class="panel source-note">
  <h2>어떻게 저장되나요</h2>
  <p class="muted">게임 상세 페이지의 <strong>위시리스트에 담기</strong> 버튼을 누르면 이 브라우저의 저장 공간(<code>localStorage</code>)에 게임 ID 만 기록됩니다. 다른 기기나 시크릿 창에서는 보이지 않고, 브라우저 데이터를 지우면 함께 사라집니다. 자세한 내용은 <a href="/privacy">개인정보처리방침</a>에 있습니다.</p>
</section>

<script type="module" src="/watchlist.js"></script>`;

  return doc(layout({
    title: `내 위시리스트 | ${SITE_NAME}`,
    description: '담아 둔 스팀 게임의 현재 가격, 할인, 역대 최저가를 한 화면에서 확인하세요. 계정 없이 이 브라우저에만 저장됩니다.',
    path: '/watchlist',
    active: '/watchlist',
    noindex: true,
    breadcrumb: [{ label: '인기 차트', href: '/' }, { label: '위시리스트' }],
    body
  }), 'no-store');
}

export const LEGAL_HANDLERS = {
  privacy: privacyPage,
  terms: termsPage,
  contact: contactPage,
  ads: adsTxt,
  watchlist: watchlistPage
};

export const staticDocPaths = () => [
  { path: '/privacy', priority: '0.3', changefreq: 'yearly' },
  { path: '/terms', priority: '0.3', changefreq: 'yearly' },
  { path: '/contact', priority: '0.4', changefreq: 'monthly' }
];

export const canonicalOrigin = siteOrigin;
