// Game Pass 층위의 바깥쪽 — 카탈로그를 읽고, 공식 발표에서 입점 예정을 읽는다.
// lib/steam.mjs · lib/platforms.mjs 와 같은 자리다: 네트워크와 정규화만 알고 DB 도 HTML 도 모른다.
//
// **이 파일은 미문서 엔드포인트를 쓴다.** Xbox 앱과 xbox.com 이 쓰는 주소이고 인증도 키도
// 없지만, 마이크로소프트가 문서로 약속한 적은 없다. 그래서 규율이 하나 더 붙는다 —
// **핵심 의존성으로 두지 않는다.** 막히면 페이지가 죽는 게 아니라 그 절이 비고,
// 나머지 사이트는 한 칸도 달라지지 않는다.
//
// 무엇을 어디서 얻는지 실측으로 확인한 결과다(2026-09-07, market=KR).
//
//   입점 / 퇴점  ->  카탈로그를 매일 찍어 **우리가 직접 비교한다.** 이 사이트가 동접에
//                   하는 일과 같다 — 남이 알려 주지 않는 변화를 기록해서 만든다.
//   퇴점 예정    ->  공식 '곧 종료' 컬렉션. 그대로 있다(10건 안팎).
//   입점 예정    ->  **카탈로그에는 없다.** 미출시작은 1건뿐이고 나머지 25건은
//                   출시일이 9998-12-30 같은 자리표시자다. 그래서 Xbox Wire 의
//                   'Coming to Xbox Game Pass' 공식 글에서 읽는다.

export const SIGL_URL = 'https://catalog.gamepass.com/sigls/v2';
export const CATALOG_URL = 'https://displaycatalog.mp.microsoft.com/v7.0/products';
// 발표 글은 이 두 피드에 흩어져 나온다. 각 피드는 최근 10건만 담고 Xbox Wire 는 하루에
// 서너 건씩 올라와서, 한 곳만 보면 웨이브 글이 하루 만에 창 밖으로 밀린다.
// 잡이 매일 돌고 읽은 발표는 DB 에 남으므로, 넓게 훑고 중복은 무시한다.
export const WIRE_FEEDS = [
  'https://news.xbox.com/en-us/tag/game-pass/feed/',
  'https://news.xbox.com/en-us/xbox-game-pass/feed/'
];

export const USER_AGENT = 'SteamPulse/1.0 (+https://steamsignal.vercel.app)';

// 컬렉션(SIGL) ID. 전부 실제 호출로 확인했다 — 추측한 두 개는 404 였다.
export const SIGLS = {
  console: 'f6f1f99f-9b49-4ccd-b3bf-4d9767a77f5e', // 모든 콘솔 게임
  pc: 'fdd9e2a7-0fee-49f6-ad69-4354098401ff',      // 모든 PC 게임
  leaving: '393f05bf-e596-4ef6-9487-6d4fa0eab987'  // 곧 종료
};

// displaycatalog 는 한 번에 받는 bigId 개수에 한도가 있다. 20 이 안전한 값이다.
export const DETAIL_BATCH = 20;

// 출시일이 이만큼 먼 미래면 날짜가 아니라 자리표시자다(실측: 9998-12-30 이 25건).
// 없는 날짜를 화면에 적지 않기 위한 유일한 방어선이다.
const DATE_HORIZON_DAYS = 3 * 365;

const iso = value => (value ? String(value).slice(0, 10) : null);

