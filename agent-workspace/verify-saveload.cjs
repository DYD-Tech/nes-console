// 验证读档的两条路径：
//   A) 游戏没在跑时，从「游戏管理 → 管理存档 → 存档列表」点槽位要真能读进去
//   B) 核心不认这份存档时，说清为什么，而不是崩在半路或只甩「读取失败」
//
// B 的背景：即时存档是 RASTATE 容器包着的核心状态字节，只有「同一个核心 + 同一款
// ROM」才认得（fceumm 的载荷自己还带 FCS\xFF 魔数和版本号）。读不进去的情形有：
// 从别的模拟器/别的核心版本拷来的档、库里的记录被写坏。界面要给出人话的原因。
const { launch } = require('./lib-browser.cjs');
const { startGame } = require('./lib-game-menu.cjs');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
};

(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.addInitScript(() => {
    window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__key = async (code, ms = 150) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      await window.__sleep(ms);
    };
    window.__status = () => document.getElementById('toast')?.textContent || '';
    // toast 是显示完就消失的（约 2.8 秒），所以不能「睡到操作结束再去读」——
    // 那样读到的多半是空。边等边盯，看到目标文案立刻取走。
    window.__waitToast = async (sub, ms = 4000) => {
      for (let waited = 0; waited < ms; waited += 80) {
        const s = window.__status();
        if (s.includes(sub)) return s;
        await window.__sleep(80);
      }
      return window.__status();
    };
    window.__title = () => document.querySelector('.sys-ui .sys-title')?.textContent || '';
    window.__rows = () => Array.from(document.querySelectorAll('.sys-item')).map((li) => ({
      label: li.querySelector('.sys-item-label')?.textContent,
      sub: li.querySelector('.sys-item-sub')?.textContent,
    }));
    window.__nav = (label) => {
      const el = Array.from(document.querySelectorAll('.sys-nav-item'))
        .find((n) => n.querySelector('.sys-nav-label')?.textContent === label);
      if (el) el.click();
      return !!el;
    };
    window.__click = (label) => {
      const el = Array.from(document.querySelectorAll('.sys-item-label')).find((e) => e.textContent === label);
      if (el) el.closest('.sys-item').click();
      return !!el;
    };
    // 把库里所有存档的字节换成一段没有 RASTATE 头、也没有核心魔数的空数据，
    // 模拟「这份档来路不对」。版本号要跟 storage.js 的 DB_VERSION 一致：
    // 用比实际低的版本 open 会直接抛 VersionError
    window.__corrupt = () => new Promise((res) => {
      const rq = indexedDB.open('nes-console', 3);
      rq.onerror = () => res(false);
      rq.onsuccess = () => {
        const tx = rq.result.transaction('savestates', 'readwrite');
        const st = tx.objectStore('savestates');
        const all = st.getAll();
        all.onsuccess = () => {
          all.result.forEach((rec) => {
            rec.data = new Uint8Array(64);
            rec.bytes = 64;
            st.put(rec);
          });
          tx.oncomplete = () => res(all.result.length > 0);
        };
        all.onerror = () => res(false);
      };
    });
    window.__ink = () => {
      const c = document.getElementById('nes-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 20 || d[i + 1] > 20 || d[i + 2] > 20) n++;
      return n;
    };
  });

  await page.goto('http://localhost:7890/nes-console/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // 先在游戏里存一档，作为后面要读的对象。
  // startGame 会等到「菜单关了、核心真在出帧」，理由见 lib-game-menu.cjs 注释。
  check('基线：游戏能启动（Destiny）', await startGame(page, 'Destiny'));
  await page.evaluate(async () => { await window.__key('Escape', 300); window.__click('保存存档'); await window.__sleep(900); });
  const saved = await page.evaluate(() => window.__status());
  check('基线：游戏里能存一档', saved.includes('已保存到'), saved);

  console.log('\n【A) 游戏没在跑，从存档列表读档】');
  await page.evaluate(async () => { window.__click('退出到主菜单'); await window.__sleep(700); });
  const exited = await page.evaluate(() => window.__status());
  check('基线：已退出到主菜单（游戏不在跑）', exited.includes('已退出'), exited);

  // 再刷新一次：这次一款游戏都没进过，但清单（games.json）里就带 ROM 哈希，
  // 存档是按哈希存的，所以「管理存档」不用把 ROM 下载一遍也能列出有存档的游戏。
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  const list = await page.evaluate(async () => {
    window.__nav('游戏管理');
    await window.__sleep(400);
    window.__click('管理存档');
    await window.__sleep(2500);
    return {
      title: window.__title(),
      // 数量从顶栏右端搬到了菜单左下角（.sys-count）
      count: document.querySelector('.sys-ui .sys-count')?.textContent || '',
      rows: window.__rows(),
    };
  });
  check('没进过游戏也能列出有存档的游戏（哈希不靠跑过游戏才有）',
    list.count.includes('1 款游戏有存档') && list.rows.length === 1,
    `数量="${list.count}" 行=${JSON.stringify(list.rows)}`);

  const gameName = list.rows[0]?.label;
  const slots = await page.evaluate(async (g) => {
    window.__click(g);
    await window.__sleep(900);
    return { title: window.__title(), rows: window.__rows() };
  }, gameName);
  check('能进这款游戏的存档列表', slots.title === '存档列表', slots.title);
  const filled = slots.rows.find((r) => r.sub && r.sub !== '空');
  check('列表里能看到刚存的那一格', !!filled, JSON.stringify(slots.rows.slice(0, 3)));

  const readBack = await page.evaluate(async (slot) => {
    // 有存档的槽位按 A 先进「槽位操作」，里面第一项就是「读取存档」
    window.__click(slot);
    await window.__sleep(400);
    window.__click('读取存档');
    const status = await window.__waitToast('已读取');
    await window.__sleep(1800);          // 再等画面真跑起来，ink 才量得到
    return {
      status,
      uiHidden: document.querySelector('.sys-ui').hidden,
      ink: window.__ink(),
    };
  }, filled.label);
  check('点槽位会先把游戏带起来再读档（不是「请先启动游戏」）',
    readBack.status.includes('已读取'), `状态栏="${readBack.status}"`);
  check('读档后菜单关闭、画面在跑',
    readBack.uiHidden === true && readBack.ink > 1000,
    `hidden=${readBack.uiHidden} ink=${readBack.ink}`);

  console.log('\n【B) 核心不认的存档】');
  const corrupted = await page.evaluate(() => window.__corrupt());
  check('基线：能把库里的存档字节换成来路不对的数据', corrupted === true, String(corrupted));

  const bogus = await page.evaluate(async () => {
    await window.__key('Escape', 300);          // 游戏在跑，呼出快速菜单
    window.__click('存档管理');
    await window.__sleep(900);
    const filledRow = window.__rows().find((r) => r.sub && r.sub !== '空');
    // 点这一行 = 进「槽位操作」。读不进去时菜单不关，详情面板会停在这一行上，
    // 所以点完再一起取「详情 + 状态栏」。
    window.__click(filledRow.label);
    await window.__sleep(400);
    window.__click('读取存档');
    const status = await window.__waitToast('核心拒绝了');
    return {
      label: filledRow.label,
      detail: (document.querySelector('.sys-detail')?.textContent || '').trim(),
      status,
      uiHidden: document.querySelector('.sys-ui').hidden,
    };
  });
  check('坏存档仍正常列在槽位里（详情有时间、有大小）',
    bogus.detail.includes('时间') && bogus.detail.includes('大小'), bogus.detail);
  check('读不进去时给得出人话原因',
    bogus.status.includes('核心拒绝了'), `状态栏="${bogus.status}"`);
  check('失败时不关菜单、不抛裸异常', bogus.uiHidden === false, String(bogus.uiHidden));

  console.log('\n【错误汇总】');
  check('全程无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e); process.exit(1); });
