// 验证：退出到主菜单再进游戏后，音频出口是不是真被重建并且又在出声。
//
// 曾经的坑（jsnes 时代）：stop() 只断开处理节点、不关 AudioContext，
// 再进游戏时初始化看到上下文还活着就直接 return，处理节点永远是 null，
// 结果是「画面在跑、一点声音都没有」。换核心之后这条路径一样存在，所以照测。
//
// 每一步都**等条件成立**而不是等固定时间（启动要编译 800 KB wasm、慢机器上 2.5 秒不够），
// 理由见 lib-game-menu.cjs 与 doc/测试方案.md「环境前置与已知假失败」。
const { launch } = require('./lib-browser.cjs');
const { startGame } = require('./lib-game-menu.cjs');

const URL = 'http://localhost:7890/nes-console/';

/** 读浏览器里宿主当前的音频状态（宿主没建起来时返回 null） */
const audioState = (page) => page.evaluate(() => {
  const h = window.__nesConsole && window.__nesConsole.host;
  if (!h) return null;
  return {
    ctx: !!h.audioCtx,
    ctxState: h.audioCtx ? h.audioCtx.state : null,
    worklet: !!h.workletNode,
    running: h.running,
    written: h.audioStats.written,
    dropped: h.audioStats.dropped,
    frames: h.frames,
  };
});

/** 等到浏览器里的条件为真。超时不抛错 —— 让后面那条断言把「没等到」如实报出来。 */
async function waitFor(page, predicate, arg = null, timeout = 20000) {
  try {
    await page.waitForFunction(predicate, arg, { timeout });
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const browser = await launch();
  const page = await (await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })).newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__nesConsole, null, { timeout: 20000 });

  let pass = 0, fail = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name} ${detail}`); }
  };

  // 1) 进游戏：startGame 等到「菜单关了、核心真在出帧」，再等音频开口
  const started = await startGame(page, 'Destiny');
  check('基线：第一次能进游戏（Destiny）', started === true);
  await waitFor(page, () => {
    const h = window.__nesConsole.host;
    return !!h && !!h.audioCtx && !!h.workletNode && h.audioStats.written > 1000;
  });
  const s1 = await audioState(page);

  // 2) 退出到主菜单：等菜单回来、核心停下来，再读「关干净了没有」
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape', bubbles: true }));
  });
  await waitFor(page, () => !document.querySelector('.sys-ui').hidden);
  await page.evaluate(() => {
    for (const item of document.querySelectorAll('.sys-item')) {
      if (item.textContent.includes('退出到主菜单')) { item.click(); break; }
    }
  });
  await waitFor(page, () =>
    !document.querySelector('.sys-ui').hidden && !window.__nesConsole.host.running);
  const s2 = await audioState(page);

  // 3) 再进一次：同样等条件。注意 written 是 worklet 报回来的**最近一次快照**，
  //    上下文关掉时它不会清零，所以「written > 1000」这种绝对值可能被退出前的旧值满足。
  //    判断「又有声音了」只能看它在新一轮里有没有继续往上涨。
  const again = await startGame(page, 'Destiny');
  await waitFor(page, () => {
    const h = window.__nesConsole.host;
    return !!h && h.running && !!h.audioCtx && !!h.workletNode;
  });
  const s3 = await audioState(page);
  // 再跑 30 帧，看音频计数是否跟着涨
  await waitFor(page, (base) => window.__nesConsole.host.frames >= base + 30,
    (s3 && s3.frames) || 0);
  const s3b = await audioState(page);

  console.log('1. 游戏中:', JSON.stringify(s1));
  console.log('2. 退出后:', JSON.stringify(s2));
  console.log('3. 再进游戏:', JSON.stringify(s3), again ? '' : '（第二次没能进游戏，下面的红是这一条连带的）');
  console.log('4. 再进后又跑了 30 帧:', JSON.stringify(s3b));

  check('游戏中上下文和 worklet 都在', !!s1 && s1.ctx && s1.worklet);
  check('游戏中声音真的在往外送', !!s1 && s1.written > 1000, `written=${s1 && s1.written}`);
  check('退出后上下文已关闭', !!s2 && s2.ctx === false && s2.worklet === false);
  check('再进游戏后上下文重建', !!s3 && s3.ctx === true && s3.worklet === true);
  check('再进游戏后状态为 running', !!s3 && s3.ctxState === 'running' && s3.running,
    String(s3 && `${s3.ctxState}/${s3.running}`));
  check('再进游戏后声音继续在往外送',
    !!s3 && !!s3b && s3b.written > s3.written,
    `written ${s3 && s3.written} -> ${s3b && s3b.written}`);
  check('两次进游戏都没有溢出丢音',
    !!s1 && !!s3b && s1.dropped === 0 && s3b.dropped === 0);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('失败:', e); process.exit(1); });
