/**
 * AudioWorklet 音频出口。语义对标 RetroArch 的 Web 音频驱动
 * （audio/drivers/audioworklet.c，master 分支）：
 *
 *  - 跑帧的一侧是生产者，往环形缓冲写；worklet 每个 quantum 从这里取。
 *  - 实时音频线程里不许等待（驱动原话：can't use Atomics.wait in AudioWorklet），
 *    所以取干了就补静音，并把这段记成 underrun。
 *  - 写不下就丢最旧的一段并计数，宁可偶尔爆音也不让延迟无限涨。
 *
 * RetroArch 用 SharedArrayBuffer 上的 SPSC 环；本项目没有跨源隔离（不带 COOP/COEP
 * 响应头），SharedArrayBuffer 造不出来，所以跨线程改用 port 传 Float32Array 块
 * （transferable，零拷贝）。环变成 worklet 私有，深度等计数由 worklet 定期回报，
 * 主线程拿深度去微调跑帧速度（见 libretro-host.js 的 _syncSpeedToAudio）。
 *
 * 消息协议：
 *   主线程 → worklet：{type:'chunk', frames, buffer} 交织立体声 Float32（transfer）
 *                    {type:'reset'}                   丢弃全部并重设计数（暂停/读档/加载）
 *                    {type:'rate', ratio}             核心率 / 设备率，非 1 时线性插值
 *   worklet → 主线程：{type:'stats', depth, written, underrun, dropped}，每 32 个 quantum 一次
 */
const CAPACITY_FRAMES = 8192; // 170 ms @48k，2 的幂，索引用掩码回绕

class NesAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opt = options && options.processorOptions ? options.processorOptions : {};
    this.mask = CAPACITY_FRAMES - 1;
    this.buf = new Float32Array(CAPACITY_FRAMES * 2);
    this.read = 0;   // 绝对帧号（已消费）
    this.write = 0;  // 绝对帧号（已写入）
    this.frac = 0;   // 插值小数余量
    this.ratio = opt.ratio || 1;
    this.underrunFrames = 0;
    this.droppedFrames = 0;
    this.quanta = 0;
    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'chunk') {
      const data = new Float32Array(msg.buffer);
      const frames = msg.frames;
      // 一次塞进来比整个环还多：只留最新的 capacity 帧
      const skip = frames > CAPACITY_FRAMES ? frames - CAPACITY_FRAMES : 0;
      if (skip) { this.droppedFrames += skip; }
      const src = skip * 2;
      const keep = frames - skip;
      const avail = CAPACITY_FRAMES - (this.write - this.read);
      if (keep > avail) {
        const over = keep - avail;
        this.read += over;
        this.droppedFrames += over;
      }
      const start = (this.write & this.mask) * 2;
      const head = Math.min(keep, CAPACITY_FRAMES - (start >> 1));
      this.buf.set(data.subarray(src, src + head * 2), start);
      if (keep > head) this.buf.set(data.subarray(src + head * 2, src + keep * 2), 0);
      this.write += keep;
    } else if (msg.type === 'reset') {
      this.read = this.write = 0;
      this.frac = 0;
      this.underrunFrames = 0;
      this.droppedFrames = 0;
    } else if (msg.type === 'rate') {
      this.ratio = msg.ratio;
    }
  }

  process(inputs, outputs) {
    // 实时线程的 outputs[0] 就是「第一条声道的 Float32Array」，不是 AudioBuffer：
    // getChannelData 是主线程 AudioBuffer 的方法，在这儿调会抛 TypeError，
    // 而异常不会冒泡到页面，只从节点的 onprocessorerror 里露头
    // （实测：抛过一次之后节点再也拿不到 stats）。
    const L = outputs[0] && outputs[0][0];
    if (!L) return true;
    const R = outputs[0][1] || null;
    const n = L.length;
    // 还没送过任何样本（开局、暂停后恢复）时取干属于「没开始」，不算断音，
    // 否则这个数字一开机就背几千帧，看不出真正的卡顿
    const avail = this.write - this.read;
    if (avail < n && this.write > 0) this.underrunFrames += n - avail; // 取干的部分补静音
    let pos = this.read;
    for (let i = 0; i < n; i++) {
      if (pos >= this.write) { L[i] = 0; if (R) R[i] = 0; continue; }
      const ai = (pos & this.mask) * 2;
      const hasNext = pos + 1 < this.write;
      const bi = hasNext ? ((pos + 1) & this.mask) * 2 : ai;
      const t = hasNext ? this.frac : 0;
      L[i] = this.buf[ai] + (this.buf[bi] - this.buf[ai]) * t;
      if (R) R[i] = this.buf[ai + 1] + (this.buf[bi + 1] - this.buf[ai + 1]) * t;
      this.frac += this.ratio;
      const step = this.frac | 0;
      this.frac -= step;
      pos += step; // ratio<1（设备率低于核心率）时同一帧连续输出两次，属预期
    }
    this.read = pos;
    if (++this.quanta % 32 === 0) {
      this.port.postMessage({
        type: 'stats',
        channels: outputs[0].length,
        quantum: n,
        depth: this.write - this.read,
        written: this.write,
        underrun: this.underrunFrames,
        dropped: this.droppedFrames,
      });
    }
    return true;
  }
}

registerProcessor('nes-audio', NesAudioProcessor);
