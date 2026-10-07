/**
 * 验证「按键真的送到了核心」，而不只是送到了宿主的 held 集合。
 *
 * 为什么单独写一个：verify-dpad / verify-touch-xy 断言的都是 `host.held` 里有没有那一项，
 * 那是输入的**入口侧**。核心从另一侧来取（retro_input_state），取到什么以前没人测。
 * 踩过的事：宿主对 RETRO_ENVIRONMENT_GET_INPUT_BITMASKS 回了 true，fceumm 于是改成
 * 只查 id=256（RETRO_DEVICE_ID_JOYPAD_MASK，一次性位掩码），而宿主只会按单个 id 回答，
 * 每帧拿回 0 —— 游戏完全收不到任何按键，且一条报错都没有，全量回归 100% 绿。
 *
 * 这个脚本量的就是「核心查了哪些 (端口,id)、拿回了什么值」：把 host._inputState 包一层
 * 记账，再精确跑若干帧看账本。暂停后用 step 跑帧，账本里就只有这几帧，不会被 rAF 插进来。
 *
 * 跑法：先 `npm run build && npx astro preview --port 7890`，
 *      再 `node agent-workspace/verify-input-reaches-core.cjs [ROM 名关键字]`
 */
const { launch } = require('./lib-browser.cjs');
const { selectGameRow } = require('./lib-game-menu.cjs');

const URL = 'http://localhost:7890/nes-console/';
const ROM = process.argv[2] || '热血格斗';

/** libretro 的 RETRO_DEVICE_ID_JOYPAD_MASK（libretro.h:380）：出现它说明核心走了位掩码路径 */
const MASK_ID = 256;
/**
 * fceumm 每帧会替 1 号手柄查的这些按键 id
 * （出处：其 libretro.c:209-219 的 bindmap，加 :2929 单独查的 L2=13 换色键）。
 * NES 手柄只有 A/B 两个动作位，所以 libretro 的 Y=1 / X=9 永远不会被查到。
 */
const CORE_IDS = [0, 2, 3, 4, 5, 6, 7, 8, 13];
const START = 3, UP = 4, DOWN = 5, LEFT = 6, A = 8;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
};

const HELPERS = () => {
  // 给 _inputState 装一层账本：键是 `端口:id`，值是该 id 最后一次返回给核心的值。
  // 必须按端口分开记 —— 核心每帧先查 0 号再查 1 号手柄，混在一个键上后写的会把前面对冲掉。
  window.__wireInputLog = () => {
    const h = window.__nesConsole.host;
    if (h.__logged) return;
    const orig = h._inputState.bind(h);
    h.__log = new Map();
    h._inputState = (port, device, id) => {
      const v = orig(port, device, id);
      h.__log.set(`${port}:${id}`, v);
      return v;
    };
    h.__logged = true;
  };
  /** 清空账本、跑 n 帧、把账本收回来 */
  window.__drainInputLog = (n) => {
    const h = window.__nesConsole.host;
    h.__log.clear();
    window.__nesConsole.step(n);
    return [...h.__log.entries()];
  };
};

const show = (entries) => entries.map(([k, v]) => `${k}=${v}`).join(' ');

