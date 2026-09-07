// 멀티플랫폼 층위의 바깥쪽 — Wikidata 에서 "이 게임이 어느 기계에 언제 나왔나"를 읽는다.
// lib/steam.mjs 와 같은 자리에 있다: 네트워크와 정규화만 알고, DB 도 HTML 도 모른다.
//
// 이 파일이 지키는 것 셋.
//
//   1. **제목으로 잇지 않는다.** P1733(Steam application ID) 역방향 조회만 쓴다.
//      appid 는 Steam 이 발급한 고유값이라 오매칭이 원천적으로 없다. 한 appid 에 항목이
//      둘 이상 걸리면 고르지 않고 모호로 표시한다 — 고르면 남의 게임 출시일이 화면에 뜬다.
//   2. **날짜는 플랫폼 한정어에서만 읽는다.** `wdt:P400`(플랫폼)과 `p:P577`(출시일)을
//      그냥 함께 조회하면 카테시안 곱이 나와서, 2020년에 나온 게임이 스위치 2에도
//      2020년에 나온 것처럼 보인다. 실제로 첫 시도에서 그렇게 나왔다.
//      날짜는 반드시 `?st ps:P577 ?date . ?st pq:P400 ?platform` 형태로 꺼낸다.
//   3. **없는 날짜를 지어내지 않는다.** 플랫폼은 확실한데 날짜가 없는 경우가 절반이 넘는다
//      (실측: 콘솔 출시 235건 중 날짜까지 있는 것 91건). 그때 released_on 은 NULL 이고
//      화면에는 `출시일 미상`이라고 쓴다.
//   4. **정밀도를 함께 읽는다.** Wikidata 의 '2027년 출시 예정'은 값으로는 `2027-01-01` 이고,
//      정밀도(wikibase:timePrecision)를 안 보면 1월 1일 출시로 굳는다. 실제로 그렇게 적재됐다 —
//      Enshrouded 의 Xbox 판이 '2027-01-01' 로 들어갔는데 원문은 연도뿐이었다.
//      precision 11(일) 이상만 날짜로 쓰고, 9(연)·10(월)은 날짜 미상으로 둔다.

export const WDQS_ENDPOINT = 'https://query.wikidata.org/sparql';

// Wikimedia 는 연락처가 있는 User-Agent 를 요구한다. 없으면 403 으로 막힌다.
export const USER_AGENT = 'SteamPulse/1.0 (+https://steamsignal.vercel.app)';

// 우리가 다루는 플랫폼. **세대를 묶는다** — 사용자가 묻는 것은 "내 기계에서 되나"이지
// 세대별 이력이 아니다. 그래서 PS4/PS5 는 둘 다 `playstation` 이다.
//
// **현행 세대만 넣는다.** PS3·Vita·Xbox 360·Wii U 를 섞으면 PS3 로만 나온 옛 게임이
// "플레이스테이션 출시"로 보이는데, 그건 PS5 를 든 사람에게 거짓말이다.
//
// QID 는 전부 Wikidata API 로 라벨을 직접 확인한 값이다. 추측으로 넣지 말 것 —
// 첫 시도에 Q11208 을 Xbox 로 적었는데 그건 'The Pentagon' 이었다. 틀린 QID 는
// 에러가 아니라 **조용한 결측**으로 나타나서 알아채는 데 오래 걸린다.
export const PLATFORM_BY_QID = {
  Q13361286: 'xbox',        // 엑스박스 원
  Q98973368: 'xbox',        // 엑스박스 시리즈 X 및 시리즈 S
  Q5014725: 'playstation',  // 플레이스테이션 4
  Q63184502: 'playstation', // 플레이스테이션 5
  Q19610114: 'switch',      // 닌텐도 스위치
  Q122761124: 'switch'      // 닌텐도 스위치 2
};

// 화면에 쓰는 이름은 우리가 정한다. Wikidata 라벨을 그대로 쓰면 언어·표기가 흔들리고
// (같은 항목이 어떤 날은 'PlayStation 5', 어떤 날은 QID 로 온다) 열 이름이 그때마다 바뀐다.
export const PLATFORMS = [
  { key: 'playstation', name: '플레이스테이션', short: 'PS' },
  { key: 'xbox', name: '엑스박스', short: 'Xbox' },
  { key: 'switch', name: '닌텐도 스위치', short: 'Switch' }
];
export const PLATFORM_KEYS = PLATFORMS.map(p => p.key);
export const platformName = key => PLATFORMS.find(p => p.key === key)?.name ?? key;

const entityId = value => String(value ?? '').replace('http://www.wikidata.org/entity/', '');
const values = appids => appids.map(id => `"${Number(id)}"`).join(' ');

// 쿼리를 둘로 나눈 이유는 성능이다. UNION + FILTER NOT EXISTS + 라벨 서비스를 한 번에
// 태우면 20개 배치도 WDQS 의 60초 한도를 넘겨 504 가 난다(50개 배치가 전부 실패했다).
// 나눠서 두 번 묻고 JS 에서 합치는 쪽이 빠르고, 한쪽이 실패해도 나머지는 쓸 수 있다.
export const DAY_PRECISION = 11;

export const datedQuery = appids => `SELECT ?appid ?game ?platform ?date ?precision WHERE {
  VALUES ?appid { ${values(appids)} }
  ?game wdt:P1733 ?appid .
  ?game p:P577 ?st .
  ?st psv:P577 ?tv . ?tv wikibase:timeValue ?date ; wikibase:timePrecision ?precision .
  ?st pq:P400 ?platform .
}`;

