/**
 * 从产品界面里截一张游戏画面，用来肉眼确认渲染对不对。
 * 跑法：先起 7890 站点，再 `node agent-workspace/shot-game.cjs 热血格斗 [等待秒数]`
 * 产物：agent-workspace/out/shot-<ROM 名>.png
 */
const fs = require('fs');
const path = require('path');
const { launch } = require('./lib-browser.cjs');
const { selectGameRow } = require('./lib-game-menu.cjs');

const URL = 'http://localhost:7890/nes-console/';
const OUT = path.join(__dirname, 'out');
const name = process.argv[2] || '热血格斗';
const waitMs = (Number(process.argv[3]) || 4) * 1000;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await (await browser.newContext({ serviceWorkers: 'block' }))
    .newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__nesConsole, null, { timeout: 20000 });
  if (!(await selectGameRow(page, name))) throw new Error(`列表里找不到 ${name}`);
  await page.evaluate(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', bubbles: true }));
  });
  await page.waitForFunction(() => window.__nesConsole.host.frames > 30, null, { timeout: 30000 });
  await page.waitForTimeout(waitMs);
  const info = await page.evaluate(() => {
    const c = document.getElementById('nes-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const colors = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const k = `${d[i]},${d[i + 1]},${d[i + 2]}`;
      colors.set(k, (colors.get(k) || 0) + 1);
    }
    return {
      size: `${c.width}×${c.height}`,
      top: [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
      frames: window.__nesConsole.host.frames,
    };
  });
  await page.locator('#nes-canvas').screenshot({ path: path.join(OUT, `shot-${name}.png`) });
  console.log(`画布 ${info.size} · ${info.frames} 帧 · 前 6 种颜色: ${info.top.map(([k, n]) => `${k}×${n}`).join(' | ')}`);
  console.log(`截图: agent-workspace/out/shot-${name}.png`);
  await browser.close();
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
