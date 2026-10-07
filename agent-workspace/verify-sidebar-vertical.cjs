/**
 * 验证窄屏（手机）下的一级分类栏：竖排不换向、放不下能上下推、不露滚动条、光标跟着进视野；
 * 外加窄屏的详情栏（存档槽位列表）仍在列表下面、没被挤出屏幕。
 *
 * 为什么单独一条脚本：窄屏那条分支只有手机才走得到（容器宽度 ≤ 420px），
 * 其余脚本的视口都在宽屏分支里，改坏了没人拦得住。
 *
 * 判「看不看得见」一律对着 `.screen` 的矩形比，不对着父盒比。第一版对着 `.sys-sidebar`
 * 自己的盒比，`.sys-body` 用 flex-wrap 换行时整栏被内容撑到 527px 高、超出 226px 的框
 * 被 `.screen` 裁掉一半，脚本却全绿 —— 溢出但没被裁的元素，它自己的盒就是假的。
 *
 * 跑法：先 npm run build 并把站点起在 7890，再 node agent-workspace/verify-sidebar-vertical.cjs
 */
const { launch } = require('./lib-browser.cjs');
const { startGame } = require('./lib-game-menu.cjs');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
};

const VIEWPORTS = [
  ['手机竖屏', { width: 390, height: 844 }],
  ['小屏手机', { width: 320, height: 568 }],
  // 故意压扁：屏幕高度放不下六个分类，用来验「超出时能上下推」这条
  ['矮到放不下', { width: 640, height: 260 }],
];

// 把分类栏的当前状态一次读全，三个视口用同一段探针，免得口径不一致。
const read = (page) => page.evaluate(() => {
  const nav = document.querySelector('.sys-sidebar');
  const body = document.querySelector('.sys-body');
  const screen = document.querySelector('.screen').getBoundingClientRect();
  const box = nav.getBoundingClientRect();
  const selected = nav.querySelector('.sys-nav-item.selected');
  const sel = selected.getBoundingClientRect();
  // 被 overflow:hidden 裁掉的元素照样算得出矩形，所以可见性只能跟屏幕比
  const insideScreen = (r) => r.top >= screen.top - 1 && r.bottom <= screen.bottom + 1;
  return {
    dir: getComputedStyle(nav).flexDirection,
    overflowY: getComputedStyle(nav).overflowY,
    barTaken: nav.offsetWidth - nav.clientWidth,
    scrollTop: Math.round(nav.scrollTop),
    // 上下推的前提：内容比栏本身高
    scrollable: nav.scrollHeight > nav.clientHeight + 1,
    // 溢出判据：菜单区域内容高超过可视高 = 有东西被裁到屏幕外
    bodyOverflow: body.scrollHeight > body.clientHeight + 1,
    navInsideScreen: insideScreen(box),
    navHeight: Math.round(box.height),
    screenHeight: Math.round(screen.height),
    labels: Array.from(nav.querySelectorAll('.sys-nav-label')).map((l) => l.textContent),
    selected: selected.querySelector('.sys-nav-label').textContent,
    selInsideScreen: insideScreen(sel),
  };
});

