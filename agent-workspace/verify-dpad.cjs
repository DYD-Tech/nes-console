// 验证十字方向键：四片软拨片 + 外切圆上四段独立斜向弧键的外形与命中、
// 四个扇区 + 四段弧 + 空白的判定、按住滑动换向、
// 多指并集、斜向真的送进模拟器（和键盘同一形状），以及摆放模式下不发按键。
// 顺带钉住两颗胶囊键的摆位（一边一颗、同一条水平线）与「两手同时按呼出菜单」。
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

  console.log('\n【1. 形状：四片拨片拼成的十字 + 外切圆上四段独立细弧（斜向）】');
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
    // 斜向弧键的几何：沿 use 引用的那条 path 采样，换算到屏幕像素。
    // 要看的是「弧是不是真的贴着十字外缘画的那道圆」「和拨片之间留没留出空隙」。
    const sample = (sel) => {
      const use = document.querySelector(sel);
      const src = document.getElementById(use.getAttribute('href').slice(1));
      const ctm = use.getScreenCTM();
      const pts = [];
      for (let i = 0; i <= 40; i++) {
        const p = src.getPointAtLength((src.getTotalLength() * i) / 40);
        const q = new DOMPoint(p.x, p.y).matrixTransform(ctm);
        pts.push([q.x, q.y]);
      }
      return pts;
    };
    const rOf = (p) => Math.hypot(p[0] - pad.cx, p[1] - pad.cy);
    const bladePts = ['up', 'right', 'down', 'left'].flatMap((s) => sample(`.dpad-blade-${s}`));
    // 拨片外缘最外那圈到中心的距离 = 十字的外接半径，弧就该画在这道圆上
    const bladeOuterR = Math.max(...bladePts.map(rOf));
    const perUnit = pad.w / document.querySelector('.touch-dpad-face').viewBox.baseVal.width;
    const hitHalfPx = parseFloat(getComputedStyle(document.querySelector('.dpad-diag-hit')).strokeWidth) * perUnit / 2;
    const diags = ['up-right', 'right-down', 'down-left', 'left-up'].map((s) => {
      const face = sample(`.dpad-diag-${s} .dpad-diag-face`);
      const radii = face.map(rOf);
      let gap = Infinity;
      for (const p of face) for (const b of bladePts) gap = Math.min(gap, Math.hypot(p[0] - b[0], p[1] - b[1]));
      // 命中带最外侧（含半个描边）离中心轴的水平/垂直距离：不能越出格子，越出去就压到别的键
      const reach = Math.max(...face.map((p) => Math.max(Math.abs(p[0] - pad.cx), Math.abs(p[1] - pad.cy)))) + hitHalfPx;
      return {
        action: document.querySelector(`.dpad-diag-${s}`).dataset.action,
        rMin: Math.min(...radii), rMax: Math.max(...radii), gap, reach,
        len: face.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - face[i][0], p[1] - face[i][1]), 0),
      };
    });
    return {
      pad, hit, arms, diags, bladeOuterR,
      diagCount: document.querySelectorAll('.dpad-diag').length,
      diagFaceStroke: parseFloat(getComputedStyle(document.querySelector('.dpad-diag-face')).strokeWidth) * perUnit,
      diagHitStroke: hitHalfPx * 2,
      diagHitPE: getComputedStyle(document.querySelector('.dpad-diag-hit')).pointerEvents,
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
      groups: { left: rect('.touch-dpad-group'), right: rect('.touch-actions-group') },
      cluster: rect('.touch-actions'),
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
  check('命中层铺满整块十字（按在四角空白也收得到按下，只是不给方向）', geo.hitCoversPad);
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
  // 斜向是四段独立的细圆弧：贴着十字的外缘那道圆画，和四片拨片之间留一道看得见的空隙。
  // 「不连接」是用户要的重点 —— 空隙没了就说明弧又跟拨片糊回去，误触会跟着回来。
  check('斜向是四段独立弧键，一段管两个方向',
    geo.diagCount === 4 && geo.diags.every((d) => d.action.split(' ').length === 2),
    geo.diags.map((d) => d.action).join(' | '));
  check('四段弧同半径，且就落在拨片外缘那道圆上（外切圆）',
    geo.diags.every((d) => Math.abs(d.rMax - d.rMin) < 0.5
      && Math.abs(d.rMin - geo.bladeOuterR) <= 1.5),
    `弧 ${geo.diags[0].rMin.toFixed(2)}~${geo.diags[0].rMax.toFixed(2)}px / 拨片外缘 ${geo.bladeOuterR.toFixed(2)}px`);
  check('弧和拨片之间留着空隙（没有连回去）',
    geo.diags.every((d) => d.gap >= 4),
    `最近 ${Math.min(...geo.diags.map((d) => d.gap)).toFixed(1)}px`);
  check('弧很细（可见不到 5px），但命中带粗到按得住（≥14px）',
    geo.diagFaceStroke <= 5 && geo.diagHitStroke >= 14 && geo.diagHitPE === 'stroke',
    `可见 ${geo.diagFaceStroke.toFixed(2)}px / 命中 ${geo.diagHitStroke.toFixed(2)}px / ${geo.diagHitPE}`);
  check('弧的命中带不出格子（不会压到旁边的键）',
    geo.diags.every((d) => d.reach <= geo.pad.w / 2),
    `最外 ${Math.max(...geo.diags.map((d) => d.reach)).toFixed(1)}px / 半格 ${geo.pad.w / 2}px`);
  check('弧长短合适：看得见（≥18px，含圆头）、又没长到快贴上拨片（≤28px）',
    geo.diags.every((d) => d.len >= 18 && d.len <= 28),
    geo.diags.map((d) => d.len.toFixed(1)).join(' '));
  check('容器不吃事件，命中交给子元素（摆放模式拦截依赖这条）',
    geo.padPointerEvents === 'none' && geo.hitPointerEvents === 'auto',
    `${geo.padPointerEvents}/${geo.hitPointerEvents}`);
  check('手柄上一共声明 15 个动作（4 方向 + 4 段斜向弧 + 6 键 + 簇心 AB）',
    geo.actions.length === 15, geo.actions.join(','));
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
  // 摆位：两颗胶囊一边一颗（SELECT 在十字键下面、START 在动作簇下面），
  // 这样两只拇指各按住一颗才凑得齐 SELECT+START 组合键 —— 挤在同一角就按不到一起。
  const bars = shape(/^(SELECT|START)$/);
  const bar = (a) => bars.find((b) => b.action === a);
  const padBottom = geo.pad.y + geo.pad.h;
  const clusterBottom = geo.cluster.y + geo.cluster.h;
  check('SELECT 摆在十字键下方、START 摆在动作簇下方',
    bars.length === 2 && bar('SELECT').top > padBottom && bar('START').top > clusterBottom,
    `SELECT top=${Math.round(bar('SELECT').top)} 十字键底=${Math.round(padBottom)} · `
    + `START top=${Math.round(bar('START').top)} 动作簇底=${Math.round(clusterBottom)}`);
  const cx = (b) => b.left + b.w / 2;
  check('两颗胶囊各自在自己那一块里居中',
    Math.abs(cx(bar('SELECT')) - geo.groups.left.cx) < 1
    && Math.abs(cx(bar('START')) - geo.groups.right.cx) < 1,
    `SELECT 中=${Math.round(cx(bar('SELECT')))} 左块中=${Math.round(geo.groups.left.cx)} · `
    + `START 中=${Math.round(cx(bar('START')))} 右块中=${Math.round(geo.groups.right.cx)}`);
  check('两颗胶囊在同一条水平线上（两手同时按）',
    Math.abs(bar('SELECT').top - bar('START').top) < 1,
    `SELECT ${Math.round(bar('SELECT').top)} / START ${Math.round(bar('START').top)}`);
  check('SELECT 在左半、START 在右半，中间隔着整块簇',
    bar('SELECT').left + bar('SELECT').w <= geo.groups.right.x + 1
    && bar('START').left >= geo.groups.left.x + geo.groups.left.w - 1,
    `SELECT 右沿=${Math.round(bar('SELECT').left + bar('SELECT').w)} · 右块左沿=${Math.round(geo.groups.right.x)}`);
  // 「平衡」的两条：两块同宽同高、底边对齐（同构 = 簇 + 一条扁键）
  const groups = geo.groups;
  check('左右两块同宽同高（配平：都是「簇 + 下面一条扁键」）',
    Math.abs(groups.left.w - groups.right.w) < 1 && Math.abs(groups.left.h - groups.right.h) < 1,
    `左 ${groups.left.w.toFixed(0)}x${groups.left.h.toFixed(0)} / 右 ${groups.right.w.toFixed(0)}x${groups.right.h.toFixed(0)}`);
  check('左右两块底边对齐（扁键那一排齐平，簇中心也齐平）',
    Math.abs((groups.left.y + groups.left.h) - (groups.right.y + groups.right.h)) < 1
    && Math.abs(geo.pad.cy - geo.cluster.cy) < 1,
    `底 ${Math.round(groups.left.y + groups.left.h)}/${Math.round(groups.right.y + groups.right.h)} · `
    + `中心 ${Math.round(geo.pad.cy)}/${Math.round(geo.cluster.cy)}`);

  // 挪这一颗就是为了这条：两只手各按住一颗胶囊，组合键才成立。
  // 手指同时按两个按钮 = 两个 pointerId 各自按下，所以这里发两个 PointerEvent，
  // 不用鼠标（鼠标只有一个指针，按不住两颗）。
  console.log('\n【1b. 屏幕上两只拇指同时按 SELECT + START 能呼出菜单】');
  const menuHidden = () => page.evaluate(() => document.querySelector('.sys-ui').hidden);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('起点：菜单是关着的', await menuHidden() === true);
  const twoThumbs = await page.evaluate(async () => {
    const fire = (sel, type, id) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      document.querySelector(sel).dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', isPrimary: id === 1, bubbles: true, cancelable: true,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, buttons: type === 'pointerdown' ? 1 : 0,
      }));
    };
    fire('.touch-select', 'pointerdown', 1);
    await new Promise((r) => setTimeout(r, 60));
    fire('.touch-start', 'pointerdown', 2);
    await new Promise((r) => setTimeout(r, 260));
    const opened = !document.querySelector('.sys-ui').hidden;
    fire('.touch-select', 'pointerup', 1);
    fire('.touch-start', 'pointerup', 2);
    await new Promise((r) => setTimeout(r, 260));
    return { opened, stillOpen: !document.querySelector('.sys-ui').hidden };
  });
  check('两只拇指各按住一颗 → 菜单打开', twoThumbs.opened === true);
  check('两根手指都松开后菜单还在（没被二次触发关掉）', twoThumbs.stillOpen === true);

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
  // 半径用实测值（弧就画在拨片外缘那道圆上）：格子尺寸一改，写死的数字会按到空白上。
  const arcR = (geo.diags[0].rMin + geo.diags[0].rMax) / 2;
  /** 按住「离中心 r 像素、方向 deg 度（屏幕坐标：0=右，负角朝上）」那个点 */
  const pressPolar = async (deg, r) => {
    const a = (deg * Math.PI) / 180;
    await page.mouse.move(pad.cx + r * Math.cos(a), pad.cy + r * Math.sin(a));
    await page.mouse.down();
    await page.waitForTimeout(60);
    const got = await active();
    await page.mouse.up();
    await page.waitForTimeout(60);
    return got;
  };
  const sorted = (s) => s.split(' ').sort().join(' ');
  console.log('\n【2. 判定：四个扇区各给一个方向，四段弧给两个，弧和拨片之间的空白什么都不给】');
  check('正上 = UP', (await pressDir(0, -1)) === 'UP');
  check('正下 = DOWN', (await pressDir(0, 1)) === 'DOWN');
  check('正左 = LEFT', (await pressDir(-1, 0)) === 'LEFT');
  check('正右 = RIGHT', (await pressDir(1, 0)) === 'RIGHT');
  // 斜向只认那四段弧：按在弧上才给两个方向（弧的中点正好在 45° 上）
  for (const [deg, want] of [[-45, 'RIGHT UP'], [45, 'DOWN RIGHT'], [135, 'DOWN LEFT'], [-135, 'LEFT UP']]) {
    const got = await pressPolar(deg, arcR);
    check(`按 ${deg}° 那道弧 = ${want}`, sorted(got) === want, got);
  }
  // 这次改的目的就在这里：拇指常扫到弧和拨片之间、以及弧外面那些空白，
  // 以前那里算斜向，误触比漏按难查得多。现在按了没反应才是对的。
  for (const deg of [-45, 45]) {
    check(`斜角空白·弧内侧（${deg}° 半径 40px）不给方向`, (await pressPolar(deg, 40)) === '');
    check(`斜角空白·弧外侧（${deg}° 半径 92px）不给方向`, (await pressPolar(deg, 92)) === '');
  }
  // 偏离正方向 15°（<22.5°）仍算正方向：拇指按歪一点不该出斜向
  check('偏上 15° 仍只给 UP', (await pressPolar(-75, arcR)) === 'UP');
  check('偏上 23°（出了扇区、又没按到弧）不给方向', (await pressPolar(-67, arcR)) === '');
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
  // 按弧的反馈：弧自己亮 + 相邻两片一起亮（看不出来按中了什么，就等于没反馈）
  const a45 = (-45 * Math.PI) / 180;
  await page.mouse.move(pad.cx + arcR * Math.cos(a45), pad.cy + arcR * Math.sin(a45));
  await page.mouse.down();
  await page.waitForTimeout(150);
  const arcLit = await page.evaluate(() => {
    const stroke = (sel) => getComputedStyle(document.querySelector(sel)).stroke;
    const fill = (sel) => getComputedStyle(document.querySelector(sel)).fill;
    return {
      arcOn: stroke('.dpad-diag-up-right .dpad-diag-face'),
      arcOff: stroke('.dpad-diag-left-up .dpad-diag-face'),
      up: fill('.dpad-blade-up'), right: fill('.dpad-blade-right'), down: fill('.dpad-blade-down'),
    };
  });
  await page.mouse.up();
  await page.waitForTimeout(150);
  check('按弧时那道弧自己也亮起', arcLit.arcOn !== arcLit.arcOff, `${arcLit.arcOn} vs ${arcLit.arcOff}`);
  check('按弧时相邻两片一起亮，不相邻的不亮',
    arcLit.up === arcLit.right && arcLit.up !== arcLit.down);
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
  // 沿那道圆滑过去：指针被容器捕获后 e.target 一直是容器，滑动中的换向只能靠现量位置重新命中。
  // 这条就是钉住「滑到弧上真的会多出第二个方向」（判定为什么读 elementFromPoint 而不是 e.target）。
  await page.mouse.move(pad.cx + arcR, pad.cy);
  await page.mouse.down();
  await page.waitForTimeout(60);
  const onArm = await active();
  await page.mouse.move(pad.cx + arcR * Math.cos(-45 * Math.PI / 180), pad.cy + arcR * Math.sin(-45 * Math.PI / 180), { steps: 8 });
  await page.waitForTimeout(60);
  const onArc = await active();
  await page.mouse.move(pad.cx, pad.cy - arcR, { steps: 8 });
  await page.waitForTimeout(60);
  const onUp = await active();
  await page.mouse.up();
  await page.waitForTimeout(60);
  check('沿圆滑到弧上：中途多出第二个方向（RIGHT → RIGHT+UP）',
    onArm === 'RIGHT' && sorted(onArc) === 'RIGHT UP', `${onArm} → ${onArc}`);
  check('滑过弧继续到 UP，斜向随之收掉', onUp === 'UP', onUp);

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
  const editProbe = await page.evaluate(({ arcR }) => {
    const el = document.querySelector('.touch-dpad');
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    /**
     * 探两个点：弧键的命中带（斜向按点，它是 svg 里 pointer-events:stroke 的子元素，
     * 摆放模式的拦截最容易漏掉它）和弧外面那道空白（只有整块命中层）。
     * 容器自己会不会被点中，就靠这两处触发。
     */
    const probe = (px, py, id) => {
      const target = document.elementFromPoint(px, py);
      target.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, pointerId: id, clientX: px, clientY: py,
      }));
      const active = el.dataset.active || '';
      target.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, pointerId: id, clientX: px, clientY: py,
      }));
      // SVG 元素的 className 是个对象，取属性才拿得到 class 名
      return { hitTag: `${target.getAttribute('class') || target.tagName}`, active };
    };
    const a45 = (-45 * Math.PI) / 180;
    return {
      onArc: probe(cx + arcR * Math.cos(a45), cy + arcR * Math.sin(a45), 31),
      outside: probe(r.x + r.width * 0.92, r.y + r.height * 0.08, 32),
      editing: document.querySelector('.stage').classList.contains('layout-edit'),
    };
  }, { arcR });
  check('确认在摆放模式里', editProbe.editing === true);
  check('探的第一个点确实是弧键的命中带', /dpad-diag-hit/.test(editProbe.onArc.hitTag), editProbe.onArc.hitTag);
  check('探的第二个点是整块命中层（不是臂）', /touch-dpad-hit/.test(editProbe.outside.hitTag), editProbe.outside.hitTag);
  check('摆放模式下按十字（含弧键）不发方向',
    editProbe.onArc.active === '' && editProbe.outside.active === '',
    `弧 ${editProbe.onArc.active || '无'} / 空白 ${editProbe.outside.active || '无'}`);
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
  await page.mouse.move(pad.cx + arcR * Math.cos(-45 * Math.PI / 180), pad.cy + arcR * Math.sin(-45 * Math.PI / 180));
  await page.mouse.down();
  await page.waitForTimeout(120);
  const dpad = (await held()).join(',');
  await page.mouse.up();
  await page.waitForTimeout(120);
  const afterDpad = await held();
  // 用户这次要的就是这条：拇指扫到弧和拨片之间那道空白，以前会当成斜向送进游戏。
  await page.mouse.move(pad.cx + 40 * Math.cos(-45 * Math.PI / 180), pad.cy + 40 * Math.sin(-45 * Math.PI / 180));
  await page.mouse.down();
  await page.waitForTimeout(120);
  const blankHeld = (await held()).join(',');
  await page.mouse.up();
  await page.waitForTimeout(120);
  check('一开始没有键是按住的', idle.length === 0, idle.join(','));
  check('键盘 上+右 两个键都送进了模拟器', kb === UP_RIGHT, kb);
  check('十字键按右上那道弧也送出两个键', dpad === UP_RIGHT, dpad);
  check('十字键斜向与键盘 上+右 完全一致', dpad === kb, `键盘 ${kb} / 手柄 ${dpad}`);
  check('按弧和拨片之间的空白什么都不送（误触没了）', blankHeld === '', blankHeld);
  check('松开后回到空闲（键盘）', afterKb.length === 0, afterKb.join(','));
  check('松开后回到空闲（十字键）', afterDpad.length === 0, afterDpad.join(','));

  console.log('\n【错误汇总】');
  const real = errors.filter((e) => !/Failed to load resource|404/.test(e));
  check('全程无 JS 错误', real.length === 0, real.slice(0, 3).join(' | '));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exitCode = fail ? 1 : 0;
})();
