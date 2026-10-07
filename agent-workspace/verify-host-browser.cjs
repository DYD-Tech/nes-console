/**
 * 浏览器端宿主原型验证（一次性检查，不进产品回归清单）。
 *
 * 回答四个问题：核心能不能在浏览器里实例化、画面是不是真在动、音频是不是真在出、
 * 存档/电池存档能不能取回并写回。接口用 probe/fceumm-host.html 暴露的 window.__host。
 *
 * 跑法：node agent-workspace/verify-host-browser.cjs [ROM 名关键字]
 * 截图与状态写到 agent-workspace/probe/out/host-*
 */
const fs = require('fs');
const path = require('path');
const { launch } = require('./lib-browser.cjs');
const { startHostProbeServer, PROBE_DIR } = require('./host-probe-server.cjs');

const OUT_DIR = path.join(PROBE_DIR, 'out');
const PORT = 7892;
const BASE = `http://localhost:${PORT}`;

const CASES = [
  // 兼容矩阵 = `public/rom/` 里现在有的三款。各板卡的实测结论（含跑不到的款）记在
  // agent-workspace/note-fceumm-wasm.md，别往矩阵里加镜像里没有的款。
  { file: '金庸群侠传.nes', expectSram: 8192, note: 'mapper 163，jsnes 打不开' },
  { file: '重装机兵.nes', expectSram: 8192, note: 'mapper 74，jsnes 打不开' },
  { file: '热血格斗.nes', expectSram: 0, note: '对照：jsnes 本来能跑' },
];

/** RGBA 原始字节 → 颜色数与非黑像素，用来区分「有画面」和「一整块纯色」 */
function analyze(rgba) {
  const colors = new Set();
  let nonBlack = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] > 8 || rgba[i + 1] > 8 || rgba[i + 2] > 8) nonBlack++;
    colors.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
    if (colors.size > 4096) break;
  }
  return { px: rgba.length / 4, colors: colors.size, nonBlack };
}

