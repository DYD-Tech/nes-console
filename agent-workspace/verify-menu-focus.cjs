/**
 * 验证屏幕内菜单的「焦点栏」导航模型。
 *
 * 规则（本次改动要守住的东西，全部由用户反馈驱动）：
 * - 带分类栏的菜单（主菜单、设置）打开时焦点在分类栏上，不在列表上
 * - ↑↓ 只动当前那一栏：分类栏里换分类，列表里换条目
 * - A 或 → 从分类栏进列表；← 或 B 从列表回分类栏
 * - 整块界面只有一个「高亮框」，画在焦点所在的那一栏；另一栏只留背景色
 * - 没有分类栏的菜单（快速菜单、存档槽位）焦点恒在列表，←→ 还是调数值
 *
 * 为什么逐条写死而不是抽查：这套按键含义是用户每天用的，改错一条没人会报，
 * 只会觉得「菜单变难用了」。断言按规则一条一个，坏了能直接指出是哪条。
 */
const { launch } = require('./lib-browser.cjs');

const SEL_BG = 'rgb(33, 34, 39)';           // --oz-selection
const SEL_BORDER = 'rgb(45, 163, 203)';      // --oz-selection-border
const NONE_BORDER = 'rgba(0, 0, 0, 0)';      // 未描边
const SEL_TEXT = 'rgb(0, 217, 174)';         // --oz-text-selected

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
};

/** 在页面里按一个键（按下+松开），等一帧让界面重绘完。 */
const press = (page, code, ms = 90) =>
  page.evaluate(
    async ([c, wait]) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true }));
      await new Promise((r) => setTimeout(r, wait));
    },
    [code, ms],
  );

/**
 * 读当前界面状态：焦点在哪栏、哪一项被选中、两栏各有没有描边/背景/变色。
 * 只从 DOM 和计算样式取，不 import 被测代码的副本（探针不许自己算一遍规则）。
 */
