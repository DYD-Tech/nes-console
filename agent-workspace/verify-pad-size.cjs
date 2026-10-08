// 验证手柄三档大小：尺子取值、每档的实际尺寸、窄屏封顶、常驻按钮不受影响、
// 设置里循环与持久化、默认档是中档，以及「放大只是等比，判定一点不变」。
//
// 尺寸全部按 global.css 的算式核对：所有长度 = 倍数 × 尺子 --pad-u，
// 尺子 = min(档位基准, 100vw / 19)。基准小 16 / 中 19 / 大 22px。
const { launch } = require('./lib-browser.cjs');

const URL = 'http://localhost:7890/nes-console/';
const SETTINGS_KEY = 'nes-console.settings';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

const LABELS = { small: '小（键径 48px）', medium: '中（键径 57px）', large: '大（键径 66px）' };
const BASE = { small: 16, medium: 19, large: 22 };

/** 量一次手柄：尺子从 #touch-controls 的 padding 读（未注册的自定义属性拿回来的是没算的式子） */
const GEOM = () => {
  const px = (s) => parseFloat(s);
  const tc = document.getElementById('touch-controls');
  const box = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.getBoundingClientRect() : null;
  };
  const menu = box('.screen .touch-menu');
  const fs = box('.screen .touch-fs');
  const gl = box('.touch-dpad-group');
  const gr = box('.touch-actions-group');
  const screen = box('.screen');
  const a = box('.touch-a');
  const sel = box('.touch-select');
  const pad = box('.touch-dpad');
  const cs = getComputedStyle(document.querySelector('.touch-a'));
  const blade = getComputedStyle(document.querySelector('.dpad-blade'));
  return {
    u: px(getComputedStyle(tc).paddingLeft),
    attr: document.querySelector('.stage').dataset.padSize || '',
    key: a.width,
    dpad: pad.width,
    pill: [sel.width, sel.height],
    gap: gr.left - gl.right,
    lift: innerHeight - Math.max(gl.bottom, gr.bottom),
    screenTop: screen.top,
    screenBottom: screen.bottom,
    padTop: gl.top,
    boxRect: tc.getBoundingClientRect(),
    btnBorder: px(cs.borderTopWidth),
    // 拨片描边是 viewBox 单位，按取景框边长折算成 px
    bladePx: px(blade.strokeWidth)
      / document.querySelector('.touch-dpad-face').viewBox.baseVal.width * pad.width,
    constBtns: [menu.width, menu.height, fs.width, fs.height],
  };
};

async function open(browser, { viewport, isTouch = true, seed }) {
  const ctx = await browser.newContext({
    serviceWorkers: 'block', viewport, hasTouch: isTouch, isMobile: isTouch,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  if (seed !== null) {
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v),
      [SETTINGS_KEY, JSON.stringify(seed)]);
  }
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(350);
  return { ctx, page, errs };
}

const measure = (page) => page.evaluate(GEOM);

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
  await page.waitForTimeout(250);
}

