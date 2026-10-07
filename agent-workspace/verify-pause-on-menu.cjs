// 验证「打开菜单时游戏暂停」。
//
// 判据是核心自己数的帧（`host.frames`）在观测窗口里涨不涨：涨 = 还在跑，不涨 = 已停。
// 不看画面（停在标题画面时本来就静止，会测出假阴性），也不用 requestAnimationFrame
// 频率推断（页面上不止一条 rAF 循环 —— 手柄轮询那条一直在跑，会把模拟器的循环盖住）。
//
// frames 是累计值，挂在唯一的宿主对象上，退出到菜单不清零 —— 所以门槛一律写增量。
const { launch } = require('./lib-browser.cjs');
const { startGame, selectGameRow } = require('./lib-game-menu.cjs');

const URL = 'http://localhost:7890/nes-console/';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
};

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    window.__press = async (code, waitMs = 200) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      await new Promise((r) => setTimeout(r, 40));
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      await new Promise((r) => setTimeout(r, waitMs));
    };
    // 观测窗口 900ms：60fps 下约 54 帧，跑没跑一眼分得开
    window.__frameDelta = async (ms = 900) => {
      const a = window.__nesConsole.host.frames;
      await new Promise((r) => setTimeout(r, ms));
      return window.__nesConsole.host.frames - a;
    };
    // 光标移到某一行的标签上（只在焦点已经落在列表上时用；分类栏另说）
    window.__walkTo = async (label) => {
      for (let i = 0; i < 24; i++) {
        const cur = document.querySelector('.sys-item.selected .sys-item-label')?.textContent || '';
        if (cur === label) return true;
        await window.__press('ArrowDown', 70);
      }
      return false;
    };
    window.__ui = () => {
      const el = document.querySelector('.sys-ui');
      return {
        hidden: el.hidden,
        title: el.querySelector('.sys-title')?.textContent || '',
        badge: el.querySelector('.sys-badge')?.textContent || '',
        toast: document.getElementById('toast').textContent,
      };
    };
  });

  const rate = () => page.evaluate(() => window.__frameDelta());
  const ui = () => page.evaluate(() => window.__ui());
  // 900ms 窗口里：在跑至少该有 30 帧，停着最多漂几帧（暂停落地前那一帧的尾巴）
  const isRunning = (n) => n > 30;
  const isStopped = (n) => n < 5;

  console.log('\n【启动游戏：核心在跑帧】');
  const started = await startGame(page, 'Destiny');
  check('游戏已启动（等到核心真跑起来）', started === true);
  const before = await rate();
  console.log(`  游戏中: ${before} 帧/900ms`);
  check('游戏中核心在跑帧', isRunning(before), `${before}`);

  console.log('\n【打开菜单：停帧，且开的是游戏中的快速菜单】');
  await page.evaluate(() => window.__press('Escape', 400));
  const open = await ui();
  check('菜单已打开', open.hidden === false, JSON.stringify(open));
  // 「游戏中呼出的是快速菜单」是暂停的前置条件：载入没完成时 playing 还是 false，
  // 那时呼出的是主菜单，pauseGame() 整个跳过（这条踩过，见 app.js startGame 的补检查）。
  check('开的是快速菜单（徽标「游戏中」）', open.badge === '游戏中', open.badge);
  check('状态栏提示已暂停', /暂停/.test(open.toast), open.toast);
  const paused = await rate();
  console.log(`  菜单打开: ${paused} 帧/900ms`);
  check('菜单打开后核心已停帧（游戏暂停）', isStopped(paused), `${paused}`);

  console.log('\n【子菜单里保持暂停】');
  // 快速菜单只有一栏，没有分类栏，焦点开局就在列表上（screen-ui.js 的 _initialFocus）
  const onSettings = await page.evaluate(() => window.__walkTo('设置'));
  check('光标移到「设置」', onSettings === true);
  await page.evaluate(() => window.__press('KeyX', 350));
  const inSub = await ui();
  check('已进入设置子菜单', inSub.title === '设置', inSub.title);
  const subPaused = await rate();
  console.log(`  设置子菜单: ${subPaused} 帧/900ms`);
  check('子菜单中仍然暂停', isStopped(subPaused), `${subPaused}`);

  console.log('\n【关闭菜单：恢复跑帧】');
  // 设置 -> 快速菜单 -> 关闭，两级各退一次
  await page.evaluate(() => window.__press('Escape', 300));
  await page.evaluate(() => window.__press('Escape', 300));
  const closed = await ui();
  check('菜单已关闭', closed.hidden === true, JSON.stringify(closed));
  const resumed = await rate();
  console.log(`  关闭菜单后: ${resumed} 帧/900ms`);
  check('关闭菜单后核心恢复跑帧', isRunning(resumed), `${resumed}`);
  check('状态栏提示继续游戏', /继续/.test(closed.toast), closed.toast);

  console.log('\n【反复开关不出错】');
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.__press('Escape', 120));
    await page.evaluate(() => window.__press('Escape', 120));
  }
  check('开关 4 次后菜单状态正确', (await ui()).hidden === true);
  const afterCycles = await rate();
  console.log(`  开关 4 次后: ${afterCycles} 帧/900ms`);
  check('开关 4 次后游戏仍能继续跑（无卡死）', isRunning(afterCycles), `${afterCycles}`);

  console.log('\n【游戏中按住 Start 开关菜单：不应卡键】');
  // 判据不看画面：标题画面对 Start 的响应不稳定（实测同一个操作有时变有时不变），
  // 用那个当断言会得到随机结果。这里只确认「按住 Start 反复开关菜单后帧率依然正常」，
  // 「暂停要把按键松开」这个不变量由 test-console-core.cjs 第 8 组直接测逻辑。
  const stuck = await page.evaluate(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    await window.__press('Escape', 250);
    await window.__press('Escape', 250);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return window.__frameDelta(900);
  });
  console.log(`  按住 Start 开关菜单后: ${stuck} 帧/900ms`);
  check('按住 Start 开关菜单后帧率正常（未卡死）', isRunning(stuck), `${stuck}`);

  console.log('\n【载入期间呼出菜单：游戏不能在菜单背后偷偷跑】');
  // 先退回主菜单，再按启动、立刻按 Esc —— 这时核心还没起来（loadROM 里才 start），
  // 暂停只能靠 startGame 完成后的那次补检查。
  await page.evaluate(() => window.__press('Escape', 250));
  const walked = await page.evaluate(() => window.__walkTo('退出到主菜单'));
  check('光标移到「退出到主菜单」', walked === true);
  await page.evaluate(() => window.__press('KeyX', 800));
  const home = await ui();
  check('已退回主菜单', home.hidden === false && home.badge === '', JSON.stringify(home));

  // selectGameRow 自己会把焦点从分类栏送进列表（看 data-focus）
  const found = await selectGameRow(page, 'Destiny');
  check('主菜单里又找到那款卡带', found === true);
  await page.evaluate(() => {
    const fire = (code) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    };
    fire('KeyX');   // 启动
    fire('Escape'); // 抢在载入完成前呼出菜单
  });
  await page.waitForFunction(() => window.__nesConsole.romLoaded === true, undefined, { timeout: 30000 });
  await page.waitForTimeout(600);
  const state = await ui();
  check('菜单还开着（没被启动流程关掉又或偷偷恢复）',
    state.hidden === false && state.badge === '', JSON.stringify(state));
  const duringLoad = await rate();
  console.log(`  载入完成后: ${duringLoad} 帧/900ms`);
  check('核心起来后立刻停帧（没在菜单背后跑）', isStopped(duringLoad), `${duringLoad}`);

  console.log('\n【错误】');
  check('无 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e); process.exit(1); });