(async () => {
  const browser = await launch();
  for (const [tag, vp] of VIEWPORTS) {
    console.log(`\n===== ${tag} ${vp.width}×${vp.height} · 主菜单 =====`);
    const page = await (await browser.newContext({ viewport: vp, hasTouch: true })).newPage();
    page.on('pageerror', (e) => { fail++; console.log(`  ❌ PAGE ERROR: ${e.message}`); });
    await page.goto('http://localhost:7890/nes-console/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    const a = await read(page);
    check(`${tag}：分类栏竖排（不是横过来当顶部标签）`, a.dir === 'column', `flex-direction=${a.dir}`);
    check(`${tag}：六个分类一个不少`, a.labels.join('/') === '游戏/游戏管理/控制管理/系统/操作说明/关于',
      a.labels.join('/'));
    check(`${tag}：没露出滚动条（占宽 ≤ 1px，那 1px 是右边框）`, a.barTaken <= 1, `占宽 ${a.barTaken}px`);
    check(`${tag}：超出部分靠上下推，不是裁掉`, a.overflowY === 'auto', `overflow-y=${a.overflowY}`);
    check(`${tag}：菜单区域没溢出到屏幕外`, a.bodyOverflow === false,
      `栏高 ${a.navHeight}/屏幕高 ${a.screenHeight}`);
    check(`${tag}：整条分类栏都在屏幕可见范围内`, a.navInsideScreen === true);

    // 光标初始在分类栏，一路按 ↓ 切到最后一个分类（按整圈会绕回第一项，白测），
    // 光标必须跟着进视野
    await page.evaluate(async (n) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < n; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowDown', bubbles: true }));
        await sleep(120);
      }
    }, a.labels.length - 1);
    await page.waitForTimeout(300);

    const b = await read(page);
    check(`${tag}：切到最后一个分类切到了「关于」`, b.selected === '关于', `实得 ${b.selected}`);
    check(`${tag}：光标所在那一项在屏幕可见范围内（不会跑到看不见的地方）`, b.selInsideScreen === true);
    if (tag === '矮到放不下') {
      check('矮屏：六个分类确实放不下（这条分支真的被测到）', a.scrollable === true,
        `scrollable=${a.scrollable}`);
      // 只判「在屏幕内」不够 —— 栏本来就够高时也能过；scrollTop 才证明真滚了
      check('矮屏：切到底时栏确实往下滚了（scrollTop > 0）', b.scrollTop > 0, `scrollTop=${b.scrollTop}`);
      check('矮屏：滚动后整条栏仍没溢出到屏幕外', b.navInsideScreen === true);
    }
    await page.close();
  }

  // 详情栏只在子菜单里出现（存档槽位列表），那时分类栏是隐藏的。窄屏把「列表 + 详情」
  // 改成上下排靠的是 .sys-body:has(> .sys-detail:not([hidden]))：这条选择器没生效的话
  // 详情栏会缩成 34% 宽的一小条，时间/大小两行全断行。
  console.log('\n===== 手机竖屏 390×844 · 存档槽位列表（带详情栏）=====');
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
  page.on('pageerror', (e) => { fail++; console.log(`  ❌ PAGE ERROR: ${e.message}`); });
  await page.addInitScript(() => {
    window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__key = async (code) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      await window.__sleep(150);
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      await window.__sleep(150);
    };
    window.__click = (label) => {
      const el = Array.from(document.querySelectorAll('.sys-item-label'))
        .find((e) => e.textContent === label);
      if (el) el.closest('.sys-item').click();
      return !!el;
    };
  });
  await page.goto('http://localhost:7890/nes-console/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  check('基线：游戏能启动（Destiny）', await startGame(page, 'Destiny'));

  // 先存一档，槽位列表里才有「时间 / 大小」这种长值可看（空槽位只有一句提示，断不断行看不出来）
  await page.evaluate(async () => {
    await window.__key('Escape');            // 呼出游戏内快速菜单
    window.__click('保存存档');              // 直接存进当前快速槽位，菜单不关
    await window.__sleep(1200);
    window.__click('存档管理');              // 进槽位列表（带详情栏）
    await window.__sleep(800);
  });
  const d = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 详情栏跟着光标走：光标挪到有档那一行，最多挪一圈
    for (let i = 0; i < 8 && !document.querySelector('.sys-detail-row'); i++) {
      await window.__key('ArrowDown');
      await sleep(150);
    }
    const body = document.querySelector('.sys-body');
    const detail = document.querySelector('.sys-detail');
    const screen = document.querySelector('.screen').getBoundingClientRect();
    const rows = Array.from(detail.querySelectorAll('.sys-detail-row'));
    const r = detail.getBoundingClientRect();
    return {
      sidebarHidden: document.querySelector('.sys-sidebar').hidden,
      dir: getComputedStyle(body).flexDirection,
      detailShown: !detail.hidden && r.height > 0,
      text: detail.textContent.trim().slice(0, 40),
      detailInsideScreen: r.top >= screen.top - 1 && r.bottom <= screen.bottom + 1,
      bodyOverflow: body.scrollHeight > body.clientHeight + 1,
      // 断行判据：值这一格装不下自己的内容
      broken: rows.filter((row) => {
        const v = row.querySelector('.sys-detail-val');
        return v.scrollWidth > v.clientWidth + 1;
      }).length,
      rows: rows.length,
    };
  });
  check('子菜单里分类栏收起（详情栏这条走「没有侧栏」的形态）', d.sidebarHidden === true);
  check('详情栏显示时列表与详情上下排', d.dir === 'column', `flex-direction=${d.dir}`);
  check('详情栏列出了存档的时间与大小', d.rows === 2, `${d.rows} 行，文字="${d.text}"`);
  check('详情栏没溢出到屏幕外', d.detailShown && d.detailInsideScreen && !d.bodyOverflow,
    `显示=${d.detailShown} 在屏内=${d.detailInsideScreen} 溢出=${d.bodyOverflow}`);
  check('详情栏的键值行没被压断行', d.broken === 0, `${d.broken}/${d.rows} 行断行`);
  await page.close();

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
