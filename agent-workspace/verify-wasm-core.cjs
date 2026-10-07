/**
 * wasm 核心 + 存档格式的产品级回归（跑真实界面，不跑探针页）。
 *
 * 回答四个问题：
 *  1. 核心在站点里能不能加载、jsnes 打不开的那几款 ROM 是不是真能跑起来。
 *     「跑起来」判的是颜色数 ≥2（NES 的黑本身就是 12,12,12，纯屏只有一种颜色）
 *     和跑帧数；两帧是否相同只打印不断言 —— 标题画面本来就可以一动不动。
 *  2. 音频走 AudioWorklet 之后是不是真的没断音、没溢出。
 *  3. 即时存档是不是合法的 RASTATE 容器（这是跟 RetroArch 桌面端互通的前提）。
 *  4. 电池存档（SRAM）能不能在退出游戏时落进 IndexedDB。
 *
 * 跑法：先 `npm run build && npx astro preview --port 7890`，
 *      再 `node agent-workspace/verify-wasm-core.cjs [ROM 名关键字]`
 */
const { launch } = require('./lib-browser.cjs');
const { selectGameRow } = require('./lib-game-menu.cjs');

const URL = 'http://localhost:7890/nes-console/';

/**
 * 兼容矩阵 = `public/rom/` 里现在有的卡带，一款一格：矩阵的职责是「核心能不能跑这块板卡」，
 * 所以只放镜像里真拿得到的款；各板卡的实测结论（帧数、SRAM、画面）记在
 * `agent-workspace/note-fceumm-wasm.md` 的探针表里，卡带下架了结论还在。
 *
 * expectSram = 核心上报的电池 RAM 字节数（探针实测值）。
 */
const CASES = [
  { name: '金庸群侠传', expectSram: 8192, note: 'mapper 163' },
  { name: '重装机兵', expectSram: 8192, note: 'mapper 74' },
  { name: '热血格斗', expectSram: 0, note: '对照：jsnes 本来也能跑' },
];

const HELPERS = () => {
  window.__shot = () => {
    const c = document.getElementById('nes-canvas');
    return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);
  };
  /**
   * 画面摘要：颜色数 + 一个像素指纹。
   * 在页面里算完只回两个数，别把 245,760 个字节来回传（一次采样就够慢了，
   * 而「连采几次」这件事本来就是为了躲开开机纯色）。
   * 整屏都要读到，但每 4 个像素取 1：热血格斗开机那屏是白底 + 中间一行黑字，
   * 只读左上 1/4 会看见一片白，颜色数=1，判成「没画面」（实测踩过）。
   */
  window.__ink = () => {
    const c = document.getElementById('nes-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const colors = new Set();
    let sig = 0;
    for (let i = 0; i < d.length; i += 16) {   // 每 4 像素采 1，判「有没有画面」够用
      colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      sig = (sig * 31 + d[i] + d[i + 1] + d[i + 2]) >>> 0;
      if (colors.size > 4096) break;   // 超过这个数就够说明「有画面」了，不再细数
    }
    return { colors: colors.size, sig };
  };
  window.__stats = () => {
    const h = window.__nesConsole.host;
    return {
      frames: h.frames,
      fps: h.avInfo.fps,
      coreRate: h.avInfo.sampleRate,
      ctxRate: h.audioCtx ? h.audioCtx.sampleRate : null,
      audioSent: h.audioSent,
      depth: h.audioStats.depth,
      underrun: h.audioStats.underrun,
      dropped: h.audioStats.dropped,
      written: h.audioStats.written,
      speed: h._speed,
    };
  };
  /**
   * 即时存档：查 RASTATE 容器结构 + 存→读→再跑一帧的画面是否一致。
   * 往返要在暂停下做，两边都「之后再精确跑一帧」，比较的才是同一个状态往后一帧；
   * 运行中比较没有意义（闪烁光标本身就会让两次不同）。
   */
  window.__checkState = () => {
    const c = window.__nesConsole;
    const press = (a, b) => {
      const x = new DataView(a.buffer, a.byteOffset);
      return x.getUint32(b, true);
    };
    c.pause();
    const state = c.getState();
    const header = Array.from(state.subarray(0, 8));
    const blockId = String.fromCharCode(...state.subarray(8, 12));
    const memLen = press(state, 12);
    // 容器总长 = 头 8 + 块头 8 + 载荷（8 字节对齐）+ END 块头 8
    const expectTotal = 8 + 8 + Math.ceil(memLen / 8) * 8 + 8;
    c.host.step(1);
    const a = window.__shot();
    c.loadState(state);
    c.host.step(1);
    const b = window.__shot();
    let identical = a.length === b.length;
    for (let i = 0; identical && i < a.length; i++) if (a[i] !== b[i]) identical = false;
    return { bytes: state.length, header, blockId, memLen, expectTotal, identical };
  };
  window.__sram = () => {
    const s = window.__nesConsole.saveRam();
    return s ? { bytes: s.length, nonZero: s.some((v) => v !== 0) } : null;
  };
  /**
   * 列出库里的电池存档记录。每个用例都开全新的浏览器上下文（IndexedDB 是干净的），
   * 所以这里出现的记录一定来自本款游戏 —— 不必为了测试再去界面上暴露当前 ROM 哈希。
   */
  window.__listSRAM = () => new Promise((resolve, reject) => {
    const req = indexedDB.open('nes-console', 3);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sram')) { resolve(null); return; }
      const all = db.transaction('sram', 'readonly').objectStore('sram').getAll();
      all.onsuccess = () => resolve(all.result.map((e) => ({ romHash: e.romHash, bytes: e.data.length })));
      all.onerror = () => reject(all.error);
    };
  });
};

