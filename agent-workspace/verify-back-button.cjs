// 验证子菜单的返回按钮和侧栏隐藏
const { launch } = require('./lib-browser.cjs');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
};

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto('http://localhost:7890/nes-console/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  const mainState = await page.evaluate(() => {
    const back = document.querySelector('.sys-back');
    const sidebar = document.querySelector('.sys-sidebar');
    return { backHidden: back?.hidden, sidebarHidden: sidebar?.hidden };
  });
  console.log('主菜单:', JSON.stringify(mainState));
  check('主菜单返回按钮隐藏', mainState.backHidden === true);
  check('主菜单侧栏显示', mainState.sidebarHidden === false);

  // 进入设置子菜单：主菜单打开时焦点在分类栏，↑↓ 走到「系统」分类，
  // 再按两次 A（第一次进列表、第二次执行列表第一行「设置」）。
  // 不写死次数 —— 分类栏会随功能增减，数次数一改就得改一遍。
  await page.evaluate(async () => {
    const pressed = () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true }));
      return new Promise((r) => setTimeout(r, 60));
    };
    const released = () => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowDown', bubbles: true }));
      return new Promise((r) => setTimeout(r, 60));
    };
    const selected = () =>
      document.querySelector('.sys-nav-item.selected .sys-nav-label')?.textContent || '';
    for (let i = 0; i < 8 && selected() !== '系统'; i++) { await pressed(); await released(); }
    const keyA = async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', bubbles: true }));
      await new Promise((r) => setTimeout(r, 40));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
    };
    await keyA();   // 分类栏 -> 列表
    await keyA();   // 执行「设置」这一行
  });

  const subState = await page.evaluate(() => {
    const back = document.querySelector('.sys-back');
    const sidebar = document.querySelector('.sys-sidebar');
    const title = document.querySelector('.sys-title')?.textContent;
    return {
      backHidden: back?.hidden,
      sidebarHidden: sidebar?.hidden,
      title,
    };
  });
  console.log('设置子菜单:', JSON.stringify(subState));
  check('子菜单返回按钮显示', subState.backHidden === false);
  // 设置自己就是带分类栏的菜单（显示/音频/系统），所以分类栏要露出来，
  // 用户在里面照样用 ↑↓ 换分类（导航模型见 screen-ui.js）。
  check('设置子菜单显示它自己的分类栏', subState.sidebarHidden === false);
  check('子菜单标题正确', subState.title === '设置', `title=${subState.title}`);

  // 点返回按钮 → 退回主菜单
  await page.evaluate(() => document.querySelector('.sys-back').click());
  await page.waitForTimeout(300);

  const backState = await page.evaluate(() => {
    const back = document.querySelector('.sys-back');
    const sidebar = document.querySelector('.sys-sidebar');
    const title = document.querySelector('.sys-title')?.textContent;
    return {
      backHidden: back?.hidden,
      sidebarHidden: sidebar?.hidden,
      title,
    };
  });
  console.log('返回后:', JSON.stringify(backState));
  check('返回后回到主菜单', backState.title === 'NES Console', `title=${backState.title}`);
  check('返回后返回按钮隐藏', backState.backHidden === true);
  check('返回后侧栏显示', backState.sidebarHidden === false);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
