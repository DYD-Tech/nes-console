// 触摸手柄验证：显示条件、动作声明、各形态下的布局位置。
// 只做结构和位置断言，不做视觉/GUI 断言。
const { launch } = require('./lib-browser.cjs');

const URL = 'http://localhost:7890/nes-console/';

// 期望的动作声明：十字键 4 个臂 + 功能键 6 个（SELECT/START/X/Y/B/A）+ 簇心 AB = 11 个
// （MENU 已移到屏幕右上角；X/Y 是界面键，NES 游戏收不到，但照样是可按的手柄按钮）
const EXPECTED_ACTIONS = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'X', 'Y', 'SELECT', 'START', 'A B'];
// 斜向是外切圆上四段独立弧键，一段一次声明两个动作，不算「一个按键动作」
const EXPECTED_DIAGS = ['UP RIGHT', 'RIGHT DOWN', 'DOWN LEFT', 'LEFT UP'];

async function checkLayout(browser, name, viewport, isTouch) {
  const ctx = await browser.newContext({
    serviceWorkers: 'block',
    viewport,
    hasTouch: isTouch,
    isMobile: isTouch,
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  const info = await page.evaluate(() => {
    const box = document.getElementById('touch-controls');
    const style = getComputedStyle(box);
    // 左手整块（十字键 + 下面的 SELECT）：位置、是否压画面、离底边多远都按这块量
    const dpad = document.querySelector('.touch-dpad-group').getBoundingClientRect();
    // 「中心齐平」只量十字键本身，它才是和五键簇对中线的那一个
    const cross = document.querySelector('.touch-dpad').getBoundingClientRect();
    // 右手整块（五键簇 + 下面的 START），和左手同构
    const actions = document.querySelector('.touch-actions-group').getBoundingClientRect();
    // 斜向那四段弧键也带 data-action，但它不是「一颗按钮」，单独列出来比
    const all = Array.from(document.querySelectorAll('#touch-controls [data-action]'));
    const btns = all.filter((b) => !b.closest('.dpad-diag'));
    // 「水平对齐」比的是十字键中心与 ABXY 四颗围出的正方形中心（簇心那颗 AB 就在正中）
    const abxy = ['x', 'y', 'b', 'a']
      .map((k) => document.querySelector(`.touch-${k}`).getBoundingClientRect());
    const screen = document.querySelector('.screen').getBoundingClientRect();
    return {
      display: style.display,
      visible: style.display !== 'none',
      direction: style.flexDirection,
      vw: window.innerWidth,
      vh: window.innerHeight,
      dpad: { left: dpad.left, top: dpad.top, right: dpad.right, bottom: dpad.bottom },
      actions: { left: actions.left, top: actions.top, right: actions.right, bottom: actions.bottom },
      dpadMidY: (cross.top + cross.bottom) / 2,
      abxyMidY: (Math.min(...abxy.map((r) => r.top)) + Math.max(...abxy.map((r) => r.bottom))) / 2,
      // 竖屏画面靠上（留 8px），手柄必须落在画面底边以下，否则就压住游戏画面
      screenTop: screen.top,
      screenBottom: screen.bottom,
      declared: btns.map((b) => b.dataset.action),
      diags: all.filter((b) => b.closest('.dpad-diag')).map((b) => b.dataset.action),
      bound: btns.filter((b) => !!b.dataset.action).length,
      // 加了一排 X/Y 后手柄变高，量一下是否还在视口内
      box: (() => {
        const r = box.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      })(),
    };
  });

  console.log(`\n【${name}】 ${viewport.width}x${viewport.height}`);
  console.log(`   display=${info.display} direction=${info.direction}`);
  console.log(`   十字键 left=${Math.round(info.dpad.left)} 功能键 left=${Math.round(info.actions.left)}`);
  console.log(`   方向键中心Y=${Math.round(info.dpadMidY)} ABXY中心Y=${Math.round(info.abxyMidY)}`);

  const results = [];
  results.push(['按键数量为 11（不含四段斜向弧键）', info.declared.length === 11]);
  results.push(['动作声明完整', EXPECTED_ACTIONS.every((a) => info.declared.includes(a))]);
  results.push(['每个按键都有动作声明（含十字键四个臂）', info.bound === 11]);
  results.push(['斜向是四段独立弧键，各声明两个动作',
    info.diags.slice().sort().join('|') === EXPECTED_DIAGS.slice().sort().join('|'),
    info.diags.join(' ')]);
  results.push(['手柄整体没超出视口',
    info.box.top >= 0 && info.box.bottom <= info.vh + 1 && info.box.left >= 0 && info.box.right <= info.vw + 1,
    `top=${Math.round(info.box.top)} bottom=${Math.round(info.box.bottom)}/${info.vh}`]);
  // 拇指同时按左右两组时，两组得在同一水平带上，不然一只手要抬着
  results.push(['方向键与 ABXY 中心齐平',
    Math.abs(info.dpadMidY - info.abxyMidY) <= 2,
    `高差=${Math.round(info.dpadMidY - info.abxyMidY)}px`]);

  if (isTouch) {
    results.push(['触摸设备显示手柄', info.visible]);
    if (viewport.width < viewport.height) {
      // 手机竖屏：和横屏同样的分工（方向键左、动作键右），整块坐在画面下方那块空白里，
      // 且离底边留出一截 —— 拇指的自然落点不在屏幕最下沿，下面还有系统手势条。
      const lift = info.vh - Math.max(info.dpad.bottom, info.actions.bottom);
      results.push(['竖屏横向排列（不折成一竖列）', info.direction === 'row']);
      results.push(['十字键在左半屏', info.dpad.left < info.vw / 2,
        `right=${Math.round(info.dpad.right)}/${info.vw}`]);
      results.push(['功能键在右半屏', info.actions.left > info.vw / 2,
        `left=${Math.round(info.actions.left)} 半屏=${Math.round(info.vw / 2)}`]);
      results.push(['两组之间不相撞', info.dpad.right <= info.actions.left,
        `间隙=${Math.round(info.actions.left - info.dpad.right)}px`]);
      results.push(['手柄在屏幕下半区', info.dpad.top > info.vh * 0.5]);
      results.push(['没压住游戏画面',
        info.dpad.top >= info.screenBottom && info.actions.top >= info.screenBottom,
        `画面底=${Math.round(info.screenBottom)} 手柄顶=${Math.round(Math.min(info.dpad.top, info.actions.top))}`]);
      // 拇指的自然落点：离底边 180px（这里 390x844 画面下方空白足够，取到上限）
      results.push(['离底边 180px（拇指落点，不是贴底）', Math.abs(lift - 180) <= 2,
        `离底边=${Math.round(lift)}px`]);
      // 常态：画面离开顶边一小截（8px），不顶着屏幕边
      results.push(['画面离顶边 8px', Math.abs(info.screenTop - 8) <= 1,
        `画面顶=${Math.round(info.screenTop)}px`]);
    } else {
      // 横屏：十字键在左，功能键在右
      results.push(['横屏横向排列', info.direction === 'row']);
      results.push(['十字键在左半屏', info.dpad.left < info.vw / 2]);
      results.push(['功能键在右半屏', info.actions.left > info.vw / 2]);
    }
  } else {
    results.push(['桌面端隐藏手柄', !info.visible]);
  }

  for (const [label, ok] of results) {
    console.log(`   ${ok ? '✅' : '❌'} ${label}`);
  }
  await ctx.close();
  return results.every(([, ok]) => ok);
}

(async () => {
  const browser = await launch();

  const results = [];
  results.push(await checkLayout(browser, '桌面端', { width: 1440, height: 900 }, false));
  results.push(await checkLayout(browser, '平板横屏', { width: 1024, height: 768 }, true));
  results.push(await checkLayout(browser, '手机竖屏', { width: 390, height: 844 }, true));
  results.push(await checkLayout(browser, '手机横屏', { width: 844, height: 390 }, true));

  await browser.close();
  const ok = results.every(Boolean);
  console.log(`\n结果: ${ok ? '✅ 全部通过' : '❌ 有失败项'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('失败:', e); process.exit(1); });