(async () => {
  const browser = await launch();

  console.log('\n【1. 三档的尺子与实测尺寸（1024x768，宽度拿得满）】');
  const wide = { width: 1024, height: 768 };
  const g = {};
  for (const size of ['small', 'medium', 'large']) {
    const s = await open(browser, { viewport: wide, seed: { controls: { padMode: 'always', padSize: size } } });
    g[size] = await measure(s.page);
    check(`${size}：档位写到 .stage 上`, g[size].attr === size, g[size].attr);
    check(`${size}：尺子 = ${BASE[size]}px`, Math.abs(g[size].u - BASE[size]) < 0.05, `${g[size].u}`);
    check(`${size}：键径 = 3u（${(3 * BASE[size]).toFixed(1)}px）`,
      Math.abs(g[size].key - 3 * g[size].u) < 0.6, `${g[size].key.toFixed(1)}`);
    check(`${size}：十字块 = 8.25u（${(8.25 * BASE[size]).toFixed(1)}px）`,
      Math.abs(g[size].dpad - 8.25 * g[size].u) < 0.6, `${g[size].dpad.toFixed(1)}`);
    check(`${size}：胶囊键 = 3.5u × 1.75u`,
      Math.abs(g[size].pill[0] - 3.5 * g[size].u) < 0.6 && Math.abs(g[size].pill[1] - 1.75 * g[size].u) < 0.6,
      `${g[size].pill[0].toFixed(1)}x${g[size].pill[1].toFixed(1)}`);
    check(`${size}：描边等粗（边框取整后与拨片最多差 0.6px）`,
      Math.abs(g[size].bladePx - g[size].btnBorder) < 0.6,
      `片 ${g[size].bladePx.toFixed(2)} / 键 ${g[size].btnBorder}`);
    await s.ctx.close();
  }
  // 「现在的当最小档」—— 小档必须逐像素等于改造前那套数，一格都不许动
  check('小档逐像素不变：键径 48 / 十字 132 / 胶囊 56x28 / 边框 3px',
    Math.abs(g.small.key - 48) < 0.5 && Math.abs(g.small.dpad - 132) < 0.5
    && Math.abs(g.small.pill[0] - 56) < 0.5 && Math.abs(g.small.pill[1] - 28) < 0.5
    && g.small.btnBorder === 3,
    `键 ${g.small.key.toFixed(1)} 十字 ${g.small.dpad.toFixed(1)} 胶囊 ${g.small.pill.join('x')} 边框 ${g.small.btnBorder}`);
  // 「不要大的不合理」：上限停在真 NES 手柄的键帽大小（A/B 键帽约 10mm），拇指再长按的是屏幕不是键
  check('大档不越上限：键径 ≤66px、十字块 ≤182px',
    g.large.key <= 66.5 && g.large.dpad <= 182,
    `键 ${g.large.key.toFixed(1)} / 十字 ${g.large.dpad.toFixed(1)}`);
  check('三档是逐级变大、不是翻倍吓人（每档比上一档大 15%~22%）',
    g.medium.key / g.small.key > 1.15 && g.medium.key / g.small.key < 1.22
    && g.large.key / g.medium.key > 1.1 && g.large.key / g.medium.key < 1.2,
    `${g.small.key.toFixed(0)} → ${g.medium.key.toFixed(0)} → ${g.large.key.toFixed(0)}`);

  console.log('\n【2. 常驻的界面按钮不参与手柄缩放（屏幕内那两颗）】');
  check('菜单/全屏两颗按钮的尺寸三档都一样',
    JSON.stringify(g.small.constBtns) === JSON.stringify(g.medium.constBtns)
    && JSON.stringify(g.medium.constBtns) === JSON.stringify(g.large.constBtns),
    `${g.small.constBtns.join('/')} vs ${g.large.constBtns.join('/')}`);

  console.log('\n【3. 手机竖屏 390x844：三档都坐在画面下方、离底边留拇指位】');
  for (const size of ['small', 'medium', 'large']) {
    const s = await open(browser, { viewport: { width: 390, height: 844 }, seed: { controls: { padMode: 'always', padSize: size } } });
    const m = await measure(s.page);
    check(`${size}：没压住游戏画面`, m.padTop >= m.screenBottom - 1,
      `手柄顶=${Math.round(m.padTop)} 画面底=${Math.round(m.screenBottom)}`);
    // 180px 是拇指的自然落点，绝对量、不随档位放大（三档都撞到这条上限）
    check(`${size}：离底边 180px`, Math.abs(m.lift - 180) <= 2, `${Math.round(m.lift)}px`);
    check(`${size}：画面离顶边 8px`, Math.abs(m.screenTop - 8) <= 1, `${Math.round(m.screenTop)}px`);
    await s.ctx.close();
  }

  console.log('\n【4. 窄屏封顶：320 宽放不下 19u，尺子被夹到 100vw/19】');
  const narrow = {};
  for (const size of ['medium', 'large']) {
    const s = await open(browser, { viewport: { width: 320, height: 640 }, seed: { controls: { padMode: 'always', padSize: size } } });
    narrow[size] = await measure(s.page);
    const cap = 320 / 19;
    check(`${size}：尺子夹到 ${cap.toFixed(2)}px（不再是 ${BASE[size]}px）`,
      Math.abs(narrow[size].u - cap) < 0.1, `${narrow[size].u}`);
    const r = narrow[size].boxRect;
    check(`${size}：手柄整块还在视口内`,
      r.left >= -1 && r.right <= 320 + 1 && r.bottom <= 640 + 1,
      `left=${Math.round(r.left)} right=${Math.round(r.right)} bottom=${Math.round(r.bottom)}`);
    // 缝隙是算式的依据：两块各 8.25u + 容器左右内边距 2u + 缝 0.5u = 19u
    check(`${size}：两块之间还留着 0.5u 的缝（没撞上）`,
      narrow[size].gap >= 0.5 * narrow[size].u - 1.5, `${Math.round(narrow[size].gap)}px / ${(0.5 * narrow[size].u).toFixed(1)}px`);
    await s.ctx.close();
  }
  check('封顶后中档与高档是同一尺寸（大当到这一宽就到底了）',
    Math.abs(narrow.medium.u - narrow.large.u) < 0.05,
    `中 ${narrow.medium.u} / 大 ${narrow.large.u}`);

  console.log('\n【5. 设置里可调：默认中档、菜单循环、写盘、刷新后仍在】');
  // 无存档 → 拿默认值，必须是中档（小档是「按不动手指」那一档，不该是新人第一眼看到的）
  const fresh = await open(browser, { viewport: wide, seed: null });
  await fresh.page.evaluate((k) => localStorage.removeItem(k), SETTINGS_KEY);
  await fresh.page.reload({ waitUntil: 'networkidle' });
  await fresh.page.waitForTimeout(350);
  const fm = await measure(fresh.page);
  check('没存档时默认是中档', fm.attr === 'medium', fm.attr);
  check('默认中档的键径是 57px', Math.abs(fm.key - 57) < 0.6, `${fm.key.toFixed(1)}`);

  await openSection(fresh.page, '控制管理');
  const rows = await fresh.page.evaluate(() => Array.from(document.querySelectorAll('.sys-item')).map((el) => ({
    label: el.querySelector('.sys-item-label')?.textContent,
    value: el.querySelector('.sys-item-value')?.textContent ?? null,
  })));
  const sizeRow = rows.find((r) => r.label === '按键大小');
  check('控制管理里有「按键大小」一行', !!sizeRow, rows.map((r) => r.label).join('/'));
  check('这一行显示当前档位', sizeRow?.value === LABELS.medium, sizeRow?.value);
  check('紧跟在「虚拟手柄」下面（先决定显不显示，再决定多大）',
    rows.findIndex((r) => r.label === '虚拟手柄') + 1 === rows.findIndex((r) => r.label === '按键大小'),
    rows.map((r) => r.label).join('/'));

  // 点一次换一档，三档转一圈回到起点；每次都要看到反馈（toast），不能静默变
  const cycle = [];
  for (const want of ['large', 'small', 'medium']) {
    await clickItem(fresh.page, '按键大小');
    const st = await fresh.page.evaluate(() => ({
      attr: document.querySelector('.stage').dataset.padSize || '',
      key: document.querySelector('.touch-a').getBoundingClientRect().width,
      toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent,
      stored: (() => { try { return JSON.parse(localStorage.getItem('nes-console.settings') || '{}').controls?.padSize; } catch { return null; } })(),
    }));
    cycle.push(st);
    check(`点一下切到「${want}」`, st.attr === want, st.attr);
    check(`${want}：键径跟着变（${BASE[want] * 3}px）`, Math.abs(st.key - 3 * BASE[want]) < 0.6, `${st.key.toFixed(1)}`);
    check(`${want}：提示写了新档位（操作有反馈）`,
      st.toast.includes('按键大小') && st.toast.includes(LABELS[want].slice(0, 1)), st.toast);
    check(`${want}：已经写进设置`, st.stored === want, String(st.stored));
  }
  await fresh.page.reload({ waitUntil: 'networkidle' });
  await fresh.page.waitForTimeout(350);
  check('刷新后还是那一档（持久化生效）',
    (await measure(fresh.page)).attr === 'medium', (await measure(fresh.page)).attr);

  // 恢复默认控制：整组控制设置清零，尺寸也该回到中档
  await openSection(fresh.page, '控制管理');
  await clickItem(fresh.page, '恢复默认控制');
  await fresh.page.waitForTimeout(250);
  check('「恢复默认控制」回到中档', (await measure(fresh.page)).attr === 'medium',
    (await measure(fresh.page)).attr);
  await fresh.ctx.close();

  console.log('\n【6. 放大只是等比：判定与弧键在大档下行为一致】');
  const big = await open(browser, { viewport: wide, seed: { controls: { padMode: 'always', padSize: 'large' } } });
  const bm = await measure(big.page);
  const padBox = await big.page.evaluate(() => {
    const r = document.querySelector('.touch-dpad').getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width };
  });
  /** 按住「离中心 deg 度方向 r 像素」那一点，返回期间的 data-active */
  const press = async (deg, r) => {
    const a = (deg * Math.PI) / 180;
    await big.page.mouse.move(padBox.cx + r * Math.cos(a), padBox.cy + r * Math.sin(a));
    await big.page.mouse.down();
    await big.page.waitForTimeout(70);
    const got = await big.page.evaluate(() => document.querySelector('.touch-dpad').dataset.active || '');
    await big.page.mouse.up();
    await big.page.waitForTimeout(70);
    return got;
  };
  // 弧就在拨片外缘那道圆上：半径 = 格子宽 × 0.4887（45.7/93.52 单位）
  const arcR = padBox.w * (45.7 / 93.52);
  const onArc = await press(-45, arcR);
  check('大档按 45° 那道弧给两个方向',
    onArc.split(' ').sort().join(' ') === 'RIGHT UP', onArc);
  const blank = await press(-45, padBox.w * 0.3);
  check('大档按弧内侧空白不给方向（和最小档一样是空白）', blank === '', blank);
  const sector = await press(-75, arcR);
  check('大档偏 15° 仍只给 UP（扇区角度没被放大带跑）', sector === 'UP', sector);
  const realErrs = big.errs.filter((e) => !/Failed to load resource|404/.test(e));
  check('大档下没有页面报错', realErrs.length === 0, realErrs.join(' | '));
  await big.ctx.close();

  await browser.close();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('失败:', e); process.exit(1); });