// 상품 상세를 우리 모양으로 줄인다. 여기서 버리는 필드가 훨씬 많다 —
// displaycatalog 응답은 상품 하나가 수십 KB 이고, 우리가 쓰는 것은 다섯 개뿐이다.
export function normalizeProduct(product, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const productId = product?.ProductId;
  const local = product?.LocalizedProperties?.[0];
  const title = local?.ProductTitle?.trim();
  if (!productId || !title) return null;

  const raw = iso(product?.MarketProperties?.[0]?.OriginalReleaseDate);
  const horizon = new Date(Date.parse(today) + DATE_HORIZON_DAYS * 864e5).toISOString().slice(0, 10);
  // 자리표시자는 날짜가 아니다. NULL 로 둔다 — 9998년을 '출시 예정'이라고 적을 수는 없다.
  const releaseDate = raw && raw <= horizon ? raw : null;

  // 이미지는 여러 벌이 오고 종류가 제각각이다. 없으면 없는 대로 둔다.
  const image = local?.Images?.find(item => item?.ImagePurpose === 'Poster')
    ?? local?.Images?.find(item => item?.ImagePurpose === 'BoxArt')
    ?? local?.Images?.[0];

  return {
    productId,
    title,
    developer: local?.DeveloperName?.trim() || null,
    imageUrl: image?.Uri ? `https:${image.Uri}`.replace(/^https:https:/, 'https:') : null,
    releaseDate
  };
}

// 어제의 카탈로그와 오늘의 카탈로그를 비교한다. 순수 함수라 네트워크 없이 검증할 수 있다.
//
// **첫 실행에서는 입점을 만들지 않는다.** 처음 본 558개를 전부 '오늘 입점'이라고 적으면
// 그건 기록이 아니라 거짓말이다. 기준선만 잡고, 실제 변화는 다음 실행부터 나온다.
export function diffCatalog({ previous, current, baseline = false }) {
  const before = new Set(previous);
  const now = new Set(current.map(item => item.productId));

  const added = baseline ? [] : current.filter(item => !before.has(item.productId)).map(item => item.productId);
  const removed = baseline ? [] : [...before].filter(id => !now.has(id));
  return { added, removed, baseline };
}

// --- 입점 예정 --------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

// 'June 18' 처럼 연도가 없는 날짜를 글이 올라온 날 기준으로 해석한다.
// 12월 글의 'January 5' 는 다음 해다 — 여기를 틀리면 예정일이 1년 밀린다.
export function resolveAnnouncedDate(text, postedAt) {
  const match = /\b([A-Z][a-z]+)\s+(\d{1,2})\b/.exec(String(text ?? ''));
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  const day = Number(match[2]);
  if (month < 0 || !(day >= 1 && day <= 31)) return null;

  const posted = new Date(postedAt);
  if (Number.isNaN(posted.getTime())) return null;
  let year = posted.getUTCFullYear();
  // 글이 난 달보다 이른 달이면 해가 넘어간 것이다(12월 글의 1월 예정).
  if (month < posted.getUTCMonth() - 1) year += 1;

  const probe = new Date(Date.UTC(year, month, day));
  if (probe.getUTCMonth() !== month || probe.getUTCDate() !== day) return null;
  return probe.toISOString().slice(0, 10);
}

// 공식 글의 한 문단을 입점 예정 한 건으로 읽는다.
//
// 형식이 아주 일정하다 — `제목 (Cloud, Console, and PC) – June 18 Game Pass Ultimate, ...`
// 그래도 **엄격하게 읽고, 안 맞으면 버린다.** 산문에서 억지로 짜내면 설명 문단이
// 게임 제목으로 들어온다. 놓치는 것보다 틀린 것을 적는 쪽이 훨씬 나쁘다.
export function parseAnnouncement(paragraph, postedAt) {
  const text = String(paragraph ?? '').replace(/\s+/g, ' ').trim();
  // 기기 목록이 괄호 안에 있고, 그 뒤에 대시와 날짜가 온다.
  const match = /^(.{2,120}?)\s*\(([^)]*)\)\s*[–—-]\s*(.{2,80})$/.exec(text);
  if (!match) return null;

  const [, title, devices, tail] = match;
  // 괄호 안이 기기 목록이 아니면 이 문단은 게임 줄이 아니다.
  if (!/\b(Cloud|Console|PC|Handheld|Series X)\b/i.test(devices)) return null;
  // 설명 문장이 딸려 들어오는 것을 막는다. 제목에 문장부호가 있으면 버린다.
  if (/[.!?]\s/.test(title)) return null;

  const availableNow = /\bavailable (now|today)\b/i.test(tail);
  const announcedFor = availableNow ? null : resolveAnnouncedDate(tail, postedAt);
  // 날짜도 '지금'도 못 읽었으면 우리가 아는 게 없다.
  if (!availableNow && !announcedFor) return null;

  return {
    title: title.trim(),
    devices: devices.replace(/\s+/g, ' ').trim(),
    announcedFor,
    availableNow
  };
}

