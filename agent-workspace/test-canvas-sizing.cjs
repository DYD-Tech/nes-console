// 实测：画面是否达到「视口内最大 4:3 矩形」，屏幕外的触摸手柄（默认摆位）是否不遮挡画面
const { launch } = require('./lib-browser.cjs');

(async () => {
  const browser = await launch();

  const sizes = [[1920, 950], [1920, 1080], [2560, 1310], [3840, 2030], [3440, 1400],
                 [1440, 900], [1366, 768], [1280, 720], [1600, 900], [1024, 768],
                 [768, 1024], [390, 844], [375, 667], [360, 640], [844, 390], [667, 375]];

  let pass = 0, fail = 0;
  console.log('视口         画面(实测)      理论最大       达成率  模式      手柄遮挡画面  问题');
  console.log('-'.repeat(90));

  for (const [vw, vh] of sizes) {
    // hasTouch：手柄的内部摆位写在 @media (pointer: coarse) 里，
    // 不模拟触摸设备，量到的就不是真机上那套位置。
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, hasTouch: true });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    // 手柄强制常显：屏幕外只剩它还在占位置，不强迫显示就测不到遮挡
    await p.addInitScript(([key, val]) => localStorage.setItem(key, val),
      ['nes-console.settings', JSON.stringify({ controls: { padMode: 'always' } })]);
    await p.goto('http://localhost:7890/nes-console/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(250);

    const r = await p.evaluate(() => {
      const scr = document.querySelector('.screen').getBoundingClientRect();
      const doc = document.documentElement;
      const tw = Math.min(innerWidth, innerHeight * 4 / 3);
      const th = tw * 3 / 4;
      // #touch-controls 是一条铺满视口宽度的透明轨道，量它的矩形等于量空气；
      // 真正看得见的是两块按键组（左手：十字键 + 系统键 / 右手：五键簇），逐组算遮挡再相加。
      const groups = Array.from(document.querySelectorAll(
        '#touch-controls .touch-dpad-group, #touch-controls .touch-actions',
      ));
      let overlapArea = 0;
      let shown = 0;
      let maxGroupW = 0;
      for (const g of groups) {
        const b = g.getBoundingClientRect();
        if (!b.width || !b.height) continue;
        shown++;
        maxGroupW = Math.max(maxGroupW, b.width);
        const w = Math.max(0, Math.min(scr.right, b.right) - Math.max(scr.left, b.left));
        const h = Math.max(0, Math.min(scr.bottom, b.bottom) - Math.max(scr.top, b.top));
        overlapArea += w * h;
      }
      return {
        scr: [+scr.width.toFixed(1), +scr.height.toFixed(1)],
        groups: shown,
        maxGroupW: +maxGroupW.toFixed(1),
        target: [+tw.toFixed(1), +th.toFixed(1)],
        vw: innerWidth, vh: innerHeight,
        overlapArea,
        screenArea: scr.width * scr.height,
        scrollW: doc.scrollWidth, clientW: doc.clientWidth,
        scrollH: doc.scrollHeight, clientH: doc.clientHeight,
      };
    });

    const attain = r.scr[0] / r.target[0];
    const ratioOk = Math.abs(r.scr[0] / r.scr[1] - 4 / 3) < 0.02;
    const attains = attain > 0.995;
    const overlapPct = r.overlapArea / r.screenArea * 100;
    const noScroll = r.scrollW <= r.clientW + 1 && r.scrollH <= r.clientH + 1;
    const aspect = r.vw / r.vh;
    // 模式判定：余量在左右 / 在下方 / 余量放不下手柄 / 余量为零只能叠加
    // 两种「数学上不存在不遮挡的摆法」不算失败：
    //   画面正好占满视口（如 1024x768）—— 根本没有余量；
    //   横屏但两侧余量比一块按键组还窄（如 667x375：单侧 83px，组宽 132px）。
    // 手柄这时必然压到画面边缘，用户可以在「控制管理」里隐藏或重新摆放。
    const freeH = r.vh - r.target[1];
    const freeSide = (r.vw - r.target[0]) / 2 - 16; // 减去 #touch-controls 的 1rem 内边距
    const sideMode = aspect > 8 / 5;
    const tooNarrow = sideMode && freeSide < r.maxGroupW;
    const mode = sideMode ? (tooNarrow ? '左右余量不足' : '左右余量')
      : (freeH > 40 ? '下方余量' : '叠加(无余量)');
    const overlayByDesign = mode === '叠加(无余量)' || tooNarrow;
    const noOverlap = overlayByDesign || (overlapPct < 1 && r.groups === 2);
    const ok = ratioOk && attains && noOverlap && noScroll && errs.length === 0;
    if (ok) pass++; else fail++;

    console.log(
      `${String(vw + 'x' + vh).padEnd(12)} ${(r.scr[0] + 'x' + r.scr[1]).padEnd(15)} ` +
      `${(r.target[0] + 'x' + r.target[1]).padEnd(15)} ` +
      `${(attain * 100).toFixed(0).padStart(5)}%  ${mode.padEnd(11)} ` +
      `${(overlayByDesign ? '(设计如此)' : (overlapPct.toFixed(0) + '%')).padStart(9)}  ` +
      `${!ratioOk ? '比例错 ' : ''}${!attains ? '未达最大 ' : ''}${!noOverlap ? '遮挡 ' : ''}${!noScroll ? '溢出滚动 ' : ''}${errs[0] ? errs[0].slice(0, 20) : ''}`
    );
    await p.close();
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})();
