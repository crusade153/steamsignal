// 게임 상세 페이지의 '위시리스트에 담기' 버튼.
//
// 서버는 버튼을 항상 '담기' 상태로 렌더링한다. 담겼는지 여부는 브라우저에만 있는 정보라
// 서버가 알 수 없고, 알았다면 CDN 캐시가 남의 상태를 보여 주게 된다.
// 그래서 실제 상태는 로드된 뒤 이 스크립트가 칠한다.
import { has, toggle } from '/watchlist.js';

const button = document.querySelector('[data-watch]');
if (button) {
  const appid = Number(button.dataset.watch);
  const label = button.querySelector('.watch-label');

  const paint = () => {
    const saved = has(appid);
    button.setAttribute('aria-pressed', String(saved));
    button.classList.toggle('saved', saved);
    label.textContent = saved ? '위시리스트에 담김' : '위시리스트에 담기';
  };

  button.hidden = false;
  paint();

  button.addEventListener('click', () => {
    const result = toggle(appid);
    if (!result.ok) {
      button.insertAdjacentHTML('afterend',
        `<span class="watch-note" role="status">${result.reason === 'full'
          ? '위시리스트는 20개까지 담을 수 있습니다.'
          : '이 브라우저에 저장할 수 없습니다. 시크릿 창이거나 사이트 데이터 저장이 차단된 상태일 수 있습니다.'}</span>`);
      return;
    }
    document.querySelector('.watch-note')?.remove();
    paint();
  });
}
