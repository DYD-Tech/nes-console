/**
 * 测试用的菜单导航 helper（多个验证脚本共用）。
 *
 * 为什么需要：内置游戏现在是「构建时扫 public/rom/ 得到的多款」，
 * 顺序跟着文件名走。测试不能再用「主菜单第一项就是那款游戏」这个假设 ——
 * 往目录里多丢一个文件，第一项就换了，甚至可能换成一款跑不起来的游戏。
 * 所以启动游戏前先按名字把光标移到目标行上。
 */

/**
 * 在主菜单的「游戏」列表里，把光标移到显示名包含 namePart 的那一行。
 * 前提：当前停在主菜单上（刚打开就是这个状态）。
 *
 * 主菜单打开时焦点在分类栏（游戏/游戏管理/…），列表还没拿到光标，
 * 所以先把焦点送进列表再找行 —— 按 → 就是「进列表」（见 screen-ui.js 的 handleAction）。
 *
 * @param {import('playwright').Page} page
 * @param {string} namePart  显示名的片段，例如 'Destiny'
 * @returns {Promise<boolean>} 有没有找到那一行
 */
async function selectGameRow(page, namePart) {
  return page.evaluate(async (part) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const press = async (code) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      await sleep(30);
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      await sleep(60);
    };
    // 焦点在分类栏 -> 按 → 进游戏列表；已经在列表上就不能再按（会把第一项启动了）
    if (document.querySelector('.sys-ui')?.dataset.focus === 'sidebar') await press('ArrowRight');
    // 30 步的上限：比任何合理的游戏数量都宽，又能保证移不动时早点失败，
    // 不会在「光标一直在原地」的情况下转无穷圈。
    for (let i = 0; i < 30; i++) {
      const label = document.querySelector('.sys-item.selected .sys-item-label')?.textContent || '';
      if (label.includes(part)) return true;
      await press('ArrowDown');
    }
    return false;
  }, namePart);
}

/**
 * 选中某款游戏并按 A 启动，**等到游戏真在跑**为止。
 *
 * 为什么不能「按下之后等固定 900ms」：核心首次实例化要编译 800 KB wasm，
 * 慢机器 / 连着跑一批脚本时这点时间不够，界面还停在菜单上。
 * 于是后面一串断言会连锁误报（「菜单没关」「没标记成游戏中」「半透明背景不对」…），
 * 看着像产品坏了，实际是测试没等到位 —— 单跑全绿、全量连跑变红就是这样查出来的。
 *
 * @param {import('playwright').Page} page
 * @param {string} namePart 游戏显示名片段
 * @param {string} [pressCode] 启动用的按键，默认 KeyX（A 键默认绑定）
 * @returns {Promise<boolean>} 有没有真的启动起来
 */
async function startGame(page, namePart, pressCode = 'KeyX') {
  if (!(await selectGameRow(page, namePart))) return false;
  // frames 是宿主对象上的累计值，退出到主菜单不会清零（宿主只有一个，见 nes/console.js）。
  // 所以「frames > 30」这种绝对门槛，在同一次页面会话里第二次进游戏时会立刻成立 ——
  // 哪怕核心还没重新跑起来。门槛必须是「比按下前又多跑了 30 帧」。
  const before = await page.evaluate(() => window.__nesConsole.host.frames);
  await page.evaluate((code) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
  }, pressCode);
  try {
    await page.waitForFunction(([base]) =>
      document.querySelector('.sys-ui').hidden && window.__nesConsole.host.frames >= base + 30,
    [before], { timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

module.exports = { selectGameRow, startGame };
