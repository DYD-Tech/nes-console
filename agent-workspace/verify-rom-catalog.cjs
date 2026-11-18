/**
 * 验证「内置游戏 = 手写清单 web/games.json」这条链路。
 *
 * 覆盖三件事：
 *  B) 清单与 web/rom/ 一致：每条都有文件、id 就是运行时那个哈希函数对文件内容算出的值、
 *     size 对得上；仓库里放行的每个 .nes 都在清单里（清单是手写的，最容易漏改）。
 *  C) 页面据此显示：条数对得上、菜单里就是这些名字、拖进一份已有的 ROM 不会多出一行，
 *     而且「管理存档」不再为了拿哈希把 ROM 下载一遍。
 *
 * 跑法：先 `npm run serve`（把 web/ 挂到 7890），再 node agent-workspace/verify-rom-catalog.cjs
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('node:url');
const { launch } = require('./lib-browser.cjs');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const URL = 'http://localhost:7890/nes-console/';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
};

/**
 * 随仓库发布的 .nes（git 跟踪的那些）。
 * 不直接读目录：web/rom/ 里还可能躺着本机自用、被 .gitignore 挡住的卡带，它们本来就不该进清单。
 */
function trackedRoms() {
  return execFileSync('git', ['ls-files', '-z', 'web/rom'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter((f) => f.toLowerCase().endsWith('.nes'))
    .map((f) => path.basename(f));
}

(async () => {
  const { computeROMHash } = await import(pathToFileURL(path.join(WEB, 'js/storage.js')).href);

  // ============ B) 清单与磁盘 ============
  console.log('\n【B) web/games.json 与 web/rom/ 一致】');
  const catalog = JSON.parse(fs.readFileSync(path.join(WEB, 'games.json'), 'utf8'));
  const fileOf = (g) => path.join(WEB, decodeURIComponent(g.url));
  check('每一条的 url 都指向 web/rom/ 下真实存在的文件',
    catalog.every((g) => g.url.startsWith('rom/') && fs.existsSync(fileOf(g))),
    JSON.stringify(catalog.map((g) => g.url)));
  check('每一条的 id 与文件内容算出的哈希一致（和运行时同一个函数）',
    catalog.every((g) => g.id === computeROMHash(new Uint8Array(fs.readFileSync(fileOf(g))))),
    JSON.stringify(catalog.map((g) => g.id)));
  check('每一条的 size 是文件字节数',
    catalog.every((g) => g.size === fs.statSync(fileOf(g)).size));
  check('url 是百分号编码过的（中文文件名在任何服务器上都取得到）',
    catalog.every((g) => g.url === 'rom/' + encodeURIComponent(path.basename(decodeURIComponent(g.url)))));
  const listed = catalog.map((g) => path.basename(decodeURIComponent(g.url)));
  const roms = trackedRoms();
  check('仓库里发布的每个 .nes 都写进了清单', roms.every((f) => listed.includes(f)),
    `仓库 ${JSON.stringify(roms)} / 清单 ${JSON.stringify(listed)}`);
  check('清单里没有重复的 id', new Set(catalog.map((g) => g.id)).size === catalog.length);

  // ============ C) 页面 ============
  console.log('\n【C) 菜单按清单显示】');
  const browser = await launch({ localRoms: false }); // 这里验的就是真清单，不补本机测试卡带
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
  check('清单里的名字都出现在菜单里', missing.length === 0,
    JSON.stringify(missing.map((g) => g.name)));

  console.log('\n【D) 把一份内置 ROM 再拖进来：不多出一行】');
  const bytes = fs.readFileSync(fileOf(catalog[0]));
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
  }, { b64, fileName: '又一份内置游戏.nes' });
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
