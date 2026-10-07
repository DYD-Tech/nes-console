/**
 * 快档测试：src/lib/nes/rastate.js（即时存档容器的读写）
 *
 * 纯逻辑模块，一个浏览器 API 都不碰，所以不需要替身、不需要构建、不需要起站点。
 * 格式对标 RetroArch 的 tasks/task_save.c（见 rastate.js 头部注释），
 * 这里断言的就是「字节摆得对不对」，出错的话桌面端 RetroArch 读我们的档会直接失败。
 *
 * 跑法：node agent-workspace/test-rastate.cjs
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

const MOD = path.join(__dirname, '..', 'src', 'lib', 'nes', 'rastate.js');

(async () => {
  const { wrapRASTATE, unwrapRASTATE } = await import(pathToFileURL(fs.realpathSync(MOD)).href);

  const bytes = (...a) => Uint8Array.from(a);
  const str = (u8, n) => String.fromCharCode(...u8.subarray(0, n));
  const u32 = (u8, off) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(off, true);
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const randomState = (n) => bytes(...Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff));

  // ---------- 1. 头 ----------
  const st = randomState(20);
  const a = wrapRASTATE(st);
  check('头 7 字节是 ASCII "RASTATE"', str(a, 7) === 'RASTATE', `实得 ${str(a, 7)}`);
  check('第 8 字节是版本号 1（RASTATE_VERSION）', a[7] === 1, `实得 ${a[7]}`);

  // ---------- 2. 块布局 ----------
  check('头后第一个块 ID 是 "MEM "', str(a.subarray(8, 12)) === 'MEM ', `实得 ${str(a.subarray(8, 12))}`);
  check('MEM 长度字段 = 核心状态字节数（小端）', u32(a, 12) === 20, `实得 ${u32(a, 12)}`);
  check('载荷紧跟块头，内容一字不差', same(a.subarray(16, 36), st));
  check('END 块在 8 + 8 + align8(20) = 40 处', str(a.subarray(40, 44)) === 'END ', `实得 ${str(a.subarray(40, 44))}`);
  check('END 块长度字段为 0', u32(a, 44) === 0, `实得 ${u32(a, 44)}`);
  check('总长 = 8 + 8 + 24 + 8 = 48（CONTENT_ALIGN_SIZE=8 对齐后）', a.length === 48, `实得 ${a.length}`);

  // ---------- 3. 对齐：载荷补零到 8 的倍数 ----------
  for (const len of [0, 1, 7, 8, 9, 15, 16, 100, 1000, 1001, 14336]) {
    const raw = randomState(len);
    const w = wrapRASTATE(raw);
    const padded = (len + 7) & ~7;
    check(`长度 ${len} → 总长 ${8 + 8 + padded + 8}`, w.length === 8 + 8 + padded + 8, `实得 ${w.length}`);
    const tail = w.subarray(16 + len, 8 + 8 + padded);
    check(`长度 ${len} → 填充字节全是 0`, tail.every((v) => v === 0), `实得 ${[...tail].join(',')}`);
    check(`长度 ${len} → 读回来还是原来那 ${len} 字节`, same(unwrapRASTATE(w), raw));
  }

  // ---------- 4. 往返 ----------
  check('往返：20 字节核心状态原样回来', same(unwrapRASTATE(a), st));
  const big = randomState(65536);
  check('往返：64 KB 核心状态原样回来', same(unwrapRASTATE(wrapRASTATE(big)), big));

  // ---------- 5. 不改动入参 ----------
  const src = randomState(12);
  const copyBefore = Uint8Array.from(src);
  wrapRASTATE(src);
  check('wrap 不写坏调用方给的那块内存', same(src, copyBefore));

  // ---------- 6. 没有 RASTATE 头的存档原样放行 ----------
  // 对标 RetroArch 读侧：前 7 字节不是 RASTATE 就按「旧格式 = 核心裸数据」直接加载。
  const raw = randomState(33);
  const passthrough = unwrapRASTATE(raw);
  check('裸核心状态（无头）原样返回，内容一致', same(passthrough, raw));
  check('裸核心状态返回的是同一段（没拷贝、没截断）',
    passthrough.length === 33 && same(passthrough.subarray(0, 33), raw));
  check('长度不足 8 的输入不算存档，原样返回', same(unwrapRASTATE(bytes(1, 2, 3)), bytes(1, 2, 3)));
  check('空输入原样返回', unwrapRASTATE(bytes()).length === 0);
  check('null 输入原样返回（不抛错）', unwrapRASTATE(null) === null);

  // ---------- 7. 有头但没有 MEM 块 ----------
  const noMem = new Uint8Array(16);
  noMem.set(new TextEncoder().encode('RASTATE'), 0);
  noMem[7] = 1;
  noMem.set(new TextEncoder().encode('END '), 8);
  let threw = null;
  try { unwrapRASTATE(noMem); } catch (e) { threw = e; }
  check('只有头 + END、没有 MEM → 抛错', threw instanceof Error, `实得 ${threw}`);
  check('抛的是「没有 MEM 数据块」这句话',
    threw && threw.message === 'RASTATE 存档里没有 MEM 数据块', `实得 ${threw && threw.message}`);

  // ---------- 8. 跳过 RPLY / ACHV 块（RetroArch 录制档、成就档） ----------
  // RetroArch 在录 BSV 时会多写一个 RPLY 块，开了Achievements 会多写 ACHV 块，
  // 两者都可能排在 MEM 前面；我们的读侧要能跳过它们找到 MEM。
  const block = (id, payload) => {
    const padded = (payload.length + 7) & ~7;
    const b = new Uint8Array(8 + padded);
    b.set(new TextEncoder().encode(id), 0);
    new DataView(b.buffer).setUint32(4, payload.length, true);
    b.set(payload, 8);
    return b;
  };
  const glue = (...parts) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const part of parts) { out.set(part, p); p += part.length; }
    return out;
  };
  const core = randomState(30);
  const withRply = glue(
    (() => { const h = new Uint8Array(8); h.set(new TextEncoder().encode('RASTATE'), 0); h[7] = 1; return h; })(),
    block('RPLY', randomState(5)),
    block('MEM ', core),
    block('END ', new Uint8Array(0)),
  );
  check('RPLY 在前的存档能读到 MEM', same(unwrapRASTATE(withRply), core));

  const withBoth = glue(
    (() => { const h = new Uint8Array(8); h.set(new TextEncoder().encode('RASTATE'), 0); h[7] = 1; return h; })(),
    block('ACHV', randomState(13)),
    block('MEM ', core),
    block('RPLY', randomState(7)),
    block('END ', new Uint8Array(0)),
  );
  check('ACHV 在前、RPLY 在后的存档也能读到 MEM', same(unwrapRASTATE(withBoth), core),
    `实得长度 ${unwrapRASTATE(withBoth).length}`);
  check('读回来的 MEM 只有载荷那么多，不含补齐的 0', unwrapRASTATE(withBoth).length === 30);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
