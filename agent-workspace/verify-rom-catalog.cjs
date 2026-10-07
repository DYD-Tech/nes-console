/**
 * 验证「内置游戏 = 扫 public/rom/ 生成的清单」这条链路。
 *
 * 覆盖三件事：
 *  A) 生成器本身（Node 侧，用临时目录，不碰真 ROM）：只认 .nes、同内容只留一条、按名字排序。
 *  B) 真实清单 public/games.json 与 public/rom/ 目录一致（哈希算法、URL 大小写、条目数）。
 *  C) 页面据此显示：条数对得上、菜单里就是这些名字、拖进一份已有的 ROM 不会多出一行，
 *     而且「管理存档」不再为了拿哈希把 ROM 下载一遍。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('node:url');
const { launch } = require('./lib-browser.cjs');

const ROOT = path.resolve(__dirname, '..');
const URL = 'http://localhost:7890/nes-console/';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
};

/** 从磁盘上的 ROM 文件名读出真实清单应该有的内容 */
function romFilesOnDisk() {
  return fs.readdirSync(path.join(ROOT, 'public/rom'))
    .filter((f) => f.toLowerCase().endsWith('.nes'));
}

(async () => {
  const { buildRomCatalog } = await import(pathToFileURL(
    path.join(ROOT, 'src/integrations/rom-catalog.js'),
  ).href);
  const { computeROMHash } = await import(pathToFileURL(
    path.join(ROOT, 'src/lib/storage.js'),
  ).href);

  // ============ A) 生成器 ============
  console.log('\n【A) 扫目录生成清单】');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rom-catalog-'));
  try {
    const real = fs.readFileSync(path.join(ROOT, 'public/rom/Destiny of an Emperor (U).nes'));
    fs.mkdirSync(path.join(tmp, 'rom'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'rom/乙.nes'), real);
    fs.writeFileSync(path.join(tmp, 'rom/甲.nes'), real);      // 与乙内容相同 = 同一款 ROM 换了名字
    fs.writeFileSync(path.join(tmp, 'rom/COPY.nes'), real.subarray(0, 16));
    fs.writeFileSync(path.join(tmp, 'rom/说明.txt'), '不是 ROM');

    const count = await buildRomCatalog(tmp);
    const list = JSON.parse(fs.readFileSync(path.join(tmp, 'games.json'), 'utf8'));

    check('只认 .nes（txt 不进清单）', list.every((g) => /\.nes$/i.test(decodeURIComponent(g.url))),
      JSON.stringify(list.map((g) => g.name)));
    check('同一份 ROM 放两个文件名，只留一条',
      new Set(list.map((g) => g.id)).size === list.length && count === 2,
      `${count} 条：${JSON.stringify(list.map((g) => g.name))}`);
    const names = list.map((g) => g.name);
    check('按显示名排序（不跟着磁盘顺序）',
      String(names) === names.slice().sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')).join(),
      JSON.stringify(names));
    check('id 就是运行时那个 ROM 哈希（同一个函数算的）',
      list.find((g) => g.name === 'COPY').id === computeROMHash(new Uint8Array(real.subarray(0, 16))),
      list.find((g) => g.name === 'COPY')?.id);
    check('url 是相对 public 的路径，且保留文件名原始大小写',
      list.find((g) => g.name === 'COPY').url === 'rom/COPY.nes',
      list.find((g) => g.name === 'COPY')?.url);
    check('size 是字节数', list.find((g) => g.name === 'COPY').size === 16);

    // 没有 rom 目录 = 一款内置游戏都没有，这是正常状态，不该报错
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    const n = await buildRomCatalog(empty);
    check('rom 目录不存在时清单为空、不抛错', n === 0, String(n));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ============ B) 真实清单 ============
  console.log('\n【B) public/games.json 与 public/rom/ 一致】');
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/games.json'), 'utf8'));
  const onDisk = romFilesOnDisk();
  check('清单条数 = 目录里的 .nes 数（去重后）',
    catalog.length === new Set(onDisk.map((f) =>
      computeROMHash(new Uint8Array(fs.readFileSync(path.join(ROOT, 'public/rom', f)))))).size,
    `清单 ${catalog.length} / 目录 ${onDisk.length} 个文件`);
  check('每一条都能在磁盘上找到对应文件',
    catalog.every((g) => onDisk.includes(path.basename(decodeURIComponent(g.url)))));
  check('每一条的 id 与磁盘内容算出的哈希一致',
    catalog.every((g) => {
      const file = path.basename(decodeURIComponent(g.url));
      return g.id === computeROMHash(new Uint8Array(fs.readFileSync(path.join(ROOT, 'public/rom', file))));
    }));
  check('构建产物里的清单和 public 里的是同一份',
    fs.readFileSync(path.join(ROOT, 'dist/games.json'), 'utf8') ===
    fs.readFileSync(path.join(ROOT, 'public/games.json'), 'utf8'));

  // ============ C) 页面 ============
  console.log('\n【C) 菜单按清单显示】');
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  const menu = await page.evaluate(() => ({
    count: document.querySelector('.sys-count')?.textContent || '',
    rows: Array.from(document.querySelectorAll('.sys-item')).map((li) => ({
      label: li.querySelector('.sys-item-label')?.textContent || '',
      sub: li.querySelector('.sys-item-sub')?.textContent || '',
    })),
  }));
  check(`左下角数量栏与清单条数一致（${catalog.length} 款）`,
    menu.count === `${catalog.length} 款`, `数量="${menu.count}"`);
  check('游戏行数与清单一致', menu.rows.length === catalog.length,
    `行数=${menu.rows.length}`);
  check('每一行都标成「内置」', menu.rows.every((r) => r.sub === '内置'),
    JSON.stringify(menu.rows.filter((r) => r.sub !== '内置').slice(0, 3)));
  const missing = catalog.filter((g) => !menu.rows.some((r) => r.label.includes(g.name)));
  check('清单里的名字都出现在菜单里（唯一例外是补过中文译名的那款）',
    missing.length === 1 && missing[0].name.includes('Destiny'),
    JSON.stringify(missing.map((g) => g.name)));
  check('手工补的元数据仍能对上（按内容哈希认，与文件名无关）',
    menu.rows.some((r) => r.label.includes('吞食天地') && r.label.includes('Destiny of an Emperor')),
    JSON.stringify(menu.rows.find((r) => r.label.includes('吞食天地'))));

  console.log('\n【D) 把一份内置 ROM 再拖进来：不多出一行】');
  const destinyUrl = catalog.find((g) => g.name.includes('Destiny')).url;
  const bytes = fs.readFileSync(path.join(ROOT, 'public/rom',
    path.basename(decodeURIComponent(destinyUrl))));
  const b64 = bytes.toString('base64');
  const rowsBefore = menu.rows.length;
  await page.evaluate(async ({ b64, fileName }) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([arr], fileName, { type: 'application/octet-stream' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
  }, { b64, fileName: '又一份吞食天地.nes' });
  await page.waitForTimeout(600);
  const afterDrop = await page.evaluate(() => ({
    count: document.querySelector('.sys-count')?.textContent || '',
    rows: document.querySelectorAll('.sys-item').length,
    toast: document.getElementById('toast')?.textContent || '',
  }));
  check('拖入同一份 ROM 后行数不变（按内容哈希认出是同一款）',
    afterDrop.rows === rowsBefore, `${rowsBefore} -> ${afterDrop.rows} 数量="${afterDrop.count}"`);
  check('没有报 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | '));

  console.log('\n【E) 管理存档不必先下载 ROM】');
  requests.length = 0;
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nav = Array.from(document.querySelectorAll('.sys-nav-item'))
      .find((n) => n.querySelector('.sys-nav-label')?.textContent === '游戏管理');
    nav?.click();
    await sleep(400);
    const row = Array.from(document.querySelectorAll('.sys-item-label'))
      .find((e) => e.textContent === '管理存档');
    row?.closest('.sys-item')?.click();
    await sleep(2500);
  });
  const romFetches = requests.filter((u) => /\/rom\//.test(u));
  check('列出存档的过程中没有去下载任何 ROM', romFetches.length === 0, romFetches.slice(0, 3).join(', '));
  check('存档管理页能打开', await page.evaluate(
    () => (document.querySelector('.sys-title')?.textContent || '') === '管理存档'),
    await page.evaluate(() => document.querySelector('.sys-title')?.textContent));

  console.log('\n【错误汇总】');
  check('全程无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e); process.exit(1); });
