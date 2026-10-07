/**
 * 快档测试：src/lib/game-manager.js（游戏列表：内置清单 + 本机 ROM + 当前运行）
 *
 * 这个模块只碰两个浏览器 API：fetch（取清单、下载 ROM）和 IndexedDB
 * （通过 storage.js 落盘 ROM 与存档），所以两个都用最小替身补上就够了 ——
 * 不用起站点，也不用先 npm run build。
 *
 * IndexedDB 替身按被测代码实际用到的那几件事实现：
 * open(name, version) 触发 onupgradeneeded、objectStore 的 put/get/getAll/delete、
 * 读写模式（只读事务里写要报错，跟真库一致）、以及「存进去的是副本」
 * （真库走结构化克隆，替身也用 structuredClone，否则测试会因为共享引用而假绿）。
 *
 * 跑法：node agent-workspace/test-game-manager.cjs
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

// ---------- IndexedDB 替身 ----------
const idbState = { writesFail: false };

function newRequest() {
  return { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
}
function succeed(req, result) {
  req.result = result;
  setTimeout(() => { if (req.onsuccess) req.onsuccess({ target: req }); }, 0);
  return req;
}

class FakeStore {
  constructor(name, keyPath, writable) {
    this.name = name;
    this.keyPath = keyPath;
    this.writable = writable;
    this.rows = null; // 只读事务下不给写
  }
  _guard(op) {
    if (!this.writable) throw new Error(`ReadOnlyError: 只读事务里不能 ${op}`);
    if (idbState.writesFail) throw new Error('QuotaExceededError: 磁盘配额已满');
  }
  put(value) {
    this._guard('put');
    const copy = structuredClone(value);
    this.rows.set(copy[this.keyPath], copy);
    return succeed(newRequest(), copy[this.keyPath]);
  }
  get(key) {
    const hit = this.rows.get(key);
    return succeed(newRequest(), hit === undefined ? undefined : structuredClone(hit));
  }
  getAll() {
    return succeed(newRequest(), [...this.rows.values()].map((v) => structuredClone(v)));
  }
  delete(key) {
    this._guard('delete');
    this.rows.delete(key);
    return succeed(newRequest(), undefined);
  }
}

class FakeDB {
  constructor(name) {
    this.name = name;
    this.version = 0;
    this.stores = new Map();
  }
  get objectStoreNames() {
    const names = this.stores;
    return { contains: (n) => names.has(n), item: (i) => [...names.keys()][i] ?? null };
  }
  createObjectStore(name, opts = {}) {
    const s = new FakeStore(name, opts.keyPath, true);
    s.rows = new Map();
    this.stores.set(name, s);
    return s;
  }
  deleteObjectStore(name) { this.stores.delete(name); }
  transaction(name, mode = 'readonly') {
    const store = this.stores.get(name);
    if (!store) throw new Error(`NotFoundError: 没有 objectStore「${name}」`);
    const view = new FakeStore(name, store.keyPath, mode === 'readwrite');
    view.rows = store.rows;
    return { objectStore: () => view, mode };
  }
}

const dbs = new Map();
global.indexedDB = {
  open(name, version) {
    const req = newRequest();
    let db = dbs.get(name);
    if (!db) { db = new FakeDB(name); dbs.set(name, db); }
    if (version && version > db.version) {
      db.version = version;
      setTimeout(() => {
        if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
    } else {
      setTimeout(() => { if (req.onsuccess) req.onsuccess({ target: req }); }, 0);
    }
    req.result = db;
    return req;
  },
};

// ---------- fetch 替身 ----------
// routes: URL -> { json } | { bytes } | { status }（status 非 200 即「没取到」）
const routes = new Map();
const fetched = [];
global.fetch = async (url) => {
  fetched.push(url);
  const r = routes.get(url);
  const ok = !!r && (!r.status || r.status === 200);
  const status = r && r.status ? r.status : ok ? 200 : 404;
  return {
    ok,
    status,
    json: async () => structuredClone(r.json),
    arrayBuffer: async () => {
      const b = new Uint8Array(r.bytes);
      return b.slice().buffer; // 给 ArrayBuffer 本体
    },
  };
};

const MOD = path.join(__dirname, '..', 'src', 'lib', 'game-manager.js');
const bytes = (...a) => Uint8Array.from(a);
const text = (s) => new TextEncoder().encode(s);

(async () => {
  const { GameManager } = await import(pathToFileURL(fs.realpathSync(MOD)).href);
  const storage = await import(
    pathToFileURL(path.join(fs.realpathSync(path.dirname(MOD)), 'storage.js')).href
  );

  const CATALOG = [
    { id: 'a34e46d0_40010', name: '街头霸王', url: 'rom/streetfighter.nes', size: 262160 },
    // 这一条命中 BUILT_IN_META（Destiny of an Emperor / 吞食天地）
    { id: '88d5498b_40010', name: 'Destiny of an Emperor (U)', url: 'rom/destiny.nes', size: 262160 },
  ];

  const BASE = '/nes-console/';
  const mk = () => {
    const statuses = [];
    const gm = new GameManager({ basePath: BASE, onStatus: (s) => statuses.push(s) });
    return { gm, statuses };
  };

  // ---------- 1. 新建 ----------
  {
    const fresh = new GameManager();
    check('新建时列表是空的（内置要等清单取回来）', fresh.getGames().length === 0);
    check('新建时没有正在运行的游戏', fresh.getCurrentGame() === null);
    check('默认 basePath 是 "/"', fresh.basePath === '/');
  }

  // ---------- 2. loadBuiltIn ----------
  routes.set(BASE + 'games.json', { json: CATALOG });
  {
    const { gm } = mk();
    const n = await gm.loadBuiltIn();
    check('loadBuiltIn 返回清单里的款数', n === 2, `实得 ${n}`);
    check('清单地址 = basePath + "games.json"', fetched[fetched.length - 1] === BASE + 'games.json',
      `实得 ${fetched[fetched.length - 1]}`);
    const g = gm.getGames()[0];
    check('内置项 isBuiltIn = true', g.isBuiltIn === true);
    check('内置项 id 与 hash 都用清单项的 id', g.id === CATALOG[0].id && g.hash === CATALOG[0].id);
    check('内置项 size 取自清单', g.size === 262160, `实得 ${g.size}`);
    check('内置项 data 起步为 null（启动时不预下载 ROM）', g.data === null);
    check('内置项下载地址 = basePath + 清单项 url', g._url === BASE + CATALOG[0].url, `实得 ${g._url}`);
    check('没有补充元数据时显示名用清单项的名字', g.name === '街头霸王');
    check('没有补充元数据时中文译名等字段为 null',
      g.nameZh === null && g.year === null && g.genre === null && g.publisher === null && g.description === null);

    const d = gm.getGames()[1];
    check('命中补充元数据时显示名换成元数据里的', d.name === 'Destiny of an Emperor', `实得 ${d.name}`);
    check('命中补充元数据时补上中文译名', d.nameZh === '吞食天地', `实得 ${d.nameZh}`);
    check('命中补充元数据时补上年份/类型/发行商',
      d.year === 1989 && d.genre === '策略 RPG' && d.publisher === 'Capcom');
    check('命中补充元数据时补上简介', typeof d.description === 'string' && d.description.includes('三国'));

    const before = gm.getGames().length;
    const again = await gm.loadBuiltIn();
    check('重复调用 loadBuiltIn 不重复添加', again === 0 && gm.getGames().length === before,
      `实得 ${again} / ${gm.getGames().length}`);
  }

  // ---------- 3. 默认 basePath 下的清单地址 ----------
  {
    routes.set('/games.json', { json: CATALOG.slice(0, 1) });
    const gm = new GameManager();
    await gm.loadBuiltIn();
    check('不传 basePath 时清单地址是 /games.json',
      fetched[fetched.length - 1] === '/games.json', `实得 ${fetched[fetched.length - 1]}`);
    check('不传 basePath 时下载地址是 /rom/…',
      gm.getGames()[0]._url === '/rom/streetfighter.nes', `实得 ${gm.getGames()[0]._url}`);
  }

  // ---------- 4. 清单取不到 ----------
  routes.set('/broken/games.json', { status: 500 });
  {
    const gm = new GameManager({ basePath: '/broken/' });
    const e = await gm.loadBuiltIn().catch((x) => x);
    check('清单 500 时抛错，不静默给空列表', e instanceof Error, `实得 ${e}`);
    check('错误文案带上 HTTP 状态码', /HTTP 500/.test(String(e && e.message)), `实得 ${e && e.message}`);
    check('清单取失败后列表还是空的', gm.getGames().length === 0);
  }

  // ---------- 5. 内置不覆盖本机已有的同一份 ROM ----------
  {
    const hash = storage.computeROMHash(bytes(1, 2, 3, 4));
    routes.set('/dup/games.json', { json: [{ id: hash, name: '同一份ROM换了名字', url: 'rom/dup.nes', size: 4 }] });
    const gm = new GameManager({ basePath: '/dup/' });
    await gm.addUserROM(bytes(1, 2, 3, 4), '本机已有.nes');
    const added = await gm.loadBuiltIn();
    check('本机已存过同一份 ROM 时，内置清单不重复加一行',
      added === 0 && gm.getGames().length === 1, `实得 ${added} / ${gm.getGames().length}`);
    check('那一行保持为本机加入的，没被内置那行顶掉', gm.getGames()[0].isBuiltIn === false);
  }

  // ---------- 6. 内置排在最前 ----------
  {
    const { gm } = mk();
    await gm.addUserROM(bytes(9, 8, 7, 6), 'user.nes');
    await gm.loadBuiltIn();
    const names = gm.getGames().map((g) => g.isBuiltIn);
    check('内置游戏排在列表最前（本机加入的在后面）',
      names[0] === true && names[1] === true && names[2] === false, JSON.stringify(names));
  }

  // ---------- 7. getGame / 当前运行 ----------
  {
    const { gm } = mk();
    await gm.loadBuiltIn();
    const target = gm.getGames()[0];
    check('getGame 按 id 能找到', gm.getGame(target.id) === target);
    check('getGame 找不到时返回 null，不是 undefined', gm.getGame('nope') === null);
    gm.setCurrent(target);
    check('setCurrent 后 getCurrentGame 就是它', gm.getCurrentGame() === target);
    gm.clearCurrent();
    check('clearCurrent 后又变成 null', gm.getCurrentGame() === null);
  }

  // ---------- 8. ensureLoaded ----------
  {
    const { gm, statuses } = mk();
    await gm.loadBuiltIn();
    const game = gm.getGames()[0];
    const romBytes = bytes(...Array.from({ length: 64 }, (_, i) => i));
    routes.set(game._url, { bytes: romBytes });
    const got = await gm.ensureLoaded(game.id);
    check('ensureLoaded 下载地址就是那一项的 _url',
      fetched[fetched.length - 1] === game._url, `实得 ${fetched[fetched.length - 1]}`);
    check('ensureLoaded 返回 ROM 字节', got.length === 64 && got[10] === 10);
    check('ensureLoaded 期间报了一句进度', statuses.length === 1 && statuses[0] === `正在加载 ${game.name}...`,
      JSON.stringify(statuses));
    check('ROM 存进了这一项，下次不用再下', gm.getGame(game.id).data !== null);
    const countBefore = fetched.length;
    const again = await gm.ensureLoaded(game.id);
    check('第二次调用不再发请求', fetched.length === countBefore, `实得 ${fetched.length}`);
    check('第二次调用返回同一份数据', again === got);
    const e = await gm.ensureLoaded('不存在的id').catch((x) => x);
    check('ensureLoaded 找不到游戏时抛「游戏不存在」', e instanceof Error && /游戏不存在/.test(e.message),
      `实得 ${e && e.message}`);
    routes.set(BASE + 'rom/gone.nes', { status: 404 });
    const gm3 = new GameManager({ basePath: BASE });
    gm3.games.push({ id: 'x', name: 'gone', hash: 'x', size: 1, data: null, isBuiltIn: true, _url: BASE + 'rom/gone.nes' });
    const e3 = await gm3.ensureLoaded('x').catch((x) => x);
    check('ROM 下载失败时抛「下载失败 HTTP 404」', e3 instanceof Error && /下载失败 HTTP 404/.test(e3.message),
      `实得 ${e3 && e3.message}`);
  }

  // ---------- 9. addUserROM ----------
  {
    const { gm } = mk();
    const rom = text('a');
    const added = await gm.addUserROM(rom, '超级玛丽.nes');
    check('加入后 id 用内容哈希（FNV-1a 32，与公开测试向量一致）',
      added.id === 'e40c292c_1', `实得 ${added.id}`);
    check('哈希算法与构建清单用的是同一个函数',
      added.id === storage.computeROMHash(rom));
    check('显示名去掉 .nes 后缀', added.name === '超级玛丽', `实得 ${added.name}`);
    check('大写 .NES 后缀也去掉', (await gm.addUserROM(bytes(5, 5, 5, 5), 'B.NES')).name === 'B');
    check('用户 ROM 的 isBuiltIn = false', added.isBuiltIn === false);
    check('用户 ROM 的 size = 字节数', (await gm.addUserROM(bytes(1, 1), 'two.nes')).size === 2);
    const lenBefore = gm.getGames().length;
    const dup = await gm.addUserROM(text('a'), '改了名字还是同一份.nes');
    check('同一份 ROM 重复加入返回已有那一项', dup.name === '超级玛丽', `实得 ${dup.name}`);
    check('同一份 ROM 重复加入不会多出一行', gm.getGames().length === lenBefore);
    const stored = await storage.listROMs();
    check('加入即落盘：库里能读到这份 ROM', stored.some((r) => r.hash === 'e40c292c_1'),
      JSON.stringify(stored.map((r) => r.hash)));

    idbState.writesFail = true;
    const err = await gm.addUserROM(bytes(7, 7, 7), '存不进去.nes').catch((e) => e);
    idbState.writesFail = false;
    check('落盘失败时 addUserROM 抛错', err instanceof Error, `实得 ${err}`);
    check('落盘失败时不进列表（不留下刷新就消失的幽灵条目）',
      !gm.getGames().some((g) => g.name === '存不进去'),
      JSON.stringify(gm.getGames().map((g) => g.name)));
  }

  // ---------- 10. restoreROMs ----------
  {
    const gm = new GameManager({ basePath: BASE });
    const n = await gm.restoreROMs();
    check('restoreROMs 把库里的 ROM 读回列表', n >= 1, `实得 ${n}`);
    const one = gm.getGames().find((g) => g.hash === 'e40c292c_1');
    check('恢复出来的项 isBuiltIn = false', one && one.isBuiltIn === false);
    check('恢复出来的项 data 是可用的 Uint8Array', one && one.data instanceof Uint8Array && one.data[0] === 0x61);
    check('恢复出来的项 name 用落盘时那个', one && one.name === '超级玛丽', `实得 ${one && one.name}`);
    const again = await gm.restoreROMs();
    check('已经在列表里的不再重复恢复', again === 0);
    const lenBefore = gm.getGames().length;
    await gm.addUserROM(text('a'), '同内容.nes');
    check('恢复出来的项再按同一内容加入也不会多一行', gm.getGames().length === lenBefore);
  }

  // ---------- 11. removeUserGame ----------
  {
    const { gm } = mk();
    const doomed = await gm.addUserROM(bytes(2, 4, 6, 8), '要删的.nes');
    const keeper = await gm.addUserROM(bytes(3, 6, 9, 12), '留下的.nes');
    await storage.saveState(doomed.hash, 'slot_0', bytes(1));
    await storage.saveState(doomed.hash, 'auto', bytes(2));
    await storage.saveState(keeper.hash, 'slot_1', bytes(3));
    gm.setCurrent(doomed);
    await gm.removeUserGame(doomed.id);

    check('删除后不在列表里了', gm.getGame(doomed.id) === null);
    check('删除正在运行的游戏时会一并清掉当前运行状态', gm.getCurrentGame() === null);
    check('ROM 本体也从库里删掉了', (await storage.listROMs()).every((r) => r.hash !== doomed.hash));
    check('该游戏的即时存档全清了（含自动存档槽）',
      (await storage.getSaveStates(doomed.hash)).length === 0,
      JSON.stringify(await storage.getSaveStates(doomed.hash)));
    check('别的游戏的存档没被牵连',
      (await storage.getSaveStates(keeper.hash)).length === 1);
    check('留下的那项还在列表里', gm.getGame(keeper.id) !== null);

    await gm.loadBuiltIn();
    const builtin = gm.getGames().find((g) => g.isBuiltIn);
    const e = await gm.removeUserGame(builtin.id).catch((x) => x);
    check('内置游戏不可删除', e instanceof Error && e.message === '内置游戏不可删除', `实得 ${e && e.message}`);
    check('删除被拒后内置游戏仍在列表里', gm.getGame(builtin.id) !== null);
    const e2 = await gm.removeUserGame('没这个id').catch((x) => x);
    check('删除不存在的 id 抛「游戏不存在」', e2 instanceof Error && /游戏不存在/.test(e2.message),
      `实得 ${e2 && e2.message}`);
  }

  // ---------- 12. 只读事务不给写 ----------
  {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('nes-console', 3);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const store = db.stores.get('savestates');
    const view = new FakeStore('savestates', store.keyPath, false);
    view.rows = store.rows;
    let threw = null;
    try { view.put({ key: 'k' }); } catch (e) { threw = e; }
    check('替身按只读事务拦写（跟真库一致，防止测试假绿）', threw instanceof Error, `实得 ${threw}`);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
