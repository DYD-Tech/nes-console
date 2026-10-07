/**
 * 游戏管理
 *
 * 管理游戏列表：内置游戏 + 用户加载的 ROM，以及「当前运行哪个游戏」。
 *
 * 为什么把游戏列表独立成一个模块：
 * 列表来源会越来越多（内置、本机文件），
 * 而「怎么渲染列表」和「怎么运行游戏」是两件事。分开后，加一种来源
 * 不用动界面代码，改界面也不用碰加载逻辑。
 *
 * 对标：
 * - RetroArch 的「播放列表」（playlist）概念：游戏条目和运行状态分离，
 *   条目里带元数据（名称、系统、发行信息），运行由核心负责。
 *   本模块的 Game 对象沿用这个划分。
 */

import { computeROMHash, getSaveStates, deleteState, saveROM, listROMs, deleteROM } from './storage.js';

/**
 * 内置游戏从哪来：
 * 把 .nes 文件丢进 `public/rom/`，构建时 `src/integrations/rom-catalog.js`
 * 扫这个目录生成 `public/games.json`，启动时 fetch 这份清单（见 loadBuiltIn）。
 *
 * 为什么是「清单 + 按需 fetch」而不是启动时全下载：
 * ROM 一个就几百 KB 到 2 MB，全下载会拖慢首屏；而且玩家通常只玩其中一个。
 * 清单只有元数据（每款一行），点击时才去取实际文件。
 *
 * 浏览器不能列目录，所以清单必须构建时生成 —— 改完 ROM 目录要重新
 * `npm run dev` / `npm run build`（这个集成挂在两条命令的启动钩子上，都会刷新清单）。
 *
 * 版权：这个目录里的 ROM 会随 dist/ 一起发布。只有自制游戏、公有领域作品
 * 才能放进来；商业游戏的 ROM 有版权，自己本地玩请走「游戏管理 → 加入游戏」
 * （存 IndexedDB，不进站点）。
 */

/**
 * 内置 ROM 的补充元数据：中文译名、年份、类型、发行商、简介。
 *
 * 这些字段推不出来（文件名里只有名字），所以手工维护；
 * 键用 ROM 的内容哈希（= 清单里的 id），文件名怎么改都能对上。
 * 换了另一个 dump（内容变了）就得重新补一条，这是应该的：那是另一份文件。
 */
const BUILT_IN_META = {
  // Destiny of an Emperor (U).nes
  '88d5498b_40010': {
    name: 'Destiny of an Emperor',
    nameZh: '吞食天地',
    year: 1989,
    genre: '策略 RPG',
    publisher: 'Capcom',
    description: '以三国为背景的策略角色扮演游戏。收服武将、组建军队，在战场上推进统一大业。',
  },
};

/**
 * 游戏对象：
 * {
 *   id: string,         唯一标识（内置与用户 ROM 都用内容哈希）
 *   name: string,       显示名称
 *   hash: string|null,  内容哈希（用户 ROM 加入时就有；内置来自清单）
 *   size: number|null,  文件大小（同上）
 *   data: Uint8Array|null, ROM 数据（加载后才填充）
 *   isBuiltIn: boolean,
 *   year, genre, publisher, description  元数据，可能为空
 * }
 */

export class GameManager {
  /**
   * @param {object} opts
   * @param {string} [opts.basePath] - 静态资源前缀，清单与内置 ROM 的相对路径基于它
   * @param {function} [opts.onStatus] - 状态提示回调
   */
  constructor(opts = {}) {
    this.basePath = opts.basePath || '/';
    this.onStatus = opts.onStatus || (() => {});

    // 列表起步是空的：内置游戏要等 loadBuiltIn() 把清单取回来才有内容。
    this.games = [];
    this.currentGame = null;
  }

  /**
   * 读构建时生成的内置游戏清单（public/games.json），把内置游戏灌进列表。
   *
   * 放在启动流程里调用一次。已经在本机 IndexedDB 里存过的同一份 ROM 不重复加，
   * 否则列表里会出现两行一样的游戏（一行「内置」、一行「已加载」）。
   *
   * @returns {Promise<number>} 加了几款
   */
  async loadBuiltIn() {
    const resp = await fetch(this.basePath + 'games.json');
    if (!resp.ok) throw new Error(`读取游戏清单失败 HTTP ${resp.status}`);
    const catalog = await resp.json();

    const incoming = catalog.filter(
      (item) => !this.games.some((g) => g.hash === item.id),
    );
    // 内置排在前面：列表是「先游戏库、后本机加入」的顺序，刷新前后位置一致。
    this.games = [...incoming.map((item) => this._toBuiltIn(item)), ...this.games];
    return incoming.length;
  }