export const platformQuery = appids => `SELECT ?appid ?game ?platform ?enTitle WHERE {
  VALUES ?appid { ${values(appids)} }
  ?game wdt:P1733 ?appid .
  ?game wdt:P400 ?platform .
  OPTIONAL { ?a schema:about ?game ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?enTitle . }
}`;

// SPARQL 결과 두 벌을 appid 별로 접는다. 순수 함수라 네트워크 없이 검증할 수 있다.
//
// 반환은 요청한 appid **전부**에 대해 하나씩이다. Wikidata 에 없는 게임도
// `status: 'unmatched'` 로 돌려줘야 커서가 전진하고, 다음 실행에서 다시 맨 앞에 서지 않는다.
export function foldBindings(appids, { dated = [], plain = [] } = {}) {
  const byApp = new Map(appids.map(id => [Number(id), {
    appid: Number(id), wikidataIds: new Set(), wikipediaTitle: null, platforms: new Map()
  }]));

  const touch = binding => byApp.get(Number(binding.appid?.value));

  for (const row of plain) {
    const entry = touch(row);
    if (!entry) continue;
    entry.wikidataIds.add(entityId(row.game?.value));
    if (row.enTitle?.value && !entry.wikipediaTitle) entry.wikipediaTitle = row.enTitle.value;
    const platform = PLATFORM_BY_QID[entityId(row.platform?.value)];
    // 플랫폼만 있고 날짜가 없는 경우다. 자리를 만들어 두고 날짜는 비워 둔다.
    if (platform && !entry.platforms.has(platform)) entry.platforms.set(platform, null);
  }

  for (const row of dated) {
    const entry = touch(row);
    if (!entry) continue;
    entry.wikidataIds.add(entityId(row.game?.value));
    const platform = PLATFORM_BY_QID[entityId(row.platform?.value)];
    if (!platform) continue;
    // 정밀도가 날(11)에 못 미치면 그것은 날짜가 아니라 '그해 어딘가'다. 플랫폼 자리는 만들되
    // 날짜는 비워 둔다 — 화면에는 `출시일 미상`이라고 쓴다.
    const precise = Number(row.precision?.value) >= DAY_PRECISION;
    const day = precise ? normalizeDay(row.date?.value) : null;
    if (!day) { if (!entry.platforms.has(platform)) entry.platforms.set(platform, null); continue; }
    // 같은 플랫폼에 날짜가 여럿이면(지역·에디션·재발매) 가장 이른 날이 그 기계의 출시일이다.
    const previous = entry.platforms.get(platform);
    entry.platforms.set(platform, previous && previous < day ? previous : day);
  }

  return [...byApp.values()].map(entry => {
    const ids = [...entry.wikidataIds].filter(Boolean).sort();
    // 항목이 둘 이상이면 하나를 고르지 않는다. 출시일도 쓰지 않는다 —
    // 어느 항목에서 온 날짜인지 모르는 채로 화면에 올리면 그냥 틀린 값이다.
    if (ids.length > 1) {
      return { appid: entry.appid, status: 'ambiguous', wikidataId: null, wikipediaTitle: null, candidates: ids, releases: [] };
    }
    if (ids.length === 0) {
      return { appid: entry.appid, status: 'unmatched', wikidataId: null, wikipediaTitle: null, candidates: [], releases: [] };
    }
    return {
      appid: entry.appid,
      status: 'matched',
      wikidataId: ids[0],
      wikipediaTitle: entry.wikipediaTitle,
      candidates: [],
      releases: PLATFORM_KEYS
        .filter(key => entry.platforms.has(key))
        .map(key => ({ platform: key, releasedOn: entry.platforms.get(key) }))
    };
  });
}

// Wikidata 는 '+2022-02-25T00:00:00Z' 처럼 앞에 부호가 붙고, 연도만 아는 값은
// '2026-00-00' 으로 온다. 달력 날짜가 아닌 것은 날짜로 만들지 않는다 — 0월 0일은 없다.
export function normalizeDay(value) {
  const match = /^[+-]?(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!match) return null;
  const [, year, month, day] = match;
  if (month === '00' || day === '00') return null;
  const probe = new Date(Date.UTC(+year, +month - 1, +day));
  if (probe.getUTCMonth() !== +month - 1 || probe.getUTCDate() !== +day) return null;
  return `${year}-${month}-${day}`;
}

export function createWikidataService({ fetcher = fetch, timeoutMs = 45_000, retries = 2, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  async function ask(query) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetcher(`${WDQS_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json' },
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (response.ok) return (await response.json())?.results?.bindings ?? [];
        // 504(질의 시간 초과)와 429(속도 제한)는 공용 서비스에서 흔하다. 물러섰다 다시 묻는다.
        if (attempt >= retries) throw new Error(`WDQS HTTP ${response.status}`);
      } catch (error) {
        if (attempt >= retries) throw error;
      }
      await wait(1_500 * (attempt + 1));
    }
  }

  // 배치 크기 20 은 실측으로 정했다. 50 은 전 배치가 504 로 죽었고 20 은 11배치 전부 성공했다.
  return {
    async lookup(appids, { batchSize = 20 } = {}) {
      const out = [];
      for (let i = 0; i < appids.length; i += batchSize) {
        const batch = appids.slice(i, i + batchSize).map(Number);
        // 두 질의는 서로 독립이라 함께 보낸다. 하나가 죽으면 배치 전체를 실패로 둔다 —
        // 반쪽 결과로 '플랫폼은 있는데 날짜만 없는' 행을 써 두면 다음 실행이 그걸 정상으로 본다.
        const [dated, plain] = await Promise.all([ask(datedQuery(batch)), ask(platformQuery(batch))]);
        out.push(...foldBindings(batch, { dated, plain }));
      }
      return out;
    }
  };
}
