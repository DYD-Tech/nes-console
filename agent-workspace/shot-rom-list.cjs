// 看一眼 12 款内置游戏在主菜单里的样子（列表能否滚动、选中项是否可见）
const { launch } = require('./lib-browser.cjs');
const path = require('path');

(async () => {
  const browser = await launch();
  const shots = path.join(__dirname, 'shots');
  for (const [tag, vp] of [
    ['desktop', { width: 1440, height: 900 }],
    ['phone-landscape', { width: 844, height: 390 }],
  ]) {
    const page = await (await browser.newContext({ viewport: vp })).newPage();
    await page.goto('http://localhost:7890/nes-console/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    const info = await page.evaluate(() => {
      const list = document.querySelector('.sys-list');
      return {
        badge: document.querySelector('.sys-badge')?.textContent,
        rows: document.querySelectorAll('.sys-item').length,
        labels: Array.from(document.querySelectorAll('.sys-item-label')).map((e) => e.textContent),
        scrollable: list ? list.scrollHeight > list.clientHeight : null,
        selectedVisible: (() => {
          const s = document.querySelector('.sys-item.selected');
          const l = document.querySelector('.sys-list');
          if (!s || !l) return null;
          const a = s.getBoundingClientRect(), b = l.getBoundingClientRect();
          return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
        })(),
        listOverflow: (() => {
          const l = document.querySelector('.sys-list');
          return l ? getComputedStyle(l).overflowY : null;
        })(),
      };
    });
    console.log(`\n[${tag}] ${JSON.stringify(info, null, 1)}`);
    await page.screenshot({ path: path.join(shots, `rom-list-${tag}.png`) });
    // 把光标移到底部，看选中项能不能跟着滚进来
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 12; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowDown', bubbles: true }));
        await sleep(70);
      }
    });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      const s = document.querySelector('.sys-item.selected');
      const l = document.querySelector('.sys-list');
      const a = s.getBoundingClientRect(), b = l.getBoundingClientRect();
      return {
        selected: s.querySelector('.sys-item-label').textContent,
        visible: a.top >= b.top - 1 && a.bottom <= b.bottom + 1,
        gapTop: Math.round(a.top - b.top), gapBottom: Math.round(b.bottom - a.bottom),
      };
    });
    console.log(`  移到底部: ${JSON.stringify(after)}`);
    await page.screenshot({ path: path.join(shots, `rom-list-${tag}-bottom.png`) });
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