async function runCase(browser, file) {
  const page = await browser.newPage({ viewport: { width: 600, height: 700 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const r = { file, ok: false, stats: null, moving: false, inputWorks: false,
    stateSize: 0, stateReload: false, sram: -1, errors };

  try {
    await page.goto(`${BASE}/probe/fceumm-host.html?rom=${encodeURIComponent(BASE + '/rom/' + file)}`,
      { timeout: 60000 });
    await page.waitForFunction(() => window.__host && (window.__host.ready || window.__host.error),
      null, { timeout: 60000 });
    r.bootError = await page.evaluate(() => window.__host.error);
    if (r.bootError) return r;
    r.ok = true;

    await page.waitForTimeout(3000);
    r.stats = await page.evaluate(() => window.__host.stats());
    const a = await page.evaluate(() => window.__host.shot());
    r.frame = analyze(a);

    const before = await page.evaluate(() => window.__host.shot());
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => window.__host.shot());
    r.moving = !Buffer.from(before).equals(Buffer.from(after));

    // 按键：按住 A 半秒看画面是否变化。标题画面本来就静止的游戏测不出差别，
    // 这一项只作参考，判定不看它。
    await page.evaluate(() => window.__host.press(window.BUTTON.A));
    await page.waitForTimeout(500);
    await page.evaluate(() => window.__host.release(window.BUTTON.A));
    await page.waitForTimeout(500);
    const pressed = await page.evaluate(() => window.__host.shot());
    r.inputWorks = !Buffer.from(after).equals(Buffer.from(pressed));

    // 存档往返要在暂停下做，并且两边都「存/读后再精确跑一帧」，这样比较的是同一个
    // 状态往后一帧的画面；运行中比较没有意义（闪烁光标本身就会让两次不同）。
    await page.evaluate(() => window.__host.pause());
    await page.waitForTimeout(150);
    const state = await page.evaluate(() => window.__host.saveState());
    r.stateSize = state ? state.length : 0;
    await page.evaluate(() => window.__host.step(1));
    const atSave = await page.evaluate(() => window.__host.shot());
    await page.evaluate(() => window.__host.resume());
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.__host.pause());
    r.stateReload = await page.evaluate((s) => window.__host.loadState(s), state);
    await page.evaluate(() => window.__host.step(1));
    const restored = await page.evaluate(() => window.__host.shot());
    r.stateMatches = Buffer.from(atSave).equals(Buffer.from(restored));
    await page.evaluate(() => window.__host.resume());

    r.sram = await page.evaluate(() => window.__host.sram());

    // 暂停/恢复：暂停期间帧号不再增长
    const f0 = (await page.evaluate(() => window.__host.stats())).frames;
    await page.evaluate(() => window.__host.pause());
    await page.waitForTimeout(400);
    const f1 = (await page.evaluate(() => window.__host.stats())).frames;
    await page.evaluate(() => window.__host.resume());
    await page.waitForTimeout(400);
    const f2 = (await page.evaluate(() => window.__host.stats())).frames;
    r.pauseHolds = f1 - f0 <= 2 && f2 - f1 > 5;

    await page.screenshot({ path: path.join(OUT_DIR, `host-${file.replace(/\.nes$/i, '')}-page.png`) });
  } catch (e) {
    errors.push(String(e.message).split('\n')[0]);
  }
  await page.close();
  return r;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const only = process.argv[2];
  const { server } = await startHostProbeServer(PORT);
  const browser = await launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const results = [];
  for (const c of CASES.filter((c) => !only || c.file.includes(only))) {
    console.log(`>>> ${c.file}`);
    const r = await runCase(browser, c.file);
    results.push({ ...c, ...r });
    const s = r.stats || {};
    console.log(`  启动 ${r.ok ? 'OK' : '失败: ' + (r.bootError || r.errors.join(' / '))}` +
      ` | 帧 ${s.frames ?? '-'}（核心报 ${s.fps ?? '-'} fps，上下文 ${s.ctxRate ?? '-'} Hz / 核心 ${s.coreRate ?? '-'} Hz，` +
      `送出 ${s.audioSent ?? '-'} 帧、worklet 队列 ${s.audioDepth ?? '-'} 帧、` +
      `欠载 ${s.audioUnderrun ?? '-'} 帧、丢弃 ${s.audioDropped ?? '-'} 帧）`);
    if (r.frame) console.log(`  画面 ${r.frame.px} 像素，颜色 ${r.frame.colors}，非黑 ${r.frame.nonBlack}` +
      ` | 在动 ${r.moving ? '是' : '否'} | 按键有反应 ${r.inputWorks ? '是' : '否'} | 暂停/恢复 ${r.pauseHolds ? 'OK' : '异常'}`);
    console.log(`  存档 ${r.stateSize} B 读回 ${r.stateReload ? 'OK' : '失败'} 画面一致 ${r.stateMatches ? '是' : '否'}` +
      ` | SRAM ${r.sram} B（预期 ${c.expectSram}）` + (r.errors.length ? ` | 报错 ${r.errors.join(' / ')}` : ''));
  }
  await browser.close();
  server.close();
  fs.writeFileSync(path.join(OUT_DIR, 'host-summary.json'), JSON.stringify(results, null, 2));
  console.log(`\n明细与截图在 ${OUT_DIR}`);
  // 音频判据（worklet 侧回报，见 src/lib/nes/audio-processor.js）：
  //  - sent：核心确实在吐样本，且主线程真的发了出去；
  //  - dropped：环装满过 —— 说明产出快于消费，延迟会一路涨，一次都不该有；
  //  - underrun：环被取干过（补了静音）。开局和每次恢复后都会有一次约一帧
  //    （1536 帧 = 32 ms）的预填充空窗，容忍到 4096 帧，再多就是不稳。
  const bad = results.filter((r) => !r.ok || !r.stateSize || !r.stateReload || !r.stateMatches
    || !r.pauseHolds || r.sram !== r.expectSram
    || (r.stats && (r.stats.audioSent < 1000 || r.stats.audioDropped > 0 || r.stats.audioUnderrun > 4096)));
  console.log(bad.length ? `未通过：${bad.map((b) => b.file).join('、')}` : '全部通过');
})();
