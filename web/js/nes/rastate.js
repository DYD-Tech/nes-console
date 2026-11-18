/**
 * RetroArch 即时存档容器（RASTATE）的读写。
 *
 * 格式对标 libretro/RetroArch 的 tasks/task_save.c（v1.22.2:340,349,381-388,
 * 397-446；master:93-97,566-671）：
 *
 *   偏移 0   7 B  ASCII "RASTATE"
 *   偏移 7   1 B  版本号 = 1（RASTATE_VERSION）
 *   随后若干块，每块：
 *     +0  4 B  块 ID ASCII：`RPLY` / `MEM ` / `ACHV` / `END `
 *     +4  4 B  uint32LE 载荷长度
 *     +8  n B  载荷，零填充到 8 的倍数（CONTENT_ALIGN_SIZE）
 *
 * `RPLY` 只在 BSV 录制/回放时写，`ACHV` 只在 RetroAchievements 激活时写，
 * 所以一个普通即时存档就是「头 + 一个 MEM 块 + END 块」，
 * 总长 = 8 + 8 + align8(核心状态) + 8。
 *
 * 不加压缩：RetroArch 读侧永远走 RZIP 接口并且能自动识别未压缩数据
 * （master:1108-1111），所以桌面端照样打得开。
 */
const MAGIC = 'RASTATE';
const RASTATE_VERSION = 1;
const HEADER_SIZE = 8;
const BLOCK_HEADER_SIZE = 8;
const ALIGN = 8;

function align8(n) {
  return (n + ALIGN - 1) & ~(ALIGN - 1);
}

/** 核心状态裸字节 → 一个 RASTATE 存档（等价于 RetroArch 的 .state） */
export function wrapRASTATE(coreState) {
  const payload = coreState.length;
  const total = HEADER_SIZE
    + BLOCK_HEADER_SIZE + align8(payload)
    + BLOCK_HEADER_SIZE;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(MAGIC), 0);
  out[7] = RASTATE_VERSION;
  let p = HEADER_SIZE;
  out[p] = 0x4d; out[p + 1] = 0x45; out[p + 2] = 0x4d; out[p + 3] = 0x20; // "MEM "
  view.setUint32(p + 4, payload, true);
  out.set(coreState, p + BLOCK_HEADER_SIZE);
  p += BLOCK_HEADER_SIZE + align8(payload);
  out[p] = 0x45; out[p + 1] = 0x4e; out[p + 2] = 0x44; out[p + 3] = 0x20; // "END "
  return out;
}

/**
 * RASTATE 存档 → 核心状态裸字节。
 *
 * 没有 RASTATE 头的输入原样返回：RetroArch 自己也是这么判的
 * （task_save.c master:1379-1381，前 7 字节不是 RASTATE 就按「旧格式 = 核心裸数据」
 * 直接加载），这样 fceumm/其它工具产出的裸核心状态也能读。
 */
export function unwrapRASTATE(bytes) {
  if (!bytes || bytes.length < HEADER_SIZE) return bytes;
  const head = String.fromCharCode(...bytes.subarray(0, MAGIC.length));
  if (head !== MAGIC) return bytes;
  let p = HEADER_SIZE;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (p + BLOCK_HEADER_SIZE <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(p, p + 4));
    const len = dv.getUint32(p + 4, true);
    if (id === 'MEM ') return bytes.subarray(p + BLOCK_HEADER_SIZE, p + BLOCK_HEADER_SIZE + len);
    if (id === 'END ') break;
    p += BLOCK_HEADER_SIZE + align8(len);
  }
  throw new Error('RASTATE 存档里没有 MEM 数据块');
}
