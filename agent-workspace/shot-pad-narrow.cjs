/**
 * 看窄屏（手机竖屏）下虚拟手柄排成什么样：截图 + 各组盒模型数字。
 * 数字口径：两组是否同排、方向键中心和 ABXY 中心是否齐平、按键离底边多少、
 * 画面离顶边多少、有没有压住画面。
 * 跑前站点要在 7890。跑法：node agent-workspace/shot-pad-narrow.cjs
 */
const path = require('path');
const fs = require('fs');
const { launch } = require('./lib-browser.cjs');
const { startGame } = require('./lib-game-menu.cjs');

const URL = 'http://localhost:7890/nes-console/';
const SETTINGS_KEY = 'nes-console.settings';
const OUT = path.join(__dirname, 'out');

const SIZES = [
  { name: '320x640', width: 320, height: 640 },
  { name: '390x844', width: 390, height: 844 },
  { name: '414x896', width: 414, height: 896 },
  // 近乎正方形又偏竖：画面下方的空白很薄，用来验「抬不动就退回贴底」那档降级
  { name: '800x900', width: 800, height: 900 },
  { name: '844x390', width: 844, height: 390 },
];

function boxes(page) {
  return page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect() : null;
    };
    const round = (b) => b && {
      left: Math.round(b.left), top: Math.round(b.top),
      right: Math.round(b.right), bottom: Math.round(b.bottom),
    };
    // ABXY 四颗的并集：判断「水平对齐」要看这四颗围出的正方形（簇心 AB 就在它的中心）
    const abxy = ['x', 'y', 'b', 'a'].map((k) => r(`.touch-${k}`)).filter(Boolean);
    const union = (list) => {
      if (!list.length) return null;
      return {
        left: Math.min(...list.map((x) => x.left)), right: Math.max(...list.map((x) => x.right)),
        top: Math.min(...list.map((x) => x.top)), bottom: Math.max(...list.map((x) => x.bottom)),
      };
    };
    const dpad = r('.touch-dpad');
    const screen = r('.screen');
    const cs = getComputedStyle(document.getElementById('touch-controls'));
    return {
      dir: cs.flexDirection,
      dpad: round(dpad), actions: round(r('.touch-actions-group')),
      // 两块都是「簇 + 下面一颗胶囊」，竖屏能不能塞进余量要看这两块的最底下，不是只看十字键
      leftGroup: round(r('.touch-dpad-group')),
      abxy: round(union(abxy)),
      dpadMidY: dpad ? Math.round(dpad.top + dpad.height / 2) : null,
      abxyMidY: (() => { const u = union(abxy); return u ? Math.round((u.top + u.bottom) / 2) : null; })(),
      screenTop: Math.round(screen.top), screenBottom: Math.round(screen.bottom),
      vh: window.innerHeight, vw: window.innerWidth,
    };
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  for (const size of SIZES) {
    const ctx = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      hasTouch: true, isMobile: true, deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    await page.addInitScript(([key, val]) => localStorage.setItem(key, val),
      [SETTINGS_KEY, JSON.stringify({ controls: { padMode: 'always' } })]);
    await page.goto(URL, { waitUntil: 'networkidle' });
    const started = await startGame(page, 'Destiny');
    const b = await boxes(page);
    await page.screenshot({ path: path.join(OUT, `pad-${size.name}.png`) });

    const lift = size.height - Math.max(b.dpad.bottom, b.actions.bottom);
    console.log(`\n【${size.name}】起游戏=${started ? 'OK' : '失败'} dir=${b.dir}`);
    console.log(`  方向键 ${JSON.stringify(b.dpad)} 中心Y=${b.dpadMidY}`);
    console.log(`  左手块 ${JSON.stringify(b.leftGroup)}（十字键 + SELECT）· 右手块 ${JSON.stringify(b.actions)}（五键簇 + START）`);
    console.log(`  ABXY   ${JSON.stringify(b.abxy)} 中心Y=${b.abxyMidY} → 高差 ${b.dpadMidY - b.abxyMidY}px`);
    console.log(`  按键离底边 ${lift}px；两组横向间隙=${b.actions.left - b.dpad.right}px`);
    console.log(`  画面 ${b.screenTop}~${b.screenBottom}（离顶 ${b.screenTop}px），手柄顶 ${Math.min(b.dpad.top, b.actions.top)} → 空档 ${Math.min(b.dpad.top, b.actions.top) - b.screenBottom}px`);
    await ctx.close();
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
