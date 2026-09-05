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
  $('#spotlights').hidden = false;
  $('#spotlights').innerHTML = state.games.slice(0, 3).map((game, i) => `<a class="spotlight" href="${escape(game.path)}">
    ${game.headerImage ? `<img src="${escape(game.headerImage)}" alt="" referrerpolicy="no-referrer">` : ''}<div class="spotlight-top"><span class="spotlight-tag">${i === 0 ? '● HOT RIGHT NOW' : `MOST PLAYED / 0${i + 1}`}</span><span class="spotlight-arrow" aria-hidden="true">↗</span></div>
    <div><h2>${escape(game.title)}</h2><div class="spotlight-stats"><strong>${fmt(game.players)}</strong><span>명 플레이 중</span></div></div><span class="spotlight-rank" aria-hidden="true">0${i + 1}</span></a>`).join('');
  $('#totalGames').textContent = state.games.length;
  $('#totalPlayers').textContent = `${fmt(state.games.reduce((sum, game) => sum + (game.players ?? 0), 0))}명`;
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

function renderTable() {
  const { all, games } = pageGames();
  writeUrl();
  const maxPlayers = state.games[0]?.players || 1;
  $('#gameRows').innerHTML = games.length ? games.map(game => `<tr class="game-row">
    <td class="rank-cell ${game.rank <= 3 ? 'top' : ''}">${String(game.rank ?? '—').padStart(2, '0')}</td>
    <td><a class="game-button" href="${escape(game.path)}">${imageMarkup(game)}<span class="game-text"><strong>${escape(game.title)}</strong><small>${escape(game.genres.slice(0, 2).join(' · ') || '인기 차트')}</small></span></a></td>
    <td class="numeric"><span class="player-number">${fmt(game.players)}</span><div class="player-track" aria-hidden="true"><i style="width:${Math.max(2, Math.min(100, (game.players || 0) / maxPlayers * 100))}%"></i></div></td>
    <td class="numeric peak-number">${fmt(game.peakToday)}</td>
    <td class="numeric">${Number.isFinite(game.positiveRatio) ? `<span class="review-score ${scoreClass(game.positiveRatio)}">${game.positiveRatio}%</span><span class="cell-sub">${fmt(game.reviewTotal)}개 리뷰</span>` : pending('집계 전')}</td>
    <td class="numeric">${game.metacritic ? `<span class="meta-score ${scoreClass(game.metacritic.score, true)}">${game.metacritic.score}</span>` : pending('미제공')}</td>
    <td class="numeric">${game.priceFormatted ? `<span class="price-value ${game.isFree ? 'free' : ''}">${escape(game.priceFormatted)}</span>${game.discount > 0 ? `<span class="cell-sub"><span class="discount">-${game.discount}%</span></span>` : ''}` : pending('가격 미확인')}</td>
  </tr>`).join('') : `<tr><td colspan="7" class="empty">${state.loading && !state.games.length ? '인기 순위를 불러오는 중입니다…' : state.error && !state.games.length ? '순위를 불러오지 못했습니다. 새로고침으로 다시 시도해 주세요.' : '검색에 맞는 게임이 없습니다. TOP 100 안에서 이름이나 게임 ID로 검색해 보세요.'}${state.query ? '<br><button class="button" data-reset-search>검색 초기화</button>' : ''}</td></tr>`;

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
    $('#updatedAt').textContent = `${clock(payload.updatedAt)} KST 기준`;
    $('#updatedAt').title = `서버 수신: ${clock(payload.retrievedAt)} KST`;
    renderSpotlights();
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
