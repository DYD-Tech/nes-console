// 验证「游戏管理」侧栏分类和子菜单
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
  page.on('pageerror', (e) => { fail++; console.log(`  ❌ PAGE ERROR: ${e.message}`); });
  await page.goto('http://localhost:7890/nes-console/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // 侧栏分类（只判「有没有这一类」，顺序跟着功能走，不作断言）
  const sections = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.sys-nav-item')).map((el) => ({
      label: el.querySelector('.sys-nav-label')?.textContent,
      active: el.classList.contains('selected'),
    }))
  );
  console.log('侧栏分类:', JSON.stringify(sections));

  check('侧栏有「游戏」分类', sections.some((s) => s.label === '游戏'));
  check('侧栏有「游戏管理」分类', sections.some((s) => s.label === '游戏管理'));
  check('侧栏有「系统」分类', sections.some((s) => s.label === '系统'));
  check('侧栏有「控制管理」分类', sections.some((s) => s.label === '控制管理'));

  // 切到「游戏管理」分类
  await page.evaluate(() => {
    const nav = document.querySelector('.sys-sidebar');
    const items = nav.querySelectorAll('.sys-nav-item');
    for (const item of items) {
      if (item.querySelector('.sys-nav-label')?.textContent === '游戏管理') {
        item.click();
        break;
      }
    }
  });
  await page.waitForTimeout(300);

  const manageItems = await page.evaluate(() => {
    const list = document.querySelector('.sys-list');
    return Array.from(list.querySelectorAll('.sys-item-label')).map((e) => e.textContent);
  });
  console.log('游戏管理子项:', JSON.stringify(manageItems));

  check('有「加入游戏」', manageItems.includes('加入游戏'));
  check('有「删除游戏」', manageItems.includes('删除游戏'));
  check('有「管理存档」', manageItems.includes('管理存档'));

  // 点击「删除游戏」→ 应显示已加入的游戏列表
  await page.evaluate(() => {
    const items = document.querySelectorAll('.sys-item');
    for (const item of items) {
      if (item.textContent.includes('删除游戏')) {
        item.click();
        break;
      }
    }
  });
  await page.waitForTimeout(300);

  const removeTitle = await page.evaluate(() => document.querySelector('.sys-title')?.textContent);
  check('删除游戏菜单标题正确', removeTitle === '删除游戏', `title=${removeTitle}`);

  // 返回
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape', bubbles: true }));
  });
  await page.waitForTimeout(300);

  // 点击「管理存档」→ 应显示有存档的游戏列表
  await page.evaluate(() => {
    const items = document.querySelectorAll('.sys-item');
    for (const item of items) {
      if (item.textContent.includes('管理存档')) {
        item.click();
        break;
      }
    }
  });
  await page.waitForTimeout(500);

  const savesTitle = await page.evaluate(() => document.querySelector('.sys-title')?.textContent);
  check('管理存档菜单标题正确', savesTitle === '管理存档', `title=${savesTitle}`);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
