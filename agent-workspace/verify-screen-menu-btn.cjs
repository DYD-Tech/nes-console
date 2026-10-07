// 验证屏幕右上角那排常驻按钮：菜单按钮（从触摸手柄区搬来）+ 全屏按钮（图标，常驻不随菜单消失）
const { launch } = require('./lib-browser.cjs');

const VIEWPORTS = [
  { w: 1440, h: 900, name: '桌面宽屏' },
  { w: 1024, h: 768, name: '4:3 显示器' },
  { w: 390, h: 844, name: '手机竖屏' },
  { w: 844, h: 390, name: '手机横屏' },
  { w: 320, h: 568, name: '小屏手机' },
];

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
};

/**
 * 反复采样，由调用方取终值，不要只读一次。
 *
 * 为什么要这样：无头浏览器的窗口在系统里可能被遮挡，页面按「不可见」限流，
 * 渲染帧率掉到很低。CSS 过渡（本处 0.1s）是靠帧推进的，于是 `waitForTimeout(300)`
 * 之后读到的还是过渡中间值（实测 opacity 0.70、按下缩放只走到 0.98），
 * 看着像布局坏了，其实是没等完。
 *
 * 为什么取极值而不是「轮询到连续两次读数相同」：限流下帧是零星来的，
 * 开头两次可能都停在起始值（过渡还没起步）就被判为已稳定，读到的是假终值。
 * 过渡是单调的（按钮按下只会变小、菜单开合只会往一个方向走），
 * 所以真实终值必然是这串采样里的极值，取极值不受起步早晚影响。
 */
async function sample(page, read, { tries = 16, gap = 60 } = {}) {
  const xs = [];
  for (let i = 0; i < tries; i++) {
    await page.waitForTimeout(gap);
    xs.push(await read(page));
  }
  return xs;
}

const opacityOf = (page) =>
  page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.touch-menu')).opacity));
const fsOpacityOf = (page) =>
  page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.touch-fs')).opacity));
const boxOfMenu = (page) =>
  page.evaluate(() => {
    const r = document.querySelector('.touch-menu').getBoundingClientRect();
    return { c: r.top + r.height / 2, h: r.height };
  });

