// 验证「控制管理」：按键改绑（含捕获态、抢键让位、持久化）、虚拟手柄显隐、拖动摆放
const { launch } = require('./lib-browser.cjs');
const URL = 'http://localhost:7890/nes-console/';
const SETTINGS_KEY = 'nes-console.settings';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

/** 点侧栏分类 */
async function openSection(page, label) {
  await page.evaluate((l) => {
    const btn = Array.from(document.querySelectorAll('.sys-nav-item'))
      .find((el) => el.querySelector('.sys-nav-label')?.textContent === l);
    if (btn) btn.click();
  }, label);
  await page.waitForTimeout(150);
}

/** 点当前列表里 label 匹配的条目 */
async function clickItem(page, label) {
  const ok = await page.evaluate((l) => {
    const li = Array.from(document.querySelectorAll('.sys-item'))
      .find((el) => el.querySelector('.sys-item-label')?.textContent === l);
    if (!li) return false;
    li.click();
    return true;
  }, label);
  if (!ok) throw new Error(`找不到条目 "${label}"`);
  await page.waitForTimeout(200);
}

/** 当前列表：label -> value */
function readList(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.sys-item')).map((el) => ({
    label: el.querySelector('.sys-item-label')?.textContent,
    value: el.querySelector('.sys-item-value')?.textContent ?? null,
  })));
}

