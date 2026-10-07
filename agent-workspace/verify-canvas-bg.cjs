// 验证 canvas 背景是否为黑色（而非白色）
const { launch } = require('./lib-browser.cjs');

(async () => {
  const browser = await launch();

  const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto('http://localhost:7890/nes-console/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);

  const r = await p.evaluate(() => {
    const canvas = document.getElementById('nes-canvas');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // 采样中心像素
    const cx = Math.floor(canvas.width / 2);
    const cy = Math.floor(canvas.height / 2);
    const offset = (cy * canvas.width + cx) * 4;
    return {
      r: data[offset],
      g: data[offset + 1],
      b: data[offset + 2],
      a: data[offset + 3],
    };
  });

  const isBlack = r.r < 10 && r.g < 10 && r.b < 10;
  console.log(`Canvas 中心像素: R=${r.r} G=${r.g} B=${r.b} A=${r.a}`);
  console.log(`背景色: ${isBlack ? '✅ 黑色' : '❌ 非黑色'}`);

  await browser.close();
  process.exit(isBlack ? 0 : 1);
})();
