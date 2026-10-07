/**
 * libretro ABI 宿主：把编译进来的 wasm 核心（fceumm）接到 canvas + Web Audio 上。
 *
 * 常量与结构偏移全部对着核心源码树里的那份 libretro.h
 * （third_party/libretro-fceumm/src/drivers/libretro/libretro-common/include），
 * 实测行为记录在 agent-workspace/note-fceumm-wasm.md。
 *
 * 这个文件只管 ABI：结构体读写、回调、帧循环、音频出口。游戏语义（端口从 0 起、
 * 存档是什么格式）由 console.js 那一层对外解释。
 */

// RETRO_DEVICE_ID_JOYPAD_*（libretro.h:320-371）
export const BUTTON = {
  B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
  A: 8, X: 9, L: 10, R: 11, L2: 12, R2: 13, L3: 14, R3: 15,
};

// RETRO_MEMORY_*（libretro.h:510-518）
const MEM_SAVE_RAM = 0;
// enum retro_pixel_format（libretro.h:5901-5914）
const PIX_XRGB8888 = 1;

const ENV = {
  SET_MESSAGE: 6,
  GET_SYSTEM_DIRECTORY: 9,
  SET_PIXEL_FORMAT: 10,
  GET_VARIABLE: 15,
  GET_VARIABLE_UPDATE: 17,
  GET_LOG_INTERFACE: 27,
  GET_SAVE_DIRECTORY: 31,
  SET_SYSTEM_AV_INFO: 32,
  SET_GEOMETRY: 37,
  GET_INPUT_BITMASKS: 51 | 0x10000,
};

const RETRO_DEVICE_JOYPAD = 1;

/**
 * 音频队列常年保持的帧数。定 2048（约 43 ms @48k）是量出来的，不是拍的：
 * 目标定 1024（21 ms）时，主线程一次两帧的停顿就能把环抽干，
 * 实测每款都有 0.3~1.4% 的样本要靠补静音填（`agent-workspace/check-audio-drift.cjs`），
 * 听感就是偶发的「嗒」一声。提到 2048 后同样的跑帧抖动落在缓冲里，断音降到接近 0。
 * 多花的这 21 ms 相对浏览器自己的输出延迟（实测 `outputLatency` 约 48 ms）不是主角。
 *
 * 对标说明：RetroArch 的 Web 音频驱动（audio/drivers/audioworklet.c）按前端请求的
 * latency 取 2 的幂当容量，但「默认 latency 该是多少」这一条没能在离线源码里查实
 * （本机只有 fceumm 那份 libretro.h，RetroArch 源码要联网抓），所以这里以自测数据为准。
 */
const AUDIO_TARGET_FRAMES = 2048;

