// 验证：标题紧跟返回按钮；右上角那排常驻按钮（全屏 + 菜单）和标题垂直居中、互不重叠；
// 顶栏徽标靠右且给整排按钮让位；「多少款游戏」不在顶栏（它在菜单左下角，见 verify-toast.cjs 1b）。
const { launch } = require('./lib-browser.cjs');

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto('http://localhost:7890/nes-console/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // 主菜单：返回按钮隐藏，标题在左边
  // 徽标（游戏名那类）文案由 app.js 按当前层生成，主菜单这层是空串，几何检查就测不到最长情况。
  // 这里直接塞应用里最长的那种徽标文案（一款游戏的名字）。
  await page.evaluate(() => {
    document.querySelector('.sys-badge').textContent = 'Super Mario Bros. 3';
  });
  const main = await page.evaluate(() => {
    const back = document.querySelector('.sys-back');
    const title = document.querySelector('.sys-title');
    const badge = document.querySelector('.sys-badge');
    const menu = document.querySelector('.touch-menu');
    const fs = document.querySelector('.touch-fs');
    const topbar = document.querySelector('.sys-topbar');
    const t = title.getBoundingClientRect();
    const g = badge.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const f = fs.getBoundingClientRect();
    const tb = topbar.getBoundingClientRect();
    return {
      backHidden: back.hidden,
      titleLeft: t.left,
      titleRight: t.right,
      titleCenterY: (t.top + t.bottom) / 2,
      badgeText: badge.textContent,
      badgeLeft: g.left,
      badgeRight: g.right,
      badgeCenterY: (g.top + g.bottom) / 2,
      menuCenterY: (m.top + m.bottom) / 2,
      menuLeft: m.left,
      menuRight: m.right,
      menuWidth: m.width,
      fsLeft: f.left,
      fsRight: f.right,
      fsCenterY: (f.top + f.bottom) / 2,
      fsWidth: f.width,
      // 全屏按钮不能是手柄动作键：带 data-action 会被 input-manager 绑成按键
      fsHasAction: fs.hasAttribute('data-action'),
      // 顶栏右端不该再出现数量（已搬到菜单左下角）
      countInTopbar: !!topbar.querySelector('.sys-count'),
      topbarCenterY: (tb.top + tb.bottom) / 2,
      topbarLeft: tb.left,
      topbarRight: tb.right,
      // 顶栏的计算字号就是 --screen-font，用它换算让位间隙是否合理
      fontSize: parseFloat(getComputedStyle(topbar).fontSize),
    };
  });
  console.log('主菜单:', JSON.stringify(main, null, 1));

  let pass = 0, fail = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name} ${detail}`); }
  };

  check('主菜单返回按钮隐藏', main.backHidden === true);
  check('标题在顶栏左侧', main.titleLeft < 200, `left=${main.titleLeft.toFixed(1)}`);
  check('MENU 按钮和标题垂直居中',
    Math.abs(main.menuCenterY - main.titleCenterY) < 2,
    `menu=${main.menuCenterY.toFixed(1)} title=${main.titleCenterY.toFixed(1)}`);
  check('MENU 按钮在顶栏右侧',
    main.menuRight <= main.topbarRight,
    `menu=${main.menuRight.toFixed(1)} topbar=${main.topbarRight.toFixed(1)}`);

  // 全屏按钮和菜单按钮同一排：同尺寸、同行、排在菜单左边、互不重叠
  check('全屏按钮和 MENU 按钮同尺寸（同一颗按钮的两个朝向）',
    Math.abs(main.fsWidth - main.menuWidth) < 0.5,
    `全屏=${main.fsWidth.toFixed(1)} 菜单=${main.menuWidth.toFixed(1)}`);
  check('全屏按钮和 MENU 按钮在同一行（中心线齐平）',
    Math.abs(main.fsCenterY - main.menuCenterY) < 2,
    `全屏=${main.fsCenterY.toFixed(1)} 菜单=${main.menuCenterY.toFixed(1)}`);
  check('全屏按钮排在 MENU 按钮左边',
    main.fsRight <= main.menuLeft, `全屏右沿=${main.fsRight.toFixed(1)} 菜单左沿=${main.menuLeft.toFixed(1)}`);
  check('两颗按钮之间的间隙 = 0.45 倍字号（和顶栏让位用同一个数）',
    Math.abs(main.menuLeft - main.fsRight - main.fontSize * 0.45) < 1,
    `间隙=${(main.menuLeft - main.fsRight).toFixed(1)}px 字号=${main.fontSize}`);
  check('全屏按钮不是手柄动作键（没写 data-action）', main.fsHasAction === false);
  check('数量不在顶栏（已搬到菜单左下角）', main.countInTopbar === false);

  // 徽标要靠右、和标题同一行、给整排按钮让位（让位对象是最左边那颗 = 全屏）
  const font = Number(main.fontSize);
  const badgeGap = main.fsLeft - main.badgeRight;
  const midX = (main.topbarLeft + main.topbarRight) / 2;
  check('徽标在顶栏右半边', main.badgeRight > midX, `badgeRight=${main.badgeRight.toFixed(1)} 中线=${midX.toFixed(1)}`);
  check('徽标与标题垂直居中',
    Math.abs(main.badgeCenterY - main.titleCenterY) < 2,
    `badge=${main.badgeCenterY.toFixed(1)} title=${main.titleCenterY.toFixed(1)}`);
  check('徽标不与常驻按钮重叠', badgeGap >= 1, `间隙=${badgeGap.toFixed(1)}px`);
  check('徽标让位不过度（间隙 < 1.2 倍字号）',
    badgeGap <= font * 1.2, `间隙=${badgeGap.toFixed(1)}px 字号=${font}`);
  check('徽标不压到标题',
    main.badgeLeft - main.titleRight >= font * 0.5,
    `间距=${(main.badgeLeft - main.titleRight).toFixed(1)}px 字号=${font}`);

  // 进入设置子菜单：返回按钮显示，标题紧跟返回按钮
  // 主菜单打开时焦点在分类栏：↑↓ 走到「系统」分类，按 A 进列表，再按 A 执行「设置」行
  // （不写死次数：分类栏会随功能增减）。
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const press = async (code) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      await sleep(60);
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      await sleep(60);
    };
    const cat = () =>
      document.querySelector('.sys-nav-item.selected .sys-nav-label')?.textContent || '';
    for (let i = 0; i < 8 && cat() !== '系统'; i++) await press('ArrowDown');
    await press('KeyX');   // 分类栏 -> 列表
    await sleep(240);
    await press('KeyX');   // 执行「设置」
    await sleep(300);
  });

  const sub = await page.evaluate(() => {
    const back = document.querySelector('.sys-back');
    const title = document.querySelector('.sys-title');
    const menu = document.querySelector('.touch-menu');
    const b = back.getBoundingClientRect();
    const t = title.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    return {
      backHidden: back.hidden,
      backRight: b.right,
      titleLeft: t.left,
      titleCenterY: (t.top + t.bottom) / 2,
      menuCenterY: (m.top + m.bottom) / 2,
    };
  });
  console.log('设置子菜单:', JSON.stringify(sub, null, 1));

  check('子菜单返回按钮显示', sub.backHidden === false);
  check('标题紧跟返回按钮', sub.titleLeft > sub.backRight, `title=${sub.titleLeft.toFixed(1)} back=${sub.backRight.toFixed(1)}`);
  check('MENU 按钮和标题垂直居中',
    Math.abs(sub.menuCenterY - sub.titleCenterY) < 2,
    `menu=${sub.menuCenterY.toFixed(1)} title=${sub.titleCenterY.toFixed(1)}`);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
