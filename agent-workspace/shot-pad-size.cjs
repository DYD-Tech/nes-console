/**
 * 三档大小各截一张图，用来看「放大以后像不像一副手柄」：
 * 光对数字够用，但键挤没挤、描边粗不粗、和画面对比够不够，只有看图才知道。
 * 跑法：node agent-workspace/shot-pad-size.cjs（站点在 7890）
 */
const path = require('path');
const fs = require('fs');
const { launch } = require('./lib-browser.cjs');
const { startGame } = require('./lib-game-menu.cjs');

const URL = 'http://localhost:7890/nes-console/';
const SETTINGS_KEY = 'nes-console.settings';
const OUT = path.join(__dirname, 'shots');

const CASES = [
  ['small', '390x844', 390, 844],
  ['medium', '390x844', 390, 844],
  ['large', '390x844', 390, 844],
  ['large', '320x640', 320, 640],
  ['large', '844x390', 844, 390],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  for (const [size, name, width, height] of CASES) {
    const ctx = await browser.newContext({
      viewport: { width, height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v),
      [SETTINGS_KEY, JSON.stringify({ controls: { padMode: 'always', padSize: size } })]);
    await page.goto(URL, { waitUntil: 'networkidle' });
    const started = await startGame(page, 'Destiny');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const file = `pad-size-${size}-${name}.png`;
    await page.screenshot({ path: path.join(OUT, file) });
    console.log(`${file}  起游戏=${started ? 'OK' : '失败'}`);
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
