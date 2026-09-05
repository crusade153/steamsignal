// 메일 발송 — Resend HTTP API. 런타임 의존성을 늘리지 않으려고 SDK 대신 fetch 를 쓴다.
//
// 원칙은 다른 환경변수와 같다: **없으면 아무것도 하지 않는다.**
// RESEND_API_KEY 와 MAIL_FROM 이 둘 다 있어야 기능이 존재한다. 하나라도 없으면
// 구독 폼이 화면에 그려지지 않고, /api/alerts 는 404 이며, 발송 잡은 즉시 끝난다.
// 반쯤 켜진 상태 — 폼은 보이는데 메일은 안 오는 상태 — 가 가장 나쁘다.
import { config, esc, siteOrigin, SITE_NAME, won, num, isNum } from './render.mjs';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export const mailConfig = {
  apiKey: process.env.RESEND_API_KEY || null,
  // "Steam Pulse <alerts@example.com>" 형태를 그대로 받는다. 도메인 인증이 끝난 주소여야 한다.
  from: process.env.MAIL_FROM || null
};

// 판정 기준은 lib/render.mjs 의 config.mail 하나다. 화면(폼·푸터 링크)과 발송이
// 서로 다른 기준으로 켜지면 폼은 보이는데 메일은 안 오는 상태가 만들어진다.
export const mailEnabled = () => config.mail;

// --- 발송 -------------------------------------------------------------------

// 수신거부 헤더(RFC 8058). 이게 있으면 Gmail 이 목록 상단에 '구독취소'를 띄우고,
// 그 버튼을 누른 사람이 스팸 신고 대신 해지를 고르게 된다 — 도메인 평판을 지키는 가장 싼 방법이다.
const unsubscribeHeaders = token => {
  if (!token) return {};
  const url = `${siteOrigin()}/api/alerts?action=unsubscribe&token=${encodeURIComponent(token)}`;
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  };
};

export async function sendMail({ to, subject, html, text, unsubscribeToken }, { fetcher = fetch, timeoutMs = 15_000 } = {}) {
  if (!mailEnabled()) throw new Error('메일 발송이 설정되지 않았습니다 (RESEND_API_KEY / MAIL_FROM).');

  const response = await fetcher(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mailConfig.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: mailConfig.from,
      to: [to],
      subject,
      html,
      text,
      headers: unsubscribeHeaders(unsubscribeToken)
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    // 본문에 원인이 들어 있다(도메인 미인증, 일일 한도 초과 등). 그대로 남겨야 원인을 찾는다.
    const body = await response.text().catch(() => '');
    throw new Error(`Resend HTTP ${response.status} ${body.slice(0, 300)}`);
  }
  const payload = await response.json().catch(() => ({}));
  return { id: payload?.id ?? null };
}

// --- 템플릿 -----------------------------------------------------------------
//
// HTML 메일은 CSS 지원이 제각각이라 인라인 스타일만 쓰고 레이아웃은 표가 아닌 블록으로 둔다.
// 모든 템플릿은 text 판을 함께 만든다 — text 가 없는 메일은 스팸 점수가 올라간다.

const BRAND = '#101311';
const ACCENT = '#4ade80';

const shell = (heading, inner, footer) => `<!doctype html>
<html lang="ko"><body style="margin:0;padding:24px;background:#f5f6f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;color:#1b1f1c">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e2e5e2">
  <div style="background:${BRAND};padding:18px 24px;color:#fff;font-weight:700;letter-spacing:-0.01em">steam<span style="color:${ACCENT}">pulse</span>.</div>
  <div style="padding:24px">
    <h1 style="margin:0 0 16px;font-size:20px;line-height:1.35">${esc(heading)}</h1>
    ${inner}
  </div>
  <div style="padding:16px 24px;border-top:1px solid #eef0ee;font-size:12px;color:#6b736c;line-height:1.6">${footer}</div>
</div>
</body></html>`;

const footerWith = (unsubscribeUrl, extra = '') =>
  `${extra}${extra ? '<br>' : ''}${SITE_NAME} · Steam 공개 데이터로 만든 독립 프로젝트이며 Valve 와 무관합니다.` +
  (unsubscribeUrl ? `<br><a href="${esc(unsubscribeUrl)}" style="color:#6b736c">이 주소로 오는 메일 모두 끊기</a>` : '');

