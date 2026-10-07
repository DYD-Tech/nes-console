/**
 * 音频漂移诊断（产品页版，对标原型时代的 audio-drift.cjs）：
 * 每秒打印「出帧数 / 送出样本 / 断音帧 / 队列深度」，看的是曲线斜率而不是单点，
 * 用来回答「这声音是稳态延迟还是一路往上涨/抽空」。不做判分，所以不进回归汇总。
 *
 * 起因：verify-wasm-core 报 金庸群侠传（50.007 fps）断音 2.4 万帧，
 * 查下来是无头窗口被遮挡限流把跑帧抽走了（见 lib-browser.cjs），不是产品问题。
 *
 * 跑法：站点起在 7890，然后
 *      node agent-workspace/check-audio-drift.cjs [ROM 名关键字] [秒数]
 */
const { launch } = require('./lib-browser.cjs');
const { selectGameRow } = require('./lib-game-menu.cjs');

const URL = 'http://localhost:7890/nes-console/';
const NAME = process.argv[2] || '金庸群侠传';
const SECONDS = Number(process.argv[3]) || 20;

(async () => {
  const browser = await launch();

  const page = await (await browser.newContext({ serviceWorkers: 'block' }))
    .newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__nesConsole, null, { timeout: 20000 });
  if (!(await selectGameRow(page, NAME))) { console.log('列表里找不到这款'); process.exit(1); }
  await page.evaluate(async () => {
    const press = (code, ms) => new Promise((r) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      setTimeout(r, ms);
    });
    await press('KeyX', 2000);
  });
  await page.waitForFunction(() => window.__nesConsole.host.frames > 30, null, { timeout: 30000 });

  const stats = () => page.evaluate(() => {
    const h = window.__nesConsole.host;
    return {
      frames: h.frames, t: performance.now(),
      depth: h.audioStats.depth, written: h.audioStats.written,
      underrun: h.audioStats.underrun, dropped: h.audioStats.dropped, speed: h._speed,
      fps: h.avInfo.fps, rate: h.avInfo.sampleRate, ctx: h.audioCtx && h.audioCtx.sampleRate,
      ctxTime: h.audioCtx ? h.audioCtx.currentTime : 0,
    };
  });
  const s0 = await stats();
  console.log(`核心报 ${s0.fps} fps / ${s0.rate} Hz，设备 ${s0.ctx} Hz`);
  const rows = [];
  for (let i = 0; i < SECONDS; i++) {
    await page.waitForTimeout(1000);
    rows.push(await stats());
  }
  const dF = rows.slice(1).map((s, i) => s.frames - rows[i].frames);
  const dU = rows.slice(1).map((s, i) => s.underrun - rows[i].underrun);
  const dW = rows.slice(1).map((s, i) => s.written - rows[i].written);
  const dCt = rows.slice(1).map((s, i) => (s.ctxTime - rows[i].ctxTime) * 1000);
  console.log(`每秒出帧   ${dF.join(' ')}`);
  console.log(`每秒送样本 ${dW.join(' ')}`);
  console.log(`每秒断音   ${dU.join(' ')}`);
  console.log(`每秒音频时钟推进(ms) ${dCt.map((v) => v.toFixed(0)).join(' ')}`);
  console.log(`深度 ${rows.map((s) => s.depth).join(' ')} · 速度修正 ${rows.map((s) => s.speed.toFixed(4)).join(' ')}`);
  const last = rows[rows.length - 1];
  console.log(`累计：跑帧 ${last.frames}（${(last.frames / ((last.t - s0.t) / 1000)).toFixed(1)} 帧/秒）` +
    ` 断音 ${last.underrun} 帧 = ${(last.underrun / 48).toFixed(0)} ms · 溢出 ${last.dropped}`);
  await browser.close();
})();