export class LibretroHost {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{coreUrl:string, onStatus?:Function, onCrash?:Function}} opts
   */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.coreUrl = opts.coreUrl;
    this.onStatus = opts.onStatus || (() => {});
    this.onCrash = opts.onCrash || (() => {});

    this.m = null;          // emscripten Module
    this.cb = {};           // addFunction 拿到的指针，destroy 时 removeFunction
    this.held = new Set();  // `${port}:${id}`
    this.frames = 0;
    this.running = false;
    this.rafId = null;
    this.romPath = null;

    this.pixelFormat = null;
    this.avInfo = { fps: 60, sampleRate: 48000, baseWidth: 256, baseHeight: 240 };

    this.audioCtx = null;
    this.workletNode = null;
    // 浏览器不给建音频出口时的原因（人话，直接拿去显示）。null = 声音正常。
    this.audioBlocked = null;
    // 核心按帧吐样本（一帧左右各一个），攒满一块再用 port 交给 AudioWorklet。
    // 环形缓冲在 worklet 那边，主线程只保留它回报的深度/欠载/丢弃计数。
    this.CHUNK_FRAMES = 1536;
    this.pending = new Float32Array(this.CHUNK_FRAMES * 2);
    this.pendingFrames = 0;
    this.audioSent = 0;
    this.audioStats = { depth: 0, written: 0, underrun: 0, dropped: 0 };
    this.srcRate = 48000;
    this._speed = 1;      // 跟着音频时钟微调的跑帧速度
    this._onAudioUp = null;
    this.volume = 0.8;
    this.muted = false;
  }

  // ---- 堆访问：ALLOW_MEMORY_GROWTH 会换掉 ArrayBuffer，视图每次重新取 ----
  get u8() { return this.m.HEAPU8; }
  get u32() { return this.m.HEAPU32; }

  _allocString(s) {
    const bytes = new TextEncoder().encode(s);
    const p = this.m._malloc(bytes.length + 1);
    this.u8.set(bytes, p);
    this.u8[p + bytes.length] = 0;
    return p;
  }

  _allocStruct(n) {
    const p = this.m._malloc(n);
    this.u32.fill(0, p >> 2, (p + n) >> 2);
    return p;
  }

  /**
   * struct retro_system_av_info（libretro.h:6633-6640）
   *   geometry{u32×4, f32 aspect_ratio} = 20 B，timing 因 double 对齐落在 24，
   *   timing{double fps, double sample_rate}，总 40 B。
   */
  _readAvInfo(ptr) {
    const dv = new DataView(this.m.HEAPU8.buffer, ptr, 40);
    return {
      baseWidth: dv.getUint32(0, true),
      baseHeight: dv.getUint32(4, true),
      fps: dv.getFloat64(24, true),
      sampleRate: dv.getFloat64(32, true),
    };
  }

  /** 加载并初始化核心：注册六个回调 + 环境回调 */
  async init() {
    if (this.m) return;
    const { default: createCore } = await import(/* @vite-ignore */ this.coreUrl);
    const m = await createCore();
    this.m = m;

    this.cb.env = m.addFunction((cmd, data) => this._environment(cmd, data), 'iii');
    this.cb.video = m.addFunction((data, w, h, pitch) => this._video(data, w, h, pitch), 'viiii');
    this.cb.audioSample = m.addFunction((l, r) => this._ringPush(l, r), 'vii');
    this.cb.audioBatch = m.addFunction((data, count) => this._audioBatch(data, count), 'iii');
    this.cb.inputPoll = m.addFunction(() => {}, 'v');
    this.cb.inputState = m.addFunction((port, device, index, id) => this._inputState(port, device, id), 'iiiii');

    m._retro_set_environment(this.cb.env);
    m._retro_set_video_refresh(this.cb.video);
    m._retro_set_audio_sample(this.cb.audioSample);
    m._retro_set_audio_sample_batch(this.cb.audioBatch);
    m._retro_set_input_poll(this.cb.inputPoll);
    m._retro_set_input_state(this.cb.inputState);
    m._retro_init();
    m._retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
    m._retro_set_controller_port_device(1, RETRO_DEVICE_JOYPAD);
  }

  _environment(cmd, data) {
    switch (cmd) {
      case ENV.SET_PIXEL_FORMAT:
        this.pixelFormat = this.u32[data >> 2];
        return this.pixelFormat === PIX_XRGB8888;
      case ENV.GET_SYSTEM_DIRECTORY:
      case ENV.GET_SAVE_DIRECTORY:
        // struct retro_{system,save}_directory { const char *path; }
        this.u32[data >> 2] = this._allocString('/');
        return true;
      case ENV.GET_VARIABLE_UPDATE:
        this.u8[data] = 0;
        return true;
      case ENV.GET_VARIABLE:
        return false; // 一律用核心默认选项
      case ENV.GET_INPUT_BITMASKS:
        // 回 false：本宿主的 input_state 只会按单个 id 回答 0/1，给不出一次性位掩码。
        // 这里绝不能凭「支持更好」回 true —— 回了 true，核心就只查 id=256
        // （RETRO_DEVICE_ID_JOYPAD_MASK，libretro.h:1793-1807），
        // 拿到的永远是 0，表现为**游戏完全收不到任何按键**且没有任何报错
        // （fceumm 的两条路径见其 libretro.c:1917 与 :2923-2966）。
        // 逐 id 查询每帧 9 次调用，开销可忽略，换成位掩码属于过早优化。
        return false;
      case ENV.SET_SYSTEM_AV_INFO:
        Object.assign(this.avInfo, this._readAvInfo(data));
        this._retuneAudio();
        return true;
      case ENV.SET_GEOMETRY:
        Object.assign(this.avInfo, this._readAvInfo(data));
        return true;
      case ENV.SET_MESSAGE:
        this.onStatus(this.m.UTF8ToString(this.u32[data >> 2]));
        return true;
      case ENV.GET_LOG_INTERFACE:
        return false; // 可变参数回调不接
      default:
        return false;
    }
  }

  /**
   * 一帧像素：XRGB8888 小端在内存里是 B,G,R,X，ImageData 要 R,G,B,A —— 必须换通道。
   * pitch 是行字节跨度，逐行取。
   */
  _video(data, width, height, pitch) {
    if (!data) return;
    if (!this.imageData || this.imageData.width !== width || this.imageData.height !== height) {
      this.imageData = this.ctx.createImageData(width, height);
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const out = this.imageData.data;
    const src = this.u8;
    for (let y = 0; y < height; y++) {
      let from = data + y * pitch;
      let to = y * width * 4;
      for (let x = 0; x < width; x++, from += 4, to += 4) {
        out[to] = src[from + 2];
        out[to + 1] = src[from + 1];
        out[to + 2] = src[from];
        out[to + 3] = 255;
      }
    }
    this.ctx.putImageData(this.imageData, 0, 0);
    this.frames++;
  }

  _audioBatch(data, count) {
    const i16 = new Int16Array(this.m.HEAPU8.buffer, data, count * 2);
    for (let i = 0; i < count; i++) this._ringPush(i16[i * 2], i16[i * 2 + 1]);
  }

  _inputState(port, device, id) {
    if (device !== RETRO_DEVICE_JOYPAD) return 0;
    return this.held.has(`${port}:${id}`) ? 1 : 0;
  }

  // ==================== 音频 ====================

  /**
   * 建音频出口。必须在 loadROM 里 await：addModule 是异步的，而 start() 要保持同步
   * （调用方的 start() 就是同步语义）。
   */
  async _ensureAudio() {
    if (this.workletNode || this.audioBlocked) return;
    this.srcRate = this.avInfo.sampleRate || 48000;
    // 按核心的采样率开上下文；浏览器不接受这个率时退回设备率，靠 worklet 里的插值重采样
    try {
      this.audioCtx = new AudioContext({ sampleRate: this.srcRate });
    } catch {
      this.audioCtx = new AudioContext();
    }
    /*
     * AudioWorklet 只在**安全上下文**（https 或 localhost）暴露。用手机通过
     * http://192.168.x.x:7890 这种局域网地址访问时，audioCtx.audioWorklet 是 undefined，
     * 原先这里直接 TypeError，游戏整个打不开。
     * 没声音不影响能玩（_flushAudio 本来就在没 worklet 时丢掉样本），所以降级成静音跑，
     * 并把原因写清楚让界面告诉玩家怎么把声音找回来。
     * 对标 storage.js 里同样的让步：那边为非 HTTPS 放弃了 crypto.subtle 改用 FNV-1a。
     */
    if (!this.audioCtx.audioWorklet) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
      this.audioBlocked = window.isSecureContext
        ? '这台设备的浏览器不支持网页音频，已静音运行'
        : '非 HTTPS 地址下浏览器禁用了网页音频，已静音运行（改用 https 或 localhost 访问即有声音）';
      return;
    }
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
    await this.audioCtx.audioWorklet.addModule(new URL('./audio-processor.js', import.meta.url));
    this.workletNode = new AudioWorkletNode(this.audioCtx, 'nes-audio', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { ratio: this._ratio() },
    });
    this.workletNode.port.onmessage = (e) => {
      if (e.data && e.data.type === 'stats') {
        this.audioStats = e.data;
        this._syncSpeedToAudio(e.data.depth);
        if (this._onAudioUp) { const done = this._onAudioUp; this._onAudioUp = null; done(); }
      }
    };
    this.workletNode.connect(this.audioCtx.destination);
    this._resetRing();
    // 等 worklet 第一次回报（也就是真被调度起来）再跑帧：否则开局那一秒核心照常出样本、
    // 下游一口没吃，队列直接堆满并丢音（实测开局丢弃 6016 帧）。等不到就 500 ms 后照常跑。
    await new Promise((resolve) => {
      this._onAudioUp = resolve;
      setTimeout(() => { this._onAudioUp = null; resolve(); }, 500);
    });
  }

  /**
   * 按音频队列深度微调跑帧速度，让模拟跟着声卡时钟走 —— 对标 RetroArch 的
   * audio_sync + 时钟校准（声音的延迟才是玩家听到的东西）。
   *
   * 不对齐会怎样：两边哪怕只差 0.9%，队列就一直堆，实测 15 秒堆到 140 ms
   * 并溢出丢了 5248 帧。反过来拿「已消费的音频量」当计时基准也不行：
   * 消费速度取决于生产速度，队列一空就自锁，实测跑帧掉到 5 帧/秒。
   *
   * 深度是「产出 − 消费」的积分，所以比例控制就够：深度高出目标 → 跑慢一点，
   * 落回目标带内稳定。上限 ±2% 足够盖住声卡时钟偏差和显示器刷新率差。
   */
  _syncSpeedToAudio(depth) {
    // 增益不能太猛：stats 回报有约 85 ms 延迟，修正快一倍（原先 1024 帧偏差就修 1%）
    // 深度会在 128~2176 之间来回抖，稳不住
    const err = Math.max(-4096, Math.min(4096, depth - AUDIO_TARGET_FRAMES));
    this._speed = 1 + (err / 4096) * 0.02;
  }

  _ratio() {
    return this.audioCtx ? this.srcRate / this.audioCtx.sampleRate : 1; // 1 = 设备率就是核心率
  }

  _resetRing() {
    this.pendingFrames = 0;
    this.audioSent = 0;
    this._speed = 1;
    if (this.workletNode) this.workletNode.port.postMessage({ type: 'reset' });
  }

  _ringPush(l, r) {
    const i = this.pendingFrames * 2;
    const gain = this.muted ? 0 : this.volume;
    this.pending[i] = (l / 32768) * gain;
    this.pending[i + 1] = (r / 32768) * gain;
    this.pendingFrames++;
    if (this.pendingFrames >= this.CHUNK_FRAMES) this._flushAudio();
  }

  _flushAudio() {
    if (!this.pendingFrames || !this.workletNode) { this.pendingFrames = 0; return; }
    const frames = this.pendingFrames;
    const buffer = this.pending.buffer;
    this.pending = new Float32Array(this.CHUNK_FRAMES * 2);
    this.pendingFrames = 0;
    this.audioSent += frames;
    this.workletNode.port.postMessage({ type: 'chunk', frames, buffer }, [buffer]);
  }

  _retuneAudio() {
    // 核心中途改采样率（fceumm 切 PAL/NTSC 时会发 SET_SYSTEM_AV_INFO）
    this.srcRate = this.avInfo.sampleRate || this.srcRate;
    if (this.workletNode) this.workletNode.port.postMessage({ type: 'rate', ratio: this._ratio() });
  }

  // ==================== 生命周期 ====================

  /**
   * @param {Uint8Array} sram 电池存档，非空时在跑第一帧之前就灌进卡带的电池 RAM
   *   （游戏开机读进度是在第一帧里干的，晚一步就读不到自己写的存档了）
   */
  async loadROM(bytes, name = 'unknown', sram = null) {
    await this.init();
    this.stop();
    // 核心 need_fullpath = true（libretro.c:1846）→ ROM 必须先进 MEMFS，只传路径
    const path = '/game.nes';
    if (this.romPath) this.m.FS.unlink(this.romPath);
    this.m.FS.writeFile(path, bytes);
    this.romPath = path;

    const gi = this._allocStruct(16); // { const char *path; void *data; size_t size; const char *meta; }
    this.u32[gi >> 2] = this._allocString(path);
    const ok = this.m._retro_load_game(gi);
    if (!ok) {
      this.onStatus(`加载失败: ${name}`, true);
      return false;
    }
    Object.assign(this.avInfo, this._readAvInfo(this._avInfoPtr()));
    this.onStatus(`已加载: ${name}（${this.avInfo.fps.toFixed(2)} fps / ${this.avInfo.sampleRate} Hz）`);
    // 核心没报电池 RAM 就跳过：库里那份镜像是旧的（或压根不该存在），不是错误
    if (sram && this.m._retro_get_memory_size(MEM_SAVE_RAM)) this.loadRam(sram);
    await this._ensureAudio();
    this.start();
    return true;
  }

  _avInfoPtr() {
    const p = this._allocStruct(40);
    this.m._retro_get_system_av_info(p);
    return p;
  }

  start() {
    if (this.running || !this.m) return;
    this.running = true;
    // 上下文可能因自动播放策略被挂起；worklet 是在 loadROM 里 await 建好的
    if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
    this._last = performance.now();
    this._acc = 0;
    this._loop();
  }

  /** 暂停：停跑帧、松开所有键、清空音频队列，但保留核心状态 */
  pause() {
    if (!this.running) return;
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this._releaseAll();
    this._resetRing();
  }

  stop() {
    this.pause();
    if (this.workletNode) { try { this.workletNode.disconnect(); } catch { /* 已断开 */ } this.workletNode = null; }
    if (this.audioCtx) { this.audioCtx.close().catch(() => {}); this.audioCtx = null; }
  }

  reset() {
    if (!this.m) return;
    this._releaseAll();
    this.m._retro_reset();
  }

  /** 手动跑 n 帧（暂停状态下用，让回归脚本能精确对齐到某一帧） */
  step(n = 1) {
    for (let i = 0; i < n; i++) this.m._retro_run();
  }

  _loop() {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    const frameMs = (1000 / (this.avInfo.fps || 60)) * (this._speed || 1);
    // 追帧上限 3：标签页切回来时不要一次性补跑几百帧
    this._acc = Math.min(this._acc + (now - this._last), frameMs * 3);
    this._last = now;
    try {
      while (this._acc >= frameMs) {
        this.m._retro_run();
        this._acc -= frameMs;
      }
    } catch (e) {
      this.stop();
      this.onCrash(e.message);
    }
  }

  _releaseAll() {
    this.held.clear();
  }

  // ==================== 存档 ====================

  /** 核心状态原始字节（不含 RASTATE 容器，容器由 console.js 负责） */
  serialize() {
    if (!this.m) return null;
    const size = this.m._retro_serialize_size();
    const p = this.m._malloc(size);
    const ok = this.m._retro_serialize(p, size);
    const bytes = ok ? this.u8.slice(p, p + size) : null;
    this.m._free(p);
    return bytes;
  }

  unserialize(bytes) {
    if (!this.m || !bytes) throw new Error('存档数据是空的');
    const p = this.m._malloc(bytes.length);
    this.u8.set(bytes, p);
    const ok = this.m._retro_unserialize(p, bytes.length);
    this.m._free(p);
    if (!ok) throw new Error('核心拒绝了这个存档（可能不是同一款游戏或同一个核心版本）');
  }

  /** 电池存档（.srm 就是这段裸字节） */
  saveRam() {
    if (!this.m) return null;
    const size = this.m._retro_get_memory_size(MEM_SAVE_RAM);
    const ptr = this.m._retro_get_memory_data(MEM_SAVE_RAM);
    if (!size || !ptr) return null;
    return this.u8.slice(ptr, ptr + size);
  }

  loadRam(bytes) {
    const size = this.m._retro_get_memory_size(MEM_SAVE_RAM);
    const ptr = this.m._retro_get_memory_data(MEM_SAVE_RAM);
    if (!size || !ptr) throw new Error('这款游戏没有电池存档');
    this.u8.set(bytes.subarray(0, size), ptr);
  }

  /** port 从 0 起（libretro 的编号） */
  buttonDown(port, id) { this.held.add(`${port}:${id}`); }
  buttonUp(port, id) { this.held.delete(`${port}:${id}`); }

  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); }
  setMuted(m) { this.muted = !!m; }

  destroy() {
    this.stop();
    if (!this.m) return;
    this.m._retro_unload_game();
    this.m._retro_deinit();
    for (const key of Object.keys(this.cb)) {
      this.m.removeFunction(this.cb[key]);
    }
    this.cb = {};
    this.m = null;
  }
}
