// 계정 화면의 위시리스트 동기화.
//
// 계정은 자율 기능이다. 로그인하지 않은 사람에게는 이 파일이 아예 로드되지 않고,
// 위시리스트는 지금까지처럼 브라우저에만 저장된다(CLAUDE.md 규칙 10).
//
// 로그인한 사람에게만 두 목록을 **합친다.** 빼지 않는 게 핵심이다 —
// 다른 기기에서 담은 게임이 이 기기 목록에 없다고 사라지면, 사용자는 그걸
// '동기화'가 아니라 '분실'로 겪는다. 빼기는 본인이 '빼기'를 누를 때만 일어난다.
import { readList, writeList } from '/watchlist.js';

const status = document.querySelector('#syncStatus');

async function sync() {
  if (!status) return;
  const local = readList();
  try {
    const response = await fetch('/api/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'watchlist-merge', appids: local }),
      signal: AbortSignal.timeout(15_000)
    });
    if (response.status === 401) {
      status.textContent = '로그인이 풀렸습니다. 다시 로그인하면 이어집니다.';
      return;
    }
    const payload = await response.json();
    if (!response.ok || !Array.isArray(payload.appids)) throw new Error(payload.error || '동기화하지 못했습니다.');

    // 서버가 돌려준 합본을 브라우저에도 적어 둔다. 이제 두 곳이 같은 목록을 본다.
    const merged = payload.appids;
    const added = merged.filter(appid => !local.includes(appid)).length;
    writeList(merged);
    status.textContent = added
      ? `${merged.length}개 게임이 이 계정에 저장돼 있습니다. 다른 기기에서 담은 ${added}개를 이 브라우저로 가져왔습니다.`
      : `${merged.length}개 게임이 이 계정에 저장돼 있습니다. 이 브라우저와 같습니다.`;
  } catch (error) {
    status.textContent = error.name === 'TimeoutError'
      ? '응답이 지연됩니다. 잠시 후 새로고침해 주세요.'
      : '동기화하지 못했습니다. 이 브라우저의 목록은 그대로 남아 있습니다.';
  }
}

sync();