const unsubscribeUrlFor = token => (token ? `${siteOrigin()}/alerts/unsubscribe?token=${encodeURIComponent(token)}` : null);

// 확인 메일 — 더블 옵트인의 전부. 이 메일 전에는 어떤 내용도 보내지 않는다.
export function confirmTemplate({ confirmToken, unsubscribeToken, what }) {
  const origin = siteOrigin();
  const link = `${origin}/alerts/confirm?token=${encodeURIComponent(confirmToken)}`;
  const inner = `
    <p style="margin:0 0 14px;line-height:1.7">${esc(what)}을(를) 신청하셨습니다. 아래 버튼을 누르면 구독이 시작됩니다.</p>
    <p style="margin:0 0 20px"><a href="${esc(link)}" style="display:inline-block;background:${BRAND};color:#fff;text-decoration:none;padding:12px 20px;border-radius:9px;font-weight:600">구독 확인하기</a></p>
    <p style="margin:0;line-height:1.7;font-size:13px;color:#6b736c">버튼이 눌리지 않으면 이 주소를 복사해 열어 주세요.<br><span style="word-break:break-all">${esc(link)}</span></p>
    <p style="margin:16px 0 0;line-height:1.7;font-size:13px;color:#6b736c"><strong>신청한 적이 없다면 이 메일을 지우면 됩니다.</strong> 확인하지 않은 주소로는 아무것도 보내지 않고, 30일 뒤 기록이 삭제됩니다.</p>`;
  const text = `${what}을(를) 신청하셨습니다.\n\n아래 주소를 열면 구독이 시작됩니다.\n${link}\n\n신청한 적이 없다면 이 메일을 지우면 됩니다. 확인하지 않은 주소로는 아무것도 보내지 않고, 30일 뒤 기록이 삭제됩니다.\n\n${SITE_NAME} ${origin}\n`;
  return {
    subject: `[${SITE_NAME}] 구독 확인 — 한 번만 눌러 주세요`,
    html: shell('구독을 확인해 주세요', inner, footerWith(unsubscribeUrlFor(unsubscribeToken))),
    text
  };
}

const priceLine = row => {
  const now = row.price_formatted || won(row.final_price) || '가격 미확인';
  const before = isNum(row.notified_price) ? won(row.notified_price)
    : isNum(row.initial_price) && row.initial_price > row.final_price ? won(row.initial_price) : null;
  const discount = isNum(row.discount_percent) && row.discount_percent > 0 ? `-${row.discount_percent}% · ` : '';
  return { now, before, discount };
};

// 가격 하락 알림. 한 사람에게 여러 게임이 걸리면 **한 통으로 묶는다** —
// 세일 첫날 20통을 보내면 그날로 스팸 처리된다.
export function alertTemplate({ rows, unsubscribeToken }) {
  const origin = siteOrigin();
  const items = rows.map(row => {
    const { now, before, discount } = priceLine(row);
    const link = `${origin}/game/${encodeURIComponent(row.slug || String(row.appid))}`;
    return `<li style="margin:0 0 14px;line-height:1.6">
      <a href="${esc(link)}" style="color:${BRAND};font-weight:600;text-decoration:none">${esc(row.title)}</a><br>
      <span style="font-size:15px">${esc(discount)}<strong>${esc(now)}</strong>${before ? ` <span style="color:#8a918b;text-decoration:line-through">${esc(before)}</span>` : ''}</span>
      ${row.at_lowest ? `<br><span style="font-size:12px;color:#2f7d4f;font-weight:600">기록상 역대 최저가</span>` : ''}
    </li>`;
  }).join('');

  const inner = `
    <p style="margin:0 0 16px;line-height:1.7">담아 두신 게임의 가격이 내려갔습니다.</p>
    <ul style="margin:0 0 18px;padding-left:18px">${items}</ul>
    <p style="margin:0;line-height:1.7;font-size:13px;color:#6b736c">가격은 한국 스토어 기준이며 저희가 마지막으로 확인한 값입니다. <strong>구매 전 Steam 에서 실제 가격을 확인하세요.</strong></p>`;

  const text = rows.map(row => {
    const { now, before, discount } = priceLine(row);
    return `- ${row.title}: ${discount}${now}${before ? ` (이전 ${before})` : ''}\n  ${origin}/game/${encodeURIComponent(row.slug || String(row.appid))}`;
  }).join('\n');

  const subject = rows.length === 1
    ? `[${SITE_NAME}] ${rows[0].title} 가격 하락`
    : `[${SITE_NAME}] 담아 둔 게임 ${rows.length}개가 할인 중`;

  return {
    subject,
    html: shell(rows.length === 1 ? '가격이 내려갔습니다' : `게임 ${rows.length}개의 가격이 내려갔습니다`, inner,
      footerWith(unsubscribeUrlFor(unsubscribeToken))),
    text: `담아 두신 게임의 가격이 내려갔습니다.\n\n${text}\n\n가격은 한국 스토어 기준이며 구매 전 Steam 에서 실제 가격을 확인하세요.\n\n수신거부: ${unsubscribeUrlFor(unsubscribeToken)}\n`
  };
}