  /** 清单项 + 补充元数据 -> Game 对象 */
  _toBuiltIn(item) {
    const meta = BUILT_IN_META[item.id] || {};
    return {
      id: item.id,
      name: meta.name || item.name,
      nameZh: meta.nameZh || null,
      hash: item.id,
      size: item.size,
      data: null,
      isBuiltIn: true,
      year: meta.year ?? null,
      genre: meta.genre ?? null,
      publisher: meta.publisher ?? null,
      description: meta.description ?? null,
      _url: this.basePath + item.url,
    };
  }

  /** 全部游戏 */
  getGames() {
    return this.games;
  }

  /** 当前运行的游戏，未运行时为 null */
  getCurrentGame() {
    return this.currentGame;
  }

  /** 按 id 找游戏 */
  getGame(id) {
    return this.games.find((g) => g.id === id) || null;
  }

  /**
   * 确保游戏的 ROM 数据已加载。
   * 内置游戏首次调用时去 fetch；用户 ROM 加入列表时就已经有数据了。
   *
   * @param {string} id
   * @returns {Promise<Uint8Array>}
   */
  async ensureLoaded(id) {
    const game = this.getGame(id);
    if (!game) throw new Error(`游戏不存在: ${id}`);
    if (game.data) return game.data;

    this.onStatus(`正在加载 ${game.name}...`);
    const resp = await fetch(game._url);
    if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);

    game.data = new Uint8Array(await resp.arrayBuffer());
    return game.data;
  }

  /**
   * 加入一个用户提供的 ROM（本机文件或拖拽）。
   * 同一份 ROM（内容哈希相同）不会重复加入，避免列表里出现两遍。
   *
   * 加入即落盘（storage.js 的 roms store），刷新页面后还在。
   * 先落盘再进列表：存不进去（比如浏览器配额满）就当没加入，
   * 否则列表里有一项、刷新后消失，用户会以为程序吞了他的游戏。
   *
   * @param {Uint8Array} data
   * @param {string} fileName
   * @returns {Promise<object>} 加入的（或已存在的）游戏对象
   */
  async addUserROM(data, fileName) {
    const hash = computeROMHash(data);
    const existing = this.games.find((g) => g.hash === hash);
    if (existing) return existing;

    const name = fileName.replace(/\.nes$/i, '');
    const game = {
      id: hash,
      name,
      nameZh: null,
      hash,
      size: data.length,
      data,
      isBuiltIn: false,
      year: null,
      genre: null,
      publisher: null,
      description: null,
    };
    await saveROM({ hash, name, data });
    this.games.push(game);
    return game;
  }

  /**
   * 把上次存进库里的用户 ROM 读回列表（启动时调用一次）。
   *
   * 为什么需要：ROM 只在内存里时，刷新一次列表就回到「只剩内置游戏」，
   * 不存下来用户白下一遍。这一步让「加入过」这件事跨刷新成立。
   *
   * @returns {Promise<number>} 恢复了几款
   */
  async restoreROMs() {
    const stored = await listROMs();
    let added = 0;
    for (const rom of stored) {
      if (this.games.some((g) => g.hash === rom.hash)) continue;
      this.games.push({
        id: rom.hash,
        name: rom.name,
        nameZh: null,
        hash: rom.hash,
        size: rom.size,
        data: rom.data,
        isBuiltIn: false,
        year: null,
        genre: null,
        publisher: null,
        description: null,
      });
      added++;
    }
    return added;
  }

  /** 标记当前运行的游戏 */
  setCurrent(game) {
    this.currentGame = game;
  }

  /** 清除当前运行状态 */
  clearCurrent() {
    this.currentGame = null;
  }

  /**
   * 删除用户加载的游戏（内置游戏不可删除）。
   * 同时删除该游戏的存档和落盘的 ROM 本体。
   * @param {string} id
   * @returns {Promise<void>}
   */
  async removeUserGame(id) {
    const game = this.getGame(id);
    if (!game) throw new Error(`游戏不存在: ${id}`);
    if (game.isBuiltIn) throw new Error('内置游戏不可删除');

    // 删除该游戏的存档
    if (game.hash) {
      const states = await getSaveStates(game.hash);
      for (const s of states) {
        await deleteState(game.hash, s.slot);
      }
      await deleteROM(game.hash);
    }

    // 从列表移除
    this.games = this.games.filter((g) => g.id !== id);

    // 如果正在运行这个游戏，清除当前状态
    if (this.currentGame?.id === id) {
      this.currentGame = null;
    }
  }
}