(async () => {
  const browser = await launch();
  const page = await (await browser.newContext({ serviceWorkers: 'block' }))
    .newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const press = (code) => page.evaluate((c) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true }));
  }, code);
  const release = (code) => page.evaluate((c) => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true }));
  }, code);

  try {
    // 强制显示虚拟手柄：下面第 4 节要真点屏幕上的 AB 键
    await page.addInitScript(() => {
      localStorage.setItem('nes-console.settings',
        JSON.stringify({ controls: { padMode: 'always' } }));
    });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__nesConsole, null, { timeout: 20000 });
    await page.evaluate(HELPERS);

    const found = await selectGameRow(page, ROM);
    if (!found) throw new Error(`游戏列表里找不到「${ROM}」`);
    await press('KeyX');          // A = 启动这款
    await release('KeyX');
    await page.waitForFunction(() => window.__nesConsole.host.frames > 30, null, { timeout: 30000 });

    await page.evaluate(() => window.__nesConsole.pause());
    await page.evaluate(() => window.__wireInputLog());

    console.log(`\n【1. 核心取键走的是逐 id 查询（${ROM}）】`);
    const idle = await page.evaluate(() => window.__drainInputLog(10));
    console.log('  账本：' + show(idle));
    const ids = [...new Set(idle.map(([k]) => k.split(':')[1] | 0))];
    const p0 = new Map(idle.filter(([k]) => k.startsWith('0:')).map(([k, v]) => [k.slice(2), v]));
    check('每帧确实来查按键', idle.length > 0, '一帧都没查到 id，说明 input_state 没被调用');
    check(`没走一次性位掩码（不该出现 id=${MASK_ID}）`, !ids.includes(MASK_ID),
      '出现了 256：宿主谎报了 GET_INPUT_BITMASKS，核心每帧拿到的都是 0');
    const missing = CORE_IDS.filter((i) => !p0.has(String(i)));
    check('核心按单个按键 id 查询', missing.length === 0, `缺 ${missing.join(' ')}`);
    check('两个手柄都查了', idle.some(([k]) => k.startsWith('1:')), '只查了 0 号手柄');

    console.log('\n【2. 按住的键，核心拿到的值是 1】');
    await press('Enter');                       // START（默认键 Enter）
    let held = new Map(await page.evaluate(() => window.__drainInputLog(10)));
    console.log('  按住 START：' + show([...held].filter(([k]) => k.startsWith('0:'))));
    check('START 报给核心 1', held.get('0:3') === 1, `实际 ${held.get('0:3')}`);
    check('没按的 A 报给核心 0', held.get('0:8') === 0, `实际 ${held.get('0:8')}`);
    await release('Enter');
    held = new Map(await page.evaluate(() => window.__drainInputLog(10)));
    check('松开后回到 0', held.get('0:3') === 0, `实际 ${held.get('0:3')}`);

    console.log('\n【3. 方向键与 A 键同时按住】');
    await press('ArrowUp');
    await press('ArrowLeft');
    await press('KeyZ');                        // B（默认键 Z；A 是 X，见 input-manager 默认表）
    const multi = new Map(await page.evaluate(() => window.__drainInputLog(10)));
    console.log('  账本：' + show([...multi].filter(([k]) => k.startsWith('0:'))));
    check(`UP(id ${UP})=1`, multi.get('0:4') === 1, `实际 ${multi.get('0:4')}`);
    check(`LEFT(id ${LEFT})=1`, multi.get('0:6') === 1, `实际 ${multi.get('0:6')}`);
    check('B(id 0)=1', multi.get('0:0') === 1, `实际 ${multi.get('0:0')}`);
    check(`没按的 A(id ${A})=0`, multi.get('0:8') === 0, `实际 ${multi.get('0:8')}`);
    check(`没按的 DOWN(id ${DOWN})=0`, multi.get('0:5') === 0, `实际 ${multi.get('0:5')}`);
    for (const c of ['ArrowUp', 'ArrowLeft', 'KeyZ']) await release(c);

    console.log('\n【4. 点手柄上簇心那颗 AB 键，核心同时读到 A 和 B】');
    // 一键多动作（data-action="A B"）走的是同一个 _set，落到核心就是两个位。
    const abBox = await page.locator('.touch-ab').boundingBox();
    if (!abBox) throw new Error('找不到 .touch-ab（手柄没显示？padMode 没生效）');
    await page.mouse.move(abBox.x + abBox.width / 2, abBox.y + abBox.height / 2);
    await page.mouse.down();
    held = new Map(await page.evaluate(() => window.__drainInputLog(10)));
    console.log('  按住 AB：' + show([...held].filter(([k]) => k.startsWith('0:'))));
    check(`A(id ${A})=1`, held.get(`0:${A}`) === 1, `实际 ${held.get(`0:${A}`)}`);
    check('B(id 0)=1', held.get('0:0') === 1, `实际 ${held.get('0:0')}`);
    check('没按的 START(id 3)=0', held.get('0:3') === 0, `实际 ${held.get('0:3')}`);
    await page.mouse.up();
    held = new Map(await page.evaluate(() => window.__drainInputLog(10)));
    check('松开后 A 和 B 都回到 0', held.get(`0:${A}`) === 0 && held.get('0:0') === 0,
      `A=${held.get(`0:${A}`)} B=${held.get('0:0')}`);
  } catch (e) {
    fail++;
    console.log('  ❌ 脚本异常: ' + e.message);
  }

  check('全程无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
