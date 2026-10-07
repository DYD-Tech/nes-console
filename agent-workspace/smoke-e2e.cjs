// 端到端：真的启动游戏、呼出快速菜单、存档、读档。
// 只验证状态和结果，不做视觉断言。
const { launch } = require('./lib-browser.cjs');
const { selectGameRow } = require('./lib-game-menu.cjs');

(async () => {
  const browser = await launch();
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  let pass = 0, fail = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name} ${detail}`); }
  };

  await page.goto('http://localhost:7890/nes-console/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    window.__press = async (code, waitMs = 120) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      await new Promise((r) => setTimeout(r, waitMs));
    };
    window.__ui = () => {
      const el = document.querySelector('.sys-ui');
      return {
        hidden: el.hidden,
        title: el.querySelector('.sys-title')?.textContent || '',
        badge: el.querySelector('.sys-badge')?.textContent || '',
        items: Array.from(el.querySelectorAll('.sys-item-label')).map((e) => e.textContent),
        values: Array.from(el.querySelectorAll('.sys-item-value')).map((e) => e.textContent),
        subs: Array.from(el.querySelectorAll('.sys-item-sub')).map((e) => e.textContent),
      };
    };
    // 统计画布上非黑像素的数量，用来判断「游戏真的在画东西」
    window.__canvasInk = () => {
      const c = document.getElementById('nes-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let nonBlack = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 20 || d[i + 1] > 20 || d[i + 2] > 20) nonBlack++;
      }
      return nonBlack;
    };
  });

  console.log('\n【启动游戏】');
  // 内置游戏现在按文件名排好多样，第一项不固定，先把光标移到那款已知能跑的游戏上
  const picked = await selectGameRow(page, 'Destiny');
  check('主菜单里能找到内置游戏「吞食天地」', picked === true);
  await page.evaluate(() => window.__press('KeyX', 800));

  const started = await page.evaluate(() => ({
    uiHidden: document.querySelector('.sys-ui').hidden,
    overlay: getComputedStyle(document.getElementById('canvas-overlay')).display,
    status: document.getElementById('toast')?.textContent || '',
  }));
  check('启动后菜单关闭（游戏可见）', started.uiHidden === true);
  check('启动后遮罩消失', started.overlay === 'none', `display=${started.overlay}`);
  // 启动会连着播两条提示：app 的「正在运行: X」和核心的「已加载: X（fps / Hz）」，
  // 后者到达时按「新消息顶掉旧消息」的规则替换掉前者。所以这里判「有没有启动反馈」，
  // 钉死其中一条会随机红（实测踩过：连跑时读到的是「已加载」）。
  check('启动后有启动反馈（正在运行 / 已加载）',
    /正在运行|已加载/.test(started.status) && started.status.includes('Destiny'), started.status);
  console.log(`     状态: "${started.status}"`);

  await page.waitForTimeout(1200);
  const ink = await page.evaluate(() => window.__canvasInk());
  check('画布上有画面内容（游戏在跑）', ink > 1000, `非黑像素 ${ink}`);

  console.log('\n【游戏中的按键转发】');
  // 游戏运行时按方向键，不应该打开菜单
  const duringGame = await page.evaluate(async () => {
    await window.__press('ArrowUp');
    await window.__press('KeyX');
    return document.querySelector('.sys-ui').hidden;
  });
  check('游戏中按方向键/A 不会误开菜单', duringGame === true);

  console.log('\n【快速菜单】');
  const quick = await page.evaluate(async () => {
    await window.__press('Escape', 200);   // Esc = MENU
    return window.__ui();
  });
  check('游戏中能呼出快速菜单', quick.hidden === false);
  check('快速菜单标题是游戏名', quick.title.includes('Destiny'), quick.title);
  check('快速菜单标记为游戏中', quick.badge === '游戏中', quick.badge);
  check('快速菜单含继续游戏', quick.items.includes('继续游戏'), quick.items.join(','));
  check('快速菜单含保存/读取存档',
    quick.items.includes('保存存档') && quick.items.includes('读取存档'), quick.items.join(','));
  check('快速菜单含退出到主菜单', quick.items.includes('退出到主菜单'), quick.items.join(','));
  console.log(`     条目: ${quick.items.join(' · ')}`);

  console.log('\n【保存存档】');
  const saved = await page.evaluate(async () => {
    // 光标默认在「继续游戏」，↓ 一次到「保存存档」
    await window.__press('ArrowDown');
    await window.__press('KeyX', 500);   // A 键保存
    return {
      status: document.getElementById('toast')?.textContent || '',
      ui: window.__ui(),
    };
  });
  check('保存后状态栏有反馈',
    saved.status.includes('已保存') || saved.status.includes('保存'), saved.status);
  console.log(`     状态: "${saved.status}"`);

  console.log('\n【存档管理菜单】');
  const saveMenu = await page.evaluate(async () => {
    // 回快速菜单，选「存档管理」
    const items = window.__ui().items;
    const idx = items.indexOf('存档管理');
    // 当前光标位置未知，直接连续 ↓ 直到选中「存档管理」再按 A
    for (let i = 0; i < items.length; i++) {
      const sel = document.querySelector('.sys-item.selected .sys-item-label')?.textContent;
      if (sel === '存档管理') break;
      await window.__press('ArrowDown', 60);
    }
    await window.__press('KeyX', 600);
    return window.__ui();
  });
  check('能打开存档管理', saveMenu.title === '存档管理', `实际 "${saveMenu.title}"`);
  check('存档管理列出槽位', saveMenu.items.length >= 10, `实际 ${saveMenu.items.length} 项`);
  const withSave = saveMenu.subs.filter((s) => s && s !== '空');
  check('刚保存的槽位显示时间（不是空）', withSave.length >= 1,
    `subs: ${saveMenu.subs.slice(0, 3).join(' | ')}`);
  console.log(`     槽位前 3 项: ${saveMenu.items.slice(0, 3).map((n, i) => `${n}=${saveMenu.subs[i]}`).join(' · ')}`);

  console.log('\n【存档详情面板】');
  // 把光标移到「有存档的那一格」——详情面板只在选中有存档的槽位时才读存档元数据，
  // 早先的 bug 正是这一步抛异常（读了一个列表接口根本不返回的字段），
  // 而且异常发生在渲染中途，界面看起来只是「没反应」，所以必须显式断言。
  const detail = await page.evaluate(async () => {
    const ui = window.__ui();
    const target = ui.items[ui.subs.findIndex((s) => s && s !== '空')];
    for (let i = 0; i < ui.items.length + 2; i++) {
      const sel = document.querySelector('.sys-item.selected .sys-item-label')?.textContent;
      if (sel === target) break;
      await window.__press('ArrowDown', 60);
    }
    const el = document.querySelector('.sys-detail');
    return {
      target,
      selected: document.querySelector('.sys-item.selected .sys-item-label')?.textContent,
      hidden: el?.hidden,
      text: (el?.textContent || '').trim(),
      keys: Array.from(document.querySelectorAll('.sys-detail-key')).map((e) => e.textContent),
    };
  });
  check('光标能停在有存档的槽位上', detail.selected === detail.target,
    `期望 "${detail.target}" 实际 "${detail.selected}"`);
  check('选中已有存档时详情面板可见', detail.hidden === false, JSON.stringify(detail));
  check('详情面板显示存档时间', detail.text.includes('时间'), detail.text);
  check('详情面板显示存档大小', detail.keys.includes('大小'), detail.keys.join(','));
  console.log(`     详情: "${detail.text}"`);

  console.log('\n【返回游戏】');
  const resumed = await page.evaluate(async () => {
    await window.__press('Escape', 200);  // 退回快速菜单
    const mid = window.__ui().title;
    await window.__press('Escape', 200);  // 再退回游戏
    return {
      mid,
      hidden: document.querySelector('.sys-ui').hidden,
    };
  });
  check('Esc 从存档管理退回快速菜单', resumed.mid.includes('Destiny'), resumed.mid);
  check('Esc 再按一次回到游戏', resumed.hidden === true);

  const inkAfter = await page.evaluate(() => window.__canvasInk());
  check('回到游戏后画面仍在跑', inkAfter > 1000, `非黑像素 ${inkAfter}`);

  console.log('\n【读取存档的反馈】');
  // 读档成功要能在状态栏看出来。曾经的坑：doLoad 先写「已读取」，紧接着
  // ui.clear() 同步触发 resumeGame() 又写「继续游戏」，后写覆盖先写，
  // 用户无法区分「读到了」和「只是把菜单关了」。
  const loadBack = await page.evaluate(async () => {
    await window.__press('Escape', 250);                 // 呼出快速菜单
    const items = window.__ui().items;
    for (let i = 0; i < items.length; i++) {
      const sel = document.querySelector('.sys-item.selected .sys-item-label')?.textContent;
      if (sel === '存档管理') break;
      await window.__press('ArrowDown', 60);
    }
    await window.__press('KeyX', 600);                   // 进存档管理
    const ui = window.__ui();
    const target = ui.items[ui.subs.findIndex((s) => s && s !== '空')];
    for (let i = 0; i < ui.items.length + 2; i++) {
      const sel = document.querySelector('.sys-item.selected .sys-item-label')?.textContent;
      if (sel === target) break;
      await window.__press('ArrowDown', 60);
    }
    await window.__press('KeyX', 600);                   // A = 进「槽位操作」
    // 槽位操作第一项就是「读取存档」，光标默认落在它上面
    await window.__press('KeyX', 1200);
    return {
      target,
      status: document.getElementById('toast')?.textContent || '',
      hidden: document.querySelector('.sys-ui').hidden,
    };
  });
  check('能读到有存档的槽位并读取', !!loadBack.target, JSON.stringify(loadBack));
  check('读取成功后状态栏写明读的是哪个槽', loadBack.status.includes('已读取'), loadBack.status);
  check('读取后菜单关闭回到游戏', loadBack.hidden === true);

  console.log('\n【快速菜单：←/→ 换槽位】');
  // 保存和读取两条都要能用 ←/→ 换槽位。曾经的坑：只有「保存存档」挂了 onAdjust，
  // 「读取存档」按左右没反应 —— 想读别的槽得先进存档管理绕一圈。两条共用同一个
  // quickSlot，所以换一边、另一边的显示也要跟着走。
  const slotCycle = await page.evaluate(async () => {
    await window.__press('Escape', 250);                 // 呼出快速菜单
    const items = window.__ui().items;
    for (let i = 0; i < items.length; i++) {
      const sel = document.querySelector('.sys-item.selected .sys-item-label')?.textContent;
      if (sel === '保存存档') break;
      await window.__press('ArrowDown', 60);
    }
    // 当前那一行自己显示的槽位（不是靠下标推算，行变了读到的就变了）
    const sub = () =>
      document.querySelector('.sys-item.selected .sys-item-sub')?.textContent || '';
    const saveBefore = sub();
    await window.__press('ArrowRight', 200);
    const saveAfter = sub();
    await window.__press('ArrowDown', 200);              // 下一项就是「读取存档」
    const label = document.querySelector('.sys-item.selected .sys-item-label')?.textContent;
    const loadBefore = sub();
    await window.__press('ArrowLeft', 200);
    const loadAfter = sub();
    // 收尾把菜单关掉：下面几段的起点是「游戏进行中、菜单关着」，
    // 它们靠按 Esc 呼出菜单 —— 留着开的话第一下 Esc 变成关，整段就乱了。
    await window.__press('Escape', 250);
    return { label, saveBefore, saveAfter, loadBefore, loadAfter, hidden: document.querySelector('.sys-ui').hidden };
  });
  check('左右移动后焦点在「读取存档」上', slotCycle.label === '读取存档', slotCycle.label);
  check('「保存存档」按 → 槽位变了',
    slotCycle.saveBefore !== slotCycle.saveAfter && !!slotCycle.saveAfter,
    JSON.stringify(slotCycle));
  check('「读取存档」按 ← 槽位也变（和保存一样能换挡位）',
    slotCycle.loadBefore !== slotCycle.loadAfter && !!slotCycle.loadAfter,
    JSON.stringify(slotCycle));
  check('两条显示同一个槽位（共用一个光标位：保存换到哪儿，读取那行就写哪儿）',
    slotCycle.loadBefore === slotCycle.saveAfter,
    `保存后=${slotCycle.saveAfter} 读取行显示=${slotCycle.loadBefore}`);
  check('这一段收尾已回到游戏', slotCycle.hidden === true, `hidden=${slotCycle.hidden}`);

  console.log('\n【退出到主菜单】');
  const exited = await page.evaluate(async () => {
    await window.__press('Escape', 250);   // 打开快速菜单
    const items = window.__ui().items;
    for (let i = 0; i < items.length; i++) {
      const sel = document.querySelector('.sys-item.selected .sys-item-label')?.textContent;
      if (sel === '退出到主菜单') break;
      await window.__press('ArrowDown', 60);
    }
    await window.__press('KeyX', 400);
    return window.__ui();
  });
  check('能退出到主菜单', exited.title === 'NES Console', `实际 "${exited.title}"`);

  console.log('\n【设置持久化】');
  const persisted = await page.evaluate(async () => {
    // 进设置，关掉 CRT，读 localStorage。
    // 主菜单打开时焦点在分类栏，所以：↑↓ 走到「系统」分类 → → 进列表 → A 执行「设置」。
    // 设置自己也是带分类栏的菜单，进去后焦点又停在它的分类栏上，
    // 要再按一次 → 进列表，A 才是翻转第一项（CRT）。
    // 分类栏会随功能增减，所以按「一直 ↓ 到选中系统分类为止」，不写死次数。
    const selected = () =>
      document.querySelector('.sys-nav-item.selected .sys-nav-label')?.textContent || '';
    for (let i = 0; i < 8 && selected() !== '系统' && !document.querySelector('.sys-sidebar').hidden; i++) {
      await window.__press('ArrowDown');
    }
    await window.__press('ArrowRight', 120);  // 分类栏 -> 列表
    await window.__press('KeyX', 300);        // 进入设置
    await window.__press('ArrowRight', 120);  // 设置的分类栏 -> 设置列表
    await window.__press('KeyX', 200);        // A 翻转 CRT
    return {
      stored: localStorage.getItem('nes-console.settings'),
      crtOff: document.getElementById('crt-filter').classList.contains('off'),
    };
  });
  const parsed = JSON.parse(persisted.stored || '{}');
  check('设置写入了 localStorage', parsed.display !== undefined, persisted.stored);
  check('CRT 设置作用到了界面', persisted.crtOff === true, `off=${persisted.crtOff}`);

  // 刷新页面，确认设置还在
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const afterReload = await page.evaluate(() =>
    document.getElementById('crt-filter').classList.contains('off'));
  check('刷新后设置仍然生效', afterReload === true);

  console.log('\n【错误汇总】');
  check('全程无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e); process.exit(1); });
