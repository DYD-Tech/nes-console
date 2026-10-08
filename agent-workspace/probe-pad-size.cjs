// 量三档手柄的实际盒子：尺子值、键径、两块间隙、竖屏抬升、画面离顶。
// 目的是核对 global.css 里的算式（--pad-u 与 100vw/19 封顶）和「小档逐像素不变」。
const { launch } = require('./lib-browser.cjs');

const URL = 'http://localhost:7890/nes-console/';
const SETTINGS_KEY = 'nes-console.settings';

const VIEWPORTS = [
  ['手机窄屏', { width: 320, height: 640 }, true],
  ['手机竖屏', { width: 390, height: 844 }, true],
  ['大屏竖屏', { width: 414, height: 896 }, true],
  ['平板横屏', { width: 1024, height: 768 }, true],
];

async function measure(browser, name, viewport, size) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v),
    [SETTINGS_KEY, JSON.stringify({ controls: { padMode: 'always', padSize: size } })]);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  const m = await page.evaluate(() => {
    const stage = document.querySelector('.stage');
    const px = (v) => Math.round(parseFloat(v) * 100) / 100;
    // 未注册的自定义属性拿回来的是没算过的式子，只能量一个真用它定的长度
    const u = px(getComputedStyle(document.getElementById('touch-controls')).paddingLeft);
    const pad = document.querySelector('.touch-dpad').getBoundingClientRect();
    const a = document.querySelector('.touch-a').getBoundingClientRect();
    const sel = document.querySelector('.touch-select').getBoundingClientRect();
    const gl = document.querySelector('.touch-dpad-group').getBoundingClientRect();
    const gr = document.querySelector('.touch-actions-group').getBoundingClientRect();
    const box = document.getElementById('touch-controls').getBoundingClientRect();
    const screen = document.querySelector('.screen').getBoundingClientRect();
    const line = (sel2) => getComputedStyle(document.querySelector(sel2));
    return {
      u,
      attr: stage.dataset.padSize,
      key: Math.round(a.width),
      dpad: Math.round(pad.width),
      sel: `${Math.round(sel.width)}x${Math.round(sel.height)}`,
      gap: Math.round(gr.left - gl.right),
      lift: Math.round(window.innerHeight - Math.max(gl.bottom, gr.bottom)),
      screenTop: Math.round(screen.top),
      boxBottom: Math.round(box.bottom),
      // 等粗不变量：拨片描边折算 px vs 按钮边框 px
      blade: px(line('.dpad-blade').strokeWidth)
        / document.querySelector('.touch-dpad-face').viewBox.baseVal.width * pad.width,
      btnBorder: px(line('.touch-a').borderTopWidth),
      // 顶边是否还齐平
      dTop: Math.round(pad.top), xTop: Math.round(document.querySelector('.touch-x').getBoundingClientRect().top),
    };
  });
  console.log(`\n【${name} ${viewport.width}x${viewport.height}】 padSize=${m.attr}`);
  console.log(`   --pad-u=${m.u}  键径=${m.key} (3u=${(3 * m.u).toFixed(1)})  十字块=${m.dpad} (8.25u=${(8.25 * m.u).toFixed(1)})  胶囊=${m.sel}`);
  console.log(`   两块间隙=${m.gap}  离底边=${m.lift}  画面顶=${m.screenTop}  手柄底=${m.boxBottom}/${viewport.height}`);
  console.log(`   描边 片=${m.blade.toFixed(2)}px 键=${m.btnBorder}px  顶边 十字=${m.dTop} X=${m.xTop}`);
  await ctx.close();
  return m;
}

(async () => {
  const browser = await launch();
  for (const size of ['small', 'medium', 'large']) {
    console.log(`\n======== ${size} ========`);
    for (const [name, vp, touch] of VIEWPORTS) {
      if (!touch) continue;
      await measure(browser, name, vp, size);
    }
  }
  await browser.close();
})().catch((e) => { console.error('失败:', e); process.exit(1); });