const readStored = (page) => page.evaluate((k) => {
  try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; }
}, SETTINGS_KEY);

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1024, height: 768 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  console.log('\n【入口与菜单】');
  const sections = await page.evaluate(() => Array.from(
    document.querySelectorAll('.sys-nav-label'),
  ).map((e) => e.textContent));
  check('侧栏有「游戏管理」（原「管理游戏」已改名）', sections.includes('游戏管理'), sections.join('/'));
  check('侧栏没有旧的「管理游戏」写法', !sections.includes('管理游戏'), sections.join('/'));
  check('侧栏有「控制管理」', sections.includes('控制管理'), sections.join('/'));

  await openSection(page, '控制管理');
  const ctrl = await readList(page);
  const labels = ctrl.map((i) => i.label);
  check('控制管理含按键映射', labels.includes('按键映射'), labels.join('/'));
  check('控制管理含虚拟手柄', labels.includes('虚拟手柄'), labels.join('/'));
  check('控制管理含手柄按键显隐', labels.includes('手柄按键显隐'), labels.join('/'));
  check('控制管理含自由摆放按键', labels.includes('自由摆放按键'), labels.join('/'));
  check('控制管理含恢复默认控制', labels.includes('恢复默认控制'), labels.join('/'));
  check('虚拟手柄一行显示当前模式',
    (ctrl.find((i) => i.label === '虚拟手柄').value || '').startsWith('自动'),
    ctrl.find((i) => i.label === '虚拟手柄').value);

  console.log('\n【按键映射】');
  await clickItem(page, '按键映射');
  let km = await readList(page);
  check('按键映射列出 13 个动作', km.length === 13, `实际 ${km.length}`);
  check('A 键默认显示 X', km.find((i) => i.label === 'A 键')?.value === 'X',
    km.find((i) => i.label === 'A 键')?.value);
  check('SELECT 显示成「右 Shift」而不是 ShiftRight',
    km.find((i) => i.label === 'SELECT')?.value === '右 Shift',
    km.find((i) => i.label === 'SELECT')?.value);

  // 选中「A 键」这一行（点它会把光标移过去并执行 onSelect -> 进入捕获）
  await clickItem(page, 'A 键');
  let hint = await page.evaluate(() => document.querySelector('.sys-hintbar')?.textContent || '');
  km = await readList(page);
  check('按 A 后该行显示等待按键', km.find((i) => i.label === 'A 键')?.value === '按下按键…',
    km.find((i) => i.label === 'A 键')?.value);
  check('捕获态提示改为「任意键 / 取消」', hint.includes('取消'), hint);

  // 捕获期按方向键：不能被当成「移动光标」，而是绑给 A 键
  const selBefore = await page.evaluate(() => Array.from(document.querySelectorAll('.sys-item'))
    .findIndex((el) => el.classList.contains('selected')));
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  const selAfter = await page.evaluate(() => Array.from(document.querySelectorAll('.sys-item'))
    .findIndex((el) => el.classList.contains('selected')));
  km = await readList(page);
  check('捕获期按方向键不移动光标', selBefore === selAfter, `${selBefore} -> ${selAfter}`);
  check('捕获期按的方向键被绑给该动作', km.find((i) => i.label === 'A 键')?.value === '↓',
    km.find((i) => i.label === 'A 键')?.value);
  check('改绑写进 localStorage',
    (await readStored(page)).controls?.keyMap?.A === 'ArrowDown');
  check('抢走方向键后，原动作（方向 下）显示未绑定',
    km.find((i) => i.label === '方向 下')?.value === '未绑定',
    km.find((i) => i.label === '方向 下')?.value);

  // Esc 取消：不改动任何绑定
  await clickItem(page, 'B 键');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  km = await readList(page);
  check('Esc 取消改绑', km.find((i) => i.label === 'B 键')?.value === 'Z',
    km.find((i) => i.label === 'B 键')?.value);

  // 用 J 键验证「改绑后真的能用」：把 START 绑到 KeyJ，退出菜单后按 J 应触发 START
  await clickItem(page, 'START');
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(200);
  km = await readList(page);
  check('START 改绑到 J', km.find((i) => i.label === 'START')?.value === 'J',
    km.find((i) => i.label === 'START')?.value);
  // 端到端证明改绑生效：SELECT+START 组合键仍然管用。
  // START 已改绑到 J，所以 Shift+Enter（旧键）不该有反应，Shift+J 才该有反应。
  // 此刻栈里是 主菜单 / 按键映射 两层（侧栏分类不算一层，它是同一层里的分区），
  // MENU 的既定行为是「在子菜单里退一级」，所以预期回到主菜单而不是一下全关。
  // 组合键要「同时按住」，playwright 的 press 是按下即松开，所以这里手工发 down/up。
  const holdCombo = async (startKey) => {
    const fire = (type, code) => page.evaluate(({ type, code }) => {
      window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    }, { type, code });
    await fire('keydown', 'ShiftRight');
    await fire('keydown', startKey);
    await page.waitForTimeout(150);
    await fire('keyup', startKey);
    await fire('keyup', 'ShiftRight');
    await page.waitForTimeout(200);
  };
  const menuTitle = () => page.evaluate(() => document.querySelector('.sys-title')?.textContent || '');
  await holdCombo('Enter');
  check('旧 START 键（Enter）改绑后不再触发组合键',
    (await menuTitle()) === '按键映射', `实际标题 "${await menuTitle()}"`);
  await holdCombo('KeyJ');
  const comboBack = await page.evaluate(() => ({
    title: document.querySelector('.sys-title')?.textContent || '',
    visible: !document.querySelector('.sys-ui').hidden,
  }));
  check('改绑后的 START 键（J）能触发组合键（退一级回主菜单）',
    comboBack.title === 'NES Console' && comboBack.visible, JSON.stringify(comboBack));

  // 刷新验证持久化：START 仍是 J，方向 下 仍未绑定
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await openSection(page, '控制管理');
  await clickItem(page, '按键映射');
  km = await readList(page);
  check('刷新后改绑仍然生效', km.find((i) => i.label === 'START')?.value === 'J',
    km.find((i) => i.label === 'START')?.value);
  check('刷新后解绑仍然生效', km.find((i) => i.label === '方向 下')?.value === '未绑定',
    km.find((i) => i.label === '方向 下')?.value);

  // 清空改绑：捕获期按 Backspace。界面不再用 X/Y（不是所有手柄都有这两个键），
  // 所以「清空这个动作的键盘键」收进了捕获态里，用键盘自己的键完成。
  await clickItem(page, 'Y 键');
  await page.waitForTimeout(150);
  const clearHint = await page.evaluate(() => document.querySelector('.sys-hintbar')?.textContent || '');
  check('捕获态提示里有「清空」', clearHint.includes('清空'), clearHint);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);
  km = await readList(page);
  check('捕获期按 Backspace 清空该动作的按键', km.find((i) => i.label === 'Y 键')?.value === '未绑定',
    km.find((i) => i.label === 'Y 键')?.value);

  console.log('\n【虚拟手柄显隐】');
  await page.evaluate(() => document.querySelector('.sys-back').click());
  await page.waitForTimeout(200);
  await openSection(page, '控制管理');

  const stageClasses = () => page.evaluate(() => Array.from(
    document.querySelector('.stage').classList,
  ).join(' '));
  const padVisible = () => page.evaluate(() => {
    const el = document.getElementById('touch-controls');
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).display !== 'none' && r.width > 0;
  });

  check('默认（自动）在非触摸设备上隐藏', (await padVisible()) === false, await stageClasses());
  await clickItem(page, '虚拟手柄');
  check('按一次切到「始终显示」',
    (await readList(page)).find((i) => i.label === '虚拟手柄')?.value === '始终显示');
  check('始终显示时 .stage 带 pad-always', (await stageClasses()).includes('pad-always'));
  check('始终显示时手柄真的可见', (await padVisible()) === true);
  await clickItem(page, '虚拟手柄');
  check('再按一次切到「隐藏」',
    (await readList(page)).find((i) => i.label === '虚拟手柄')?.value === '隐藏');
  check('隐藏时手柄不可见', (await padVisible()) === false);
  await clickItem(page, '虚拟手柄');
  check('三档循环回到「自动」',
    (await readList(page)).find((i) => i.label === '虚拟手柄')?.value.startsWith('自动'));
  check('模式写进 localStorage', (await readStored(page)).controls?.padMode === 'auto');

  // 单键显隐：先切到「始终显示」（自动→始终是一步），再逐个关
  await clickItem(page, '虚拟手柄');
  check('切到始终显示以便验证单键', (await padVisible()) === true, await stageClasses());
  await clickItem(page, '手柄按键显隐');
  const padList = await readList(page);
  check('显隐菜单列出 8 个按键组', padList.length === 8, `实际 ${padList.length}`);
  const hiddenSize = await page.evaluate(() => {
    const el = document.querySelector('.touch-a');
    return el.getBoundingClientRect().width;
  });
  check('A 键当前占位（未隐藏）', hiddenSize > 0, `宽 ${hiddenSize}`);
  await clickItem(page, 'A 键');
  const aHidden = await page.evaluate(() => {
    const el = document.querySelector('.touch-a');
    return { cls: el.classList.contains('pad-off'), w: el.getBoundingClientRect().width };
  });
  check('按 A 后 A 键隐藏', aHidden.cls === true && aHidden.w === 0, JSON.stringify(aHidden));
  check('隐藏状态写进 localStorage', (await readStored(page)).controls?.padKeys?.a === false);
  await clickItem(page, 'A 键');
  const aBack = await page.evaluate(() => document.querySelector('.touch-a').getBoundingClientRect().width);
  check('再按一次恢复显示', aBack > 0, `宽 ${aBack}`);

  console.log('\n【拖动摆放】');
  await page.evaluate(() => document.querySelector('.sys-back').click());
  await page.waitForTimeout(200);
  await openSection(page, '控制管理');
  await clickItem(page, '自由摆放按键');
  const editState = await page.evaluate(() => ({
    menuHidden: document.querySelector('.sys-ui').hidden,
    editorShown: !document.getElementById('layout-editor').hidden,
    editing: document.querySelector('.stage').classList.contains('layout-edit'),
  }));
  check('进入摆放模式会关掉菜单', editState.menuHidden === true);
  check('摆放模式显示提示条', editState.editorShown === true);
  check('摆放模式给 .stage 打上标记', editState.editing === true);

  // 两个拖动单位都要真的存在：selector 写错时构造里那句 filter 会把整块悄悄丢掉，
  // 看起来一切正常，只是那块再也拖不动。两颗胶囊一边一颗之后，右手那块是新包出来的，
  // 所以点名验「各带自己那颗」。
  const units = await page.evaluate(() => ({
    leftSelect: !!document.querySelector('.touch-dpad-group .touch-select'),
    leftStart: !!document.querySelector('.touch-dpad-group .touch-start'),
    rightStart: !!document.querySelector('.touch-actions-group .touch-start'),
    rightCluster: !!document.querySelector('.touch-actions-group .touch-actions'),
  }));
  check('两块拖动单位都在，胶囊键一边一颗',
    units.leftSelect && !units.leftStart && units.rightStart && units.rightCluster,
    JSON.stringify(units));

  // 摆放模式下按按键组只拖动、不给游戏发按键
  const suppressed = await page.evaluate(() => {
    const el = document.querySelector('.touch-up');
    let got = false;
    const probe = () => { got = true; };
    el.addEventListener('pointerdown', probe);
    const ev = new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 9, clientX: 10, clientY: 10,
    });
    el.dispatchEvent(ev);
    el.removeEventListener('pointerdown', probe);
    return { got, prevented: ev.defaultPrevented };
  });
  check('拖动时按键收不到 pointerdown（不发游戏输入）', suppressed.got === false);
  check('拖动时事件被拦下（preventDefault）', suppressed.prevented === true);

  // 反证「鼠标划过」不会被当成拖动：上面那次没配对 pointerup 的 pointerdown
  // 仍留在拖动态里，此时 buttons=0 的 pointermove 必须不动元素（曾踩过：扫一下就把按键拖走）。
  const hoverMove = await page.evaluate(() => {
    const el = document.querySelector('.touch-dpad-group');
    const before = el.style.transform;
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: 500, clientY: 200, buttons: 0, pointerId: 9,
    }));
    const after = el.style.transform;
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));
    return { before, after };
  });
  check('指针没按住时的 move 不拖动按键',
    hoverMove.before === hoverMove.after, JSON.stringify(hoverMove));

  const before = await page.evaluate(() => {
    const r = document.querySelector('.touch-dpad-group').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await page.mouse.move(before.x + 30, before.y + 30);
  await page.mouse.down();
  await page.mouse.move(before.x + 180, before.y - 120, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => {
    const el = document.querySelector('.touch-dpad-group');
    const r = el.getBoundingClientRect();
    return {
      x: r.x, y: r.y, transform: el.style.transform,
      stored: JSON.parse(localStorage.getItem('nes-console.settings') || '{}').controls?.padLayout?.dpad,
    };
  });
  check('拖动改变了方向键区位置', Math.abs(after.x - before.x) > 100, JSON.stringify(after));
  check('位置用 transform 实现（不影响其他元素布局）', after.transform.startsWith('translate('),
    after.transform);
  check('偏移按比例存进 localStorage',
    typeof after.stored?.x === 'number' && after.stored.x > 0.1, JSON.stringify(after.stored));

  // 右手那块（动作簇 + START）也要能整块拖：START 挪到这边之后，
  // 它跟着簇走才是「拖一块管两颗键」，否则用户得能拖单键（没这功能）。
  const rBefore = await page.evaluate(() => {
    const g = document.querySelector('.touch-actions-group').getBoundingClientRect();
    const s = document.querySelector('.touch-start').getBoundingClientRect();
    return { x: g.x, y: g.y, startDx: s.x - g.x };
  });
  await page.mouse.move(rBefore.x + 30, rBefore.y + 30);
  await page.mouse.down();
  await page.mouse.move(rBefore.x - 150, rBefore.y - 120, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const rAfter = await page.evaluate(() => {
    const g = document.querySelector('.touch-actions-group').getBoundingClientRect();
    const s = document.querySelector('.touch-start').getBoundingClientRect();
    return {
      x: g.x,
      startDx: s.x - g.x,
      stored: JSON.parse(localStorage.getItem('nes-console.settings') || '{}').controls?.padLayout?.actions,
    };
  });
  check('右手那块能整块拖动', Math.abs(rAfter.x - rBefore.x) > 100,
    `位移 ${Math.round(rAfter.x - rBefore.x)}px`);
  check('START 跟着簇一起走（相对块的位置不变）',
    Math.abs(rAfter.startDx - rBefore.startDx) < 1,
    `拖动前 ${rBefore.startDx.toFixed(0)}px / 拖动后 ${rAfter.startDx.toFixed(0)}px`);
  check('右手偏移存进 padLayout.actions',
    typeof rAfter.stored?.x === 'number' && rAfter.stored.x < -0.1, JSON.stringify(rAfter.stored));

  // 复位
  await page.click('[data-editor="reset"]');
  await page.waitForTimeout(250);
  const reset = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('nes-console.settings') || '{}').controls?.padLayout;
    return {
      transform: document.querySelector('.touch-dpad-group').style.transform,
      rightTransform: document.querySelector('.touch-actions-group').style.transform,
      dpad: stored?.dpad,
      actions: stored?.actions,
    };
  });
  check('「恢复默认位置」清掉 transform',
    reset.transform === '' && reset.rightTransform === '',
    `左 "${reset.transform}" 右 "${reset.rightTransform}"`);
  check('「恢复默认位置」两块都写回零偏移',
    reset.dpad?.x === 0 && reset.dpad?.y === 0 && reset.actions?.x === 0 && reset.actions?.y === 0,
    JSON.stringify({ dpad: reset.dpad, actions: reset.actions }));

  // 退出
  await page.click('[data-editor="done"]');
  await page.waitForTimeout(250);
  const exited = await page.evaluate(() => ({
    editorHidden: document.getElementById('layout-editor').hidden,
    editing: document.querySelector('.stage').classList.contains('layout-edit'),
    // 设置里是「始终显示」，退出后不该被摆放模式的临时强制显示带跑
    padAlways: document.querySelector('.stage').classList.contains('pad-always'),
  }));
  check('点完成退出摆放模式', exited.editorHidden === true && exited.editing === false);
  check('退出后显示模式回到设置值', exited.padAlways === true, JSON.stringify(exited));

  // 反向验证「摆放模式临时强制显示」：设置里是「隐藏」时也要拖得到。
  // 曾经只加 pad-always、没摘 pad-never，两条同权重规则后者赢，进了摆放模式仍是一片空白。
  // 摆放模式是关掉菜单进来的，所以先按 Esc 把菜单呼回来。
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await openSection(page, '控制管理');
  // 上一段结束时是「始终显示」，点一次就到「隐藏」
  await clickItem(page, '虚拟手柄');
  check('先切到「隐藏」以便验证摆放模式会强制显示',
    (await readList(page)).find((i) => i.label === '虚拟手柄')?.value === '隐藏',
    (await readList(page)).find((i) => i.label === '虚拟手柄')?.value);
  await clickItem(page, '自由摆放按键');
  const hiddenButDraggable = await page.evaluate(() => {
    const el = document.querySelector('.touch-dpad-group');
    const cls = document.querySelector('.stage').classList;
    return {
      w: el.getBoundingClientRect().width,
      padNever: cls.contains('pad-never'),
      padAlways: cls.contains('pad-always'),
    };
  });
  check('从「隐藏」进摆放模式也会把手柄显示出来',
    hiddenButDraggable.w > 0 && hiddenButDraggable.padAlways && !hiddenButDraggable.padNever,
    JSON.stringify(hiddenButDraggable));
  await page.click('[data-editor="done"]');
  await page.waitForTimeout(250);
  const backToHidden = await page.evaluate(() => {
    const el = document.getElementById('touch-controls');
    return getComputedStyle(el).display === 'none' || el.getBoundingClientRect().width === 0;
  });
  check('退出后回到设置里的「隐藏」', backToHidden === true);

  console.log('\n【恢复默认控制】');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await openSection(page, '控制管理');
  await clickItem(page, '恢复默认控制');
  const defaults = await readStored(page);
  check('按键映射回到默认', defaults.controls?.keyMap?.A === 'KeyX'
    && defaults.controls?.keyMap?.START === 'Enter', JSON.stringify(defaults.controls?.keyMap));
  check('解绑过的动作恢复默认', defaults.controls?.keyMap?.DOWN === 'ArrowDown');
  check('显隐恢复全显示', Object.values(defaults.controls?.padKeys || {}).every((v) => v === true),
    JSON.stringify(defaults.controls?.padKeys));
  check('显示模式恢复自动', defaults.controls?.padMode === 'auto');
  check('位置恢复原点', defaults.controls?.padLayout?.dpad?.x === 0);
  const afterReset = await page.evaluate(() => ({
    padHidden: getComputedStyle(document.getElementById('touch-controls')).display === 'none',
    always: document.querySelector('.stage').classList.contains('pad-always'),
  }));
  check('恢复默认后界面同步（自动模式下重新隐藏）',
    afterReset.padHidden === true && afterReset.always === false, JSON.stringify(afterReset));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
