// 위시리스트 — 브라우저에만 저장되는 목록.
//
// 계정도 서버 저장도 없다. localStorage 에 appid 만 담고, 화면을 그릴 때
// /api/game-details 로 현재 값을 받아 온다. 그래서 개인정보를 수집하지 않으면서도
// "담아 둔 게임이 지금 얼마인가"를 답할 수 있다.
//
// localStorage 는 시크릿 창·차단 설정에서 예외를 던진다. 전부 try/catch 로 감싸고,
// 실패해도 페이지는 그대로 뜨게 한다.

const KEY = 'steampulse:watchlist:v1';
const LIMIT = 20; // /api/game-details 의 계약과 같다

export function readList() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, LIMIT);
  } catch { return []; }
}

export function writeList(ids) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids.slice(0, LIMIT)));
    return true;
  } catch { return false; }
}

export const has = appid => readList().includes(appid);

export function toggle(appid) {
  const ids = readList();
  const index = ids.indexOf(appid);
  if (index >= 0) ids.splice(index, 1);
  else if (ids.length >= LIMIT) return { ok: false, reason: 'full', added: false };
  else ids.unshift(appid);
  return { ok: writeList(ids), added: index < 0, count: ids.length };
}

// --- 목록 화면 ---------------------------------------------------------------

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const fmt = value => Number.isFinite(value) ? new Intl.NumberFormat('ko-KR').format(value) : '—';

function emptyState() {
  return `<div class="empty-panel">
    <p>아직 담아 둔 게임이 없습니다.</p>
    <p class="muted">게임 상세 페이지에서 <strong>위시리스트에 담기</strong>를 누르면 여기에 모입니다. 최대 ${LIMIT}개까지 담을 수 있습니다.</p>
    <p style="margin-top:18px"><a class="button" href="/">인기 차트에서 게임 찾기</a></p>
  </div>`;
}

function row(game) {
  const price = game.priceFormatted
    ? `<span class="price-value ${game.isFree ? 'free' : ''}">${game.discount > 0 ? `<span class="discount">-${game.discount}%</span>` : ''}${escape(game.priceFormatted)}</span>`
    : '<span class="missing">가격 미확인</span>';
  const review = Number.isFinite(game.positiveRatio)
    ? `<span class="review-score ${game.positiveRatio >= 80 ? '' : game.positiveRatio >= 40 ? 'mixed' : 'negative'}">${game.positiveRatio}%</span><span class="cell-sub">${fmt(game.reviewTotal)}개 리뷰</span>`
    : '<span class="missing">집계 전</span>';
  const image = game.headerImage
    ? `<img class="game-image" src="${escape(game.headerImage)}" alt="" width="96" height="47" loading="lazy" decoding="async">`
    : '<span class="game-image fallback" aria-hidden="true">▦</span>';

  return `<tr>
    <td><a class="game-button" href="${escape(game.path)}">${image}<span class="game-text"><strong>${escape(game.title)}</strong><small>${escape(game.genres.slice(0, 2).join(' · ') || 'Steam 게임')}</small></span></a></td>
    <td class="numeric price-column">${price}</td>
    <td class="numeric">${review}</td>
    <td class="numeric">${Number.isFinite(game.players) ? `<span class="player-number">${fmt(game.players)}</span>` : '<span class="missing">차트 밖</span>'}</td>
    <td class="numeric"><button class="button remove" data-remove="${game.appid}" aria-label="${escape(game.title)} 위시리스트에서 빼기">빼기</button></td>
  </tr>`;
}

async function render() {
  const ids = readList();
  const status = $('#watchlistStatus');
  const body = $('#watchlistBody');
  if (!status || !body) return;

  if (!ids.length) {
    status.textContent = '0개 게임';
    body.innerHTML = emptyState();
    return;
  }

  status.textContent = `${ids.length}개 게임 · 현재 값을 불러오는 중…`;
  try {
    const response = await fetch(`/api/game-details?ids=${ids.join(',')}`, { signal: AbortSignal.timeout(20_000) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '불러오지 못했습니다.');

    // 담은 순서를 유지한다. 응답 순서는 보장되지 않는다.
    const byId = new Map(payload.games.map(game => [game.appid, game]));
    const games = ids.map(id => byId.get(id)).filter(Boolean);
    const missing = ids.length - games.length;

    status.textContent = `${games.length}개 게임${missing ? ` · ${missing}개는 아직 수집되지 않았습니다` : ''}`;
    body.innerHTML = `<div class="table-scroll" tabindex="0"><table>
      <thead><tr>
        <th scope="col" class="game-column">게임</th>
        <th scope="col" class="numeric price-column">현재 가격</th>
        <th scope="col" class="numeric">Steam 평가</th>
        <th scope="col" class="numeric">현재 동접</th>
        <th scope="col" class="numeric">　</th>
      </tr></thead>
      <tbody>${games.map(row).join('')}</tbody>
    </table></div>
    <p class="muted table-footnote">가격은 한국 스토어 기준이며 게임마다 순서대로 갱신되므로 스토어와 차이가 날 수 있습니다. 구매 전 실제 가격을 확인하세요. 이 목록은 이 브라우저에만 저장됩니다.</p>`;
  } catch (error) {
    status.textContent = '';
    body.innerHTML = `<div class="empty-panel"><p>목록을 불러오지 못했습니다.</p><p class="muted">${escape(error.name === 'TimeoutError' ? '응답이 지연됩니다. 잠시 후 새로고침해 주세요.' : error.message)}</p></div>`;
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-remove]');
  if (!button) return;
  toggle(Number(button.dataset.remove));
  render();
});

render();
