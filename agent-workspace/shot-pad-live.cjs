/**
 * 看手柄颜色在真页面上长什么样：空闲、真按住 A、真按住上拨片，横竖各一套。
 * 最后单独出一张「按键压在亮画面上」的对比图 —— 按下色从饱和紫改成提亮青之后，
 * 弱背景（近黑外围）上更清楚，但压在明亮的游戏画面上还剩多少，只能这样量。
 * 判分在 verify-ozone-colors.cjs，这里只出图。
 * 跑法：node agent-workspace/shot-pad-live.cjs [ROM 名]（站点在 7890）
 */
const path = require('path');
const fs = require('fs');
const { launch } = require('./lib-browser.cjs');
const { startGame } = require('./lib-game-menu.cjs');

const URL = 'http://localhost:7890/nes-console/';
const OUT = path.join(__dirname, 'out');
const GAME = process.argv[2] || '牧场物语';

/** 真按下：把鼠标移到元素中心按下，截图后再松开 */
async function hold(page, sel, shot, clip) {
  const b = await page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sel);
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(OUT, shot), clip });
  await page.mouse.up();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();

  for (const size of [{ n: 'land-844x390', w: 844, h: 390 }, { n: 'port-390x844', w: 390, h: 844 }]) {
    const ctx = await browser.newContext({
      viewport: { width: size.w, height: size.h },
      hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem('nes-console.settings',
      JSON.stringify({ controls: { padMode: 'always' } })));
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(OUT, `live-${size.n}-idle.png`) });
    const right = await page.evaluate(() => {
      const r = document.querySelector('.touch-actions').getBoundingClientRect();
      return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 };
    });
    const left = await page.evaluate(() => {
      const r = document.querySelector('.touch-dpad-group').getBoundingClientRect();
      return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 };
    });
    await hold(page, '.touch-a', `live-${size.n}-press-a.png`, right);
    await hold(page, '.touch-up', `live-${size.n}-press-up.png`, left);
    await ctx.close();
  }

  // 压在亮画面上：起一款游戏，把右手那块临时按到视口正中（正常只能靠摆放模式拖，这里直接改样式）
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('nes-console.settings',
    JSON.stringify({ controls: { padMode: 'always' } })));
  await page.goto(URL, { waitUntil: 'networkidle' });
  const started = await startGame(page, GAME);
  await page.waitForTimeout(2500);
  await page.addStyleTag({
    content: '.touch-actions{position:fixed;left:50%;top:50%;'
      + 'transform:translate(-50%,-50%);margin:0;pointer-events:auto}',
  });
  const box = await page.evaluate(() => {
    const r = document.querySelector('.touch-actions').getBoundingClientRect();
    return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 };
  });
  await page.screenshot({ path: path.join(OUT, 'live-on-bright-idle.png'), clip: box });
  await hold(page, '.touch-a', 'live-on-bright-press.png', box);
  console.log(`起游戏 ${GAME}=${started ? 'OK' : '失败'}；图在 agent-workspace/out/live-*.png`);
  await ctx.close();
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
