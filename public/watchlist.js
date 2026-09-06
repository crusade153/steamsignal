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

// 담아 둔 게임의 '무엇이 달라졌나'. 현재값만 보여 주면 매일 열어 볼 이유가 없다 —
// 이 칸 하나가 위시리스트를 목록에서 이유로 바꾼다(docs/PRODUCT.md §3).
//
// 규율은 다른 값과 같다. 비교할 근거가 없으면 0 이라고 쓰지 않고 없다고 쓴다.
// 가격은 '며칠 전'이 아니라 '직전에 달랐던 값' 기준이라, 언제부터 이 가격인지를 함께 적는다.
function delta(game) {
  const change = game.change;
  if (!change) return '<span class="missing">비교할 기록 없음</span>';

  const parts = [];
  if (Number.isFinite(change.priceChange) && change.priceChange !== 0) {
    const down = change.priceChange < 0;
    const amount = fmt(Math.round(Math.abs(change.priceChange) / 100));
    const since = change.priceChangedAt
      ? new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Seoul' }).format(new Date(change.priceChangedAt))
      : null;
    parts.push(`<span class="move ${down ? 'up' : 'down'}">${down ? '▼' : '▲'} ₩${amount} ${down ? '내림' : '오름'}</span>` +
      (since ? `<span class="cell-sub">${escape(since)}부터</span>` : ''));
  }
  if (Number.isFinite(change.playersChangePct)) {
    const up = change.playersChangePct > 0;
    parts.push(`<span class="move ${up ? 'up' : change.playersChangePct < 0 ? 'down' : 'flat'}">동접 ${up ? '+' : ''}${change.playersChangePct}%</span>` +
      (change.since ? `<span class="cell-sub">${escape(change.since)} 평균 대비</span>` : ''));
  }
  return parts.length ? parts.join('') : '<span class="missing">달라진 것 없음</span>';
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

  // data-label 이 좁은 화면의 카드에서 열 이름을 대신한다(styles.css §7).
  // '빼기' 열에는 붙이지 않는다 — 버튼 위에 '　' 라는 라벨이 뜨면 그게 더 이상하다.
  return `<tr>
    <td class="game-cell"><a class="game-button" href="${escape(game.path)}">${image}<span class="game-text"><strong>${escape(game.title)}</strong><small>${escape(game.genres.slice(0, 2).join(' · ') || 'Steam 게임')}</small></span></a></td>
    <td class="numeric price-column" data-label="현재 가격">${price}</td>
    <td class="numeric" data-label="무엇이 달라졌나">${delta(game)}</td>
    <td class="numeric" data-label="Steam 평가">${review}</td>
    <td class="numeric" data-label="현재 동접">${Number.isFinite(game.players) ? `<span class="player-number">${fmt(game.players)}</span>` : '<span class="missing">차트 밖</span>'}</td>
    <td class="numeric action-cell"><button class="button remove" data-remove="${game.appid}" aria-label="${escape(game.title)} 위시리스트에서 빼기">빼기</button></td>
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
        <th scope="col" class="numeric">무엇이 달라졌나</th>
        <th scope="col" class="numeric">Steam 평가</th>
        <th scope="col" class="numeric">현재 동접</th>
        <th scope="col" class="numeric">　</th>
      </tr></thead>
      <tbody>${games.map(row).join('')}</tbody>
    </table></div>
    <p class="muted table-footnote"><b>무엇이 달라졌나</b>는 가격이 직전에 달랐던 값과, 동접이 마지막으로 집계된 날의 평균과 비교한 값입니다. '어제'로 못 박지 않고 실제로 비교한 날짜를 함께 적습니다 — 기록이 없는 날을 지어내지 않기 때문입니다. 가격은 한국 스토어 기준이며 게임마다 순서대로 갱신되므로 스토어와 차이가 날 수 있습니다. 구매 전 실제 가격을 확인하세요. 이 목록은 이 브라우저에만 저장됩니다.</p>`;
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
