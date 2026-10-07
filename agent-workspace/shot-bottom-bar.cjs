// 自检截图：菜单底栏（左数量 / 右按键图例）+ 屏幕右上角两颗常驻按钮。
// 用法：node agent-workspace/shot-bottom-bar.cjs  （先 npm run build，预览服务在 7890）
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

    const r = (sel) => page.locator(sel).first().boundingBox();
    const bar = await r('.sys-hintbar');
    const top = await page.locator('.sys-topbar').boundingBox();
    const fsBtn = await r('.touch-fs');

    // 整屏
    await page.screenshot({ path: `agent-workspace/out/bar-${vp.name}-full.png` });
    // 底栏放大（左右两栏同行，窄屏最容易被挤）
    await page.screenshot({
      path: `agent-workspace/out/bar-${vp.name}-bottom.png`,
      clip: {
        x: Math.max(0, bar.x - 4),
        y: Math.max(0, bar.y - 4),
        width: Math.min(vp.w, bar.width + 8),
        height: Math.min(vp.h - bar.y + 4, bar.height + 8),
      },
    });
    // 顶栏右端（徽标 + 两颗按钮）
    await page.screenshot({
      path: `agent-workspace/out/bar-${vp.name}-topbar.png`,
      clip: {
        x: Math.max(0, top.x + top.width - fsBtn.width * 7),
        y: Math.max(0, top.y - 2),
        width: Math.min(fsBtn.width * 7, top.x + top.width),
        height: Math.min(top.height + 4, vp.h),
      },
    });

    const info = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const rect = (e) => {
        const r = e.getBoundingClientRect();
        return { l: +r.left.toFixed(1), r: +r.right.toFixed(1), w: +r.width.toFixed(1) };
      };
      const bar = q('.sys-hintbar');
      const legend = q('.sys-hints');
      return {
        字号: +parseFloat(getComputedStyle(q('.sys-ui')).fontSize).toFixed(1),
        数量: q('.sys-count').textContent,
        数量左沿: rect(q('.sys-count')).l,
        图例: Array.from(legend.querySelectorAll('.sys-hint')).map((e) => e.textContent.trim()),
        图例左沿: rect(legend).l,
        图例右沿: rect(legend).r,
        栏右沿: rect(bar).r,
        底栏被裁: bar.scrollWidth > bar.clientWidth + 1,
        图例被裁: legend.scrollWidth > legend.clientWidth + 1,
        全屏按钮: rect(q('.touch-fs')),
        菜单按钮: rect(q('.touch-menu')),
      };
    });
    console.log(`【${vp.name} ${vp.w}x${vp.h}】 ${JSON.stringify(info)}`);
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
