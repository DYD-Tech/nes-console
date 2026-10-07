// 出图自检：菜单里的按键提示栏 + 画面上的 toast（弹出中 / 菜单开着 / 超长文案 / 竖屏带手柄）
const { launch } = require('./lib-browser.cjs');
const path = require('path');
const OUT = path.join(__dirname, 'shots');
require('fs').mkdirSync(OUT, { recursive: true });

const LONG = '加载失败: 这个存档来自旧版本模拟器，格式对不上，请重新打一次游戏再存，旧档无法恢复';

(async () => {
  const browser = await launch();

  const press = async (page, code) => page.evaluate(async (c) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
  }, code);

  /** 弹一条 toast（不载入 ROM：按快速存档键 -> 「请先启动游戏」） */
  const toast = (page) => press(page, 'F5');

  const shot = async (name, opts) => {
    const ctx = await browser.newContext({ viewport: opts.viewport, hasTouch: !!opts.touch });
    const page = await ctx.newPage();
    if (opts.padAlways) {
      await page.addInitScript(([k, v]) => localStorage.setItem(k, v),
        ['nes-console.settings', JSON.stringify({ controls: { padMode: 'always' } })]);
    }
    await page.goto('http://localhost:7890/nes-console/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    if (opts.prep) await opts.prep(page);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`${name}.png`);
    await ctx.close();
  };

  await shot('hintbar-menu-open', { viewport: { width: 1280, height: 800 } });
  await shot('toast-over-menu', { viewport: { width: 1280, height: 800 }, prep: toast });
  await shot('toast-game', {
    viewport: { width: 1280, height: 800 },
    prep: async (p) => { await press(p, 'Escape'); await toast(p); },
  });
  await shot('toast-long', {
    viewport: { width: 1280, height: 800 },
    prep: (p) => p.evaluate((t) => {
      const el = document.getElementById('toast');
      el.textContent = t.repeat(2);
      el.hidden = false;
    }, LONG),
  });
  await shot('toast-portrait', {
    viewport: { width: 390, height: 844 }, touch: true, padAlways: true, prep: toast,
  });

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
