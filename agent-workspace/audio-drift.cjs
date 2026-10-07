/**
 * 音频积压漂移测量：三国在 verify-host-browser 里报积压 12683 帧（约 264 ms），
 * 其它三款只有 1600~2100。要判断这是稳态延迟还是一路往上涨（涨到 ringFrames 就会
 * 被溢出策略丢掉一段，听感上就是周期性咔哒）。
 *
 * 决定宿主的音频出口用 ScriptProcessorNode（当前原型）还是 AudioWorkletNode，
 * 看的是这条曲线斜率，不是单点数值。
 *
 * 跑法：node agent-workspace/audio-drift.cjs [秒数]
 */
const { launch } = require('./lib-browser.cjs');
const { startHostProbeServer } = require('./host-probe-server.cjs');

const PORT = 7893;
const ROMS = ['热血格斗.nes'];
const SECONDS = Number(process.argv[2]) || 20;

(async () => {
  const { server, base } = await startHostProbeServer(PORT);
  const browser = await launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const file of ROMS) {
    const page = await browser.newPage({ viewport: { width: 600, height: 700 } });
    await page.goto(`${base}/probe/fceumm-host.html?rom=${encodeURIComponent(base + '/rom/' + file)}`,
      { timeout: 60000 });
    await page.waitForFunction(() => window.__host && (window.__host.ready || window.__host.error),
      null, { timeout: 60000 });
    const samples = [];
    for (let i = 0; i < SECONDS; i++) {
      await page.waitForTimeout(1000);
      samples.push(await page.evaluate(() => {
        const s = window.__host.stats();
        return { depth: s.audioDepth, sent: s.audioSent, underrun: s.audioUnderrun,
          dropped: s.audioDropped, speed: s.speed, frames: s.frames };
      }));
    }
    await page.close();
    const depths = samples.map((s) => s.depth);
    const dFrames = samples.slice(1).map((s, i) => s.frames - samples[i].frames);
    const dSent = samples.slice(1).map((s, i) => s.sent - samples[i].sent);
    console.log(`\n· ${file}`);
    console.log(`  worklet 队列深度 ${depths.join(' ')} 帧（容量 8192 帧 = 170 ms）`);
    console.log(`  每秒送出 ${dSent.join(' ')} 帧 | 每秒出帧 ${dFrames.join(' ')}`);
    const last = samples[samples.length - 1];
    console.log(`  累计：欠载补静音 ${last.underrun} 帧（${(last.underrun / 48).toFixed(0)} ms）` +
      ` | 溢出丢弃 ${last.dropped} 帧 | 送出 ${last.sent} 帧 | 跑帧速度修正 ${last.speed.toFixed(4)}`);
    const half = Math.floor(depths.length / 2);
    const avg = depths.slice(half).reduce((a, b) => a + b, 0) / (depths.length - half);
    console.log(`  后半段：平均深度 ${avg.toFixed(0)} 帧（${(avg / 48).toFixed(0)} ms 延迟）` +
      ` | 区间 ${Math.min(...depths.slice(half))}~${Math.max(...depths.slice(half))} 帧` +
      ` | 平均出帧 ${(dFrames.slice(half).reduce((a, b) => a + b, 0) / (dFrames.length - half)).toFixed(1)} 帧/秒`);
  }
  await browser.close();
  server.close();
})();
