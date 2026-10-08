/**
 * 一次性量具（不在回归套件里）：看簇心那颗 AB 键的实际几何，并截一张放大图。
 *
 * 关心两件事：
 *   1) AB 的圆心是否等于四颗键围出正方形的几何中心；
 *   2) AB 的外沿到四颗键的外沿留没留缝（压住就会吃掉想按 A/B 的手指）。
 */
const { launch } = require('./lib-browser.cjs');

const URL = 'http://localhost:7890/nes-console/';

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 4,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('nes-console.settings', JSON.stringify({ controls: { padMode: 'always' } }));
  });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  const g = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    };
    const a = box('.touch-a'), b = box('.touch-b'), x = box('.touch-x'), y = box('.touch-y');
    const ab = box('.touch-ab');
    const sel = box('.touch-select'), st = box('.touch-start');
    const geo = { x, y, a, b, ab, sel, st };
    // 空档能放下的最大圆：几何中心到任一颗键圆心的距离，减掉那颗键的半径
    const center = { cx: (a.cx + b.cx + x.cx + y.cx) / 4, cy: (a.cy + b.cy + x.cy + y.cy) / 4 };
    const hole = Math.min(...[a, b, x, y].map((k) => Math.hypot(k.cx - center.cx, k.cy - center.cy) - k.w / 2));
    const clear = Math.min(...[a, b, x, y].map((k) => Math.hypot(k.cx - ab.cx, k.cy - ab.cy) - k.w / 2 - ab.w / 2));
    // 中心点实际命中的是不是 AB 自己（被别的元素盖住 = 点不着）
    const top = document.elementFromPoint(ab.cx, ab.cy);
    return {
      geo,
      center,
      offX: ab.cx - center.cx, offY: ab.cy - center.cy,
      holeR: hole, abR: ab.w / 2, clear,
      hitAb: top === document.querySelector('.touch-ab'),
      hitTag: `${top?.tagName}.${top?.className}`,
      abText: document.querySelector('.touch-ab').textContent,
      abAction: document.querySelector('.touch-ab').dataset.action,
      actions: document.querySelectorAll('#touch-controls [data-action]').length,
      btns: document.querySelectorAll('#touch-controls .touch-btn').length,
      padBox: box('#touch-controls'),
      // 「平衡」要看的两条：两块同宽、且十字键中心和五键簇中心在同一条水平线上
      left: box('.touch-dpad-group'),
      right: box('.touch-actions-group'),
      dpad: box('.touch-dpad'),
    };
  });

  console.log(JSON.stringify({
    offX: g.offX.toFixed(2), offY: g.offY.toFixed(2),
    holeR: g.holeR.toFixed(2), abR: g.abR.toFixed(2), clear: g.clear.toFixed(2),
    hitAb: g.hitAb, hitTag: g.hitTag, abText: g.abText, abAction: g.abAction,
    actions: g.actions, btns: g.btns,
    size: `${g.geo.ab.w}x${g.geo.ab.h} 四键 ${g.geo.a.w}x${g.geo.a.h}`,
    pad: `${g.padBox.w.toFixed(0)}x${g.padBox.h.toFixed(0)}`,
    左块: `${g.left.w.toFixed(0)}x${g.left.h.toFixed(0)}`,
    右块: `${g.right.w.toFixed(0)}x${g.right.h.toFixed(0)}`,
    中心高差: (g.dpad.cy - g.right.cy).toFixed(2),
  }, null, 1));
  for (const [k, v] of Object.entries(g.geo)) {
    console.log(`  ${k.padStart(6)} cx=${v.cx.toFixed(1)} cy=${v.cy.toFixed(1)} w=${v.w.toFixed(1)}`);
  }

  await page.screenshot({
    path: 'agent-workspace/out/ab-geom.png',
    clip: { x: g.padBox.x, y: g.padBox.y, width: g.padBox.w, height: g.padBox.h },
  });
  const c = await page.evaluate(() => {
    const r = document.querySelector('.touch-actions').getBoundingClientRect();
    return { x: r.x - 12, y: r.y - 12, width: r.width + 24, height: r.height + 24 };
  });
  await page.screenshot({ path: 'agent-workspace/out/ab-geom-zoom.png', clip: c });
  console.log('截图：agent-workspace/out/ab-geom.png / ab-geom-zoom.png');

  // 手机竖屏再看一眼：AB 在窄屏那套排布里不该被切掉或压到别的键
  const ctx2 = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
  });
  const p2 = await ctx2.newPage();
  await p2.addInitScript(() => {
    localStorage.setItem('nes-console.settings', JSON.stringify({ controls: { padMode: 'always' } }));
  });
  await p2.goto(URL, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(600);
  const cb = await p2.evaluate(() => {
    const r = document.querySelector('.touch-actions').getBoundingClientRect();
    const ab = document.querySelector('.touch-ab').getBoundingClientRect();
    return {
      clip: { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 },
      inViewport: ab.left >= 0 && ab.top >= 0 && ab.right <= innerWidth && ab.bottom <= innerHeight,
      ab: { w: Math.round(ab.width), left: Math.round(ab.left), top: Math.round(ab.top) },
    };
  });
  await p2.screenshot({ path: 'agent-workspace/out/ab-portrait.png', clip: cb.clip });
  console.log(`竖屏 AB ${JSON.stringify(cb.ab)} 在视口内=${cb.inViewport}；截图 out/ab-portrait.png`);
  await ctx2.close();
  await browser.close();
})();
