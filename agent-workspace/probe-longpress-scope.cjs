/**
 * 探针：把「掐掉 touchstart」从手柄扩到整页（游戏画面除外），会不会碰坏三件事 ——
 *   A) tap 分类栏、tap 开关行（它们监听 click；取消 touchstart 按 Touch Events 规范会吃掉兼容鼠标事件，
 *      click 还在不在必须实测，不能靠规范推）
 *   B) 列表的手指滑动（.sys-list 是唯一能滚的地方，只在真溢出的列表上量：设置子菜单余量 0px，量不出差别）
 *   C) 按住 800ms 再松手会不会把这一行执行掉（出厂状态实测会 —— 长按的真正危害不只是震一下）
 *
 * 只做测量，不改产品代码：在页面里临时加同一条监听，量「加之前 / 加之后」。
 * 每步前都退回根菜单重进，否则上一步留下的子菜单会让下一步找不到行（实测踩过：
 * 在「设置」子菜单里找 .sys-nav-item 直接 undefined）。
 * 跑法：站点在 7890，node agent-workspace/probe-longpress-scope.cjs
 */
const { launch } = require('./lib-browser.cjs');

const URL = 'http://localhost:7890/nes-console/';
const SETTINGS = { 'nes-console.settings': { controls: { padMode: 'always' } } };

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await ctx.addInitScript((data) => {
    for (const [k, v] of Object.entries(data)) localStorage.setItem(k, JSON.stringify(v));
  }, SETTINGS);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  pageerror:', e.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const cdp = await ctx.newCDPSession(page);
  const touchPan = async (x, y, dy) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - (dy * i) / 10, id: 1 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  /** 回到「主菜单根、焦点在分类栏」这个起点 */
  const reset = async () => {
    for (let i = 0; i < 6; i++) {
      if (await page.evaluate(() => document.querySelector('.sys-ui').hidden)) break;
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
    }
    await page.locator('.screen .touch-menu').tap();
    await page.waitForTimeout(500);
  };

  const clickNav = (label) => page.evaluate((t) => {
    const n = Array.from(document.querySelectorAll('.sys-nav-item'))
      .find((x) => x.querySelector('.sys-nav-label').textContent.trim() === t);
    n.click();
  }, label);
  const clickRow = (label) => page.evaluate((t) => {
    const r = Array.from(document.querySelectorAll('.sys-item'))
      .find((x) => x.querySelector('.sys-item-label').textContent.trim() === t);
    if (!r) throw new Error(`找不到行：${t}`);
    r.click();
  }, label);
  const rows = () => page.evaluate(() => Array.from(document.querySelectorAll('.sys-item'))
    .map((li) => ({
      label: li.querySelector('.sys-item-label').textContent.trim(),
      value: li.querySelector('.sys-item-value')?.textContent.trim() ?? null,
    })));
  const geom = () => page.evaluate(() => {
    const el = document.querySelector('.sys-list');
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height, room: el.scrollHeight - el.clientHeight, scrollTop: el.scrollTop };
  });

  const measure = async (tag) => {
    const out = {};

    // A-1 tap 分类栏：从「游戏」换到「游戏管理」，看列表内容有没有换掉
    await reset();
    await clickNav('游戏');
    await page.locator('.sys-nav-item').nth(1).tap();
    await page.waitForTimeout(500);
    out.nav = await page.evaluate(() => Array.from(document.querySelectorAll('.sys-item-label'))
      .map((e) => e.textContent.trim()).join('/'));

    // A-2 tap 开关行（进 系统 → 设置），值翻过去 = click 到了
    await reset();
    await clickNav('系统');
    await clickRow('设置');
    const list = await rows();
    const idx = list.findIndex((r) => r.value !== null);
    const v0 = list[idx]?.value;
    await page.locator('.sys-item').nth(idx).tap();
    await page.waitForTimeout(600);
    out.row = `${v0}->${(await rows())[idx]?.value}`;

    // C 按住开关行 800ms 再松手：值变了 = 这一行被长按执行掉了
    const rb = await page.locator('.sys-item').nth(idx).boundingBox();
    const v1 = (await rows())[idx]?.value;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rb.x + 40, y: rb.y + 10, id: 1 }] });
    await page.waitForTimeout(800);
    const vHold = (await rows())[idx]?.value;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(500);
    out.hold = `${v1}/按住中${vHold}/松手${(await rows())[idx]?.value}`;

    // B 手指滑列表：在真会溢出的「游戏」列表上量
    await reset();
    await clickNav('游戏');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    const g = await geom();
    await touchPan(g.left + g.width / 2, g.top + g.height / 2, 120);
    await page.waitForTimeout(600);
    const g2 = await geom();
    out.pan = `${g.scrollTop}->${g2.scrollTop}（余量 ${g.room}px）`;

    console.log(`\n[${tag}]`);
    console.log(`  A-1 tap 分类栏 -> 列表 = ${out.nav}`);
    console.log(`  A-2 tap 开关行 -> ${out.row}`);
    console.log(`  C   按住 800ms -> ${out.hold}`);
    console.log(`  B   手指滑 120px -> ${out.pan}`);
    return out;
  };

  const base = await measure('出厂状态');
  if (process.argv.includes('--as-shipped')) {
    console.log('\n（--as-shipped：只量产品现状，不注入对比监听）');
    await browser.close();
    return;
  }

  await page.evaluate(() => {
    document.addEventListener('touchstart', (e) => {
      if (e.target instanceof Element && e.target.closest('#nes-canvas, #canvas-overlay')) return;
      e.preventDefault();
    }, { passive: false });
  });
  const patched = await measure('整页掐 touchstart（画面除外）');

  console.log('\n========== 对比 ==========');
  for (const k of ['nav', 'row', 'hold', 'pan']) {
    console.log(`${k.padEnd(4)} 出厂 ${base[k]}`);
    console.log(`     加了 ${patched[k]}`);
  }

  await browser.close();
})();
