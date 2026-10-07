/**
 * 一次性自检：把左右两块的顶边放到同一张放大图里看。
 * 量的是「画出来的边」：拨片的 getBoundingClientRect 不含描边，要自己减半个描边。
 * 判分在 verify-dpad.cjs，这里只出数字和截图。
 * 跑法：node agent-workspace/shot-pad-align.cjs（站点在 7890）
 */
const path = require('path');
const fs = require('fs');
const { launch } = require('./lib-browser.cjs');

const URL = 'http://localhost:7890/nes-console/';
const OUT = path.join(__dirname, 'out');
const SIZES = [
  { name: 'land-844x390', width: 844, height: 390 },
  { name: 'port-390x844', width: 390, height: 844 },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  for (const size of SIZES) {
    const ctx = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      hasTouch: true, isMobile: true, deviceScaleFactor: 3,
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem('nes-console.settings',
      JSON.stringify({ controls: { padMode: 'always' } })));
    await page.goto(URL, { waitUntil: 'networkidle' });
    const m = await page.evaluate(() => {
      const top = (sel) => document.querySelector(sel).getBoundingClientRect().top;
      const face = document.querySelector('.touch-dpad-face');
      const sw = parseFloat(getComputedStyle(document.querySelector('.dpad-blade')).strokeWidth);
      const padBox = document.querySelector('.touch-dpad').getBoundingClientRect();
      const linePx = sw / face.viewBox.baseVal.width * padBox.width;
      return {
        padBoxTop: padBox.top,
        bladePaintTop: top('.dpad-blade-up') - linePx / 2,
        xTop: top('.touch-x'),
        yTop: top('.touch-y'),
        linePx,
      };
    });
    console.log(`\n【${size.name}】格子顶 ${m.padBoxTop.toFixed(2)} · 十字画出来的顶 ${m.bladePaintTop.toFixed(2)} · X/Y 顶 ${m.xTop.toFixed(2)}/${m.yTop.toFixed(2)} · 描边 ${m.linePx.toFixed(2)}px`);
    const clip = await page.evaluate(() => {
      const l = document.querySelector('.touch-dpad-group').getBoundingClientRect();
      const r = document.querySelector('.touch-actions').getBoundingClientRect();
      return { x: l.left, y: l.top - 10, width: r.right - l.left, height: Math.max(l.bottom, r.bottom) - l.top + 10 };
    });
    await page.screenshot({ path: path.join(OUT, `pad-align-${size.name}.png`), clip });
    await ctx.close();
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
