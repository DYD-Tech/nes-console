// 验证屏幕内界面用的确实是 Ozone 默认主题的真实颜色（读渲染后的实际像素和计算样式）。
// 对照来源：RetroArch menu/drivers/ozone.c 的 ozone_theme_dark（第 1220 行）。
const { launch } = require('./lib-browser.cjs');
const { startGame } = require('./lib-game-menu.cjs');

const URL = 'http://localhost:7890/nes-console/';

// 源码里的期望值（十六进制 -> "rgb(r, g, b)"）
const OZONE = {
  background: 'rgb(45, 45, 45)',          // 0x2D2D2D
  sidebar: 'rgb(40, 40, 40)',             // 0x282828
  selection: 'rgb(33, 34, 39)',           // 0x212227
  selection_border: 'rgb(45, 163, 203)',  // 0x2DA3CB
  text_selected: 'rgb(0, 217, 174)',      // 0x00D9AE
  text_sublabel: 'rgb(159, 159, 161)',    // 0x9F9FA1
  message_bg: 'rgb(70, 70, 70)',          // 0x464646
};

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
};

// WCAG 相对亮度与对比度
function lum(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const parse = (s) => s.match(/\d+/g).slice(0, 3).map(Number);
function contrast(a, b) {
  const [l1, l2] = [lum(parse(a)), lum(parse(b))].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

(async () => {
  const browser = await launch();
  const page = await (await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 900 },
  })).newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  console.log('\n【主菜单背景色】');
  // 主菜单打开时焦点在分类栏（导航模型见 screen-ui.js）。色板里「选中」的那几色
  // 只有焦点落上去才显形，所以先测「框在分类栏、列表行干净」，
  // 再按 → 把焦点送进列表测列表行的色。
  const navBox = await page.evaluate(() => {
    const ui = document.querySelector('.sys-ui');
    const sel = ui.querySelector('.sys-item.selected');
    const nav = ui.querySelector('.sys-nav-item.selected');
    return {
      focus: ui.dataset.focus,
      navBg: getComputedStyle(nav).backgroundColor,
      navBorder: getComputedStyle(nav).borderTopColor,
      navText: getComputedStyle(nav.querySelector('.sys-nav-label')).color,
      selBg: getComputedStyle(sel).backgroundColor,
      selBorder: getComputedStyle(sel).borderTopColor,
      selText: getComputedStyle(sel.querySelector('.sys-item-label')).color,
    };
  });
  check('开局焦点在分类栏', navBox.focus === 'sidebar', `实际 ${navBox.focus}`);
  check('分类栏选中项填充 = Ozone selection 0x212227',
    navBox.navBg === OZONE.selection, `实际 ${navBox.navBg}`);
  check('分类栏选中项描边 = Ozone selection_border 0x2DA3CB（框在这一栏）',
    navBox.navBorder === OZONE.selection_border, `实际 ${navBox.navBorder}`);
  check('分类栏选中项文字 = Ozone text_selected 0x00D9AE',
    navBox.navText === OZONE.text_selected, `实际 ${navBox.navText}`);
  check('焦点在分类栏时列表行不描边（整块界面只有一个框）',
    navBox.selBorder === 'rgba(0, 0, 0, 0)', `实际 ${navBox.selBorder}`);
  check('焦点在分类栏时列表行不填色、文字不变青绿',
    navBox.selBg === 'rgba(0, 0, 0, 0)' && navBox.selText === 'rgb(255, 255, 255)',
    `bg=${navBox.selBg} text=${navBox.selText}`);

  await page.evaluate(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowRight', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
  });

  const styles = await page.evaluate(() => {
    const ui = document.querySelector('.sys-ui');
    const cs = getComputedStyle(ui);
    const sel = document.querySelector('.sys-item.selected');
    const selCs = getComputedStyle(sel);
    const nav = document.querySelector('.sys-nav-item.selected');
    const sub = document.querySelector('.sys-item-sub');
    const sidebar = document.querySelector('.sys-sidebar');
    const topbar = document.querySelector('.sys-topbar');
    const toast = document.getElementById('toast');
    return {
      running: ui.dataset.running,
      background: cs.backgroundColor,
      color: cs.color,
      selectionBg: selCs.backgroundColor,
      selectionBorder: selCs.borderTopColor,
      selectionText: getComputedStyle(sel.querySelector('.sys-item-label')).color,
      navBorder: getComputedStyle(nav).borderTopColor,
      subColor: sub ? getComputedStyle(sub).color : null,
      sidebarBg: getComputedStyle(sidebar).backgroundColor,
      topbarBg: getComputedStyle(topbar).backgroundColor,
      toastBg: getComputedStyle(toast).backgroundColor,
    };
  });

  check('菜单背景 = Ozone background 0x2D2D2D',
    styles.background === OZONE.background, `实际 ${styles.background}`);
  check('选中项填充 = Ozone selection 0x212227',
    styles.selectionBg === OZONE.selection, `实际 ${styles.selectionBg}`);
  check('选中项描边 = Ozone selection_border 0x2DA3CB',
    styles.selectionBorder === OZONE.selection_border, `实际 ${styles.selectionBorder}`);
  check('选中项文字 = Ozone text_selected 0x00D9AE',
    styles.selectionText === OZONE.text_selected, `实际 ${styles.selectionText}`);
  check('焦点进列表后分类栏只留填充、框交给列表行',
    styles.navBorder === 'rgba(0, 0, 0, 0)', `实际 ${styles.navBorder}`);
  if (styles.subColor) {
    check('次要文字 = Ozone text_sublabel 0x9F9FA1',
      styles.subColor === OZONE.text_sublabel, `实际 ${styles.subColor}`);
  }
  check('主菜单（无游戏运行）背景不透明', styles.running === 'false', `data-running=${styles.running}`);
  check('侧边栏底色 = #282828', styles.sidebarBg === 'rgb(40, 40, 40)', `实际 ${styles.sidebarBg}`);
  check('顶栏底色 = #282828', styles.topbarBg === 'rgb(40, 40, 40)', `实际 ${styles.topbarBg}`);
  check('一次性提示底色 = #282828 的 0.92（浮在画面上，不透成一块死黑）',
    styles.toastBg === 'rgba(40, 40, 40, 0.92)', `实际 ${styles.toastBg}`);

  // Ozone 的关键特征：选中项比底色更暗
  check('选中项比底色更暗（Ozone 招牌特征）',
    lum(parse(styles.selectionBg)) < lum(parse(styles.background)),
    `selection L=${lum(parse(styles.selectionBg)).toFixed(3)} vs bg L=${lum(parse(styles.background)).toFixed(3)}`);

  console.log('\n【对比度（WCAG AA 正文需 ≥4.5）】');
  const pairs = [
    ['正文 白 on #2D2D2D', styles.color, styles.background, 4.5],
    ['选中文字 青绿 on #212227', styles.selectionText, styles.selectionBg, 4.5],
    ['次要文字 #9F9FA1 on #2D2D2D', OZONE.text_sublabel, styles.background, 4.5],
    ['选中描边 青 on #212227', styles.selectionBorder, styles.selectionBg, 3.0],
  ];
  for (const [label, fg, bg, min] of pairs) {
    const ratio = contrast(fg, bg);
    check(`${label} = ${ratio.toFixed(2)} (≥${min})`, ratio >= min, `实际 ${ratio.toFixed(2)}`);
  }

  console.log('\n【游戏中：背景半透明，画面透出来】');
  // 启动游戏，再呼出快速菜单
  await page.evaluate(async () => {
    window.__press = async (code, waitMs = 150) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      await new Promise((r) => setTimeout(r, waitMs));
    };
  });
  // 启动内置游戏，等到「菜单关了、核心真在出帧」为止。
  // 为什么不能等固定时间：见 lib-game-menu.cjs 的 startGame 注释
  //（实测踩过 —— 单跑全绿、全量连跑变红就是这里来的）。
  const playing = await startGame(page, 'Destiny');
  check('游戏已启动（菜单关闭）', playing === true);
  const quick = await page.evaluate(async () => {
    await window.__press('Escape', 300);   // 呼出快速菜单
    const ui = document.querySelector('.sys-ui');
    const cs = getComputedStyle(ui);
    return {
      running: ui.dataset.running,
      bgImage: cs.backgroundImage,
      hasBlur: cs.backdropFilter,
      visible: !ui.hidden,
      title: ui.querySelector('.sys-title')?.textContent || '',
    };
  });
  check('快速菜单已打开', quick.visible === true, quick.title);
  check('快速菜单标记为游戏中', quick.running === 'true', `data-running=${quick.running}`);
  check('快速菜单背景是渐变（顶部不透明到底部半透明）',
    quick.bgImage.includes('linear-gradient'), quick.bgImage.slice(0, 60));

  // 从渐变色标里取出 alpha，确认顶部 1.0 / 底部 0.75（对应 Ozone 默认 0.9 opacity）
  const alphas = [...quick.bgImage.matchAll(/rgba?\(45,\s*45,\s*45(?:,\s*([\d.]+))?\)/g)]
    .map((m) => (m[1] === undefined ? 1 : parseFloat(m[1])));
  check('渐变顶部 alpha = 1.0（Ozone: 0.9/0.9）',
    alphas.length > 0 && alphas[0] === 1, `实际 ${JSON.stringify(alphas)}`);
  check('渐变底部 alpha = 0.75（Ozone: 2.5*0.9-1.5）',
    alphas.length > 1 && alphas[alphas.length - 1] === 0.75, `实际 ${JSON.stringify(alphas)}`);

  console.log('\n【子菜单继承半透明】');
  const subMenu = await page.evaluate(async () => {
    // 从快速菜单进「设置」，背景应保持半透明
    const ui = document.querySelector('.sys-ui');
    const items = Array.from(ui.querySelectorAll('.sys-item-label')).map((e) => e.textContent);
    for (let i = 0; i < items.length; i++) {
      const sel = ui.querySelector('.sys-item.selected .sys-item-label')?.textContent;
      if (sel === '设置') break;
      await window.__press('ArrowDown', 60);
    }
    await window.__press('KeyX', 300);
    return {
      title: ui.querySelector('.sys-title')?.textContent || '',
      running: ui.dataset.running,
      bgImage: getComputedStyle(ui).backgroundImage,
    };
  });
  check('已进入设置子菜单', subMenu.title === '设置', subMenu.title);
  check('子菜单继承半透明背景（画面不被盖住）',
    subMenu.running === 'true' && subMenu.bgImage.includes('linear-gradient'),
    `data-running=${subMenu.running}`);

  console.log('\n【两套色板互不污染：屏幕内 Ozone，屏幕外中性石墨 + 青】');
  const outside = await page.evaluate(() => {
    const stage = document.querySelector('.stage');
    const controls = document.getElementById('touch-controls');
    // 自定义属性拿不到解析后的颜色，套到一个临时元素上让浏览器算成 rgb()
    const resolve = (expr) => {
      const el = document.createElement('div');
      el.style.color = expr;
      document.body.appendChild(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    };
    // 通道差：R/G/B 最大减最小。小于 6 就当「中性、看不出带色相」
    const spread = (rgb) => { const n = rgb.match(/\d+/g).map(Number); return Math.max(...n) - Math.min(...n); };
    return {
      // 手柄按下描边取自外围强调色（屏幕外那套，故意不等于 Ozone 选中框的 #2DA3CB）
      padPressLine: getComputedStyle(controls).getPropertyValue('--pad-press-line').trim(),
      stageBg: getComputedStyle(stage).backgroundImage,
      bgAccent: spread(resolve('var(--bg-accent)')),
      bgPrimary: spread(resolve('var(--bg-primary)')),
      // 屏幕内不该出现外围那支亮青
      sysTitle: getComputedStyle(document.querySelector('.sys-title')).color,
      toastColor: getComputedStyle(document.getElementById('toast')).color,
    };
  });
  check('手柄按下描边是外围强调青（与 Ozone 选中框不同值）',
    outside.padPressLine === '#7FD8F5', `实际 ${outside.padPressLine}`);
  check('外围底色是中性石墨（不带色相，改色不许回潮）',
    outside.bgAccent < 6 && outside.bgPrimary < 6,
    `--bg-accent 通道差 ${outside.bgAccent} / --bg-primary 通道差 ${outside.bgPrimary}`);
  check('屏幕内标题是 Ozone 白', outside.sysTitle === 'rgb(255, 255, 255)', `实际 ${outside.sysTitle}`);
  check('一次性提示文字也是 Ozone 白', outside.toastColor === 'rgb(255, 255, 255)', `实际 ${outside.toastColor}`);
  check('背景台仍是渐变 + 网格',
    outside.stageBg.includes('gradient'), outside.stageBg.slice(0, 40));

  console.log('\n【错误】');
  check('无 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e); process.exit(1); });
