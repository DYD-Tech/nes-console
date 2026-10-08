// 冒烟检查：在真实浏览器里跑一遍，只验证「不报错、菜单能开、按键有反应」。
// 不做视觉/GUI 断言（用户明确要求不做 GUI 测试），只抓控制台错误和关键状态。
const { launch } = require('./lib-browser.cjs');

const URL = 'http://localhost:7890/nes-console/';

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // 按键工具：必须「按下 + 松开」成对派发。
  // 输入系统对同一动作去重（按住不放只算一次），只派发 keydown 不派发 keyup，
  // 第二次同方向按键会被当成「还按着」而忽略。
  await page.addInitScript(() => {});
  await page.evaluate(() => {
    window.__press = async (code, waitMs = 70) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      await new Promise((r) => setTimeout(r, waitMs));
    };
  });

  let pass = 0, fail = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name} ${detail}`); }
  };

  console.log('\n【页面加载】');
  check('无 JS 错误', errors.length === 0, errors.join(' | '));

  console.log('\n【系统界面】');
  const ui = await page.evaluate(() => {
    const el = document.querySelector('.sys-ui');
    return el ? {
      exists: true,
      visible: !el.hidden,
      title: el.querySelector('.sys-title')?.textContent || '',
      sections: el.querySelectorAll('.sys-nav-item').length,
      items: el.querySelectorAll('.sys-item').length,
      // 按键提示是菜单的一部分（.sys-ui 里的 .sys-hintbar），菜单关掉整栏跟着没
      hints: document.querySelectorAll('.sys-hintbar .sys-hint').length,
      firstItem: el.querySelector('.sys-item-label')?.textContent || '',
      selected: el.querySelectorAll('.sys-item.selected').length,
    } : { exists: false };
  });

  check('系统界面已挂载', ui.exists === true);
  check('启动时显示主菜单', ui.visible === true);
  check('标题为 NES Console', ui.title === 'NES Console', `实际 "${ui.title}"`);
  check('侧边栏有分类（游戏/游戏管理/控制管理/系统/操作说明/关于）', ui.sections === 6, `实际 ${ui.sections}`);
  check('列表有游戏条目', ui.items > 0, `实际 ${ui.items}`);
  check('底部有按键提示', ui.hints > 0, `实际 ${ui.hints}`);
  check('有且仅有一个选中项', ui.selected === 1, `实际 ${ui.selected}`);
  console.log(`     首个条目: "${ui.firstItem}"`);

  console.log('\n【键盘导航】');
  // 导航模型（见 screen-ui.js）：带分类栏的菜单里焦点分「分类栏 / 列表」两栏，
  // ↑↓ 只动当前那一栏，→ 或 A 进列表，← 或 B 回分类栏。
  // 下面每一块开头都先按 ← 把焦点收回分类栏，这样各块互不依赖上一块停在哪儿。
  const nav = await page.evaluate(async () => {
    const ui = document.querySelector('.sys-ui');
    const sel = () => Array.from(ui.querySelectorAll('.sys-item'))
      .findIndex((el) => el.classList.contains('selected'));
    const cat = () => ui.querySelector('.sys-nav-item.selected .sys-nav-label')?.textContent || '';
    await window.__press('ArrowLeft');
    // 「游戏」分类有多少款取决于 public/rom/ 里放了什么，
    // 所以光标移动在「游戏管理」这种条目固定的分类上验证（3 项）。
    for (let i = 0; i < 6 && cat() !== '游戏管理'; i++) await window.__press('ArrowDown');
    const reached = cat();
    await window.__press('ArrowRight');   // 进列表
    const before = sel();
    await window.__press('ArrowDown');
    const after = sel();
    await window.__press('ArrowLeft');
    return { reached, before, after, focus: ui.dataset.focus };
  });
  check('在分类栏按 ↓ 能走到「游戏管理」', nav.reached === '游戏管理', `实际 "${nav.reached}"`);
  check('进列表时光标停在第一行', nav.before === 0, `实际 ${nav.before}`);
  check('十字键 ↓ 移动光标', nav.after === nav.before + 1,
    `${nav.before} -> ${nav.after}`);
  check('按 ← 回到分类栏', nav.focus === 'sidebar', `实际 ${nav.focus}`);

  const navUp = await page.evaluate(async () => {
    const ui = document.querySelector('.sys-ui');
    const sel = () => Array.from(ui.querySelectorAll('.sys-item'))
      .findIndex((el) => el.classList.contains('selected'));
    await window.__press('ArrowLeft');
    await window.__press('ArrowRight');   // 进列表
    await window.__press('ArrowDown');
    await window.__press('ArrowDown');
    const mid = sel();
    await window.__press('ArrowUp');
    const after = sel();
    return { mid, after, len: ui.querySelectorAll('.sys-item').length };
  });
  // 「游戏管理」只有三项，↓ 走两下会绕回第一行，此时 ↑ 的下一步是最后一项 —— 取模算
  check('十字键 ↑ 反向移动光标', navUp.after === (navUp.mid - 1 + navUp.len) % navUp.len,
    `${navUp.mid} -> ${navUp.after}（共 ${navUp.len} 项）`);

  const catSwitch = await page.evaluate(async () => {
    const ui = document.querySelector('.sys-ui');
    const active = () => Array.from(ui.querySelectorAll('.sys-nav-item'))
      .findIndex((el) => el.classList.contains('selected'));
    await window.__press('ArrowLeft');   // 先回分类栏
    const before = active();
    await window.__press('ArrowDown');
    const after = active();
    await window.__press('ArrowUp');
    const back = active();
    return { before, after, back };
  });
  check('分类栏里 ↓ 换分类', catSwitch.after === catSwitch.before + 1,
    `${catSwitch.before} -> ${catSwitch.after}`);
  check('分类栏里 ↑ 换回来', catSwitch.back === catSwitch.before,
    `${catSwitch.after} -> ${catSwitch.back}`);

  const enterList = await page.evaluate(async () => {
    const ui = document.querySelector('.sys-ui');
    const active = () => Array.from(ui.querySelectorAll('.sys-nav-item'))
      .findIndex((el) => el.classList.contains('selected'));
    await window.__press('ArrowLeft');
    const catBefore = active();
    await window.__press('ArrowRight');
    const catAfter = active();
    return { catBefore, catAfter, focus: ui.dataset.focus };
  });
  check('按 → 是「进列表」，不是换分类',
    enterList.catBefore === enterList.catAfter && enterList.focus === 'list',
    `分类 ${enterList.catBefore} -> ${enterList.catAfter}，焦点 ${enterList.focus}`);

  console.log('\n【设置菜单】');
  const settings = await page.evaluate(async () => {
    const ui = document.querySelector('.sys-ui');
    // 走到「系统」分类（↑↓ 在分类栏里选），进列表，再对第一项「设置」按 A。
    // 这里不按「按几次 →」写死：分类栏会随功能增减，写死次数一改就得改一遍。
    await window.__press('ArrowLeft');
    const activeLabel = () =>
      ui.querySelector('.sys-nav-item.selected .sys-nav-label')?.textContent || '';
    for (let i = 0; i < 8 && activeLabel() !== '系统'; i++) await window.__press('ArrowDown');
    const reached = activeLabel();
    await window.__press('KeyX', 150);   // A：从分类栏进列表
    const row = ui.querySelector('.sys-item.selected .sys-item-label')?.textContent || '';
    await window.__press('KeyX', 300);   // A：执行「设置」这一行
    return {
      reached,
      row,
      title: ui.querySelector('.sys-title')?.textContent || '',
      items: Array.from(ui.querySelectorAll('.sys-item-label')).map((e) => e.textContent),
      values: Array.from(ui.querySelectorAll('.sys-item-value')).map((e) => e.textContent),
      sections: Array.from(ui.querySelectorAll('.sys-nav-item')).map((e) => e.textContent.trim()),
      focus: ui.dataset.focus,
    };
  });
  check('能进入设置菜单', settings.title === '设置', `实际 "${settings.title}"`);
  check('设置菜单有内容', settings.items.length > 0, settings.items.join(','));
  check('基线：确实是从「系统」分类进的设置（不是走错栏）', settings.reached === '系统', `实际停在 "${settings.reached}"`);
  check('系统分类第一项是「设置」', settings.row === '设置', `实际 "${settings.row}"`);
  check('设置自己带分类栏（显示/音频/系统）', settings.sections.length === 3,
    settings.sections.join('/'));
  check('进设置后焦点停在它自己的分类栏上', settings.focus === 'sidebar', `实际 ${settings.focus}`);
  console.log(`     设置项: ${settings.items.map((n, i) => `${n}=${settings.values[i]}`).join(' · ')}`);

  // 焦点在分类栏时 A 是「进列表」，所以先按 → 进列表，A 才是改值
  const toggled = await page.evaluate(async () => {
    const ui = document.querySelector('.sys-ui');
    const val = () => ui.querySelector('.sys-item.selected .sys-item-value')?.textContent || '';
    await window.__press('ArrowRight');
    const before = val();
    await window.__press('KeyX');   // A 键
    const after = val();
    return { before, after };
  });
  check('A 键能切换设置值', toggled.before !== toggled.after,
    `${toggled.before} -> ${toggled.after}`);

  // 分类栏里 ↑↓ 换分类：列表内容跟着换（显示 -> 音频）。
  // 上一块把焦点留在了列表上，先按 ← 回分类栏。
  const sectionSwitch = await page.evaluate(async () => {
    const ui = document.querySelector('.sys-ui');
    const items = () => Array.from(ui.querySelectorAll('.sys-item-label')).map((e) => e.textContent);
    await window.__press('ArrowLeft');
    const before = items();
    await window.__press('ArrowDown');
    const after = items();
    return { before, after, focus: ui.dataset.focus };
  });
  check('分类栏里 ↓ 能换分类（列表内容变了）',
    sectionSwitch.before.join(',') !== sectionSwitch.after.join(','),
    `${sectionSwitch.before.join(',')} -> ${sectionSwitch.after.join(',')}`);
  check('换分类后焦点仍在分类栏', sectionSwitch.focus === 'sidebar', `实际 ${sectionSwitch.focus}`);

  // 音频分类里应该有音量和静音
  const audioItems = await page.evaluate(() => {
    const ui = document.querySelector('.sys-ui');
    return {
      items: Array.from(ui.querySelectorAll('.sys-item-label')).map((e) => e.textContent),
      values: Array.from(ui.querySelectorAll('.sys-item-value')).map((e) => e.textContent),
    };
  });
  check('音频分类含音量项', audioItems.items.some((n) => n.includes('音量')),
    audioItems.items.join(','));
  console.log(`     音频项: ${audioItems.items.map((n, i) => `${n}=${audioItems.values[i]}`).join(' · ')}`);

  console.log('\n【菜单按键提示】');
  // 提示按焦点所在栏给不同的内容（menu.hints 是函数，见 app.js）
  const hintSidebar = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.sys-hintbar .sys-hint')).map((e) => e.textContent));
  check('焦点在分类栏时提示「选分类」', hintSidebar.some((h) => h.includes('选分类')),
    hintSidebar.join(' | '));
  const hintList = await page.evaluate(async () => {
    await window.__press('ArrowRight');
    return Array.from(document.querySelectorAll('.sys-hintbar .sys-hint')).map((e) => e.textContent);
  });
  check('进列表后提示换成「回分类」', hintList.some((h) => h.includes('回分类')),
    hintList.join(' | '));

  // Esc 逐级返回：设置 -> 主菜单 -> 关闭
  const escOnce = await page.evaluate(async () => {
    await window.__press('Escape', 150);
    return document.querySelector('.sys-title')?.textContent || '';
  });
  check('Esc 从设置退回主菜单', escOnce === 'NES Console', `实际 "${escOnce}"`);

  const escTwice = await page.evaluate(async () => {
    await window.__press('Escape', 150);
    return {
      hidden: document.querySelector('.sys-ui').hidden,
      title: document.querySelector('.sys-title')?.textContent || '',
    };
  });
  check('Esc 再按一次关闭菜单', escTwice.hidden === true, `title="${escTwice.title}"`);

  // 重新打开菜单，确认还能用
  const reopened = await page.evaluate(async () => {
    await window.__press('Escape', 150);
    return {
      hidden: document.querySelector('.sys-ui').hidden,
      title: document.querySelector('.sys-title')?.textContent || '',
    };
  });
  check('Esc 能把菜单再打开', reopened.hidden === false && reopened.title === 'NES Console',
    `hidden=${reopened.hidden} title="${reopened.title}"`);

  console.log('\n【触摸手柄】');
  const touch = await page.evaluate(() => {
    const btns = document.querySelectorAll('#touch-controls [data-action]');
    return {
      count: btns.length,
      actions: Array.from(btns).map((b) => b.dataset.action),
      hasMenu: !!document.querySelector('.touch-menu'),
    };
  });
  // 十字键 4 个臂 + 4 段斜向弧键 + 功能键 6 个（SELECT/START/X/Y/B/A）+ 簇心 AB = 15
  // （MENU 已移到屏幕右上角；弧键一段声明两个动作，但它是一段键，不是一个按键）
  check('触摸手柄有 15 个动作声明', touch.count === 15, `实际 ${touch.count}`);
  check('每个按键都有动作声明', touch.actions.every((a) => !!a), touch.actions.join(','));
  check('有独立的菜单键', touch.hasMenu === true);

  console.log('\n【控制台错误汇总】');
  check('全程无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('冒烟检查失败:', e);
  process.exit(1);
});
