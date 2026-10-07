/**
 * 读 public/rom/ 每款 ROM 的 iNES 头（mapper = (b6>>4)|((b7>>4)<<4)），
 * 顺带看探针产出的截图是不是纯色 —— 坏头用例要分清「fceumm 没纠正」和「纠正了但跑歪了」。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'agent-workspace/probe/out');

console.log('ROM 头：');
for (const f of fs.readdirSync(path.join(ROOT, 'public/rom'))) {
  const b = fs.readFileSync(path.join(ROOT, 'public/rom', f));
  const mapper = (b[6] >> 4) | ((b[7] >> 4) << 4);
  const prg = b[4] * 16384;
  const chr = b[5] * 8192;
  const declared = 16 + prg + chr;
  console.log(`  ${f.padEnd(34)} mapper=${String(mapper).padStart(3)} PRG=${prg}B CHR=${chr}B ` +
    `声明${declared}B/实际${b.length}B ${declared === b.length ? '头相符' : '**头不符**'} ` +
    `镜像=${b[6] & 8 ? '4screen' : '1screen'} 电池=${b[6] & 2 ? '有' : '无'}`);
}

// PNG 是 zlib 压缩的，这里只做粗略判断：把 IDAT 解压出来看像素是否全相同
const zlib = require('zlib');
function pngStats(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) return { error: '不是 PNG' };
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  let pos = 8;
  const idat = [];
  let palette = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
    if (type === 'PLTE') palette = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 3 ? 1 : 0;
  const bpp = Math.max(1, channels);
  const stride = Math.ceil(width * bitDepth * bpp / 8);
  const uniq = new Map();
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    // 只解 0/1/2/3 号滤镜足够判断纯色
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 0xff;
      else if (filter === 2) line[x] = (line[x] + b) & 0xff;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        line[x] = (line[x] + pred) & 0xff;
      }
    }
    for (let x = 0; x + bpp <= stride; x += bpp) {
      const key = colorType === 3 ? `idx${line[x]}` : line.subarray(x, x + bpp).toString('hex');
      uniq.set(key, (uniq.get(key) || 0) + 1);
    }
    prev = line;
  }
  const top = [...uniq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return { width, height, colorType, bitDepth, colors: uniq.size, top: top.map(([k, v]) => `${k}×${v}`) };
}

console.log('\n截图颜色统计：');
for (const f of fs.readdirSync(OUT).filter((x) => x.endsWith('.png') && !x.endsWith('-page.png'))) {
  console.log(`  ${f.padEnd(30)} ${JSON.stringify(pngStats(path.join(OUT, f)))}`);
}
