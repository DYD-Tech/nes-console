// 验证两件事：
// 1) 按键提示栏只在菜单里（.sys-ui 的子元素，菜单关掉它跟着没）；
// 2) 系统提示改成一次性 toast —— 出现在画面顶部居中、显示完自己消失、
//    新消息顶掉旧消息并重播动画，游戏画面下不留任何常驻提示位。
// 顺带盯住一级菜单末尾的「操作说明」「关于」两项。
const { launch } = require('./lib-browser.cjs');

const URL = 'http://localhost:7890/nes-console/';
/** 和 global.css 里 .toast 的 --toast-ms / --toast-ms-long 一致 */
const TOAST_MS = 2800;
const TOAST_MS_LONG = 6000;

let pass = 0, fail = 0;
const check = (label, ok, actual) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${actual === undefined ? '' : `  [${actual}]`}`);
  ok ? pass++ : fail++;
};

/** 发一个键盘按下+松开（input-manager 监听 window 的 keydown/keyup） */
async function press(page, code, wait = 120) {
  await page.evaluate(async ([c, w]) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true }));
    await new Promise((r) => setTimeout(r, w));
  }, [code, wait]);
}

/**
 * 触发 toast 而不必真的载入 ROM，两档时长各一个入口：
 * - 普通：摆放模式的「恢复默认位置」-> 「按键位置已恢复默认」（例行回执）
 * - 重要：没有正在运行的游戏时按快速存档 -> 「请先启动游戏」（没做成）
 */
const pressQuickSave = (page) => press(page, 'F5');
const resetPadLayout = (page) =>
  page.evaluate(() => document.querySelector('#layout-editor [data-editor="reset"]').click());

/** 一次性把 toast 和提示栏的观测量都取回来 */
const measure = (page) => page.evaluate(() => {
  const scr = document.querySelector('.screen').getBoundingClientRect();
  const toast = document.getElementById('toast');
  const tb = toast.getBoundingClientRect();
  const ui = document.querySelector('.sys-ui');
  const ub = ui.hidden ? null : ui.getBoundingClientRect();
  const topbar = ui.hidden ? null : document.querySelector('.sys-topbar').getBoundingClientRect();
  const hintbar = document.querySelector('.sys-hintbar');
  const hb = hintbar.getBoundingClientRect();
  const countEl = hintbar.querySelector('.sys-count');
  const legend = hintbar.querySelector('.sys-hints');
  const cs = getComputedStyle(toast);
  return {
    scrTop: scr.top, scrBottom: scr.bottom, scrLeft: scr.left, scrRight: scr.right, scrCx: (scr.left + scr.right) / 2,
    uiHidden: ui.hidden,
    uiBottom: ub ? ub.bottom : null,
    topbarBottom: topbar ? topbar.bottom : null,
    hintInUi: !!hintbar.closest('.sys-ui'),
    hintVisible: !ui.hidden && hb.height > 0 && hb.width > 0,
    hintHeight: hb.height,
    hintFontSize: parseFloat(getComputedStyle(ui).fontSize),
    hintLeft: hb.left, hintRight: hb.right, hintWidth: hb.width,
    // 底栏被 overflow: hidden 保护着（宁可裁掉最左一条也不撑高栏），所以要看有没有真裁到
    hintClipped: hintbar.scrollWidth > hintbar.clientWidth + 1,
    // 按键图例：底栏右侧那一串
    hintText: Array.from(legend.querySelectorAll('.sys-hint')).map((e) => e.textContent),
    legendLeft: legend.getBoundingClientRect().left,
    legendRight: legend.getBoundingClientRect().right,
    // 数量栏：底栏左侧那一格，没有数量可说时整块隐藏
    countText: countEl.textContent,
    countHidden: countEl.hidden,
    countLeft: countEl.hidden ? null : countEl.getBoundingClientRect().left,
    countBottom: countEl.hidden ? null : countEl.getBoundingClientRect().bottom,
    toastHidden: toast.hidden,
    toastText: toast.textContent,
    toastLeft: tb.left, toastRight: tb.right, toastTop: tb.top, toastBottom: tb.bottom, toastCx: (tb.left + tb.right) / 2,
    toastInScreen: !!toast.closest('.screen'),
    toastPe: cs.pointerEvents,
    toastImportant: toast.classList.contains('toast-important'),
    toastDur: cs.animationDuration,
    toastZ: Number(cs.zIndex),
    uiZ: Number(getComputedStyle(ui).zIndex),
    toastWrap: cs.whiteSpace,
    toastScrollW: toast.scrollWidth, toastClientW: toast.clientWidth,
    toastScrollH: toast.scrollHeight, toastClientH: toast.clientHeight,
    animTime: toast.getAnimations()[0] ? Math.round(toast.getAnimations()[0].currentTime) : null,
  };
});

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  console.log('\n【1. 菜单开着：按键提示是菜单的一部分，靠右】');
  const open = await measure(page);
  check('提示栏在 .sys-ui 里面（不是屏幕的常驻件）', open.hintInUi);
  check('菜单开着时提示栏可见', open.hintVisible, `宽度=${open.hintWidth.toFixed(1)}`);
  check('提示栏有内容可读', open.hintText.length > 0, open.hintText.join(' | '));
  check('提示靠右（贴着屏幕右内缩，不超过一个字号）',
    open.scrRight - open.hintRight < 24, `间隙=${(open.scrRight - open.hintRight).toFixed(1)}px`);
  check('菜单铺满整个屏幕（不再给常驻底栏让位）',
    open.uiBottom !== null && open.scrBottom - open.uiBottom <= 4,
    `菜单底=${open.uiBottom === null ? 'hidden' : open.uiBottom.toFixed(1)} 屏幕底=${open.scrBottom.toFixed(1)}`);
  check('提示栏不换行（只占一行字高，不会把列表挤矮）',
    open.hintHeight < open.hintFontSize * 2.6,
    `高=${open.hintHeight.toFixed(1)} 字号=${open.hintFontSize.toFixed(1)}`);
  check('底栏没把提示裁掉（左右两栏加起来还放得下）', !open.hintClipped,
    `滚动宽=${open.hintClipped ? '超出' : '未超出'}`);

  console.log('\n【1b. 数量在底栏左下角，图例在右下角】');
  check('有数量的菜单（主菜单游戏列表）左下角写了数量',
    !open.countHidden && /^\d+ 款$/.test(open.countText), open.countText);
  check('数量贴在底栏最左（离屏幕左内缩不超过一个字号）',
    open.countLeft !== null && open.countLeft - open.scrLeft < 24,
    `间隙=${open.countLeft === null ? '隐藏' : (open.countLeft - open.scrLeft).toFixed(1)}px`);
  check('图例仍然贴右（有数量也没把它拽到左边）',
    open.scrRight - open.legendRight < 24,
    `间隙=${(open.scrRight - open.legendRight).toFixed(1)}px`);

  console.log('\n【2. 一级菜单末尾两项：操作说明 / 关于】');
  const navLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.sys-nav-label')).map((e) => e.textContent));
  check('分类顺序是 游戏/游戏管理/控制管理/系统/操作说明/关于',
    navLabels.join(',') === '游戏,游戏管理,控制管理,系统,操作说明,关于', navLabels.join(','));

  // 主菜单打开时焦点就在分类栏上，↑↓ 是换分类：从默认的「游戏」往下 4 格到「操作说明」
  for (let i = 0; i < 4; i++) await press(page, 'ArrowDown');
  const helpItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.sys-item-label')).map((e) => e.textContent));
  check('操作说明列出了界面按键',
    helpItems.includes('呼出 / 关闭菜单') && helpItems.includes('进入该分类的列表')
    && helpItems.includes('回到分类栏 / 关闭菜单') && helpItems.includes('X / Y 键')
    && helpItems.includes('手柄中间的 AB 键'),
    helpItems.join(' | '));
  const helpValues = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.sys-item-value')).map((e) => e.textContent));
  const noCount = await measure(page);
  check('没有数量可说的菜单：左下角整块隐藏，不占栏高',
    noCount.countHidden, `文案=${JSON.stringify(noCount.countText)}`);
  check('按键值跟着当前绑定显示，不是写死的旧键位',
    helpValues.some((v) => v.includes('Esc') || v.includes('未绑定'))
    && helpValues.some((v) => v.includes('F5')),
    helpValues.join(' | '));
  check('说明里的分类栏按键是新模型（进列表 A 或 →、回分类栏 B 或 ←）',
    helpValues.some((v) => v.includes('→')) && helpValues.some((v) => v.includes('←')),
    helpValues.join(' | '));

  await press(page, 'ArrowDown');
  const about = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.sys-item')).map((li) => ({
      label: li.querySelector('.sys-item-label')?.textContent,
      sub: li.querySelector('.sys-item-sub')?.textContent,
    })));
  const powered = about.find((r) => r.label === 'Powered by fceumm');
  check('关于里有 Powered by 行，并告诉用户按 A 会打开主页',
    !!powered && powered.sub === '按 A 打开项目主页', JSON.stringify(powered));

  console.log('\n【3. 菜单开着也能弹 toast，且压在菜单之上、不挡顶栏】');
  await pressQuickSave(page);
  await page.waitForTimeout(120);
  const tOpen = await measure(page);
  check('toast 可见且文案对', !tOpen.toastHidden && tOpen.toastText === '请先启动游戏', tOpen.toastText);
  check('toast 压在菜单之上（z-index 比 .sys-ui 高）', tOpen.toastZ > tOpen.uiZ,
    `toast=${tOpen.toastZ} 菜单=${tOpen.uiZ}`);
  check('toast 在顶栏下沿之下，不跟标题抢地方',
    tOpen.toastTop >= tOpen.topbarBottom, `toast顶=${tOpen.toastTop.toFixed(1)} 顶栏底=${tOpen.topbarBottom.toFixed(1)}`);
  check('toast 不吃事件（按得到它下面的东西）', tOpen.toastPe === 'none', tOpen.toastPe);

  console.log('\n【4. 菜单关掉：提示栏跟着消失，画面里不留常驻提示】');
  // 一次 Esc 就从最顶层一按到底关掉（再按一次会重新打开，别多按）
  await press(page, 'Escape', 300);
  const closed = await measure(page);
  check('菜单已关闭', closed.uiHidden);
  check('按键提示栏不可见（它是 .sys-ui 的子元素，一起隐藏）', !closed.hintVisible,
    `宽度=${closed.hintWidth.toFixed(1)}`);
  const leftovers = await page.evaluate(() => ({
    statusbar: !!document.querySelector('.screen-statusbar'),
    status: !!document.getElementById('status'),
    hud: !!document.getElementById('hud'),
    hudToggle: !!document.getElementById('hud-toggle'),
    dropZone: !!document.getElementById('drop-zone'),
    toast: !!document.getElementById('toast'),
  }));
  check('常驻底栏 / #status / 旧 HUD 全都不在了',
    !leftovers.statusbar && !leftovers.status && !leftovers.hud
    && !leftovers.hudToggle && !leftovers.dropZone, JSON.stringify(leftovers));
  check('#toast 还在（只是这一条播完了收起来）', leftovers.toast);

  console.log('\n【5. 普通提示：出现在画面顶部居中，播完自己消失】');
  await resetPadLayout(page);
  await page.waitForTimeout(120);
  const shown = await measure(page);
  check('例行回执给了提示', !shown.toastHidden && shown.toastText === '按键位置已恢复默认', shown.toastText);
  check('普通提示不算重要（不挂 toast-important）', !shown.toastImportant);
  check(`普通时长 = ${TOAST_MS / 1000} 秒`, shown.toastDur === `${TOAST_MS / 1000}s`, shown.toastDur);
  check('toast 挂在 .screen 上（菜单关着也要能显示）', shown.toastInScreen);
  check('水平居中', Math.abs(shown.toastCx - shown.scrCx) <= 1,
    `偏差=${(shown.toastCx - shown.scrCx).toFixed(2)}px`);
  check('在屏幕内，且靠上（上半屏）',
    shown.toastLeft >= shown.scrLeft && shown.toastRight <= shown.scrRight
    && shown.toastTop >= shown.scrTop && shown.toastBottom < (shown.scrTop + shown.scrBottom) / 2,
    `top=${(shown.toastTop - shown.scrTop).toFixed(1)}px 起`);
  check('动画正在播（进度 > 0）', shown.animTime !== null && shown.animTime > 0, `${shown.animTime}ms`);
  await page.waitForTimeout(TOAST_MS + 400);
  const gone = await measure(page);
  check(`普通提示显示完自动收起（约 ${TOAST_MS / 1000} 秒）`, gone.toastHidden);
  check('收起时文案清空（不会让人误读成当前状态）', gone.toastText === '', JSON.stringify(gone.toastText));

  console.log('\n【6. 重要提示（报错 / 没做成）多停留一会儿】');
  await pressQuickSave(page);
  await page.waitForTimeout(120);
  const imp = await measure(page);
  check('没做成的操作给的是重要档', imp.toastImportant === true, `文案=${imp.toastText}`);
  check(`重要时长 = ${TOAST_MS_LONG / 1000} 秒`, imp.toastDur === `${TOAST_MS_LONG / 1000}s`, imp.toastDur);
  // 普通档这会儿早该消失了；重要档必须还在 —— 两档真的分开了
  await page.waitForTimeout(TOAST_MS + 400 - 120);
  const pastNormal = await measure(page);
  check(`超过普通时长（${TOAST_MS / 1000} 秒）仍然可见`,
    !pastNormal.toastHidden && pastNormal.toastText === '请先启动游戏',
    `文案=${pastNormal.toastText}`);
  await page.waitForTimeout(TOAST_MS_LONG - TOAST_MS + 600);
  const pastLong = await measure(page);
  check(`到 ${TOAST_MS_LONG / 1000} 秒一样会消失（不常驻）`, pastLong.toastHidden);

  console.log('\n【7. 新消息顶掉旧消息，动画从头重播，档位跟着新消息走】');
  await pressQuickSave(page);
  await page.waitForTimeout(600);
  const first = await measure(page);
  await resetPadLayout(page);
  await page.waitForTimeout(120);
  const second = await measure(page);
  check('两条消息文案不同，后一条在前',
    first.toastText === '请先启动游戏' && second.toastText === '按键位置已恢复默认',
    `${first.toastText} -> ${second.toastText}`);
  check('重播了动画（进度回到上一条之前）',
    second.animTime !== null && second.animTime < first.animTime,
    `第一条 ${first.animTime}ms -> 第二条 ${second.animTime}ms`);
  check('档位按最新一条切换（重要 -> 普通）',
    first.toastImportant === true && second.toastImportant === false,
    `${first.toastImportant} -> ${second.toastImportant}`);
  check('没有排队：仍然只有一个 toast 元素',
    await page.evaluate(() => document.querySelectorAll('.toast').length === 1));

  console.log('\n【8. 文案很长：换行显示完整，不越出画面】');
  await page.evaluate(() => {
    const t = document.getElementById('toast');
    t.hidden = true;
    void t.offsetWidth;
    t.textContent = ('加载失败: 这个存档来自旧版本模拟器，格式对不上，'
      + '请重新打一次游戏再存，旧档无法恢复').repeat(2);
    t.hidden = false;
  });
  await page.waitForTimeout(120);
  const long = await measure(page);
  // 以前这里断言的是「放不下就用省略号收尾」—— 结果手机上那句「非 HTTPS 地址下浏览器
  // 禁用了网页音频…」被截成半句，玩家既看不懂也修不了。报错类消息必须整句读得完。
  check('长文案会换行', long.toastWrap === 'normal', long.toastWrap);
  check('整句都显示得下（横向没被裁）',
    long.toastScrollW <= long.toastClientW + 1, `scroll=${long.toastScrollW} client=${long.toastClientW}`);
  check('整句都显示得下（纵向没被裁）',
    long.toastScrollH <= long.toastClientH + 1, `scroll=${long.toastScrollH} client=${long.toastClientH}`);
  check('换出多行了（确实是一句长话）', long.toastClientH > 40, `高=${long.toastClientH}px`);
  check('再长也不越出画面左右边界',
    long.toastLeft >= long.scrLeft - 0.5 && long.toastRight <= long.scrRight + 0.5,
    `${long.toastLeft.toFixed(1)}~${long.toastRight.toFixed(1)} / 屏幕 ${long.scrLeft.toFixed(1)}~${long.scrRight.toFixed(1)}`);
  check('也不越出画面上下边界',
    long.toastTop >= long.scrTop - 0.5 && long.toastBottom <= long.scrBottom + 0.5,
    `${long.toastTop.toFixed(1)}~${long.toastBottom.toFixed(1)} / 屏幕 ${long.scrTop.toFixed(1)}~${long.scrBottom.toFixed(1)}`);

  check('无 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | '));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e); process.exit(1); });
