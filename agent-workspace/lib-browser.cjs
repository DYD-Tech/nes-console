/**
 * 测试脚本共用的浏览器启动（多个验证脚本都用同一套参数）。
 *
 * 为什么要有这三条 `--disable-*`：无头浏览器开的窗口在系统里算「被遮挡的窗口」，
 * Chrome 会对它做「后台标签页」限流 —— rAF 掉速、定时器推迟、合成器少给帧。
 * 本项目测的东西恰好全是时间相关的（跑帧速度、音频队列断音、CSS 过渡走完没有），
 * 于是限流会伪装成产品 bug：实测金庸群侠传每秒出帧从 50 掉到 30，
 * 音频队列被抽干到 0，最狠的一秒补静音 1.7 万帧（约 350 ms），20 秒累计 1.2 秒静音，
 * 看着像游戏在卡音。关掉这三条之后同一款游戏稳定 50 帧/秒，
 * 15 秒累计断音降到 3840 帧（约 80 ms）。
 *
 * 注意：这只让**测试环境**不再限流，不代表产品里不会卡。
 * 真实用户把标签页切到后台时 rAF 本来就该停，那是浏览器该有的行为。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const WEB = path.resolve(__dirname, '..', 'web');

const ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

/**
 * 测试页拿到的游戏清单 = web/games.json + web/rom/ 里清单之外的 .nes。
 *
 * 为什么要补：站点的内置清单是手写入库的（只有一张演示卡带），而回归脚本要点的
 * 测试卡带（Destiny of an Emperor、热血格斗、重装机兵…）不入库、只放在本机 web/rom/。
 * 以前清单是构建时扫目录生成的，放进去就有；不构建之后得由测试这一侧把它们补上。
 * 只在测试浏览器里改响应，不写文件、不影响站点。补的条目和真清单同一个形状、同一个哈希函数，
 * 页面分不出差别。
 *
 * @returns {Promise<object[]|null>} 没有清单外的卡带时返回 null（不必拦请求）
 */
async function testCatalog() {
  const catalog = JSON.parse(fs.readFileSync(path.join(WEB, 'games.json'), 'utf8'));
  const listed = new Set(catalog.map((g) => path.basename(decodeURIComponent(g.url))));
  const extra = fs.readdirSync(path.join(WEB, 'rom'))
    .filter((f) => f.toLowerCase().endsWith('.nes') && !listed.has(f));
  if (!extra.length) return null;
  const { computeROMHash } = await import(pathToFileURL(path.join(WEB, 'js', 'storage.js')).href);
  const ids = new Set(catalog.map((g) => g.id));
  const added = [];
  for (const f of extra.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))) {
    const data = new Uint8Array(fs.readFileSync(path.join(WEB, 'rom', f)));
    const id = computeROMHash(data);
    if (ids.has(id)) continue; // 同一份 ROM 换了个名字，只留一条（和页面去重同一规则）
    ids.add(id);
    added.push({ id, name: path.basename(f, path.extname(f)), url: `rom/${encodeURIComponent(f)}`, size: data.length });
  }
  return [...catalog, ...added];
}

/**
 * @param {import('playwright').LaunchOptions & { localRoms?: boolean }} [opts] 额外启动参数。
 *   `args` 是**追加**不是替换 —— 调用方写 `{ args: ['--autoplay-policy=…'] }`
 *   只想加一条，不该顺手把上面三条限流豁免也丢掉（那样测出来的数字又会「像产品卡」）。
 *   `localRoms`（默认 true）：把本机 web/rom/ 里清单之外的测试卡带补进页面拿到的清单（见 testCatalog）。
 *   要验「页面就按真清单显示」的脚本（verify-rom-catalog）传 false。
 */
async function launch(opts = {}) {
  const { args = [], localRoms = true, ...rest } = opts;
  const browser = await chromium.launch({
    ...rest,
    executablePath: chromium.executablePath(),
    args: [...ARGS, ...args],
  });
  const catalog = localRoms ? await testCatalog() : null;
  if (catalog) {
    // browser.newPage() 内部也走 newContext()，所以包这一处就覆盖了两种开页面的写法。
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (ctxOpts) => {
      const ctx = await newContext(ctxOpts);
      await ctx.route('**/games.json', (route) => route.fulfill({ json: catalog }));
      return ctx;
    };
  }
  return browser;
}

module.exports = { launch, ARGS };
