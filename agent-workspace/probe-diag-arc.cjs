/**
 * 一次性量具：四段斜向弧键到底对不对。
 * 量三件事：弧在不在十字的外切圆上（半径 = 拨片尖头半径）、弧端和拨片之间有没有
 * 留空隙、elementFromPoint 命不命中那条透明命中带；再按三种位置看给不给方向。
 * 用法：node agent-workspace/probe-diag-arc.cjs
 */
const { launch } = require('./lib-browser.cjs');

const URL = 'http://localhost:7890/nes-console/';
const SETTINGS_KEY = 'nes-console.settings';

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 }, hasTouch: true, deviceScaleFactor: 4,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v),
    [SETTINGS_KEY, JSON.stringify({ controls: { padMode: 'always' } })]);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  const geo = await page.evaluate(() => {
    const pad = document.querySelector('.touch-dpad').getBoundingClientRect();
    const cx = pad.x + pad.width / 2;
    const cy = pad.y + pad.height / 2;
    const rOf = (p) => Math.hypot(p.x - cx, p.y - cy);

    /** 沿 use 引用的那条 path 采样 41 个点，换算到屏幕坐标（含 use 上的 rotate） */
    const samples = (sel) => {
      const use = document.querySelector(sel);
      const src = document.getElementById(use.getAttribute('href').slice(1));
      const ctm = use.getScreenCTM();
      const n = 40;
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const p = src.getPointAtLength((src.getTotalLength() * i) / n);
        const q = new DOMPoint(p.x, p.y).matrixTransform(ctm);
        pts.push({ x: q.x, y: q.y });
      }
      return pts;
    };
    /** 点到一条采样折线的最近距离 */
    const distToPolyline = (p, line) => {
      let best = Infinity;
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i], b = line[i + 1];
        const vx = b.x - a.x, vy = b.y - a.y;
        const L = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / L));
        best = Math.min(best, Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy)));
      }
      return best;
    };

    const bladeSels = ['-up', '-right', '-down', '-left']
      .map((s) => `svg.touch-dpad-face use.dpad-blade${s}`);
    const blades = bladeSels.map(samples);
    // 拨片最外缘（尖头那条扁弧的中点）到中心的距离 = 十字的外接半径
    const bladeOuterR = Math.max(...blades.flat().map(rOf));

    const arcs = ['-up-right', '-right-down', '-down-left', '-left-up'].map((s) => {
      const face = samples(`svg.touch-dpad-face .dpad-diag${s} .dpad-diag-face`);
      const radii = face.map(rOf);
      let len = 0;
      for (let i = 1; i < face.length; i++) len += Math.hypot(face[i].x - face[i - 1].x, face[i].y - face[i - 1].y);
      const mid = face[Math.floor(face.length / 2)];
      return {
        action: document.querySelector(`.dpad-diag${s}`).dataset.action,
        rMin: Math.min(...radii), rMax: Math.max(...radii),
        arcLen: len,
        gap: Math.min(...face.map((p) => Math.min(...blades.map((b) => distToPolyline(p, b))))),
        midR: rOf(mid),
        midAngle: (Math.atan2(mid.y - cy, mid.x - cx) * 180) / Math.PI,
      };
    });

    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    // 沿对角线扫一串半径，看 elementFromPoint 分别命中谁（判定靠它，命中带粗细就由这组数说了算）
    const scan = (radius) => {
      const a = (-45 * Math.PI) / 180;
      const el = document.elementFromPoint(cx + radius * Math.cos(a), cy + radius * Math.sin(a));
      return el ? (el.getAttribute('class') || el.tagName) : null;
    };
    const outer = Math.max(pad.width / 2, bladeOuterR);

    return {
      pad: { x: pad.x, y: pad.y, w: pad.width, cx, cy },
      bladeOuterR,
      arcs,
      faceStroke: cs('.dpad-diag-face').strokeWidth,
      hitStroke: cs('.dpad-diag-hit').strokeWidth,
      hitPE: cs('.dpad-diag-hit').pointerEvents,
      facePE: cs('.dpad-diag-face').pointerEvents,
      svgPE: cs('svg.touch-dpad-face').pointerEvents,
      // 扫描点按格子宽的比例给（括号里是小档实测的那几个 px）：写死 px，换档位就扫到别处去了
      scan: [0.303, 0.424, 0.455, 0.489, 0.53, 0.553, 0.606, 0.697]
        .map((f) => ({ r: +(f * pad.width).toFixed(1), hit: scan(f * pad.width) })),
      outerHitR: outer,
      diagGroups: document.querySelectorAll('.dpad-diag').length,
      uses: document.querySelectorAll('svg.touch-dpad-face > use').length,
      actions: Array.from(document.querySelectorAll('#touch-controls [data-action]')).map((e) => e.dataset.action),
    };
  });

  const print = (k, v) => console.log(`  ${k}: ${v}`);
  console.log('\n【1. 几何】');
  print('十字格子边长(px)', geo.pad.w.toFixed(2));
  print('拨片最外缘半径(px)', geo.bladeOuterR.toFixed(2));
  print('弧半径范围(px)', geo.arcs.map((a) => `${a.rMin.toFixed(2)}~${a.rMax.toFixed(2)}`).join(' / '));
  print('弧可见长度(px)', geo.arcs.map((a) => a.arcLen.toFixed(1)).join(' / '));
  print('弧端到拨片最近距离(px)', geo.arcs.map((a) => a.gap.toFixed(1)).join(' / '));
  print('弧中点角度(°)', geo.arcs.map((a) => a.midAngle.toFixed(1)).join(' / '));
  print('可见描边/命中描边(px)', `${geo.faceStroke} / ${geo.hitStroke}`);
  print('pointer-events face/hit/svg', `${geo.facePE} / ${geo.hitPE} / ${geo.svgPE}`);
  print('弧键组数 / face 里 use 数', `${geo.diagGroups} / ${geo.uses}`);
  print('data-action 总数', `${geo.actions.length} 个：${geo.actions.join(' | ')}`);
  console.log('  沿对角线扫半径的 elementFromPoint：');
  for (const s of geo.scan) print(`    r=${s.r}`, s.hit);

  const active = () => page.evaluate(() => document.querySelector('.touch-dpad').dataset.active || '');
  const pressPolar = async (deg, r) => {
    const a = (deg * Math.PI) / 180;
    await page.mouse.move(geo.pad.cx + r * Math.cos(a), geo.pad.cy + r * Math.sin(a));
    await page.mouse.down();
    await page.waitForTimeout(70);
    const got = await active();
    await page.mouse.up();
    await page.waitForTimeout(70);
    return got;
  };

  console.log('\n【2. 判定】');
  // 弧的半径取实测中点，空白点按格子宽的比例给（同上一节）
  const ARC_R = (geo.arcs[0].rMin + geo.arcs[0].rMax) / 2;
  for (const deg of [-45, 45, 135, -135]) {
    print(`按弧 ${deg}° r=${ARC_R.toFixed(1)}`, `"${await pressPolar(deg, ARC_R)}"`);
  }
  for (const deg of [-45, 45]) {
    print(`斜角空白（弧内侧）${deg}° r=${(geo.pad.w * 0.303).toFixed(1)}`, `"${await pressPolar(deg, geo.pad.w * 0.303)}"`);
    print(`斜角空白（弧外侧）${deg}° r=${(geo.pad.w * 0.697).toFixed(1)}`, `"${await pressPolar(deg, geo.pad.w * 0.697)}"`);
  }
  print(`正上 r=${ARC_R.toFixed(1)}`, `"${await pressPolar(-90, ARC_R)}"`);
  print(`偏上 15° r=${ARC_R.toFixed(1)}（扇区内）`, `"${await pressPolar(-75, ARC_R)}"`);
  print(`偏上 23° r=${ARC_R.toFixed(1)}（出扇区、不在弧上）`, `"${await pressPolar(-67, ARC_R)}"`);

  console.log('\n【3. 截图】agent-workspace/probe/diag-*.png');
  const clip = {
    x: geo.pad.cx - geo.pad.w / 2 - 14, y: geo.pad.cy - geo.pad.w / 2 - 14,
    width: geo.pad.w + 28, height: geo.pad.w + 28,
  };
  await page.screenshot({ path: 'agent-workspace/probe/diag-idle.png', clip });
  const a = (-45 * Math.PI) / 180;
  await page.mouse.move(geo.pad.cx + ARC_R * Math.cos(a), geo.pad.cy + ARC_R * Math.sin(a));
  await page.mouse.down();
  await page.waitForTimeout(160);
  await page.screenshot({ path: 'agent-workspace/probe/diag-press.png', clip });
  await page.mouse.up();
  await page.screenshot({ path: 'agent-workspace/probe/diag-full.png', clip });
  const box = await page.evaluate(() => {
    const r = document.querySelector('#touch-controls').getBoundingClientRect();
    return { x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height + 12 };
  });
  await page.screenshot({ path: 'agent-workspace/probe/diag-controls.png', clip: box });

  await browser.close();
})();
