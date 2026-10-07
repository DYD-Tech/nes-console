/**
 * 复现「手机上启动失败：Cannot read properties of undefined」。
 *
 * 手机不是通过 localhost 访问，而是 http://192.168.0.82:7890 —— 局域网 IP + http
 * 属于**非安全上下文**，浏览器会把一批 API 藏掉（AudioWorklet 首当其冲）。
 * 这条脚本用同一个 LAN 地址打开站点、启动游戏，把完整错误和堆栈打出来。
 *
 * 跑法：node agent-workspace/repro-insecure-context.cjs [LAN 地址]
 */
const { launch } = require('./lib-browser.cjs');
const { startGame } = require('./lib-game-menu.cjs');

const BASE = process.argv[2] || 'http://192.168.0.82:7890';
const URL = `${BASE}/nes-console/`;

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message, '\n', e.stack));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text()); });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  console.log('地址', URL);
  console.log('环境', JSON.stringify(await page.evaluate(() => ({
    isSecureContext: window.isSecureContext,
    hasAudioWorklet: !!(window.AudioContext && new AudioContext().audioWorklet),
    hasRandomUUID: typeof crypto?.randomUUID === 'function',
  }))));

  const started = await startGame(page, 'Destiny');
  console.log('启动成功=', started);
  console.log('系统提示=', JSON.stringify(await page.evaluate(
    () => Array.from(document.querySelectorAll('.sys-toast, .toast, [class*=toast]')).map((el) => ({
      cls: el.className, text: el.textContent, hidden: el.hidden,
      scrollW: el.scrollWidth, clientW: el.clientWidth,
      overflow: getComputedStyle(el).overflow, wrap: getComputedStyle(el).whiteSpace,
    })),
  )));
  await page.screenshot({ path: 'agent-workspace/out/repro-insecure.png' });
  await browser.close();
})().catch((e) => { console.error('脚本失败:', e); process.exit(1); });
