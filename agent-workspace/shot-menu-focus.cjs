/**
 * 取景用（不出判分）：看「高亮框只落在当前焦点那一栏」和「手柄 A 左 B 右」。
 * 焦点模型的两形态（框在分类栏 / 框在列表行）只有截图能判断好不好看，
 * 断言只能证明属性值对，证明不了「两个框抢视线」这类问题。
 *
 * 跑法：先 npm run build 并把站点起在 7890，再 node agent-workspace/shot-menu-focus.cjs
 */
const fs = require('fs');
const path = require('path');
const { launch } = require('./lib-browser.cjs');

const URL = 'http://localhost:7890/nes-console/';
const shots = path.join(__dirname, 'shots');
fs.mkdirSync(shots, { recursive: true });

const press = async (page, code) => {
  await page.evaluate((c) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true }));
  }, code);
  await page.waitForTimeout(220);
};

// 当前「带框」的那一行是谁：只有焦点那一栏的选中项有青色描边
const boxed = (page) => page.evaluate(() => {
  const b = (el) => getComputedStyle(el).borderTopColor;
  const bar = document.querySelector('.sys-nav-item.selected');
  const list = document.querySelector('.sys-item.selected');
  return {
    focus: document.querySelector('.sys-ui').dataset.focus,
    barBox: b(bar), barText: getComputedStyle(bar).color,
    listBox: b(list), listText: getComputedStyle(list.querySelector('.sys-item-label')).color,
    barLabel: bar.querySelector('.sys-nav-label').textContent,
    listLabel: list.querySelector('.sys-item-label').textContent,
  };
});

const log = async (page, tag) => {
  const s = await boxed(page);
  console.log(`\n[${tag}] focus=${s.focus}`);
  console.log(`  分类栏「${s.barLabel}」框=${s.barBox} 字色=${s.barText}`);
  console.log(`  列表「${s.listLabel}」框=${s.listBox} 字色=${s.listText}`);
  await page.screenshot({ path: path.join(shots, `focus-${tag}.png`) });
};

(async () => {
  const browser = await launch();

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await log(page, '1-开局-框在分类栏');

  await press(page, 'ArrowDown');
  await log(page, '2-分类栏里往下走一格');

  await press(page, 'ArrowRight');
  await log(page, '3-进列表-框跟着走');

  await press(page, 'ArrowDown');
  await log(page, '4-列表里换条目');

  await press(page, 'ArrowLeft');
  await log(page, '5-回分类栏-位置记着');

  // 「系统」分类进去就是设置列表：数值项在焦点进列表后能不能看清
  for (let i = 0; i < 6; i++) {
    if ((await boxed(page)).barLabel === '系统') break;
    await press(page, 'ArrowDown');
  }
  await press(page, 'ArrowRight');
  await log(page, '6-设置列表');

  await page.close();

  // 手柄：A 在左、B 在右，且上排是 X/Y
  const p2 = await (await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true,
  })).newPage();
  await p2.addInitScript(() => localStorage.setItem('nes-console.settings',
    JSON.stringify({ controls: { padMode: 'always' } })));
  await p2.goto(URL, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(600);
  const layout = await p2.evaluate(() => {
    const r = (s) => {
      const b = document.querySelector(s).getBoundingClientRect();
      return { label: document.querySelector(s).textContent.trim(), x: Math.round(b.x), y: Math.round(b.y) };
    };
    return { a: r('.touch-a'), b: r('.touch-b'), x: r('.touch-x'), y: r('.touch-y') };
  });
  console.log(`\n[手柄] 中排 A.x=${layout.a.x} B.x=${layout.b.x}（A 在左）`
    + `｜上排 X.x=${layout.x.x} Y.x=${layout.y.x}｜下排 A.y=${layout.a.y} X.y=${layout.x.y}`);
  const box = await p2.locator('#touch-controls').boundingBox();
  await p2.screenshot({
    path: path.join(shots, 'focus-7-手柄-AB位置.png'),
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
  });
  await p2.close();

  await browser.close();
  console.log(`\n截图在 agent-workspace/shots/`);
})().catch((e) => { console.error(e); process.exit(1); });