async function runCase(browser, c) {
  const page = await (await browser.newContext({ serviceWorkers: 'block' }))
    .newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const r = { ...c, ok: false, errors };

  try {
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__nesConsole, null, { timeout: 20000 });
    await page.evaluate(HELPERS);
    const found = await selectGameRow(page, c.name);
    // 卡带不在，是**内容**问题不是核心问题：标出来跳过，别把后面三款一起带走
    // （以前这里返回半个结果对象，汇总段读 r.sramStore.length 直接抛异常，整套没跑完）。
    if (!found) {
      r.missing = true;
      r.failAt = '清单里没有这款卡带（public/rom/ 缺文件）';
      return r;
    }

    await page.evaluate(async () => {
      const press = (code, ms) => new Promise((res) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
        setTimeout(res, ms);
      });
      await press('KeyX', 1500);   // A = 启动
    });
    // 核心首次实例化要编译 800 KB wasm，等到真跑出帧为止
    await page.waitForFunction(() => window.__nesConsole.host.frames > 30, null, { timeout: 30000 });
    await page.waitForTimeout(3000);

    r.loaded = await page.evaluate(() => window.__nesConsole.romLoaded);
    // 画面：既要有内容（NES 的「黑」本身就是 12,12,12，只有一种颜色就是纯黑屏），
    // 也要在动（帧与帧不一样）。单取一帧不行：重装机兵开机头几秒是一整屏纯色
    // （淡入、厂商标志的底），那一帧颜色数就是 1，会把已经跑起来的游戏误判成失败。
    // 所以连采 6 次（约 6 秒），颜色数取最大值，指纹有无变化作为「在动」的参考。
    const shots = [];
    for (let i = 0; i < 6; i++) {
      shots.push(await page.evaluate(() => window.__ink()));
      await page.waitForTimeout(1000);
    }
    r.ink = shots.reduce((a, b) => (b.colors > a.colors ? b : a));
    r.moving = shots.some((s) => s.sig !== shots[0].sig);
    r.stats = await page.evaluate(() => window.__stats());
    r.state = await page.evaluate(() => window.__checkState());
    r.sram = await page.evaluate(() => window.__sram());

    await page.evaluate(async () => {
      const press = (code, ms) => new Promise((res) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
        setTimeout(res, ms);
      });
      await press('Escape', 250);                       // 呼出快速菜单
      for (let i = 0; i < 10; i++) {
        const sel = document.querySelector('.sys-item.selected .sys-item-label')?.textContent;
        if (sel === '退出到主菜单') break;
        await press('ArrowDown', 60);
      }
      await press('KeyX', 800);                         // 退出 = 触发电池存档落盘
    });
    r.sramStore = await page.evaluate(() => window.__listSRAM());

    r.ok = !!r.loaded
      && r.ink.colors >= 2
      && r.stats.frames > 60
      && r.stats.written > 1000 && r.stats.dropped === 0 && r.stats.underrun < 4096
      && r.state.header.join(',') === '82,65,83,84,65,84,69,1'   // "RASTATE" + 版本 1
      && r.state.blockId === 'MEM '
      && r.state.bytes === r.state.expectTotal
      && r.state.identical
      && (c.expectSram === 0
        // 没电池 RAM 的游戏：核心上报 size = 0，saveRam() 就是 null，库里也不该有记录
        ? !r.sram && (!r.sramStore || r.sramStore.length === 0)
        : !!r.sram && r.sram.bytes === c.expectSram
          && !!r.sramStore && r.sramStore.some((e) => e.bytes === c.expectSram));
  } catch (e) {
    r.failAt = e.message;
  } finally {
    await page.context().close();
  }
  return r;
}

