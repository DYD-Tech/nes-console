// 验证虚拟手柄上的 X / Y 两枚按钮，以及「界面不依赖 X/Y」这件事：
//   1) 手柄上有 X/Y，看得见点得着；
//   2) 按 X/Y 界面**不该**有任何反应（不是所有手柄都有这两个键，界面不能靠它们）；
//   3) 只用 十字键 + A + B（+ 菜单键）就能把存档的读 / 覆盖 / 删除整条路走通；
//   4) 显隐设置能单独关掉 X / Y / AB；
//   5) X/Y 不会被送进模拟器（NES 一个端口只有 8 位、只有 A/B 两个动作位）；
//   6) 簇心那颗 AB 键：摆在四颗键围出的正方形正中、不压到它们，按住等于 A 和 B 一起按。
const { launch } = require('./lib-browser.cjs');
const { startGame } = require('./lib-game-menu.cjs');

const URL = 'http://localhost:7890/nes-console/';
const SETTINGS_KEY = 'nes-console.settings';

let pass = 0, fail = 0;
const check = (label, ok, actual) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${actual === undefined ? '' : `  [${actual}]`}`);
  ok ? pass++ : fail++;
};

(async () => {
  const browser = await launch();
  // 桌面尺寸 + 强制显示手柄：不用真手机形态也能点到屏幕上的手柄按钮
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.addInitScript(([key, val]) => {
    localStorage.setItem(key, val);
  }, [SETTINGS_KEY, JSON.stringify({ controls: { padMode: 'always' } })]);

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // 全程点屏幕上的手柄按钮、不碰键盘 —— 这样才能证明「只有十字键 + A/B」的手柄够用
  const tap = async (sel, ms = 400) => {
    await page.locator(sel).click();
    await page.waitForTimeout(ms);
  };
  const snap = () => page.evaluate(() => ({
    title: document.querySelector('.sys-ui .sys-title')?.textContent || '',
    hidden: document.querySelector('.sys-ui').hidden,
    focus: document.querySelector('.sys-ui')?.dataset.focus || '',
    selected: document.querySelector('.sys-item.selected .sys-item-label')?.textContent || '',
    labels: Array.from(document.querySelectorAll('.sys-item-label')).map((e) => e.textContent.trim()),
    subs: Array.from(document.querySelectorAll('.sys-item-sub')).map((e) => e.textContent.trim()),
    detail: (document.querySelector('.sys-detail')?.textContent || '').trim(),
    detailShown: document.querySelector('.sys-detail')?.hidden === false,
    status: document.getElementById('toast')?.textContent || '',
    hints: Array.from(document.querySelectorAll('.sys-hint')).map((h) => h.textContent.trim()).join(' '),
  }));
  const openQuickMenu = async () => {
    await page.locator('.screen .sys-menu-btn, #btn-screen-menu, [data-action="MENU"]').first().click()
      .catch(async () => { await page.keyboard.press('Escape'); });
    await page.waitForTimeout(600);
  };

  console.log('\n【1. 手柄上确实有 X / Y，且看得见点得着】');
  const geom = await page.evaluate(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        display: s.display, action: el.dataset.action,
        hitSelf: top === el || el.contains(top),
        hitTag: `${top?.tagName}${top?.id ? `#${top.id}` : ''}${top?.className ? `.${String(top.className).split(' ')[0]}` : ''}`,
      };
    };
    return {
      padVisible: getComputedStyle(document.getElementById('touch-controls')).display !== 'none',
      x: vis('.touch-x'), y: vis('.touch-y'), ab: vis('.touch-ab'),
      count: document.querySelectorAll('#touch-controls [data-action]').length,
      // 簇心那颗 AB：位置要算出来（它靠绝对定位居中在四颗键围出的空档里），
      // 更要紧的是「不压到四颗键」—— 压住就会吃掉本来想按 A/B 的手指。
      abGeom: (() => {
        const b = (s) => document.querySelector(s).getBoundingClientRect();
        const keys = ['.touch-x', '.touch-y', '.touch-a', '.touch-b'].map(b);
        const c = { x: 0, y: 0 };
        for (const k of keys) { c.x += k.x + k.width / 2; c.y += k.y + k.height / 2; }
        c.x /= keys.length; c.y /= keys.length;
        const ab = b('.touch-ab');
        const abx = ab.x + ab.width / 2, aby = ab.y + ab.height / 2;
        return {
          off: Math.max(Math.abs(abx - c.x), Math.abs(aby - c.y)),
          gap: Math.min(...keys.map((k) =>
            Math.hypot(k.x + k.width / 2 - abx, k.y + k.height / 2 - aby) - k.width / 2 - ab.width / 2)),
          w: Math.round(ab.width),
        };
      })(),
    };
  });
  check('强制显示手柄生效', geom.padVisible);
  check('手柄按键共 15 个动作声明（11 个按键动作 + 4 段斜向弧键）', geom.count === 15, `实际 ${geom.count}`);
  check('X 按钮显示且可点（没被别的元素盖住）', !!geom.x && geom.x.display !== 'none' && geom.x.hitSelf,
    geom.x && `display=${geom.x.display} 命中=${geom.x.hitTag}`);
  check('Y 按钮显示且可点', !!geom.y && geom.y.display !== 'none' && geom.y.hitSelf,
    geom.y && `display=${geom.y.display} 命中=${geom.y.hitTag}`);
  check('X/Y 的 data-action 声明正确', geom.x?.action === 'X' && geom.y?.action === 'Y',
    `${geom.x?.action} / ${geom.y?.action}`);
  check('X/Y 尺寸够手指（≥44px）', geom.x?.w >= 44 && geom.y?.w >= 44, `${geom.x?.w}x${geom.x?.h}`);
  check('AB 的 data-action 是两个动作（A B）', geom.ab?.action === 'A B', geom.ab?.action);
  check('AB 显示且点得着（中心点命中的是它自己）',
    !!geom.ab && geom.ab.display !== 'none' && geom.ab.hitSelf, geom.ab && `命中=${geom.ab.hitTag}`);
  check('AB 摆在四颗键围出的正方形正中（偏差 < 1px）',
    geom.abGeom.off < 1, `偏 ${geom.abGeom.off.toFixed(2)}px`);
  check('AB 不压到 A/B/X/Y 任何一颗（间隙 > 0）',
    geom.abGeom.gap > 0, `最小间隙 ${geom.abGeom.gap.toFixed(2)}px · AB ${geom.abGeom.w}px`);

  console.log('\n【2. 界面不靠 X/Y：按了没反应；主菜单选中游戏也不弹详情栏】');
  const s0 = await snap();
  // 主菜单一度改成「选中即在右侧详情栏列出游戏信息」，为的是没有 X 键的手柄也能看信息；
  // 后来这块栏子被砍掉了（游戏信息改从游戏里的「游戏信息」菜单看），所以这里断言它不出现。
  check('主菜单没有右侧详情栏', s0.detailShown !== true, `详情栏="${s0.detail.slice(0, 30)}…"`);
  await tap('.touch-x');
  await tap('.touch-y');
  const s1 = await snap();
  check('按 X / Y 界面没有任何变化', s1.title === s0.title && s1.selected === s0.selected,
    `"${s0.title}/${s0.selected}" → "${s1.title}/${s1.selected}"`);
  check('提示栏里不再出现 X / Y', !/\bX\b|\bY\b/.test(s1.hints), s1.hints);

  console.log('\n【3. 只用 A 启动游戏，只用 B 关掉菜单】');
  // 主菜单开局焦点在分类栏，A 的含义是「进入列表」，所以先按 → 进到游戏列表，
  // 这时 A 才是「启动光标这一行」（导航模型见 screen-ui.js 的 handleAction）。
  await tap('.touch-right', 200);
  const entered = await snap();
  check('按手柄 → 从分类栏进到游戏列表', entered.focus === 'list' && entered.selected !== '',
    `focus=${entered.focus} 选中="${entered.selected}"`);
  // 等「真在跑」，不是等固定 1800ms：核心首次实例化要编译 800 KB wasm，全量连跑时
  // 那一下不一定够。没等到位就按 MENU，那一刻 playing 还是 false，开出来的是**主菜单**，
  // 后面一串「用十字键走存档管理」就全走岔了（单跑全绿、连跑红九条就是这么来的）。
  // 门槛用「比按下前又多跑 30 帧」，理由同 lib-game-menu.cjs 的 startGame。
  const framesBefore = await page.evaluate(() => window.__nesConsole.host.frames);
  await tap('.touch-a', 200);
  let booted = true;
  try {
    await page.waitForFunction(([base]) =>
      document.querySelector('.sys-ui').hidden && window.__nesConsole.host.frames >= base + 30,
    [framesBefore], { timeout: 30000 });
  } catch { booted = false; }
  const running = await snap();
  check('点 A 启动了游戏（菜单关掉、确实在跑帧）', booted && running.hidden === true, running.status);
  await openQuickMenu();
  const quick = await snap();
  check('屏幕内菜单开着（是游戏里的快速菜单，不是主菜单）',
    quick.labels.includes('继续游戏'), quick.labels.slice(0, 6).join(' / '));
  await tap('.touch-b');
  check('在快速菜单里点 B 关掉菜单回到游戏', (await snap()).hidden === true);

  console.log('\n【4. 存档管理：槽位行按 A 进「槽位操作」，读 / 覆盖 / 删除都在里面】');
  await openQuickMenu();
  // 快速菜单顺序：继续游戏 / 保存存档 / 读取存档 / 存档管理 /…（光标默认在第一项）
  await tap('.touch-down', 150);
  await tap('.touch-down', 150);
  await tap('.touch-down', 150);
  check('用十字键能走到「存档管理」这一行', (await snap()).selected === '存档管理',
    (await snap()).selected);
  await tap('.touch-a', 1000);
  const slots = await snap();
  check('进了槽位列表', slots.title === '存档管理' && slots.labels.length > 0,
    `${slots.title} / ${slots.labels.slice(0, 4).join(' / ')}`);

  // 第一条槽位：空的按 A 直接存，存完再按一次 A 才进「槽位操作」
  await tap('.touch-a', 1600);
  let cur = await snap();
  if (cur.title !== slots.labels[0]) {
    check('空槽位按 A 直接存档（状态栏写明已保存）', /已保存/.test(cur.status), cur.status);
    await tap('.touch-a', 800);
    cur = await snap();
  }
  check('有存档的槽位按 A 进「槽位操作」', cur.title === slots.labels[0], `${cur.title} / ${cur.labels.join(' / ')}`);
  check('「槽位操作」里有 读取 / 覆盖保存 / 删除',
    cur.labels.includes('读取存档') && cur.labels.includes('覆盖保存') && cur.labels.includes('删除存档'),
    cur.labels.join(' / '));
  check('这一屏只用 A 确认、B 返回',
    /A/.test(cur.hints) && /B/.test(cur.hints) && !/\bX\b|\bY\b/.test(cur.hints), cur.hints);
  await tap('.touch-x');
  await tap('.touch-y');
  const afterXY = await snap();
  check('在槽位操作里按 X / Y 同样没反应',
    afterXY.title === cur.title && afterXY.selected === cur.selected,
    `${afterXY.title} / ${afterXY.selected}`);

  await tap('.touch-down');
  check('十字键下移选到「覆盖保存」', (await snap()).selected === '覆盖保存', (await snap()).selected);
  await tap('.touch-a', 1600);
  const saved = await snap();
  check('按 A 完成覆盖保存并退回槽位列表',
    /已保存/.test(saved.status) && saved.title === '存档管理', `${saved.title} / ${saved.status}`);

  // 再进同一格 → 走到删除 → 确认屏按 B 取消 → 存档必须还在
  await tap('.touch-a', 800);
  await tap('.touch-down', 150);
  await tap('.touch-down', 150);
  check('十字键能走到「删除存档」', (await snap()).selected === '删除存档', (await snap()).selected);
  await tap('.touch-a', 800);
  const confirm = await snap();
  check('按 A 给的是删除确认（没直接删）',
    confirm.title === '删除存档' && /确认/.test(confirm.hints),
    `标题=${confirm.title} 提示=${confirm.hints}`);
  await tap('.touch-b', 700);
  const backToOps = await snap();
  check('确认屏按 B 取消，退回「槽位操作」',
    backToOps.title === slots.labels[0] && backToOps.labels.includes('删除存档'),
    `${backToOps.title} / ${backToOps.labels.join(' / ')}`);
  await tap('.touch-b', 700);
  const cancelled = await snap();
  check('再按 B 回槽位列表，存档没被删',
    cancelled.title === '存档管理' && cancelled.subs.some((s) => s && s !== '空'),
    `${cancelled.title} / ${cancelled.subs.slice(0, 3).join(' / ')}`);

  console.log('\n【5. 显隐设置能单独关掉 X / Y / AB】');
  // 另开一个上下文再进页面：同一个 page 上 reload 会重跑上面的 addInitScript，
  // 把这份 padKeys 盖掉，测出来的就不是显隐逻辑了。
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const p3 = await ctx3.newPage();
  await p3.addInitScript(([key, val]) => localStorage.setItem(key, val), [SETTINGS_KEY, JSON.stringify({
    controls: {
      padMode: 'always',
      padKeys: { dpad: true, a: true, b: true, ab: false, x: false, y: false, select: true, start: true },
    },
  })]);
  await p3.goto(URL, { waitUntil: 'networkidle' });
  await p3.waitForTimeout(600);
  const afterHide = await p3.evaluate(() => {
    const d = (sel) => getComputedStyle(document.querySelector(sel)).display;
    return { x: d('.touch-x'), y: d('.touch-y'), ab: d('.touch-ab'), a: d('.touch-a'), select: d('.touch-select') };
  });
  check('X 被隐藏', afterHide.x === 'none', afterHide.x);
  check('Y 被隐藏', afterHide.y === 'none', afterHide.y);
  check('AB 被隐藏', afterHide.ab === 'none', afterHide.ab);
  check('A 与 SELECT 仍显示（没被连累）',
    afterHide.a !== 'none' && afterHide.select !== 'none', `A=${afterHide.a} SELECT=${afterHide.select}`);
  await ctx3.close();

  console.log('\n【6. X / Y 不该送进模拟器（NES 只有 A/B 两个动作位）】');
  await ctx.close();
  const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const p2 = await c2.newPage();
  await p2.addInitScript(([key, val]) => localStorage.setItem(key, val),
    [SETTINGS_KEY, JSON.stringify({ controls: { padMode: 'always' } })]);
  await p2.goto(URL, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(400);
  // 按名字把光标移到 Destiny 再启动。原来写的是「点列表第一项」，
  // 而内置游戏是构建时扫 public/rom/ 得到的多款 —— 往目录里多丢一个文件，
  // 第一项就换了，甚至可能换成一款跑不起来的，这一节的红就查不清是谁的问题。
  check('基线：游戏能启动（Destiny）', await startGame(p2, 'Destiny'));
  // 宿主的按键集合就是「送进模拟器的按键」（元素是 `端口:按键号`），
  // 跑帧数用它自己的计数器，不用去补丁核心内部。
  const held = () => p2.evaluate(() => [...window.__nesConsole.host.held]);
  const frames = () => p2.evaluate(() => window.__nesConsole.host.frames);
  const before = await frames();
  const pressAndProbe = async (sel) => {
    const box = await p2.locator(sel).boundingBox();
    await p2.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p2.mouse.down();
    const during = await held();
    await p2.mouse.up();
    await p2.waitForTimeout(120);
    return { during, after: await held() };
  };
  const x = await pressAndProbe('.touch-x');
  const y = await pressAndProbe('.touch-y');
  const st = await p2.evaluate(() => ({ status: document.getElementById('toast')?.textContent || '' }));
  check('按 X/Y 后游戏状态栏没被改动（没转发成 A/B）',
    !/已保存|设置|信息/.test(st.status) || st.status.includes('正在运行'), st.status);
  check('按住 X 期间模拟器没有任何按键（NES 没有第 9、10 个键位）',
    x.during.length === 0 && x.after.length === 0, x.during.join(','));
  check('按住 Y 期间模拟器没有任何按键',
    y.during.length === 0 && y.after.length === 0, y.during.join(','));
  // 簇心那颗 AB：按住要同时出现 A（libretro id 8）和 B（id 0），松开两个都清掉。
  // 量的是宿主的 held，也就是核心每帧去取的那一层，不是按钮上的类名。
  const ab = await pressAndProbe('.touch-ab');
  check('按住 AB 期间模拟器同时收到 A 和 B',
    ab.during.includes('0:8') && ab.during.includes('0:0'), ab.during.join(','));
  check('松开 AB 后 A 和 B 都释放', ab.after.length === 0, ab.after.join(','));
  // 居中靠 transform，而按下态的 scale 会整条顶掉它（这条坑在 MENU 键上踩过一次），
  // 所以按下时既要还在居中，也要真的缩了。transition 是 0.1s，读之前等一下。
  const abBox = await p2.locator('.touch-ab').boundingBox();
  await p2.mouse.move(abBox.x + abBox.width / 2, abBox.y + abBox.height / 2);
  await p2.mouse.down();
  await p2.waitForTimeout(180);
  const abTransform = await p2.evaluate(() => getComputedStyle(document.querySelector('.touch-ab')).transform);
  await p2.mouse.up();
  const m = (abTransform.match(/matrix\(([^)]+)\)/) || [, ''])[1].split(',').map(Number);
  check('按住 AB 时仍居中、且有缩小反馈',
    m.length === 6 && Math.abs(m[4] + abBox.width / 2) < 1 && Math.abs(m[5] + abBox.height / 2) < 1
    && Math.abs(m[0] - 0.92) < 0.02,
    `${abTransform}（AB ${abBox.width}x${abBox.height}）`);
  const after = await frames();
  check('游戏仍在跑帧（没被按键打断）', after > before, `${before} → ${after}`);

  console.log('\n【7. A/B 的左右位置，以及长按不该弹出系统菜单】');
  // -webkit-touch-callout 只在 WebKit（iOS Safari）有效：实测 Chromium 在解析阶段
  // 就把它整条丢掉（构建出的样式表里没有这个属性，getComputedStyle 取回空串），
  // 所以浏览器侧读不到值。改查「产出的 CSS 里有没有这条声明」——
  // 用户手机上生效的就是这份文件，读它的文本比读一个不支持它的浏览器的计算值更真。
  const cssText = await p2.evaluate(async () => {
    const links = [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href);
    const parts = [];
    for (const href of links) parts.push(await (await fetch(href)).text());
    return parts.join('\n');
  });
  const padGeom = await p2.evaluate(() => {
    const r = (sel) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), right: Math.round(b.right) };
    };
    const bs = getComputedStyle(document.body);
    // 长按时浏览器派发 contextmenu；这里用同一个事件验证「我们把它吞掉了」
    //（真机的长按是浏览器自己派发这个事件的，没有别的钩子可测）。
    const swallow = (sel) => {
      const el = sel ? document.querySelector(sel) : document.body;
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    // 长按手势本身能不能被掐掉，看的是 touchstart 有没有被 preventDefault
    //（浏览器就不再把这串触摸编成长按）。用可取消的冒泡事件模拟这一下。
    const swallowTouch = (sel) => {
      const el = document.querySelector(sel);
      const ev = new Event('touchstart', { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    return {
      a: r('.touch-a'), b: r('.touch-b'), x: r('.touch-x'), select: r('.touch-select'),
      dpadBox: r('.touch-dpad'), actionsBox: r('.touch-actions'),
      userSelect: bs.userSelect,
      tapHighlight: bs.getPropertyValue('-webkit-tap-highlight-color'),
      prevented: {
        body: swallow(null),
        screen: swallow('.screen'),
        padA: swallow('.touch-a'),
        dpad: swallow('.touch-dpad'),
        canvas: swallow('canvas'),
      },
      // 长按手势的掐法：touchstart 被 preventDefault 之后浏览器不再把它编成长按。
      // 只有「不靠 click 工作」的地方能掐，菜单行与摆放条上的按钮都监听 click，
      // 画面按需求保留原生长按 —— 这三处必须是 false（见 app.js 的 LONG_PRESS_KEEP）。
      touchKilled: {
        padA: swallowTouch('.touch-a'),
        dpad: swallowTouch('.touch-dpad'),
        menuBtn: swallowTouch('.screen .touch-menu'),
        canvas: swallowTouch('canvas'),
        overlay: swallowTouch('#canvas-overlay'),
        sysUi: swallowTouch('.sys-ui'),
        layoutEditor: swallowTouch('#layout-editor'),
      },
    };
  });
  check('中排只有 A、B 两枚，A 在左、B 在右',
    padGeom.a.right <= padGeom.b.x && padGeom.b.x > padGeom.a.x,
    `A=${padGeom.a.x}~${padGeom.a.right} B=${padGeom.b.x}`);
  check('X/Y 仍在上排（在 A/B 之上）', padGeom.x.y < padGeom.a.y, `X.y=${padGeom.x.y} A.y=${padGeom.a.y}`);
  check('SELECT 在左手那一列（十字键下方、动作簇左边）',
    padGeom.select.y > padGeom.dpadBox.y && padGeom.select.right <= padGeom.actionsBox.x,
    `SELECT.y=${padGeom.select.y} 十字键.y=${padGeom.dpadBox.y} / SELECT 右沿=${padGeom.select.right} 动作簇.x=${padGeom.actionsBox.x}`);
  check('长按不弹 iOS 气泡：产出的 CSS 写了 -webkit-touch-callout: none',
    /-webkit-touch-callout:\s*none/.test(cssText),
    cssText ? `样式表 ${cssText.length} 字节` : '没取到样式表');
  check('长按选不中文字（body user-select: none）',
    padGeom.userSelect === 'none', `实际=${padGeom.userSelect}`);
  check('长按不涂高亮块', padGeom.tapHighlight === 'rgba(0, 0, 0, 0)', `实际=${padGeom.tapHighlight}`);
  check('页面任意处长按都不触发系统菜单（contextmenu 被吞）',
    Object.values(padGeom.prevented).every(Boolean), JSON.stringify(padGeom.prevented));
  check('长按在手柄和屏幕外围不成为操作（touchstart 被掐）',
    padGeom.touchKilled.padA && padGeom.touchKilled.dpad && padGeom.touchKilled.menuBtn,
    JSON.stringify(padGeom.touchKilled));
  check('该留原生触摸的三处没被掐：画面 / 菜单（靠 click 与滑动）/ 摆放条',
    !padGeom.touchKilled.canvas && !padGeom.touchKilled.overlay
      && !padGeom.touchKilled.sysUi && !padGeom.touchKilled.layoutEditor,
    JSON.stringify(padGeom.touchKilled));

  console.log('\n【错误汇总】');
  const real = errors.filter((e) => !/Failed to load resource|404/.test(e));
  check('全程无 JS 错误', real.length === 0, real.slice(0, 3).join(' | '));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exitCode = fail ? 1 : 0;
})();
