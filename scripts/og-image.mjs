#!/usr/bin/env node
// 기본 OG 이미지를 만든다. public/og-cover.png 를 다시 뽑을 때만 돌리면 된다.
//
//   node scripts/og-image.mjs
//
// 게임 페이지는 Steam 헤더 이미지를 쓰지만 홈과 허브 페이지에는 대표 이미지가 없다.
// og:image 가 없으면 카카오톡·X·디스코드에 링크를 붙였을 때 그림 없이 글자만 나간다.
// 폰트를 직접 래스터화할 방법이 없으므로 브라우저에 카드를 그려 1200x630 으로 찍는다.
import { chromium } from 'playwright';

const card = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800&display=swap');
  *{margin:0;box-sizing:border-box}
  body{width:1200px;height:630px;background:#101311;color:#f0f3ee;
       font-family:Inter,"Malgun Gothic",sans-serif;display:flex;flex-direction:column;
       justify-content:center;padding:82px 88px;position:relative;overflow:hidden}
  .glow{position:absolute;right:-180px;top:-180px;width:620px;height:620px;border-radius:50%;
        background:radial-gradient(circle,#c3f56826 0%,#c3f56800 70%)}
  .brand{display:flex;align-items:center;gap:16px;font-size:38px;font-weight:800;letter-spacing:-1.8px}
  .mark{width:52px;height:52px;background:#c3f568;color:#101311;border-radius:14px;
        display:grid;place-items:center;font-size:44px;font-weight:500;line-height:1}
  .light{font-weight:400}
  .dot{color:#c3f568}
  h1{font-size:76px;line-height:1.22;letter-spacing:-3.4px;font-weight:800;margin:44px 0 26px;max-width:900px}
  h1 em{font-style:normal;color:#c3f568}
  p{font-size:26px;color:#9da79e;line-height:1.6;max-width:860px}
  .strip{position:absolute;left:0;right:0;bottom:0;height:8px;background:#c3f568}
</style></head><body>
  <div class="glow"></div>
  <div class="brand"><span class="mark">↗</span><span>steam<span class="light">pulse</span><span class="dot">.</span></span></div>
  <h1>지금 스팀에서<br><em>가장 핫한 게임.</em></h1>
  <p>동시접속자 · 유저 평가 · 한국 가격을 10분마다 기록해 추이로 보여 줍니다.</p>
  <div class="strip"></div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(card, { waitUntil: 'networkidle' });
  await page.screenshot({ path: 'public/og-cover.png' });
  console.log('public/og-cover.png 생성 완료 (1200x630)');
} finally {
  await browser.close();
}