(async () => {
  const filter = process.argv[2];
  const cases = filter ? CASES.filter((c) => c.name.includes(filter)) : CASES;
  const browser = await launch();
  let fail = 0;
  for (const c of cases) {
    const r = await runCase(browser, c);
    if (r.missing) {
      console.log(`\n❌ ${r.name}（${r.note}） — ${r.failAt}`);
      fail++;
      continue;
    }
    const s = r.stats || {};
    console.log(`\n${r.ok ? '✅' : '❌'} ${r.name}（${r.note}）${r.failAt ? ' — ' + r.failAt : ''}`);
    console.log(`   画面 ${r.ink ? `${r.ink.colors} 色${r.moving ? '，且在动' : '（这两帧相同：标题画面本来就静止，只作参考）'}` : '—'}`
      + ` · 跑帧 ${s.frames} · 上报 ${s.fps ? s.fps.toFixed(3) : '?'} fps / ${s.coreRate || '?'} Hz（设备率 ${s.ctxRate || '?'}）`);
    console.log(`   音频 已消费 ${s.written || 0} 帧 · 队列深度 ${s.depth || 0} · 断音 ${s.underrun || 0} · 溢出 ${s.dropped || 0} · 速度修正 ${s.speed ? s.speed.toFixed(4) : '?'}`);
    if (r.state) {
      console.log(`   即时存档 ${r.state.bytes} B · 块 ${r.state.blockId} 载荷 ${r.state.memLen} B（容器算得 ${r.state.expectTotal}）· 往返一致 ${r.state.identical ? 'Y' : 'N'}`);
    }
    console.log(`   电池存档 核心 ${r.sram ? `${r.sram.bytes} B（含非零字节 ${r.sram.nonZero}）` : '无'}`
      + ` · 库里 ${r.sramStore === null ? '没有 sram 表' : r.sramStore.length ? r.sramStore.map((e) => `${e.romHash}=${e.bytes}B`).join(',') : '空'}`);
    if (r.errors.length) console.log(`   页面错误 ${r.errors.slice(0, 3).join(' | ')}`);
    if (!r.ok || r.errors.length) fail++;
  }
  await browser.close();
  console.log(fail ? `\n结果: ${fail}/${cases.length} 项有问题` : `\n结果: ${cases.length} 款全部通过`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('失败:', e); process.exit(1); });
