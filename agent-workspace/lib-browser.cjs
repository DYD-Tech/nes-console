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
const { chromium } = require('playwright');

const ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

/**
 * @param {import('playwright').LaunchOptions} [opts] 额外启动参数。
 *   `args` 是**追加**不是替换 —— 调用方写 `{ args: ['--autoplay-policy=…'] }`
 *   只想加一条，不该顺手把上面三条限流豁免也丢掉（那样测出来的数字又会「像产品卡」）。
 */
function launch(opts = {}) {
  const { args = [], ...rest } = opts;
  return chromium.launch({
    ...rest,
    executablePath: chromium.executablePath(),
    args: [...ARGS, ...args],
  });
}

module.exports = { launch, ARGS };
