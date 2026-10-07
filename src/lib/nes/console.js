/**
 * 模拟器对外的门面：app.js 只认这一层，换核心（fceumm → 别的 libretro 核心）
 * 时改动都收在 libretro-host.js 里。
 *
 * 接线时要知道的三件事：
 *  1. 控制器端口从 **0** 开始（libretro 的编号规则）。
 *  2. 按钮常量是 libretro 的 `BUTTON`（B/Y/SELECT/START/UP/DOWN/LEFT/RIGHT/A/X…）；
 *     界面只认动作名，这套编号只在模拟器这一侧出现。
 *  3. 存档是**二进制**：getState() 给一个 RASTATE 字节串（= RetroArch 的 .state，
 *     桌面端能直接读），loadState() 收同一种字节串。
 */
import { LibretroHost, BUTTON } from './libretro-host.js';
import { wrapRASTATE, unwrapRASTATE } from './rastate.js';

// NES 屏幕分辨率（fceumm 上报的 baseWidth/baseHeight 就是这个；PAL 机型不变）
export const SCREEN_WIDTH = 256;
export const SCREEN_HEIGHT = 240;

/** 核心产物由 scripts/build-core.cjs 编到 public/cores/，Astro 原样拷贝，不参与打包 */
const CORE_URL = () => `${import.meta.env.BASE_URL}cores/fceumm_libretro.mjs`;

export class NesConsole {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onStatus?:Function, onCrash?:Function}} [opts]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.onStatus = opts.onStatus || (() => {});
    this.onCrash = opts.onCrash || (() => {});
    this.host = new LibretroHost(canvas, {
      coreUrl: CORE_URL(),
      onStatus: this.onStatus,
      onCrash: opts.onCrash,
    });
    this._core = null;      // 核心加载的 Promise，失败后清掉好重试
    this.romLoaded = false;
  }

  /**
   * 加载 wasm 核心（约 800 KB）。页面启动时调一次，把加载耗时藏在选游戏之前；
   * loadROM() 也会 await 同一个 Promise，所以这里没完成也不影响正确性。
   */
  init() {
    if (this._core) return this._core;
    this._fillBlack();
    this._core = this.host.init().catch((e) => {
      this._core = null; // 清掉缓存的失败 Promise，让调用方可以重试
      throw new Error(`模拟器核心加载失败：${e.message}`);
    });
    return this._core;
  }

  /** 首帧之前画一屏黑：canvas 默认是全透明，在深色界面外会露出底色 */
  _fillBlack() {
    const ctx = this.canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width || SCREEN_WIDTH, this.canvas.height || SCREEN_HEIGHT);
  }

  /**
   * 加载 ROM 并开始运行。异步：核心要等 wasm 编译好，音频出口要等 AudioWorklet
   * 真被调度起来（否则开局一秒的样本全堆在队列里溢出，实测丢 6016 帧）。
   *
   * @param {Uint8Array} romData
   * @param {string} [name]
   * @param {Uint8Array} [sram] 电池存档，会在第一帧之前灌进卡带的电池 RAM
   */
  async loadROM(romData, name = 'unknown', sram = null) {
    await this.init();
    this.romLoaded = false;
    const ok = await this.host.loadROM(romData, name, sram);
    this.romLoaded = ok;
    return ok;
  }

  start() { this.host.start(); }

  /**
   * 暂停：不再跑帧、松开所有键、丢掉已排队的音频，但保留核心状态。
   *
   * 松键是暂停语义的一部分，不是调用方的责任：暂停期间按键被界面消费，游戏收不到
   * buttonUp，那些键会一直保持按下 —— 玩家按 Start 开菜单，回到游戏时 Start 仍是
   * 按下状态（游戏会认为一直暂停着）。实测过这个卡键。
   */
  pause() { this.host.pause(); }

  /** 彻底停止（退出游戏、换 ROM 时用）：断开音频节点并关闭上下文 */
  stop() {
    this.host.stop();
    this.romLoaded = false;
  }

  /** 相当于按主机上的 RESET 键 */
  reset() {
    if (!this.romLoaded) return;
    this.host.reset();
    this.onStatus('已重置');
  }

  /**
   * 当前即时存档（RASTATE 字节串，可直接落盘给 RetroArch 用）。
   * @returns {Uint8Array|null}
   */
  getState() {
    if (!this.romLoaded) return null;
    const core = this.host.serialize();
    return core ? wrapRASTATE(core) : null;
  }

  /** 失败一律抛异常，把原因交给调用方显示，别只留「读取失败」四个字 */
  loadState(state) {
    if (!state || !state.length) throw new Error('存档数据是空的');
    if (!this.romLoaded) throw new Error('要先启动游戏才能读档');
    this.host.unserialize(unwrapRASTATE(state));
  }

  /** 电池存档（游戏自己写的进度，.srm 就是这段裸字节）；没有电池 RAM 的游戏返回 null */
  saveRam() {
    return this.romLoaded ? this.host.saveRam() : null;
  }

  loadRam(bytes) {
    if (!this.romLoaded) throw new Error('要先启动游戏才能写入电池存档');
    this.host.loadRam(bytes);
  }

  /** @param {number} controller 0 或 1 @param {number} button BUTTON.* */
  buttonDown(controller, button) { this.host.buttonDown(controller, button); }
  buttonUp(controller, button) { this.host.buttonUp(controller, button); }

  setVolume(value) { this.host.setVolume(value); }
  setMuted(muted) { this.host.setMuted(muted); }

  /** 手动跑 n 帧（暂停状态下用，回归脚本要靠它精确对齐帧） */
  step(n = 1) { this.host.step(n); }

  destroy() {
    this.host.destroy();
    this._core = null;
    this.romLoaded = false;
  }
}

export { BUTTON };
