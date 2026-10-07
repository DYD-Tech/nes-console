/**
 * 看一眼一级分类栏在手机上是不是还竖着排、放不下时能不能上下推、有没有露出滚动条。
 * 跑法：node agent-workspace/shot-sidebar.cjs（要先 npm run build 且站点起在 7890）
 */
const { launch } = require('./lib-browser.cjs');
const path = require('path');

(async () => {
  const browser = await launch();
  const shots = path.join(__dirname, 'shots');
  for (const [tag, vp] of [
    ['桌面宽屏', { width: 1440, height: 900 }],
    ['手机竖屏', { width: 390, height: 844 }],
    ['手机横屏', { width: 844, height: 390 }],
    ['小屏手机', { width: 320, height: 568 }],
    // 故意给一个很扁的窗口：屏幕高度被压到放不下六个分类，用来验「超出能不能上下推」
    ['矮到放不下', { width: 640, height: 260 }],
  ]) {
    const page = await (await browser.newContext({ viewport: vp, hasTouch: true })).newPage();
    await page.goto('http://localhost:7890/nes-console/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);

    const read = () => page.evaluate(() => {
      const nav = document.querySelector('.sys-sidebar');
      const body = document.querySelector('.sys-body');
      const cs = getComputedStyle(nav);
      const items = Array.from(nav.querySelectorAll('.sys-nav-item'));
      // 可见性只能对着 `.screen` 比：被 overflow:hidden 裁掉的元素，自己的矩形照样算得出
      const screen = document.querySelector('.screen').getBoundingClientRect();
      const sel = nav.querySelector('.sys-nav-item.selected').getBoundingClientRect();
      const insideScreen = (r) => r.top >= screen.top - 1 && r.bottom <= screen.bottom + 1;
      return {
        dir: cs.flexDirection,
        overflowY: cs.overflowY,
        scrollbarWidth: cs.scrollbarWidth,
        barTaken: nav.offsetWidth - nav.clientWidth, // 滚动条吃掉的宽度，0 = 没露出来
        labels: items.map((el) => {
          const l = el.querySelector('.sys-nav-label');
          return { t: l.textContent, cut: l.scrollWidth > l.clientWidth + 1 };
        }),
        scrollable: nav.scrollHeight > nav.clientHeight + 1,
        // 菜单区域内容高超过可视高 = 有东西被裁到屏幕外（flex-wrap 那次就是这么骗过判据的）
        bodyOverflow: body.scrollHeight > body.clientHeight + 1,
        navInsideScreen: insideScreen(nav.getBoundingClientRect()),
        selVisible: insideScreen(sel),
      };
    });

    const first = await read();
    console.log(`\n[${tag}] ${JSON.stringify(first)}`);
    await page.screenshot({ path: path.join(shots, `sidebar-${tag}.png`) });

    // 光标初始在分类栏，用 ↓ 一路切到最后一个分类（按 项数-1 次，按整圈会绕回第一项，就白测了），
    // 看光标会不会跑到看不见的地方
    await page.evaluate(async (n) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < n; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowDown', bubbles: true }));
        await sleep(120);
      }
    }, first.labels.length - 1);
    await page.waitForTimeout(300);
    const last = await read();
    console.log(`  切到底: 选中项在屏幕内=${last.selVisible} 整栏在屏幕内=${last.navInsideScreen} `
      + `溢出=${last.bodyOverflow} 可上下推=${last.scrollable} 滚动条占位=${last.barTaken}px`);
    await page.screenshot({ path: path.join(shots, `sidebar-${tag}-最后.png`) });
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
