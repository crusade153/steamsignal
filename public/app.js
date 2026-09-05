const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const fmt = value => Number.isFinite(value) ? new Intl.NumberFormat('ko-KR').format(value) : '—';
const clock = value => value ? new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul', hour12: false }).format(new Date(value)) : '확인 불가';
const state = { games: [], details: new Map(), page: 1, query: '', sort: 'players', chart: null, chartLoading: false, detailLoading: false, detailError: '', chartError: '', modalId: null, generation: 0 };
const pageSize = 20;
let detailsController;

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
function gameWithDetails(base) {
  const detail = state.details.get(base.appid)?.game;
  return { ...base, ...detail, title: detail?.title || base.title, headerImage: detail?.headerImage || base.headerImage, detailLoaded: Boolean(detail) };
}
function filteredGames() {
  const query = state.query.toLocaleLowerCase();
  const games = state.games.map(gameWithDetails).filter(game => !query || `${game.title} ${state.games.find(base => base.appid === game.appid)?.title} ${game.appid}`.toLocaleLowerCase().includes(query));
  return games.sort((a, b) => state.sort === 'name' ? a.title.localeCompare(b.title, 'ko') : state.sort === 'peak' ? (b.peakToday ?? -1) - (a.peakToday ?? -1) || a.rank - b.rank : a.rank - b.rank);
}
function pageGames() {
  const all = filteredGames();
  state.page = Math.min(Math.max(1, Math.ceil(all.length / pageSize)), state.page);
  return { all, games: all.slice((state.page - 1) * pageSize, state.page * pageSize) };
}
const scoreClass = (score, meta = false) => score === null || score === undefined ? '' : score >= (meta ? 75 : 80) ? '' : score >= (meta ? 50 : 40) ? 'mixed' : 'negative';
const loadingOrMissing = (game, label = '미제공') => `<span class="missing">${game.detailLoaded ? label : state.detailError ? '조회 실패' : '확인 중'}</span>`;
function imageMarkup(game, className = 'game-image') {
  return game.headerImage ? `<img class="${className}" src="${escape(game.headerImage)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="${className} fallback" aria-hidden="true">↗</span>`;
}
function renderSpotlights() {
  if (!state.games.length) { $('#spotlights').hidden = true; return; }
  $('#spotlights').hidden = false;
  $('#spotlights').innerHTML = state.games.slice(0, 3).map(gameWithDetails).map((game, i) => `<button class="spotlight" data-game="${game.appid}" aria-label="${escape(game.title)} 상세 정보">
    ${game.headerImage ? `<img src="${escape(game.headerImage)}" alt="" referrerpolicy="no-referrer">` : ''}<div class="spotlight-top"><span class="spotlight-tag">${i === 0 ? '● HOT RIGHT NOW' : `MOST PLAYED / 0${i + 1}`}</span><span class="spotlight-arrow" aria-hidden="true">↗</span></div>
    <div><h2>${escape(game.title)}</h2><div class="spotlight-stats"><strong>${fmt(game.players)}</strong><span>명 플레이 중</span></div></div><span class="spotlight-rank" aria-hidden="true">0${i + 1}</span></button>`).join('');
  $('#totalGames').textContent = state.games.length;
  $('#totalPlayers').textContent = `${fmt(state.games.reduce((sum, game) => sum + (game.players ?? 0), 0))}명`;
}
function renderNotices() {
  const notes = [];
  if (state.chartError) notes.push(state.chartError + (state.games.length ? ' 이전에 받은 순위를 표시하고 있습니다.' : ''));
  if (state.chart?.stale) notes.push('Steam 응답이 지연되어 마지막으로 받은 순위를 표시합니다. 갱신 시간을 확인해 주세요.');
  if (state.chart?.sources.names.status !== 'ok' && state.chart) notes.push('일부 게임 이름을 최신 상태로 확인하지 못했습니다. 게임 ID로도 검색할 수 있습니다.');
  if (state.games.length && state.games.length < 100) notes.push(`현재 Steam이 제공한 ${state.games.length}개의 게임을 표시합니다.`);
  $('#notice').hidden = !notes.length; $('#notice').textContent = notes.join(' ');
}
function renderTable() {
  const { all, games } = pageGames();
  writeUrl();
  const maxPlayers = state.games[0]?.players || 1;
  $('#gameRows').innerHTML = games.length ? games.map(game => `<tr class="game-row" data-appid="${game.appid}">
    <td class="rank-cell ${game.rank <= 3 ? 'top' : ''}">${game.rank.toString().padStart(2, '0')}</td>
    <td><button class="game-button" data-game="${game.appid}" aria-label="${escape(game.title)} 상세 정보">${imageMarkup(game)}<span class="game-text"><strong>${escape(game.title)}</strong><small>${escape(game.genres?.slice(0, 2).join(' · ') || (game.detailLoaded ? 'Steam 게임' : '인기 차트'))}</small></span></button></td>
    <td class="numeric"><span class="player-number">${fmt(game.players)}</span><div class="player-track" aria-hidden="true"><i style="width:${Math.max(2, Math.min(100, (game.players || 0) / maxPlayers * 100))}%"></i></div></td>
    <td class="numeric peak-number">${fmt(game.peakToday)}</td>
    <td class="numeric">${game.positiveRatio !== null && game.positiveRatio !== undefined ? `<span class="review-score ${scoreClass(game.positiveRatio)}">${game.positiveRatio}%</span><span class="cell-sub">${fmt(game.reviewTotal)}개 리뷰</span>` : loadingOrMissing(game, game.sources?.reviews.status === 'unavailable' ? '조회 불가' : '리뷰 없음')}</td>
    <td class="numeric">${game.metacritic ? `<span class="meta-score ${scoreClass(game.metacritic.score, true)}">${game.metacritic.score}</span>` : loadingOrMissing(game, game.sources?.details.status === 'unavailable' ? '조회 불가' : '미제공')}</td>
    <td class="numeric">${game.priceFormatted ? `<span class="price-value ${game.isFree ? 'free' : ''}">${escape(game.priceFormatted)}</span>${game.discount > 0 ? `<span class="cell-sub"><span class="discount">-${game.discount}%</span>${game.originalPrice ? `<span class="original-price">${escape(game.originalPrice)}</span>` : ''}</span>` : ''}` : loadingOrMissing(game, '가격 정보 없음')}</td>
  </tr>`).join('') : `<tr><td colspan="7" class="empty">${state.chartLoading && !state.games.length ? 'Steam 인기 순위를 불러오는 중입니다…' : state.chartError && !state.games.length ? '순위를 불러오지 못했습니다. 새로고침으로 다시 시도해 주세요.' : '검색에 맞는 게임이 없습니다. TOP 100 안에서 이름이나 게임 ID로 검색해 보세요.'}${state.query ? '<br><button class="button" data-reset-search>검색 초기화</button>' : ''}</td></tr>`;
  $('#resultCount').textContent = all.length ? `${all.length}개 게임 · ${(state.page - 1) * pageSize + 1}–${Math.min(state.page * pageSize, all.length)} 표시` : state.chartLoading ? '순위 확인 중' : '0개 게임';
  const partial = games.filter(game => game.sources && Object.values(game.sources).some(source => source.status !== 'ok')).length;
  $('#detailsStatus').textContent = state.detailLoading ? '평가·가격 확인 중…' : state.detailError || (partial ? `${partial}개 게임에 미수신 또는 이전 정보가 있습니다` : games.length ? '전체 리뷰 기준 · 평론가 점수 / 100' : '');
  const totalPages = Math.ceil(all.length / pageSize);
  $('#pagination').innerHTML = totalPages ? `<button class="edge" data-page="${state.page - 1}" ${state.page === 1 ? 'disabled' : ''} aria-label="이전 페이지">←</button>${Array.from({ length: totalPages }, (_, index) => `<button data-page="${index + 1}" aria-label="${index + 1}페이지" ${state.page === index + 1 ? 'aria-current="page"' : ''}>${index + 1}</button>`).join('')}<button class="edge" data-page="${state.page + 1}" ${state.page === totalPages ? 'disabled' : ''} aria-label="다음 페이지">→</button>` : '';
  $('#pageSummary').textContent = totalPages ? `${state.page} / ${totalPages} 페이지 · 페이지당 20개` : '검색 결과 없음';
  renderInsights(games);
}
function renderInsights(games) {
  const rated = games.filter(game => game.sources?.reviews.status === 'ok' && game.positiveRatio !== null && game.reviewTotal >= 1000);
  const crowd = [...rated].sort((a, b) => b.positiveRatio - a.positiveRatio || b.reviewTotal - a.reviewTotal)[0];
  const consensus = rated.filter(game => game.sources?.details.status === 'ok' && game.metacritic?.score >= 80 && game.positiveRatio >= 80).sort((a, b) => b.metacritic.score - a.metacritic.score)[0];
  const deal = rated.filter(game => game.sources?.details.status === 'ok' && game.discount > 0 && game.priceFormatted && game.positiveRatio >= 80).sort((a, b) => b.discount - a.discount)[0];
  const cards = [
    { label: 'THE PLAYER’S CHOICE', game: crowd, title: crowd?.title || '리뷰 규모까지 함께 보세요', text: crowd ? `긍정 ${crowd.positiveRatio}%, 리뷰 ${fmt(crowd.reviewTotal)}개. 현재 페이지에서 리뷰 1,000개 이상인 게임 중 긍정 비율이 가장 높습니다.` : '리뷰 1,000개 이상인 게임을 기준으로 유저들의 선택을 비교합니다. 아직 비교할 평가가 충분하지 않습니다.' },
    { label: 'PLAYERS & CRITICS', game: consensus, title: consensus?.title || '서로 다른 두 가지 시선', text: consensus ? `Steam 긍정 ${consensus.positiveRatio}% · 메타크리틱 ${consensus.metacritic.score}점. 유저와 평론가 모두에게 좋은 평가를 받은 게임입니다.` : 'Steam 긍정 80% 이상, 메타크리틱 80점 이상인 게임을 찾습니다. 현재 페이지에는 조건에 맞는 확인된 게임이 없습니다.' },
    { label: 'WORTH A LOOK', game: deal, title: deal?.title || '가격도 좋은 타이밍일까요?', text: deal ? `${deal.discount}% 할인, ${deal.priceFormatted}. 긍정 ${deal.positiveRatio}%로 평가도 좋은 게임입니다. 현재 페이지의 조건 충족 게임 중 할인율이 가장 높습니다.` : '긍정 80% 이상이고 할인 중인 게임을 살펴봅니다. 현재 페이지에는 조건에 맞는 확인된 할인이 없습니다.' }
  ];
  $('#insightScope').textContent = `현재 페이지 ${games.length}개 게임 기준`;
  $('#insightCards').innerHTML = cards.map(card => `<article class="insight-card"><div class="insight-label">${card.label}<span aria-hidden="true">↗</span></div><h3>${escape(card.title)}</h3><p>${escape(state.detailLoading && !card.game ? '평가와 가격을 확인하고 있습니다. 조회가 끝나면 비교 결과를 보여드립니다.' : card.text)}</p>${card.game ? `<button data-game="${card.game.appid}">게임 자세히 보기 <span aria-hidden="true">→</span></button>` : ''}</article>`).join('');
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '데이터를 불러오지 못했습니다.');
  return payload;
}
async function loadDetails() {
  const generation = ++state.generation;
  detailsController?.abort();
  detailsController = new AbortController();
  const ids = pageGames().games.filter(game => !state.details.has(game.appid) || Date.now() - state.details.get(game.appid).at > 10 * 60_000).map(game => game.appid);
  state.detailError = ''; state.detailLoading = ids.length > 0;
  renderTable();
  if (!ids.length) return;
  try {
    const payload = await fetchJson(`/api/game-details?ids=${ids.join(',')}`, AbortSignal.any([detailsController.signal, AbortSignal.timeout(55_000)]));
    if (generation !== state.generation) return;
    for (const game of payload.games) state.details.set(game.appid, { game, at: Date.now() });
  } catch (error) {
    if (generation !== state.generation) return;
    state.detailError = error.name === 'TimeoutError' ? '평가 조회가 지연됩니다. 새로고침으로 재시도해 주세요.' : error.message;
  } finally {
    if (generation === state.generation) { state.detailLoading = false; renderTable(); renderSpotlights(); if (state.modalId) renderModal(); }
  }
}
async function loadChart({ manual = false } = {}) {
  if (state.chartLoading) return;
  state.chartLoading = true;
  $('#refreshBtn').disabled = true;
  $('#refreshBtn').innerHTML = '<span aria-hidden="true">↻</span> 확인 중';
  if (manual) state.details.clear();
  try {
    const payload = await fetchJson('/api/games', AbortSignal.timeout(20_000));
    if (!Array.isArray(payload.games) || !payload.games.length) throw new Error('순위 응답에 게임이 없습니다.');
    state.chart = payload; state.games = payload.games; state.chartError = '';
    $('#updatedAt').textContent = `${clock(payload.updatedAt)} KST 기준`;
    $('#updatedAt').title = `서버 수신: ${clock(payload.retrievedAt)} KST`;
    renderSpotlights(); renderNotices();
    await loadDetails();
  } catch (error) { state.chartError = error.message; renderNotices(); }
  finally {
    state.chartLoading = false; $('#refreshBtn').disabled = false; $('#refreshBtn').innerHTML = '<span aria-hidden="true">↻</span> 새로고침';
    if (!state.games.length) { $('#spotlights').hidden = true; $('#updatedAt').textContent = '연결 확인 필요'; }
    renderTable();
  }
}
const sourceLabel = status => ({ ok: '확인됨', stale: '이전 정보', unavailable: '조회 불가' })[status] || '확인 중';
function renderModal() {
  const base = state.games.find(game => game.appid === state.modalId);
  if (!base) return;
  const game = gameWithDetails(base);
  $('#modalContent').innerHTML = `${game.headerImage ? `<img class="modal-hero" src="${escape(game.headerImage)}" alt="">` : ''}<div class="modal-body"><div class="modal-eyebrow">MOST PLAYED #${game.rank} · APP ${game.appid}</div><h2 id="modalTitle">${escape(game.title)}</h2><p class="modal-genres">${escape(game.genres?.join(' · ') || 'Steam 인기 게임')}${game.releaseDate ? ` · ${escape(game.releaseDate)} 출시` : ''}</p>${game.description ? `<p class="modal-description">${escape(game.description)}</p>` : ''}
    <div class="modal-metrics"><div class="modal-metric"><span>현재 플레이어</span><strong>${fmt(game.players)}</strong><small>순위 기준 ${clock(state.chart?.updatedAt)} KST</small></div><div class="modal-metric"><span>오늘 최고 동시접속자</span><strong>${fmt(game.peakToday)}</strong><small>Steam 제공 당일 최고치</small></div><div class="modal-metric"><span>Steam 전체 긍정 리뷰</span><strong class="review-score ${scoreClass(game.positiveRatio)}">${game.positiveRatio !== null && game.positiveRatio !== undefined ? `${game.positiveRatio}%` : '—'}</strong><small>${game.reviewTotal !== null && game.reviewTotal !== undefined ? `${fmt(game.reviewTotal)}개 리뷰 · 전체 언어` : '아직 확인된 리뷰가 없습니다'}</small></div><div class="modal-metric"><span>메타크리틱 · 평론가 평가</span><strong>${game.metacritic?.score ?? '—'}</strong><small>${game.metacritic ? 'PC · 100점 만점' : game.sources?.details.status === 'unavailable' ? '스토어 정보 조회 불가' : 'Steam 스토어에서 미제공'}</small></div></div>
    <div class="modal-price"><span>한국 스토어 가격</span><div>${game.discount > 0 ? `<span class="discount">-${game.discount}%</span> ` : ''}<strong>${escape(game.priceFormatted || '가격 정보 없음')}</strong></div></div>
    <p class="modal-note">Steam 평가는 유저 리뷰의 긍정 비율, 메타크리틱은 평론가 점수입니다. 서로 다른 평가 기준을 함께 참고하세요.</p>
    <div class="modal-actions"><a class="button primary" href="https://store.steampowered.com/app/${game.appid}/?cc=kr&l=koreana" target="_blank" rel="noopener noreferrer">Steam에서 보기 ↗</a>${game.metacritic?.url ? `<a class="button" href="${escape(game.metacritic.url)}" target="_blank" rel="noopener noreferrer">메타크리틱 원문 ↗</a>` : ''}<a class="button" href="https://store.steampowered.com/app/${game.appid}/#app_reviews_hash" target="_blank" rel="noopener noreferrer">유저 리뷰 읽기 ↗</a></div>
    <div class="source-stamps"><span>스토어·메타크리틱: ${sourceLabel(game.sources?.details.status)} · ${clock(game.sources?.details.retrievedAt)}</span><span>Steam 리뷰: ${sourceLabel(game.sources?.reviews.status)} · ${clock(game.sources?.reviews.retrievedAt)}</span></div></div>`;
}
function openModal(appid) {
  state.modalId = appid; renderModal();
  $('#gameDialog').showModal(); document.body.style.overflow = 'hidden';
  // Spotlight games may sit outside the currently viewed page.
  if (!state.details.has(appid)) {
    fetchJson(`/api/game-details?ids=${appid}`, AbortSignal.timeout(30_000)).then(payload => {
      for (const game of payload.games) state.details.set(game.appid, { game, at: Date.now() });
      if (state.modalId === appid) renderModal();
      renderTable();
    }).catch(() => { if (state.modalId === appid) { $('.source-stamps').textContent = '상세 정보 조회가 지연됩니다. 창을 닫고 다시 시도해 주세요.'; } });
  }
}
document.addEventListener('click', event => {
  const gameButton = event.target.closest('[data-game]');
  if (gameButton) openModal(Number(gameButton.dataset.game));
  const pageButton = event.target.closest('[data-page]');
  if (pageButton && !pageButton.disabled) { state.page = Number(pageButton.dataset.page); loadDetails(); $('#ranking').scrollIntoView({ behavior: 'instant' }); }
  if (event.target.closest('[data-reset-search]')) { state.query = ''; $('#search').value = ''; state.page = 1; loadDetails(); }
});
document.addEventListener('error', event => { if (event.target instanceof HTMLImageElement) event.target.style.visibility = 'hidden'; }, true);
$('#refreshBtn').addEventListener('click', () => loadChart({ manual: true }));
let searchTimer;
$('#search').addEventListener('input', event => { clearTimeout(searchTimer); state.query = event.target.value.trim().slice(0, 120); state.page = 1; renderTable(); searchTimer = setTimeout(loadDetails, 250); });
$('#sort').addEventListener('change', event => { state.sort = event.target.value; state.page = 1; loadDetails(); });
$('#modalClose').addEventListener('click', () => $('#gameDialog').close());
$('#gameDialog').addEventListener('click', event => { if (event.target === $('#gameDialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
$('#gameDialog').addEventListener('close', () => {
  const appid = state.modalId; state.modalId = null; document.body.style.overflow = '';
  (document.querySelector(`.game-button[data-game="${appid}"]`) || document.querySelector(`.spotlight[data-game="${appid}"]`) || $('#search')).focus({ preventScroll: true });
});
document.addEventListener('keydown', event => { if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !state.modalId) { event.preventDefault(); $('#search').focus(); } });
window.addEventListener('popstate', () => { readUrl(); loadDetails(); });
setInterval(() => { if (!document.hidden && !state.modalId && !state.detailLoading) loadChart(); }, 60_000);
readUrl(); loadChart();
