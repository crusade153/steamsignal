// 인기 차트 화면.
//
// 예전에는 목록(/api/games)과 상세(/api/game-details)를 나눠 부르고 게임을 모달로 열었다.
// 지금은 /api/games 한 번이 평가·가격까지 다 준다(수집기가 미리 채워 둔 DB 를 읽으므로 느리지 않다).
// 그리고 게임은 모달이 아니라 /game/<slug> 페이지로 연다 — 모달은 주소가 없어서
// 공유도 색인도 되지 않고, 광고 수익의 단위인 '페이지뷰'로도 세어지지 않는다.

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const fmt = value => Number.isFinite(value) ? new Intl.NumberFormat('ko-KR').format(value) : '—';
const clock = value => value ? new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul', hour12: false }).format(new Date(value)) : '확인 불가';

const state = { games: [], page: 1, query: '', sort: 'players', chart: null, loading: false, error: '' };
const pageSize = 20;

function readUrl() {
  const params = new URLSearchParams(location.search);
  state.page = Math.max(1, Math.min(5, Math.floor(Number(params.get('page')) || 1)));
  state.query = (params.get('q') || '').slice(0, 120);
  state.sort = ['players', 'peak', 'name'].includes(params.get('sort')) ? params.get('sort') : 'players';
  $('#search').value = state.query; $('#sort').value = state.sort;
}
function writeUrl() {
  const params = new URLSearchParams();
  if (state.page > 1) params.set('page', state.page);
  if (state.query) params.set('q', state.query);
  if (state.sort !== 'players') params.set('sort', state.sort);
  const query = params.toString();
  history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
}

function filteredGames() {
  const query = state.query.toLocaleLowerCase();
  const games = state.games.filter(game => !query || `${game.title} ${game.appid}`.toLocaleLowerCase().includes(query));
  return games.sort((a, b) =>
    state.sort === 'name' ? a.title.localeCompare(b.title, 'ko')
      : state.sort === 'peak' ? (b.peakToday ?? -1) - (a.peakToday ?? -1) || a.rank - b.rank
        : a.rank - b.rank);
}
function pageGames() {
  const all = filteredGames();
  state.page = Math.min(Math.max(1, Math.ceil(all.length / pageSize)), state.page);
  return { all, games: all.slice((state.page - 1) * pageSize, state.page * pageSize) };
}

