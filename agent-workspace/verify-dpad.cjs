// 验证十字方向键：四片软拨片的外形与命中、八个扇区的判定、按住滑动换向、
// 多指并集、斜向真的送进模拟器（和键盘同一形状），以及摆放模式下不发按键。
const { launch } = require('./lib-browser.cjs');
const { startGame } = require('./lib-game-menu.cjs');

const URL = 'http://localhost:7890/nes-console/';
const SETTINGS_KEY = 'nes-console.settings';

let pass = 0, fail = 0;
const check = (label, ok, actual) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${actual === undefined ? '' : `  [${actual}]`}`);
  ok ? pass++ : fail++;
};

/** 点侧栏分类 / 点列表条目（进摆放模式要用菜单） */
async function openSection(page, label) {
  await page.evaluate((l) => {
    const btn = Array.from(document.querySelectorAll('.sys-nav-item'))
      .find((el) => el.querySelector('.sys-nav-label')?.textContent === l);
    btn?.click();
  }, label);
  await page.waitForTimeout(150);
}

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

(async () => {
  const browser = await launch();
  // 桌面尺寸 + 强制显示手柄：不依赖真手机形态也能点到屏幕上的手柄
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.addInitScript(([key, val]) => localStorage.setItem(key, val),
    [SETTINGS_KEY, JSON.stringify({ controls: { padMode: 'always' } })]);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  console.log('\n【1. 形状：四片拨片拼成的十字，不是一个方向一个圆钮】');
  const geo = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    };
    const pad = rect('.touch-dpad');
    const hit = rect('.touch-dpad-hit');
    const arms = ['UP', 'DOWN', 'LEFT', 'RIGHT'].map((a) => ({
      action: a, ...rect(`.touch-dpad [data-action="${a}"]`),
    }));
    return {
      pad, hit, arms,
      square: Math.abs(pad.w - pad.h) < 1,
      hitCoversPad: Math.abs(hit.w - pad.w) < 1 && Math.abs(hit.h - pad.h) < 1,
      blades: document.querySelectorAll('.touch-dpad-face > use').length,
      sameShape: new Set(Array.from(document.querySelectorAll('.touch-dpad-face > use'))
        .map((u) => u.getAttribute('href'))).size === 1,
      centerEmpty: document.querySelectorAll('.touch-dpad-face > circle').length === 0,
      padPointerEvents: getComputedStyle(document.querySelector('.touch-dpad')).pointerEvents,
      hitPointerEvents: getComputedStyle(document.querySelector('.touch-dpad-hit')).pointerEvents,
      actions: Array.from(document.querySelectorAll('#touch-controls [data-action]')).map((e) => e.dataset.action),
      btnCount: document.querySelectorAll('#touch-controls .touch-btn').length,
      btnSizes: Array.from(document.querySelectorAll('#touch-controls .touch-btn'))
        .map((b) => `${b.dataset.action}=${Math.round(b.getBoundingClientRect().width)}`),
      // 形状量的是实际像素：圆角按百分比相对宽度解析（50% 的圆片 → r = 边长一半）
      btnShapes: Array.from(document.querySelectorAll('#touch-controls .touch-btn'))
        .map((b) => {
          const box = b.getBoundingClientRect();
          const v = getComputedStyle(b).borderTopLeftRadius;
          const r = v.endsWith('%') ? parseFloat(v) / 100 * box.width : parseFloat(v);
          return { action: b.dataset.action, w: box.width, h: box.height, top: box.top, left: box.left, r };
        }),
      // 左右两块（摆放模式各是一个拖动单位）：配平要量的就是这两块的宽
      groups: { left: rect('.touch-dpad-group'), right: rect('.touch-actions') },
      btnBg: getComputedStyle(document.querySelector('.touch-a')).backgroundColor,
      btnLine: getComputedStyle(document.querySelector('.touch-a')).borderTopColor,
      btnLineW: parseFloat(getComputedStyle(document.querySelector('.touch-a')).borderTopWidth),
      bladeFill: getComputedStyle(document.querySelector('.dpad-blade')).fill,
      bladeLine: getComputedStyle(document.querySelector('.dpad-blade')).stroke,
      bladeStrokeUnits: parseFloat(getComputedStyle(document.querySelector('.dpad-blade')).strokeWidth),
      // 取景框边长（故意不是整块 100，见 index.astro）：描边折算成 px 要按它换算
      faceBox: document.querySelector('.touch-dpad-face').viewBox.baseVal.width,
      // 拨片的 getBoundingClientRect 只有路径、不含描边，所以「画出来的顶边」还要再减半个描边
      bladeTop: document.querySelector('.dpad-blade-up').getBoundingClientRect().top,
      xTop: document.querySelector('.touch-x').getBoundingClientRect().top,
    };
  });
  check('十字键容器是正方形', geo.square, `${geo.pad.w.toFixed(0)}x${geo.pad.h.toFixed(0)}`);
  check('命中层铺满整块十字（四角也算按键，斜向来自这里）', geo.hitCoversPad);
  check('四个臂各占一格且不小于 44px',
    geo.arms.length === 4 && geo.arms.every((a) => a.w >= 44 && a.h >= 44),
    geo.arms.map((a) => `${a.action}=${a.w.toFixed(0)}x${a.h.toFixed(0)}`).join(' '));
  check('四个臂方位正确（上格在上、右格在右…）',
    geo.arms.find((a) => a.action === 'UP').cy < geo.pad.cy
    && geo.arms.find((a) => a.action === 'DOWN').cy > geo.pad.cy
    && geo.arms.find((a) => a.action === 'LEFT').cx < geo.pad.cx
    && geo.arms.find((a) => a.action === 'RIGHT').cx > geo.pad.cx);
  check('外形是四片同形状的拨片，中心不画东西（空缝就是死区）',
    geo.blades === 4 && geo.sameShape && geo.centerEmpty,
    `use=${geo.blades} 同形状=${geo.sameShape} 中心空=${geo.centerEmpty}`);
  check('容器不吃事件，命中交给子元素（摆放模式拦截依赖这条）',
    geo.padPointerEvents === 'none' && geo.hitPointerEvents === 'auto',
    `${geo.padPointerEvents}/${geo.hitPointerEvents}`);
  check('手柄上一共声明 11 个动作（4 方向 + 6 键 + 簇心 AB）', geo.actions.length === 11, geo.actions.join(','));
  check('独立按钮 7 个（十字键的臂不再算按钮）', geo.btnCount === 7, `${geo.btnCount}`);
  check('A/B/X/Y 同尺寸', new Set(geo.btnSizes.filter((s) => /^[ABXY]=/.test(s))
    .map((s) => s.split('=')[1])).size === 1, geo.btnSizes.join(' '));
  const alpha = (c) => parseFloat((c.match(/[\d.]+\s*\)\s*$/) || ['0)'])[0].replace(/[^.\d]/g, ''));
  check('动作键是半透明的（不挡画面）', alpha(geo.btnBg) > 0 && alpha(geo.btnBg) <= 0.2, geo.btnBg);
  // 「一套」的三条：同底色、同描边色、描边一样粗（片的描边按取景框边长折算成 px 比）
  check('按钮与方向键同底色同描边色（一套材质）',
    geo.btnBg === geo.bladeFill && geo.btnLine === geo.bladeLine,
    `${geo.btnBg} / ${geo.btnLine}`);
  const bladeLinePx = geo.bladeStrokeUnits / geo.faceBox * geo.pad.w;
  check('按钮边框与拨片描边等粗', Math.abs(bladeLinePx - geo.btnLineW) <= 0.6,
    `片 ${bladeLinePx.toFixed(2)}px / 键 ${geo.btnLineW}px`);
  // 顶边对齐：两块盒子本来就同顶（都是 132px、底对齐），差的只是拨片画面在盒子里内缩，
  // 所以取景框贴着外缘画，缩进应当归零
  check('方向键画出来的顶边和 X/Y 的顶边齐平',
    Math.abs(geo.bladeTop - bladeLinePx / 2 - geo.xTop) <= 0.6,
    `十字 ${geo.bladeTop.toFixed(2)} − 半个描边 = ${(geo.bladeTop - bladeLinePx / 2).toFixed(2)}px / X ${geo.xTop.toFixed(2)}px`);
  const shape = (re) => geo.btnShapes.filter((b) => re.test(b.action));
  const fmt = (list) => list.map((b) => `${b.action}=${b.w.toFixed(0)}x${b.h.toFixed(0)} r${b.r.toFixed(0)}`).join(' ');
  check('四个动作键是圆片',
    shape(/^[ABXY]$/).length === 4 && shape(/^[ABXY]$/).every((b) =>
      Math.abs(b.w - b.h) < 1 && Math.abs(2 * b.r - b.w) < 1),
    fmt(shape(/^[ABXY]$/)));
  // 簇心那颗 AB 和四颗角键同尺寸（用户要求），间距为此加大到 2.25rem，见 global.css
  const abShape = shape(/^A B$/)[0];
  const round = shape(/^[ABXY]$/);
  check('AB 也是圆片，且和 A/B/X/Y 一样大',
    !!abShape && Math.abs(abShape.w - abShape.h) < 1 && Math.abs(2 * abShape.r - abShape.w) < 1
    && round.every((k) => Math.abs(k.w - abShape.w) < 0.5),
    fmt(shape(/^A B$/)));
  // 扁长条：宽至少是高的 1.8 倍，两端圆到至少半圆（border-radius 给大值时浏览器渲染时才收窄，
  // computed style 仍是原值，所以这里只能判「不小于」）
  check('SELECT/START 是扁长条（不是圆片）',
    shape(/^(SELECT|START)$/).length === 2 && shape(/^(SELECT|START)$/).every((b) => b.w / b.h >= 1.8 && b.r >= b.h / 2 - 0.5),
    fmt(shape(/^(SELECT|START)$/)));
  // 摆位：系统键在十字键下面（左手一列），不再挤在动作键那一块里
  const bars = shape(/^(SELECT|START)$/);
  const padBottom = geo.pad.y + geo.pad.h;
  check('SELECT/START 摆在十字键下方',
    bars.length === 2 && bars.every((s) => s.top > padBottom),
    `条 top=${bars.map((b) => Math.round(b.top)).join('/')} · 十字键底=${Math.round(padBottom)}`);
  // 「平衡」的两条：两块同宽，且扁条那一整列在动作簇的左边（各归一个拇指）
  const groups = geo.groups;
  check('左右两块同宽（配平：左边十字+系统键，右边五键簇）',
    Math.abs(groups.left.w - groups.right.w) < 1,
    `左 ${groups.left.w.toFixed(0)}px / 右 ${groups.right.w.toFixed(0)}px`);
  check('SELECT/START 整排在动作簇左边（不越界到右手）',
    bars.every((b) => b.left + b.w <= groups.right.x + 1),
    `条右沿=${bars.map((b) => Math.round(b.left + b.w)).join('/')} · 右块左沿=${Math.round(groups.right.x)}`);

  const pad = geo.pad;
  const active = () => page.evaluate(() => document.querySelector('.touch-dpad').dataset.active || '');
  /** 按住十字上某个相对中心的方向，返回按住期间的 data-active */
  const pressDir = async (ux, uy, ratio = 0.36) => {
    await page.mouse.move(pad.cx + pad.w * ratio * ux, pad.cy + pad.w * ratio * uy);
    await page.mouse.down();
    await page.waitForTimeout(60);
    const got = await active();
    await page.mouse.up();
    await page.waitForTimeout(60);
    return got;
  };
  console.log('\n【2. 八个扇区：正方向给一个，两臂之间给两个，中心是死区】');
  check('正上 = UP', (await pressDir(0, -1)) === 'UP');
  check('正下 = DOWN', (await pressDir(0, 1)) === 'DOWN');
  check('正左 = LEFT', (await pressDir(-1, 0)) === 'LEFT');
  check('正右 = RIGHT', (await pressDir(1, 0)) === 'RIGHT');
  const dr = await pressDir(0.707, 0.707);
  check('右下（两臂之间）= RIGHT + DOWN', dr.split(' ').sort().join(' ') === 'DOWN RIGHT', dr);
  const ur = await pressDir(0.707, -0.707);
  check('右上 = RIGHT + UP', ur.split(' ').sort().join(' ') === 'RIGHT UP', ur);
  const ul = await pressDir(-0.707, -0.707);
  check('左上 = LEFT + UP', ul.split(' ').sort().join(' ') === 'LEFT UP', ul);
  const dl = await pressDir(-0.707, 0.707);
  check('左下 = LEFT + DOWN', dl.split(' ').sort().join(' ') === 'DOWN LEFT', dl);
  // 偏离正方向 15°（<22.5°）仍算正方向：拇指按歪一点不该出斜向
  check('偏上 15° 仍只给 UP', (await pressDir(0.26, -0.97)) === 'UP');
  check('偏上 30° 出斜向', (await pressDir(0.5, -0.87)).split(' ').length === 2);
  // 按下的反馈点亮的是那一片 SVG 形状（不是方的格子）：比较 UP 片与 DOWN 片的填充
  await page.mouse.move(pad.cx, pad.cy - pad.w * 0.36);
  await page.mouse.down();
  await page.waitForTimeout(150);
  const lit = await page.evaluate(() => {
    const fill = (sel) => getComputedStyle(document.querySelector(sel)).fill;
    return { up: fill('.dpad-blade-up'), down: fill('.dpad-blade-down') };
  });
  await page.mouse.up();
  await page.waitForTimeout(150);
  check('按下的那一片整片亮起，没按的不亮', lit.up !== lit.down, `${lit.up} vs ${lit.down}`);
  check('正中心不给任何方向（死区）', (await pressDir(0, 0)) === '');
  // 死区边界钉在 8%：里面的空缝按了不给方向，画出来的那片尖头（离中心 11%）按得动
  check('死区内（离中心 5%）不给方向', (await pressDir(0, -1, 0.05)) === '');
  check('拨片尖头位置（离中心 11%）给 UP', (await pressDir(0, -1, 0.11)) === 'UP');
  check('松开后不残留（data-active 被清掉）', (await active()) === '');

  console.log('\n【3. 按住滑动换向（真机拇指就是这么用的）】');
  await page.mouse.move(pad.cx + pad.w * 0.36, pad.cy);
  await page.mouse.down();
  await page.waitForTimeout(60);
  const slideStart = await active();
  await page.mouse.move(pad.cx, pad.cy + pad.w * 0.36, { steps: 6 });
  await page.waitForTimeout(60);
  const slideEnd = await active();
  await page.mouse.up();
  await page.waitForTimeout(60);
  const slideAfter = await active();
  check('起手按住 RIGHT', slideStart === 'RIGHT', slideStart);
  check('滑到下面换成 DOWN，RIGHT 同时释放', slideEnd === 'DOWN', slideEnd);
  check('松手干净', slideAfter === '', slideAfter);

  console.log('\n【4. 两根手指同时按：取并集，松开一根还剩一根】');
  const multi = await page.evaluate(async ({ cx, cy, w }) => {
    const padEl = document.querySelector('.touch-dpad-hit');
    const fire = (type, id, x, y) => padEl.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: id, clientX: x, clientY: y, buttons: 1,
    }));
    const read = () => document.querySelector('.touch-dpad').dataset.active || '';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    fire('pointerdown', 21, cx, cy - w * 0.36);
    await sleep(40);
    const one = read();
    fire('pointerdown', 22, cx + w * 0.36, cy);
    await sleep(40);
    const two = read();
    fire('pointerup', 21, cx, cy - w * 0.36);
    await sleep(40);
    const afterOneUp = read();
    fire('pointerup', 22, cx + w * 0.36, cy);
    await sleep(40);
    return { one, two, afterOneUp, none: read() };
  }, { cx: pad.cx, cy: pad.cy, w: pad.w });
  check('一根手指 = UP', multi.one === 'UP', multi.one);
  check('两根手指 = UP + RIGHT', multi.two.split(' ').sort().join(' ') === 'RIGHT UP', multi.two);
  check('松开 UP 后 RIGHT 还在（不被别的来源误释放）', multi.afterOneUp === 'RIGHT', multi.afterOneUp);
  check('全松开后清空', multi.none === '', multi.none);

  console.log('\n【5. 摆放模式：在十字上按下只拖动，不给游戏发方向】');
  await openSection(page, '控制管理');
  await clickItem(page, '自由摆放按键');
  await page.waitForTimeout(400);
  const editProbe = await page.evaluate(() => {
    const el = document.querySelector('.touch-dpad');
    const r = el.getBoundingClientRect();
    // 探的是右上角（两臂之间）：那里只有命中层，正是「斜向」按点，
    // 也是容器自己会不会被点中这件事唯一会被触发的位置。
    const px = r.x + r.width * 0.92, py = r.y + r.height * 0.08;
    const target = document.elementFromPoint(px, py);
    target.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 31, clientX: px, clientY: py,
    }));
    const activeDuringDrag = el.dataset.active || '';
    target.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 31, clientX: px, clientY: py,
    }));
    return {
      activeDuringDrag,
      hitTag: `${target.className}`,
      editing: document.querySelector('.stage').classList.contains('layout-edit'),
    };
  });
  check('确认在摆放模式里', editProbe.editing === true);
  check('按的是命中层而不是臂', /touch-dpad-hit/.test(editProbe.hitTag), editProbe.hitTag);
  check('摆放模式下按十字不发方向', editProbe.activeDuringDrag === '', editProbe.activeDuringDrag);
  await page.click('[data-editor="done"]');
  await page.waitForTimeout(300);

  console.log('\n【6. 斜向真的送进模拟器，且和键盘同形状】');
  // 摆放模式是关掉菜单进来的，先按 Esc 把主菜单呼回来。
  // 前面扇区探测按过 LEFT/RIGHT，界面把它当成「切分类」了，所以显式回「游戏」分类。
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await openSection(page, '游戏');
  // 按名字选行并等「真的多出 30 帧」再起手。原来是点第一行 + 固定等 1500ms：
  // 跑全量套件时机器负载高，1500ms 里 wasm 还没编完，下面的键盘按键发出去没人接，
  // `held` 就是空的 —— 单跑必绿、进套件偶发红，就是这么来的。
  check('按名字启动了 Destiny', await startGame(page, 'Destiny'));
  /**
   * 读宿主的按键集合（元素是 `端口:按键号`，libretro 的编号：UP=4、RIGHT=7）。
   * 比反推核心内部状态可靠 —— 那是 wasm 里的 NES 按键矩阵，低有效，形状还不稳定。
   */
  const held = () => page.evaluate(() => [...window.__nesConsole.host.held].sort());
  const UP_RIGHT = '0:4,0:7';
  const idle = await held();
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(120);
  const kb = (await held()).join(',');
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(120);
  const afterKb = await held();
  await page.mouse.move(pad.cx + pad.w * 0.36 * 0.707, pad.cy - pad.w * 0.36 * 0.707);
  await page.mouse.down();
  await page.waitForTimeout(120);
  const dpad = (await held()).join(',');
  await page.mouse.up();
  await page.waitForTimeout(120);
  const afterDpad = await held();
  check('一开始没有键是按住的', idle.length === 0, idle.join(','));
  check('键盘 上+右 两个键都送进了模拟器', kb === UP_RIGHT, kb);
  check('十字键按右上也送出两个键', dpad === UP_RIGHT, dpad);
  check('十字键斜向与键盘 上+右 完全一致', dpad === kb, `键盘 ${kb} / 手柄 ${dpad}`);
  check('松开后回到空闲（键盘）', afterKb.length === 0, afterKb.join(','));
  check('松开后回到空闲（十字键）', afterDpad.length === 0, afterDpad.join(','));

  console.log('\n【错误汇总】');
  const real = errors.filter((e) => !/Failed to load resource|404/.test(e));
  check('全程无 JS 错误', real.length === 0, real.slice(0, 3).join(' | '));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exitCode = fail ? 1 : 0;
})();