// RSS 한 편에서 게임 줄만 뽑는다.
export function parseWirePost(html, postedAt) {
  const paragraphs = [...String(html ?? '').matchAll(/<p>([\s\S]*?)<\/p>/g)]
    .map(match => match[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '–')
      .replace(/&#8217;|&#8216;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim());

  const seen = new Set();
  const out = [];
  for (const paragraph of paragraphs) {
    const parsed = parseAnnouncement(paragraph, postedAt);
    if (!parsed || seen.has(parsed.title)) continue;
    seen.add(parsed.title);
    out.push(parsed);
  }
  return out;
}

const tag = (name, xml) => {
  const match = new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`).exec(xml);
  return match ? match[1].trim() : null;
};

export function createGamePassService({ fetcher = fetch, timeoutMs = 20_000, market = 'KR', language = 'ko-kr' } = {}) {
  async function json(url) {
    const response = await fetcher(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`Game Pass HTTP ${response.status}`);
    return response.json();
  }

  // 컬렉션 응답의 첫 항목은 컬렉션 설명이고 나머지가 상품이다.
  async function collection(siglId) {
    const rows = await json(`${SIGL_URL}?id=${siglId}&language=${language}&market=${market}`);
    return Array.isArray(rows) ? rows.slice(1).map(row => row?.id).filter(Boolean) : [];
  }

  return {
    collection,

    async products(ids, { today } = {}) {
      const out = [];
      for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
        const batch = ids.slice(i, i + DETAIL_BATCH);
        const body = await json(
          `${CATALOG_URL}?bigIds=${batch.join(',')}&market=${market}&languages=${language}&MS-CV=SteamPulse.1`);
        for (const product of body?.Products ?? []) {
          const normalized = normalizeProduct(product, { today });
          if (normalized) out.push(normalized);
        }
      }
      return out;
    },

    // 공식 발표. 실패해도 던지지 않는다 — 입점 예정이 없다고 카탈로그 기록까지
    // 못 남기면 그게 더 큰 손해다.
    async announcements() {
      const out = [];
      const seen = new Set();
      for (const feed of WIRE_FEEDS) {
        try {
          const response = await fetcher(feed, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml' },
            signal: AbortSignal.timeout(timeoutMs)
          });
          if (!response.ok) continue;
          const xml = await response.text();
          const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(match => match[1]);
          for (const item of items) {
            const title = tag('title', item) ?? '';
            // 'Coming to Xbox Game Pass: ...' 글만 읽는다. 다른 글에도 게임 줄이 있지만
            // 그건 입점 발표가 아니라 신작 소개다.
            if (!/coming to (the )?xbox game pass/i.test(title)) continue;
            const link = tag('link', item);
            const postedAt = tag('pubDate', item);
            if (seen.has(link)) continue;
            seen.add(link);
            const body = tag('content:encoded', item) ?? tag('description', item) ?? '';
            for (const entry of parseWirePost(body, postedAt)) {
              out.push({ ...entry, sourceUrl: link, sourceTitle: title, postedAt: new Date(postedAt).toISOString() });
            }
          }
        } catch {
          // 한 피드가 죽어도 나머지는 읽는다. 전부 실패하면 빈 배열이고, 그러면
          // 입점 예정 절이 빌 뿐 카탈로그 기록은 그대로 남는다.
        }
      }
      return out;
    }
  };
}