const state = (page) =>
  page.evaluate(() => {
    const ui = document.querySelector('.sys-ui');
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const navSel = ui.querySelector('.sys-nav-item.selected');
    const itemSel = ui.querySelector('.sys-item.selected');
    const itemNext = ui.querySelectorAll('.sys-item')[1];
    return {
      hidden: ui.hidden,
      focus: ui.dataset.focus,
      title: ui.querySelector('.sys-title').textContent,
      badge: ui.querySelector('.sys-badge').textContent,
      sidebarHidden: ui.querySelector('.sys-sidebar').hidden,
      cat: navSel ? navSel.querySelector('.sys-nav-label').textContent : '',
      item: itemSel ? itemSel.querySelector('.sys-item-label').textContent : '',
      catBg: cs(navSel)?.backgroundColor,
      catBorder: cs(navSel)?.borderColor,
      itemBg: cs(itemSel)?.backgroundColor,
      itemBorder: cs(itemSel)?.borderColor,
      // 列表第二项（未选中）当基准，确认没选中项没有跟着变亮
      otherBg: cs(itemNext)?.backgroundColor,
      // 数量栏在菜单左下角（.sys-count）；按键提示常驻在底栏右侧
      count: ui.querySelector('.sys-count').textContent,
      hint: ui.querySelector('.sys-hintbar').textContent,
      rowCount: ui.querySelectorAll('.sys-item').length,
    };
  });

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto('http://localhost:7890/nes-console/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // 菜单是开局就打开的（主菜单），先确认这一点，后面的步骤都以它为起点
  let s = await state(page);
  check('开局菜单打开', s.hidden === false);
  check('标题是主菜单', s.title === 'NES Console', `title=${s.title}`);

  // ---------- 1. 打开时焦点在分类栏 ----------
  check('焦点在分类栏', s.focus === 'sidebar', `focus=${s.focus}`);
  check('分类栏显示', s.sidebarHidden === false);
  check('默认选中「游戏」分类', s.cat === '游戏', `cat=${s.cat}`);
  check('分类有描边（框在分类栏）', s.catBorder === SEL_BORDER, `border=${s.catBorder}`);
  check('分类有背景高亮色', s.catBg === SEL_BG, `bg=${s.catBg}`);
  check('列表第一项没有背景高亮', s.itemBg !== SEL_BG && s.itemBg === s.otherBg, `itemBg=${s.itemBg} otherBg=${s.otherBg}`);
  check('列表光标行没有描边', s.itemBorder === NONE_BORDER, `border=${s.itemBorder}`);
  check('底栏提示是分类栏那套', s.hint.includes('选分类') && s.hint.includes('进入'), `hint=${s.hint}`);
  check('数量在菜单左下角，和列表条数一致', s.count === `${s.rowCount} 款`, `count=${s.count} 行数=${s.rowCount}`);

  // ---------- 2. ↑↓ 在分类栏里换分类 ----------
  await press(page, 'ArrowDown');
  s = await state(page);
  check('按 ↓ 换到下一个分类', s.cat === '游戏管理', `cat=${s.cat}`);
  check('换分类后焦点仍在分类栏', s.focus === 'sidebar');
  await press(page, 'ArrowUp');
  s = await state(page);
  check('按 ↑ 回到「游戏」分类', s.cat === '游戏', `cat=${s.cat}`);

  // ---------- 3. → 或 A 进列表 ----------
  await press(page, 'ArrowRight');
  s = await state(page);
  check('按 → 进入列表', s.focus === 'list', `focus=${s.focus}`);
  check('进列表后分类不变', s.cat === '游戏', `cat=${s.cat}`);
  check('列表停在第一行', s.item !== '', `item=${s.item}`);
  check('框移到列表行上', s.itemBorder === SEL_BORDER, `border=${s.itemBorder}`);
  check('列表行有背景高亮', s.itemBg === SEL_BG, `bg=${s.itemBg}`);
  check('列表行文字变青绿', (await page.evaluate(() => getComputedStyle(document.querySelector('.sys-item.selected .sys-item-label')).color)) === SEL_TEXT);
  check('分类只留背景色、不留框', s.catBg === SEL_BG && s.catBorder === NONE_BORDER, `bg=${s.catBg} border=${s.catBorder}`);
  check('底栏提示换成列表那套',
    s.hint.includes('确认') && s.hint.includes('回分类'), `hint=${s.hint}`);

  // ---------- 4. ← 或 B 回分类栏，光标记住位置 ----------
  const firstItem = s.item;
  await press(page, 'ArrowDown');
  s = await state(page);
  check('在列表里按 ↓ 换条目', s.item !== firstItem && s.focus === 'list', `item=${s.item}`);
  const movedTo = s.item;
  await press(page, 'ArrowLeft');
  s = await state(page);
  check('按 ← 回到分类栏', s.focus === 'sidebar' && s.cat === '游戏', `focus=${s.focus} cat=${s.cat}`);
  check('回分类栏后框在分类上', s.catBorder === SEL_BORDER && s.itemBorder === NONE_BORDER, `cat=${s.catBorder} item=${s.itemBorder}`);
  await press(page, 'ArrowRight');
  s = await state(page);
  check('再进列表还停在原来那一行（记住选择）', s.item === movedTo, `item=${s.item} 期望=${movedTo}`);
  await press(page, 'KeyZ'); // B
  s = await state(page);
  check('在列表里按 B 也回分类栏', s.focus === 'sidebar', `focus=${s.focus}`);

  // ---------- 5. ↑↓ 换分类不会跑到别的分类的列表里去 ----------
  await press(page, 'ArrowDown');
  await press(page, 'ArrowDown');
  s = await state(page);
  check('连按 ↓ 走到「控制管理」', s.cat === '控制管理', `cat=${s.cat}`);
  check('控制管理列表有内容', s.rowCount >= 3, `rows=${s.rowCount}`);

  // ---------- 6. 分类栏上按 B：退一级，顶层就是关菜单 ----------
  await press(page, 'KeyZ');
  s = await state(page);
  check('主菜单分类栏上按 B 直接关掉菜单', s.hidden === true);

  // ---------- 7. 设置子菜单：自己带分类栏，进去后焦点在分类栏 ----------
  await press(page, 'Escape'); // 重新打开主菜单
  s = await state(page);
  check('重开后菜单是打开的', s.hidden === false);
  check('重开后焦点回到分类栏', s.focus === 'sidebar', `focus=${s.focus}`);
  // 走到「系统」分类（不写死次数：分类会增减）
  for (let i = 0; i < 8 && s.cat !== '系统'; i++) {
    await press(page, 'ArrowDown');
    s = await state(page);
  }
  check('能走到「系统」分类', s.cat === '系统', `cat=${s.cat}`);
  await press(page, 'KeyX'); // A 进列表
  s = await state(page);
  check('进列表后选中「设置」行', s.item.includes('设置'), `item=${s.item}`);
  await press(page, 'KeyX'); // A 执行
  s = await state(page);
  check('进入设置菜单', s.title === '设置', `title=${s.title}`);
  check('设置菜单焦点在分类栏', s.focus === 'sidebar', `focus=${s.focus}`);
  check('设置菜单的分类栏是显示的', s.sidebarHidden === false);
  check('设置分类栏停在第一个分类', s.cat !== '', `cat=${s.cat}`);
  await press(page, 'ArrowRight');
  s = await state(page);
  check('设置里按 → 进列表', s.focus === 'list', `focus=${s.focus}`);
  const valBefore = await page.evaluate(() => document.querySelector('.sys-item.selected .sys-item-value')?.textContent || '');
  await press(page, 'KeyX');
  s = await state(page);
  const valAfter = await page.evaluate(() => document.querySelector('.sys-item.selected .sys-item-value')?.textContent || '');
  check('设置里按 A 会改值', valBefore !== valAfter, `${valBefore} -> ${valAfter}`);
  await press(page, 'ArrowLeft');
  s = await state(page);
  check('设置里按 ← 回分类栏', s.focus === 'sidebar', `focus=${s.focus}`);
  await press(page, 'KeyZ');
  s = await state(page);
  check('设置里分类栏按 B 退回主菜单', s.title === 'NES Console', `title=${s.title}`);
  check('退回主菜单后焦点还在列表（离开时在哪就该在哪）', s.focus === 'list', `focus=${s.focus}`);

  // ---------- 8. 没有分类栏的菜单：焦点恒在列表 ----------
  await press(page, 'KeyZ');
  s = await state(page);
  check('主菜单列表按 B 先回分类栏，菜单没关', s.hidden === false && s.focus === 'sidebar', `hidden=${s.hidden} focus=${s.focus}`);
  await press(page, 'ArrowUp');
  s = await state(page);
  check('走到「控制管理」分类', s.cat === '控制管理', `cat=${s.cat}`);
  await press(page, 'ArrowRight');
  s = await state(page);
  check('进控制管理列表，第一行是按键映射', s.item.includes('按键映射'), `item=${s.item}`);
  await press(page, 'KeyX');
  s = await state(page);
  check('进入按键映射（单栏）', s.title === '按键映射', `title=${s.title}`);
  check('单栏菜单没有分类栏', s.sidebarHidden === true);
  check('单栏菜单焦点直接落在列表上', s.focus === 'list', `focus=${s.focus}`);
  check('单栏菜单的光标行有描边', s.itemBorder === SEL_BORDER, `border=${s.itemBorder}`);
  await press(page, 'ArrowDown');
  s = await state(page);
  check('单栏菜单里 ↑↓ 动的就是条目', s.focus === 'list' && s.item !== '');
  await press(page, 'KeyZ');
  s = await state(page);
  check('单栏菜单按 B 直接退一级（没有分类栏可回）', s.title === 'NES Console', `title=${s.title}`);

  // ---------- 9. 触屏：点分类就等于选中并进入它的列表 ----------
  await press(page, 'KeyZ'); // 回分类栏
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.sys-nav-item .sys-nav-label')];
    const target = items.find((el) => el.textContent === '关于');
    target.closest('.sys-nav-item').click();
  });
  await page.waitForTimeout(200);
  s = await state(page);
  check('点「关于」分类后进到它的列表', s.cat === '关于' && s.focus === 'list', `cat=${s.cat} focus=${s.focus}`);
  check('点分类后列表有内容', s.rowCount >= 1, `rows=${s.rowCount}`);

  // ---------- 10. 「操作说明」写的就是这套按键，不再写「← → 切分类」 ----------
  // 「操作说明」就排在「关于」上面一格，按一次 ↑ 即到
  await press(page, 'KeyZ'); // 回分类栏
  await press(page, 'ArrowUp');
  s = await state(page);
  check('能走到「操作说明」分类', s.cat === '操作说明', `cat=${s.cat}`);
  const helpRows = await page.evaluate(() =>
    [...document.querySelectorAll('.sys-item')].map((li) => ({
      label: li.querySelector('.sys-item-label').textContent,
      value: li.querySelector('.sys-item-value')?.textContent || '',
    })),
  );
  const helpText = JSON.stringify(helpRows);
  check('说明里有「进入该分类的列表」= A 或 →', helpRows.some((r) => r.label.includes('进入该分类的列表') && r.value.includes('→')), helpText);
  check('说明里有「回到分类栏」= B 或 ←', helpRows.some((r) => r.label.includes('回到分类栏') && r.value.includes('←')), helpText);
  check('说明里不再有「← → 切分类」这种旧写法', !helpRows.some((r) => r.value.replace(/\s/g, '') === '←→'), helpText);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