// 주간 리포트. 급상승 TOP 5 + 지금 할인 중인 고평가작 5개.
// 값이 없으면 그 구획을 통째로 빼고, 둘 다 없으면 아예 보내지 않는다(호출부에서 판단).
export function weeklyTemplate({ rising = [], deals = [], unsubscribeToken, generatedAt = new Date() }) {
  const origin = siteOrigin();
  const when = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'long' }).format(generatedAt);

  const gameLink = row => `${origin}/game/${encodeURIComponent(row.slug || String(row.appid))}`;

  const risingHtml = rising.length ? `
    <h2 style="margin:24px 0 10px;font-size:15px;letter-spacing:0.02em;color:#6b736c;text-transform:uppercase">이번 주 급상승</h2>
    <ol style="margin:0;padding-left:20px">${rising.map(row => `<li style="margin:0 0 10px;line-height:1.6">
      <a href="${esc(gameLink(row))}" style="color:${BRAND};font-weight:600;text-decoration:none">${esc(row.title)}</a>
      <span style="color:#2f7d4f;font-weight:600"> +${esc(row.change_pct?.toFixed(1))}%</span>
      <span style="color:#6b736c;font-size:13px"> · 평균 ${esc(num(row.now_players))}명</span>
    </li>`).join('')}</ol>` : '';

  const dealsHtml = deals.length ? `
    <h2 style="margin:24px 0 10px;font-size:15px;letter-spacing:0.02em;color:#6b736c;text-transform:uppercase">할인 중인 고평가작</h2>
    <ul style="margin:0;padding-left:20px">${deals.map(row => `<li style="margin:0 0 10px;line-height:1.6">
      <a href="${esc(gameLink(row))}" style="color:${BRAND};font-weight:600;text-decoration:none">${esc(row.title)}</a>
      <span style="color:#6b736c;font-size:13px"> · -${row.discount_percent}% ${esc(row.price_formatted || won(row.final_price) || '')}${isNum(row.positive_ratio) ? ` · 평가 ${row.positive_ratio}%` : ''}</span>
      ${row.at_lowest ? '<span style="color:#2f7d4f;font-size:12px;font-weight:600"> 역대 최저가</span>' : ''}
    </li>`).join('')}</ul>` : '';

  const inner = `
    <p style="margin:0 0 4px;line-height:1.7">${esc(when)} 기준으로 정리했습니다.</p>
    ${risingHtml}${dealsHtml}
    <p style="margin:24px 0 0"><a href="${esc(origin)}/rising" style="display:inline-block;background:${BRAND};color:#fff;text-decoration:none;padding:11px 18px;border-radius:9px;font-weight:600;font-size:14px">전체 순위 보기</a></p>`;

  const text = [
    `${when} 기준 주간 리포트`,
    rising.length ? `\n[이번 주 급상승]\n${rising.map(r => `- ${r.title} +${r.change_pct?.toFixed(1)}% (평균 ${num(r.now_players)}명)\n  ${gameLink(r)}`).join('\n')}` : '',
    deals.length ? `\n[할인 중인 고평가작]\n${deals.map(r => `- ${r.title} -${r.discount_percent}% ${r.price_formatted || won(r.final_price) || ''}\n  ${gameLink(r)}`).join('\n')}` : '',
    `\n전체 순위: ${origin}/rising`,
    `수신거부: ${unsubscribeUrlFor(unsubscribeToken)}`
  ].filter(Boolean).join('\n');

  return {
    subject: `[${SITE_NAME}] 이번 주 급상승 게임과 할인`,
    html: shell('이번 주의 Steam', inner, footerWith(unsubscribeUrlFor(unsubscribeToken))),
    text
  };
}