const scoreClass = (score, meta = false) => score === null || score === undefined ? '' : score >= (meta ? 75 : 80) ? '' : score >= (meta ? 50 : 40) ? 'mixed' : 'negative';
const imageMarkup = (game, className = 'game-image') => game.headerImage
  ? `<img class="${className}" src="${escape(game.headerImage)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
  : `<span class="${className} fallback" aria-hidden="true">↗</span>`;

function renderSpotlights() {
  if (!state.games.length) { $('#spotlights').hidden = true; return; }
  // 자리표시를 지우는 것도 이 함수의 일이다. 값이 왔는데 스켈레톤이 남아 있으면
  // 사용자는 '아직 로딩 중'으로 읽는다.
  $('#spotlights').hidden = false;
  $('#spotlights').innerHTML = state.games.slice(0, 3).map((game, i) => `<a class="spotlight" href="${escape(game.path)}">
    ${game.headerImage ? `<img src="${escape(game.headerImage)}" alt="" referrerpolicy="no-referrer">` : ''}<div class="spotlight-top"><span class="spotlight-tag">${i === 0 ? '● HOT RIGHT NOW' : `MOST PLAYED / 0${i + 1}`}</span><span class="spotlight-arrow" aria-hidden="true">↗</span></div>
    <div><h2>${escape(game.title)}</h2><div class="spotlight-stats"><strong>${fmt(game.players)}</strong><span>명 플레이 중</span></div></div><span class="spotlight-rank" aria-hidden="true">0${i + 1}</span></a>`).join('');
  // 합계는 순위표 제목 옆 한 줄로 붙인다. 예전에는 이것만을 위한 띠가 따로 있었는데,
  // 그 띠가 첫 화면에서 60px 넘게 차지하면서 정작 게임을 밀어냈다.
  const total = state.games.reduce((sum, game) => sum + (game.players ?? 0), 0);
  const summary = $('#chartSummary');
  if (summary) summary.textContent = `TOP ${state.games.length} · 지금 ${fmt(total)}명이 플레이 중`;
}

// '오늘의 변화'. 홈이 TOP 100 순위표뿐이면 어제와 오늘이 거의 같아서 다시 올 이유가 없다.
// 순위표는 그대로 두고, **달라진 것만** 위로 끌어올린다(docs/PRODUCT.md §3).
//
// 계산은 전부 이미 받아 온 목록 안에서 한다. 서버에 질문을 하나 더 만들면
// 홈이 느려지는 대신 얻는 게 없다 — 필요한 값(change)이 이미 각 행에 붙어 있다.
function renderChanges() {
  const section = $('#todayChanges');
  if (!section) return;
  if (!state.games.length) { section.hidden = true; return; }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const climbers = state.games
    .filter(game => Number.isFinite(game.change?.rankChange) && game.change.rankChange > 0)
    .sort((a, b) => b.change.rankChange - a.change.rankChange);
  const newcomers = state.games.filter(game => !game.change || !Number.isFinite(game.change.rankChange));
  // '오늘 시작된 할인'은 가격이 바뀐 시각이 오늘(KST)인 것만이다.
  // 지금 할인 중인 것 전부를 여기 쓰면 어제와 같은 목록이 되어 '변화'가 아니게 된다.
  const fresh = state.games.filter(game =>
    game.discount > 0 && game.change?.priceChangedAt
    && new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(game.change.priceChangedAt)) === today)
    .sort((a, b) => b.discount - a.discount);

  // 큰 카드가 아니라 한 줄짜리 타일이다. 이 구역이 세로로 길어지면 정작 순위표가
  // 첫 화면 밖으로 밀려난다 — '오늘의 변화'를 보여 주려다 게임을 안 보이게 하는 셈이다.
  const tile = (label, headline, note, href) => {
    const inner = `<span class="change-label">${label}</span>` +
      `<strong>${escape(headline)}</strong><span class="change-note">${note}</span>`;
    return href
      ? `<a class="change-tile" href="${escape(href)}">${inner}<span class="change-arrow" aria-hidden="true">→</span></a>`
      : `<div class="change-tile is-empty">${inner}</div>`;
  };

  const top = climbers[0];
  const deal = fresh[0];
  section.hidden = false;
  section.querySelector('.change-cards').innerHTML = [
    tile('BIGGEST CLIMB',
      top ? top.title : '아직 움직인 순위가 없습니다',
      top
        ? `<span class="move up">▲${top.change.rankChange}</span> ${top.change.prevRank}위 → ${top.rank}위${climbers.length > 1 ? ` · 오른 게임 ${climbers.length}개` : ''}`
        : `${escape('어제 기록이 쌓이면 여기에 나옵니다')}`,
      top?.path),
    tile('NEW IN THE CHART',
      newcomers.length ? `${newcomers.length}개 게임이 새로 보입니다` : '새로 들어온 게임 없음',
      newcomers.length
        ? escape(`${newcomers.slice(0, 2).map(game => game.title).join(', ')}${newcomers.length > 2 ? ' 외' : ''}`)
        : escape('지금 순위의 게임은 모두 어제도 있었습니다'),
      newcomers[0]?.path),
    tile('DISCOUNT STARTED TODAY',
      deal ? deal.title : '오늘 시작된 할인 없음',
      deal
        ? `<span class="discount">-${deal.discount}%</span> ${escape(deal.priceFormatted || '')}${fresh.length > 1 ? ` · 오늘 ${fresh.length}개` : ''}`
        : escape('가격이 바뀌면 그 시각을 기록합니다'),
      deal ? deal.path : null)
  ].join('');
}

function renderNotices() {
  const notes = [];
  if (state.error) notes.push(state.error);
  if (state.chart?.stale) notes.push('수집이 25분 이상 갱신되지 않았습니다. 마지막으로 기록된 순위를 표시합니다.');
  if (state.games.length && state.games.length < 100) notes.push(`현재 ${state.games.length}개의 게임을 표시합니다.`);
  $('#notice').hidden = !notes.length; $('#notice').textContent = notes.join(' ');
}

// 결측은 0 이 아니다. 아직 수집이 그 게임 차례에 닿지 않았다는 뜻으로 적는다.
const pending = label => `<span class="missing">${label}</span>`;

// 열 이름은 서버가 정한다. 첫 24시간의 추적군 비중, 전일 동시간, 일평균 전일 대비는
// 서로 다른 질문이므로 실제로 계산한 비교 기준을 그대로 적는다.
const sparkLabel = () => state.chart?.sparkLabel || '전일 대비';

const sparkHelp = label => label === '추적군 내 비중 변화'
  ? '전체 추적 게임의 동접 합계에서 이 게임이 차지하는 비중이 첫 표본보다 얼마나 변했는지 보여 줍니다.'
  : label === '전일 동시간 대비'
    ? '각 시각의 동접을 정확히 24시간 전 같은 시각과 비교한 변화율입니다.'
    : '각 날짜의 평균 동접을 바로 전날 평균과 비교한 변화율입니다.';

// 목록 행의 미니 차트. lib/render.mjs 의 sparkline() 과 같은 규칙이다 —
// 표본이 셋 미만이면 그리지 않는다. 두 점을 이으면 무조건 직선이 나오는데
// 그 직선은 추세처럼 보이면서 아무것도 말해 주지 않는다.
function spark(game) {
  const points = (game.spark || []).filter(Number.isFinite);
  if (points.length < 3) return pending('비교 준비 중');
  const max = Math.max(...points);
  const min = Math.min(...points);
  const limit = 50;
  const y = value => 50 - (Math.max(-limit, Math.min(limit, value)) / limit) * 50;
  const path = points.map((value, i) =>
    `${i ? 'L' : 'M'}${((i / (points.length - 1)) * 100).toFixed(1)} ${y(value).toFixed(1)}`).join(' ');
  const latest = points[points.length - 1];
  const direction = latest > 0 ? 'up' : latest < 0 ? 'down' : 'flat';
  const signed = `${latest > 0 ? '+' : ''}${fmt(latest)}%`;
  const label = `${game.title} ${sparkLabel()} · 현재 ${signed}, 범위 ${fmt(min)}%~${fmt(max)}%, 표본 ${points.length}개`;
  return `<span class="spark-wrap ${direction}" title="${escape(label)}"><svg class="spark" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="${escape(label)}"><line class="spark-zero" x1="0" y1="50" x2="100" y2="50"/><path d="${path}"/></svg><span class="spark-delta">${escape(signed)}</span></span>`;
}

// 순위 변동 칩. 목록에서 가장 값싼 재방문 장치다 — 어제와 오늘이 다르다는 걸
// 한 글자로 말해 준다(docs/PRODUCT.md §3).
//
// 비교할 직전 순위가 없으면 0 이나 '—' 가 아니라 NEW 다. 다만 NEW 는
// "우리 기록에서 처음 본다"는 뜻이지 "Steam 에 새로 나왔다"가 아니므로 그렇게 적는다.
// 어제로 못 박지 않고 실제로 비교한 날짜를 툴팁에 밝힌다 — 차트 밖에 있던 날은
// 순위가 없어서 그 앞날과 비교되기 때문이다.
function rankMove(game) {
  const change = game.change;
  if (!change || !Number.isFinite(change.rankChange)) {
    return '<span class="move new" title="이 게임이 순위에 있는 것을 기록상 처음 봅니다">NEW</span>';
  }
  const since = change.since ? `${change.since} 최고 ${change.prevRank}위 대비` : '직전 기록 대비';
  if (change.rankChange > 0) return `<span class="move up" title="${escape(since)}">▲${change.rankChange}</span>`;
  if (change.rankChange < 0) return `<span class="move down" title="${escape(since)}">▼${-change.rankChange}</span>`;
  return `<span class="move flat" title="${escape(since)}">—</span>`;
}

function renderTable() {
  const { all, games } = pageGames();
  writeUrl();
  $('#gameRows').removeAttribute('aria-busy');
  const maxPlayers = state.games[0]?.players || 1;
  // data-label 은 장식이 아니다. 720px 아래에서 표가 카드로 바뀌면서 thead 가 숨겨지고,
  // 그때 각 칸이 이 값으로 스스로 이름을 댄다(styles.css §7). 빠지면 숫자만 나열된다.
  $('#gameRows').innerHTML = games.length ? games.map(game => `<tr class="game-row">
    <td class="rank-cell ${game.rank <= 3 ? 'top' : ''}" data-label="순위">${String(game.rank ?? '—').padStart(2, '0')}${rankMove(game)}</td>
    <td class="game-cell"><a class="game-button" href="${escape(game.path)}">${imageMarkup(game)}<span class="game-text"><strong>${escape(game.title)}</strong><small>${escape(game.genres.slice(0, 2).join(' · ') || '인기 차트')}</small></span></a></td>
    <td class="numeric" data-label="현재 플레이어"><span class="player-number">${fmt(game.players)}</span><div class="player-track" aria-hidden="true"><i style="width:${Math.max(2, Math.min(100, (game.players || 0) / maxPlayers * 100))}%"></i></div></td>
    <td class="numeric peak-number" data-label="오늘 최고">${fmt(game.peakToday)}</td>
    <td class="spark-cell" data-label="${escape(sparkLabel())}">${spark(game)}</td>
    <td class="numeric review-column" data-label="Steam 평가">${Number.isFinite(game.positiveRatio) ? `<span class="review-score ${scoreClass(game.positiveRatio)}">${game.positiveRatio}%</span><span class="cell-sub">${fmt(game.reviewTotal)}개 리뷰</span>` : pending('집계 전')}</td>
    <td class="numeric" data-label="메타크리틱">${game.metacritic ? `<span class="meta-score ${scoreClass(game.metacritic.score, true)}">${game.metacritic.score}</span>` : pending('미제공')}</td>
    <td class="numeric price-column" data-label="현재 가격">${game.priceFormatted ? `<span class="price-value ${game.isFree ? 'free' : ''}">${escape(game.priceFormatted)}</span>${game.discount > 0 ? `<span class="cell-sub"><span class="discount">-${game.discount}%</span></span>` : ''}` : pending('가격 미확인')}</td>
  </tr>`).join('') : `<tr><td colspan="8" class="empty">${state.loading && !state.games.length ? '인기 순위를 불러오는 중입니다…' : state.error && !state.games.length ? '순위를 불러오지 못했습니다. 새로고침으로 다시 시도해 주세요.' : '검색에 맞는 게임이 없습니다. TOP 100 안에서 이름이나 게임 ID로 검색해 보세요.'}${state.query ? '<br><button class="button" data-reset-search>검색 초기화</button>' : ''}</td></tr>`;

  $('#resultCount').textContent = all.length ? `${all.length}개 게임 · ${(state.page - 1) * pageSize + 1}–${Math.min(state.page * pageSize, all.length)} 표시` : state.loading ? '순위 확인 중' : '0개 게임';
  const missing = games.filter(game => !Number.isFinite(game.positiveRatio) || !game.priceFormatted).length;
  $('#detailsStatus').textContent = missing ? `${missing}개 게임은 평가·가격 수집을 기다리는 중입니다` : games.length ? '전체 리뷰 기준 · 평론가 점수 / 100' : '';

  const totalPages = Math.ceil(all.length / pageSize);
  $('#pagination').innerHTML = totalPages ? `<button class="edge" data-page="${state.page - 1}" ${state.page === 1 ? 'disabled' : ''} aria-label="이전 페이지">←</button>${Array.from({ length: totalPages }, (_, index) => `<button data-page="${index + 1}" aria-label="${index + 1}페이지" ${state.page === index + 1 ? 'aria-current="page"' : ''}>${index + 1}</button>`).join('')}<button class="edge" data-page="${state.page + 1}" ${state.page === totalPages ? 'disabled' : ''} aria-label="다음 페이지">→</button>` : '';
  $('#pageSummary').textContent = totalPages ? `${state.page} / ${totalPages} 페이지 · 페이지당 20개` : '검색 결과 없음';
  renderInsights(games);
}

function renderInsights(games) {
  const rated = games.filter(game => Number.isFinite(game.positiveRatio) && game.reviewTotal >= 1000);
  const crowd = [...rated].sort((a, b) => b.positiveRatio - a.positiveRatio || b.reviewTotal - a.reviewTotal)[0];
  const consensus = rated.filter(game => game.metacritic?.score >= 80 && game.positiveRatio >= 80).sort((a, b) => b.metacritic.score - a.metacritic.score)[0];
  const deal = rated.filter(game => game.discount > 0 && game.priceFormatted && game.positiveRatio >= 80).sort((a, b) => b.discount - a.discount)[0];
  const cards = [
    { label: 'THE PLAYER’S CHOICE', game: crowd, title: crowd?.title || '리뷰 규모까지 함께 보세요', text: crowd ? `긍정 ${crowd.positiveRatio}%, 리뷰 ${fmt(crowd.reviewTotal)}개. 현재 페이지에서 리뷰 1,000개 이상인 게임 중 긍정 비율이 가장 높습니다.` : '리뷰 1,000개 이상인 게임을 기준으로 유저들의 선택을 비교합니다. 아직 비교할 평가가 충분하지 않습니다.' },
    { label: 'PLAYERS & CRITICS', game: consensus, title: consensus?.title || '서로 다른 두 가지 시선', text: consensus ? `Steam 긍정 ${consensus.positiveRatio}% · 메타크리틱 ${consensus.metacritic.score}점. 유저와 평론가 모두에게 좋은 평가를 받은 게임입니다.` : 'Steam 긍정 80% 이상, 메타크리틱 80점 이상인 게임을 찾습니다. 현재 페이지에는 조건에 맞는 게임이 없습니다.' },
    { label: 'WORTH A LOOK', game: deal, title: deal?.title || '가격도 좋은 타이밍일까요?', text: deal ? `${deal.discount}% 할인, ${deal.priceFormatted}. 긍정 ${deal.positiveRatio}%로 평가도 좋은 게임입니다. 현재 페이지의 조건 충족 게임 중 할인율이 가장 높습니다.` : '긍정 80% 이상이고 할인 중인 게임을 살펴봅니다. 현재 페이지에는 조건에 맞는 할인이 없습니다.' }
  ];
  $('#insightScope').textContent = `현재 페이지 ${games.length}개 게임 기준`;
  $('#insightCards').innerHTML = cards.map(card => `<article class="insight-card"><div class="insight-label">${card.label}<span aria-hidden="true">↗</span></div><h3>${escape(card.title)}</h3><p>${escape(card.text)}</p>${card.game ? `<a href="${escape(card.game.path)}">게임 자세히 보기 <span aria-hidden="true">→</span></a>` : ''}</article>`).join('');
}

async function loadChart() {
  if (state.loading) return;
  state.loading = true;
  $('#refreshBtn').disabled = true;
  $('#refreshBtn').innerHTML = '<span aria-hidden="true">↻</span> 확인 중';
  try {
    const response = await fetch('/api/games', { signal: AbortSignal.timeout(20_000) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '데이터를 불러오지 못했습니다.');
    if (!Array.isArray(payload.games) || !payload.games.length) throw new Error('순위 응답에 게임이 없습니다.');
    state.chart = payload; state.games = payload.games; state.error = '';
    const sparkHead = document.querySelector('.spark-column');
    if (sparkHead) {
      sparkHead.innerHTML = `${escape(sparkLabel())} <span title="${escape(sparkHelp(sparkLabel()))}" class="info-mark">ⓘ</span>`;
    }
    $('#updatedAt').textContent = `${clock(payload.updatedAt)} KST 기준`;
    $('#updatedAt').title = `서버 수신: ${clock(payload.retrievedAt)} KST`;
    renderSpotlights();
    renderChanges();
  } catch (error) {
    state.error = error.name === 'TimeoutError' ? '응답이 지연됩니다. 잠시 후 다시 시도해 주세요.' : error.message;
    if (!state.games.length) { $('#spotlights').hidden = true; $('#updatedAt').textContent = '연결 확인 필요'; }
  } finally {
    state.loading = false;
    $('#refreshBtn').disabled = false;
    $('#refreshBtn').innerHTML = '<span aria-hidden="true">↻</span> 새로고침';
    renderNotices();
    renderTable();
  }
}

document.addEventListener('click', event => {
  const pageButton = event.target.closest('[data-page]');
  if (pageButton && !pageButton.disabled) { state.page = Number(pageButton.dataset.page); renderTable(); $('#ranking').scrollIntoView({ behavior: 'instant' }); }
  if (event.target.closest('[data-reset-search]')) { state.query = ''; $('#search').value = ''; state.page = 1; renderTable(); }
});
document.addEventListener('error', event => { if (event.target instanceof HTMLImageElement) event.target.style.visibility = 'hidden'; }, true);
$('#refreshBtn').addEventListener('click', () => loadChart());
$('#search').addEventListener('input', event => { state.query = event.target.value.trim().slice(0, 120); state.page = 1; renderTable(); });
$('#sort').addEventListener('change', event => { state.sort = event.target.value; state.page = 1; renderTable(); });
document.addEventListener('keydown', event => { if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); $('#search').focus(); } });
window.addEventListener('popstate', () => { readUrl(); renderTable(); });
// 수집이 10분 주기라 5분마다 확인하면 충분하다. 예전의 1분 주기는 DB 를 헛돌게 할 뿐이다.
setInterval(() => { if (!document.hidden) loadChart(); }, 5 * 60_000);
readUrl(); loadChart();
