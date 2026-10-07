// 屏幕内「菜单」按钮的样子：整屏 + 右上角放大，和手柄按键放一起对眼。
// 用法：node agent-workspace/shot-menu-btn.cjs   （要先 npm run build 且预览服务在 7890）
const { launch } = require('./lib-browser.cjs');

const VIEWPORTS = [
  { w: 1440, h: 900, name: '桌面宽屏' },
  { w: 390, h: 844, name: '手机竖屏' },
  { w: 320, h: 568, name: '小屏手机' },
  { w: 844, h: 390, name: '手机横屏' },
];

(async () => {
  const browser = await launch();
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: vp.w, height: vp.h },
      deviceScaleFactor: 4,
    });
    const page = await ctx.newPage();
    await page.goto('http://localhost:7890/nes-console/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    const box = await page.locator('.touch-menu').boundingBox();
    const num = (v) => Math.round(v);
    // 放大框：按钮往外扩 3.2 倍边长，顺带把顶栏标题和右边的边距一起拍进来
    const pad = box.width * 3.2;
    await page.screenshot({
      path: `agent-workspace/out/menu-btn-${vp.name}.png`,
      clip: {
        x: Math.max(0, num(box.x - pad)),
        y: Math.max(0, num(box.y - pad)),
        width: num(Math.min(vp.w - Math.max(0, box.x - pad), box.width + pad * 2)),
        height: num(Math.min(vp.h - Math.max(0, box.y - pad), box.height + pad * 2)),
      },
    });

    const info = await page.evaluate(() => {
      const cs = (s) => getComputedStyle(document.querySelector(s));
      const m = cs('.touch-menu'), a = cs('.touch-a');
      const r = document.querySelector('.touch-menu').getBoundingClientRect();
      const t = document.querySelector('.touch-menu');
      return {
        text: t.textContent.trim(),
        size: `${r.width.toFixed(1)}x${r.height.toFixed(1)}`,
        radius: m.borderTopLeftRadius,
        bg: m.backgroundColor, abg: a.backgroundColor,
        border: `${m.borderTopWidth} ${m.borderTopStyle} ${m.borderTopColor}`,
        fs: m.fontSize, opacity: m.opacity,
        fits: t.scrollWidth <= t.clientWidth + 1,
      };
    });
    console.log(`【${vp.name} ${vp.w}x${vp.h}】${JSON.stringify(info)}`);
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
