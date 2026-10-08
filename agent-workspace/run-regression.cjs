/**
 * 回归测试的统一入口。三档跑法（详见 doc/测试方案.md）：
 *
 *   node agent-workspace/run-regression.cjs --fast   只跑快档（纯 node，不用构建、不用起站点，几秒）
 *   node agent-workspace/run-regression.cjs 关键字    跑脚本名含关键字的那几条
 *   node agent-workspace/run-regression.cjs           全量（浏览器脚本要站点已起在 7890）
 *
 * npm run test:fast 就是 --fast 那条。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** 快档：不起浏览器、不读构建产物，改完纯逻辑就能立刻跑 */
const FAST = [
  'test-system-core.cjs',
  'test-rastate.cjs',
  'test-game-manager.cjs',
];

/** 全量 = 快档 + 浏览器档（顺序即跑的顺序） */
const SCRIPTS = [
  ...FAST,
  'verify-wasm-core.cjs',
  'smoke-e2e.cjs',
  'verify-saveload.cjs',
  'verify-audio-fix.cjs',
  'verify-pause-on-menu.cjs',
  'smoke-system.cjs',
  'verify-menu-focus.cjs',
  'test-canvas-sizing.cjs',
  'verify-canvas-bg.cjs',
  'verify-rom-catalog.cjs',
  'verify-screen-menu-btn.cjs',
  'verify-ozone-colors.cjs',
  'verify-toast.cjs',
  'verify-touch-controls.cjs',
  'verify-pad-size.cjs',
  'verify-dpad.cjs',
  'verify-input-reaches-core.cjs',
  'verify-touch-xy.cjs',
  'verify-back-button.cjs',
  'verify-game-manager.cjs',
  'verify-control-manager.cjs',
  'verify-topbar-align.cjs',
  'verify-sidebar-vertical.cjs',
];

const arg = process.argv[2];
const fastOnly = arg === '--fast';
const picked = fastOnly ? FAST : (arg ? SCRIPTS.filter((s) => s.includes(arg)) : SCRIPTS);
if (!picked.length) {
  console.error(`没有脚本名含「${arg}」，可用：\n  ${SCRIPTS.join('\n  ')}`);
  process.exit(1);
}
console.log(fastOnly
  ? `只跑快档：${picked.length} 条（不构建、不起站点）`
  : `跑 ${picked.length} 条${arg ? `（关键字「${arg}」）` : '（全量，需站点已起在 7890）'}`);

// 每个脚本的完整输出落到 out/<脚本名>.log：汇总里只留最后几行，一旦有失败，
// 光看那几行查不出是哪条断言、拿到什么值（实测踩过，只能重跑单个脚本再看）。
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const t0 = Date.now();
for (const s of picked) {
  const file = path.join(__dirname, s);
  if (!fs.existsSync(file)) { results.push([s, '缺文件', '', 0]); continue; }
  process.stdout.write(`\n===== ${s} =====\n`);
  const start = Date.now();
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ms = Date.now() - start;
  const out = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(path.join(OUT, s + '.log'), out);
  const bad = out.split('\n').filter((l) => l.includes('❌'));
  if (bad.length) {
    console.log(bad.slice(0, 15).join('\n'));
    console.log(`  （完整输出：agent-workspace/out/${s}.log）`);
  } else {
    console.log(out.trim().split('\n').slice(-6).join('\n'));
  }
  console.log(`  用时 ${(ms / 1000).toFixed(1)} 秒`);
  const m = out.match(/结果[:：]\s*([^\n]*)/);
  results.push([s, r.status === 0 ? '通过' : '失败', m ? m[1] : '', ms]);
}

const total = Date.now() - t0;
console.log('\n========== 汇总 ==========');
for (const [s, st, detail, ms] of results) {
  console.log(`${st === '通过' ? '✅' : '❌'} ${s.padEnd(30)} ${(ms / 1000).toFixed(1).padStart(5)} 秒  ${detail}`);
}
const slowest = [...results].sort((a, b) => b[3] - a[3])[0];
console.log(`\n合计 ${picked.length} 条，${(total / 1000).toFixed(1)} 秒`
  + `${slowest ? `；最慢：${slowest[0]} ${(slowest[3] / 1000).toFixed(1)} 秒` : ''}`);
console.log('耗时看这张表就知道值不值得为一处改动跑全量，明细在 agent-workspace/out/<脚本名>.log');
process.exit(results.some(([, st]) => st !== '通过') ? 1 : 0);