(async () => {
  const browser = await launch();

  for (const vp of VIEWPORTS) {
    console.log(`\n【${vp.name} ${vp.w}x${vp.h}】`);
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: vp.w, height: vp.h } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { fail++; console.log(`  ❌ PAGE ERROR: ${e.message}`); });
    await page.goto('http://localhost:7890/nes-console/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);

    // 按钮存在且只有一个
    const btnCount = await page.locator('.touch-menu').count();
    check('菜单按钮存在且只有一个', btnCount === 1, `count=${btnCount}`);

    // 按钮在 .screen 内
    const inScreen = await page.evaluate(() => {
      const btn = document.querySelector('.touch-menu');
      return btn?.closest('.screen') !== null;
    });
    check('按钮在 .screen 内', inScreen);

    // 按钮不在触摸手柄区
    const inTouch = await page.evaluate(() => {
      const btn = document.querySelector('.touch-menu');
      return btn?.closest('#touch-controls') !== null;
    });
    check('按钮不在触摸手柄区', !inTouch);

    // 按钮位置：屏幕右上角
    const pos = await page.evaluate(() => {
      const btn = document.querySelector('.touch-menu');
      const screen = document.querySelector('.screen');
      const b = btn.getBoundingClientRect();
      const s = screen.getBoundingClientRect();
      return {
        btnTop: b.top, btnRight: b.right, btnW: b.width, btnH: b.height,
        screenTop: s.top, screenRight: s.right, screenW: s.width, screenH: s.height,
        inScreen: b.top >= s.top && b.right <= s.right && b.bottom <= s.bottom && b.left >= s.left,
        distFromTop: b.top - s.top,
        distFromRight: s.right - b.right,
      };
    });
    check('按钮在屏幕范围内', pos.inScreen);
    check('按钮贴右上角（上距 < 20px）', pos.distFromTop < 20, `top=${pos.distFromTop.toFixed(1)}`);
    check('按钮贴右上角（右距 < 20px）', pos.distFromRight < 20, `right=${pos.distFromRight.toFixed(1)}`);

    // 按钮可点击（elementFromPoint 返回按钮本身）
    const clickable = await page.evaluate(() => {
      const btn = document.querySelector('.touch-menu');
      const b = btn.getBoundingClientRect();
      const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return el === btn || btn.contains(el);
    });
    check('按钮在最上层可点', clickable);

    // 材质 = 和手柄上的按键同一套：同一份底色、同一档描边、同一字重。
    // 形状反过来 —— 跟着屏幕里的界面元素走小圆角方块，不跟手柄的圆片。
    // 拿 .touch-a（A 键）当基准现算，不写死色值：改了 --pad-surface 这里跟着变，
    // 不会因为「两边都改了但常量没改」而假红/假绿。
    const style = await page.evaluate(() => {
      const cs = (sel) => getComputedStyle(document.querySelector(sel));
      const m = cs('.touch-menu'), a = cs('.touch-a');
      return {
        radius: parseFloat(m.borderTopLeftRadius),
        w: parseFloat(m.width), h: parseFloat(m.height),
        bg: m.backgroundColor, abg: a.backgroundColor,
        bw: m.borderTopWidth, abw: a.borderTopWidth,
        bc: m.borderTopColor, abc: a.borderTopColor,
        fw: m.fontWeight, afw: a.fontWeight,
      };
    });
    check('形状是小圆角方块，不是圆片',
      style.radius > 0.5 && style.radius < style.w / 2,
      `radius=${style.radius}px 半边长=${style.w / 2}px`);
    // 圆角和边长都是 --screen-font 的倍数（0.35 与 2.35），比值恒定，
    // 所以拿比值验「跟着画面缩放」—— 直接读那个变量不行，它是 clamp() 表达式，
    // getPropertyValue 给的是没算过的字符串。
    check('圆角跟着画面缩放（半径 = 边长 × 0.35/2.35）',
      Math.abs(style.radius - style.w * (0.35 / 2.35)) <= 0.1,
      `radius=${style.radius} 边长=${style.w}`);
    check('宽高相等', Math.abs(style.w - style.h) < 0.5, `${style.w}x${style.h}`);
    check('底色与 A 键一致', style.bg === style.abg, `${style.bg} vs ${style.abg}`);
    check('描边粗细与 A 键一致', style.bw === style.abw, `${style.bw} vs ${style.abw}`);
    check('描边颜色与 A 键一致', style.bc === style.abc, `${style.bc} vs ${style.abc}`);
    check('字重与 A 键一致', style.fw === style.afw, `${style.fw} vs ${style.afw}`);

    // 初始状态主菜单已打开，先关闭
    await page.locator('.touch-menu').click();
    await page.waitForTimeout(300);
    const menuClosed0 = await page.evaluate(() => document.querySelector('.sys-ui').hidden);
    check('初始点击按钮 → 菜单关闭', menuClosed0);

    // 菜单关闭时按钮半透明
    const opacityClosed0 = Math.min(...(await sample(page, opacityOf)));
    check('菜单关闭时按钮半透明（opacity<1）', opacityClosed0 < 1, `opacity=${opacityClosed0}`);

    // 点击按钮 → 菜单打开
    await page.locator('.touch-menu').click();
    await page.waitForTimeout(300);
    const menuOpen = await page.evaluate(() => !document.querySelector('.sys-ui').hidden);
    check('点击按钮 → 菜单打开', menuOpen);

    // 菜单打开时按钮不透明
    const opacityOpen = Math.max(...(await sample(page, opacityOf)));
    check('菜单打开时按钮不透明（opacity=1）', opacityOpen === 1, `opacity=${opacityOpen}`);

    // 再点按钮 → 菜单关闭
    await page.locator('.touch-menu').click();
    await page.waitForTimeout(300);
    const menuClosed = await page.evaluate(() => document.querySelector('.sys-ui').hidden);
    check('再点按钮 → 菜单关闭', menuClosed);

    // 菜单关闭时按钮半透明
    const opacityClosed = Math.min(...(await sample(page, opacityOf)));
    check('菜单关闭时按钮半透明（opacity<1）', opacityClosed < 1, `opacity=${opacityClosed}`);

    // 按钮有 data-action="MENU"
    const hasAction = await page.evaluate(() => {
      const btn = document.querySelector('.touch-menu');
      return btn?.dataset.action === 'MENU';
    });
    check('按钮保留 data-action="MENU"', hasAction);

    // 按钮文字是 MENU
    const text = await page.locator('.touch-menu').textContent();
    check('按钮文字是中文「菜单」', text.trim() === '菜单', `text="${text.trim()}"`);

    // 触摸手柄区不再有 MENU 按钮
    const touchMenuCount = await page.locator('#touch-controls .touch-menu').count();
    check('触摸手柄区不再有 MENU 按钮', touchMenuCount === 0, `count=${touchMenuCount}`);

    // ---------- 全屏按钮：和菜单按钮同一排，常驻 ----------
    const fsInfo = await page.evaluate(() => {
      const btn = document.querySelector('.touch-fs');
      const menu = document.querySelector('.touch-menu');
      const screen = document.querySelector('.screen');
      if (!btn) return { exists: false };
      const b = btn.getBoundingClientRect();
      const m = menu.getBoundingClientRect();
      const s = screen.getBoundingClientRect();
      const cs = getComputedStyle(btn);
      return {
        exists: true,
        count: document.querySelectorAll('.touch-fs').length,
        inScreen: !!btn.closest('.screen'),
        inTouch: !!btn.closest('#touch-controls'),
        hasAction: btn.hasAttribute('data-action'),
        left: b.left, right: b.right, top: b.top, bottom: b.bottom,
        w: b.width, h: b.height,
        cy: b.top + b.height / 2,
        menuLeft: m.left, menuCy: m.top + m.height / 2, menuW: m.width,
        scrLeft: s.left, scrRight: s.right, scrTop: s.top, scrBottom: s.bottom,
        // 图标按钮：里面是 svg，不该有文字
        hasSvg: !!btn.querySelector('svg'),
        text: btn.textContent.trim(),
        ariaLabel: btn.getAttribute('aria-label'),
        opacity: parseFloat(cs.opacity),
        radius: parseFloat(cs.borderTopLeftRadius),
      };
    });
    check('全屏按钮存在且只有一个', fsInfo.exists && fsInfo.count === 1, JSON.stringify(fsInfo.count));
    check('全屏按钮在 .screen 内', fsInfo.inScreen === true);
    check('全屏按钮不在触摸手柄区', fsInfo.inTouch === false);
    check('全屏按钮没有 data-action（否则会被当成手柄按键绑掉）', fsInfo.hasAction === false);
    check('全屏按钮排下来在 MENU 按钮左边，且不重叠',
      fsInfo.right <= fsInfo.menuLeft + 0.5 && fsInfo.left >= fsInfo.scrLeft,
      `全屏右沿=${fsInfo.right?.toFixed(1)} 菜单左沿=${fsInfo.menuLeft?.toFixed(1)}`);
    check('全屏按钮和 MENU 按钮同尺寸、同一行',
      Math.abs(fsInfo.w - fsInfo.menuW) < 0.5 && Math.abs(fsInfo.cy - fsInfo.menuCy) < 2,
      `${fsInfo.w?.toFixed(1)} vs ${fsInfo.menuW?.toFixed(1)}；中心线 ${fsInfo.cy?.toFixed(1)} vs ${fsInfo.menuCy?.toFixed(1)}`);
    check('全屏按钮在画面内（不越出屏幕边界）',
      fsInfo.top >= fsInfo.scrTop && fsInfo.bottom <= fsInfo.scrBottom && fsInfo.left >= fsInfo.scrLeft,
      `top=${fsInfo.top?.toFixed(1)} 屏幕上沿=${fsInfo.scrTop?.toFixed(1)}`);
    check('全屏按钮是图标（内含 svg，无文字）', fsInfo.hasSvg && fsInfo.text === '',
      `text="${fsInfo.text}"`);
    check('全屏按钮有可读名（aria-label）', /^全屏$/.test(fsInfo.ariaLabel || ''), `aria="${fsInfo.ariaLabel}"`);
    check('全屏按钮形状与菜单按钮同一档小圆角（半径 = 边长 × 0.35/2.35）',
      Math.abs(fsInfo.radius - fsInfo.w * (0.35 / 2.35)) <= 0.2,
      `radius=${fsInfo.radius} 边长=${fsInfo.w}`);

    // 常驻：菜单关着时它在（此刻菜单是关的），且能点
    const fsAtClosed = await page.evaluate(() => {
      const btn = document.querySelector('.touch-fs');
      const b = btn.getBoundingClientRect();
      const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return {
        uiHidden: document.querySelector('.sys-ui').hidden,
        opacity: parseFloat(getComputedStyle(btn).opacity),
        clickable: el === btn || btn.contains(el),
      };
    });
    check('菜单关闭时全屏按钮仍在（常驻，不随菜单消失）',
      fsAtClosed.uiHidden && fsAtClosed.opacity > 0,
      `opacity=${fsAtClosed.opacity}`);
    check('菜单关闭时全屏按钮可点（没被界面盖住）', fsAtClosed.clickable);

    // 打开菜单后两颗按钮一起变实
    await page.locator('.touch-menu').click();
    await page.waitForTimeout(300);
    const fsOpacityOpen = Math.max(...(await sample(page, fsOpacityOf)));
    check('菜单打开时全屏按钮不透明（和菜单按钮同一档强调）', fsOpacityOpen === 1, `opacity=${fsOpacityOpen}`);

    // 按下反馈：只许缩放，不许位移。放在最后一条，因为这个按钮按下即触发
    // （input-manager 绑的是 pointerdown），会改变菜单开合状态。
    // transform 是整体替换不是叠加：`.touch-btn:active` 的 scale() 一旦盖过
    // 本按钮的 translateY(-50%)，按下就会掉下半个按钮高（实测 19.97px）。
    const btnBox = await page.locator('.touch-menu').boundingBox();
    // 静止态取最高的那次采样（缩到最小后还要弹回来），按下态取最矮的那次。
    const resting = (await sample(page, boxOfMenu)).reduce((a, b) => (b.h > a.h ? b : a));
    await page.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
    await page.mouse.down();
    const pressed = (await sample(page, boxOfMenu)).reduce((a, b) => (b.h < a.h ? b : a));
    await page.mouse.up();
    check(
      '按下时不位移',
      Math.abs(pressed.c - resting.c) < 1,
      `位移=${(pressed.c - resting.c).toFixed(2)}px`
    );
    check(
      '按下有缩放反馈',
      pressed.h < resting.h * 0.97,
      `高度 ${resting.h.toFixed(1)} -> ${pressed.h.toFixed(1)}`
    );

    await ctx.close();
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
