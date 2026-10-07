/**
 * fceumm wasm 核心的最小 libretro 宿主跑通验证（node 里，不进产品）。
 *
 * 目的：在写浏览器宿主之前，先用最少的胶水把 ABI 走通——
 * 环境回调、视频/音频/输入注册、按路径加载 ROM、跑帧、存档往返、SRAM 取回。
 * ROM 特意选 jsnes 载不了的那几款。
 *
 * 结构体布局按 libretro.h（third_party/libretro-fceumm/src/drivers/libretro/libretro-common/include），
 * wasm32 小端、指针 4 字节。用到的偏移都在注释里标了出处。
 *
 * 跑法：node agent-workspace/smoke-fceumm-host.cjs [ROM 文件名]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CORE_MJS = path.join(ROOT, 'public/cores/fceumm_libretro.mjs');
const ROM_DIR = path.join(ROOT, 'public/rom');
const OUT_DIR = path.join(__dirname, 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- libretro.h 常量（数值逐个从头文件 grep 得来）----
const RETRO_DEVICE_JOYPAD = 1;
const RETRO_DEVICE_ID_JOYPAD_B = 0, RETRO_DEVICE_ID_JOYPAD_SELECT = 2,
  RETRO_DEVICE_ID_JOYPAD_START = 3, RETRO_DEVICE_ID_JOYPAD_UP = 4,
  RETRO_DEVICE_ID_JOYPAD_DOWN = 5, RETRO_DEVICE_ID_JOYPAD_LEFT = 6,
  RETRO_DEVICE_ID_JOYPAD_RIGHT = 7, RETRO_DEVICE_ID_JOYPAD_A = 8;
// enum retro_pixel_format（libretro.h:5901-5914）：0RGB1555=0, XRGB8888=1, RGB565=2
const PIX_XRGB8888 = 1;
// retro_memory_type（libretro.h:510-518）：SAVE_RAM=0, RTC=1, SYSTEM_RAM=2, VIDEO_RAM=3
const MEM_SAVE_RAM = 0, MEM_SYSTEM_RAM = 2;
const ENV = {
  SET_MESSAGE: 6,
  GET_SYSTEM_DIRECTORY: 9,
  SET_PIXEL_FORMAT: 10,
  GET_VARIABLE: 15,
  SET_VARIABLES: 16,
  GET_VARIABLE_UPDATE: 17,
  GET_LOG_INTERFACE: 27,
  GET_SAVE_DIRECTORY: 31,
  SET_SYSTEM_AV_INFO: 32,
  SET_GEOMETRY: 37,
  GET_INPUT_BITMASKS: 51 | 0x10000, // EXPERIMENTAL 位
};

async function main() {
  const arg = process.argv[2] || '热血格斗.nes';
  /**
   * 参数两种给法：`public/rom/` 里的卡带名关键字（默认），或者一个显式路径。
   * 给路径是为了评估还没进镜像的卡带（比如挑随站发布的 homebrew）时，
   * 不必往 `public/rom/` 里塞临时文件——那个目录是用户的卡带镜像。
   */
  const romPath = fs.existsSync(arg)
    ? path.resolve(arg)
    : (() => {
      const hit = fs.readdirSync(ROM_DIR).find((f) => f.startsWith(arg.replace(/\.nes$/i, '')));
      return hit ? path.join(ROM_DIR, hit) : null;
    })();
  if (!romPath) throw new Error(`找不到 ROM：${arg}（${ROM_DIR} 里有：${fs.readdirSync(ROM_DIR).join('、')}）`);
  const romLabel = path.basename(romPath).replace(/\.[^.]+$/, '');
  const romBytes = new Uint8Array(fs.readFileSync(romPath));

  // Windows 绝对路径要转成 file: URL 才能被 import()
  const { default: createFceummCore } = await import(require('url').pathToFileURL(CORE_MJS).href);
  const m = await createFceummCore();

  // 堆视图每次重新取：ALLOW_MEMORY_GROWTH 之后旧视图会失效
  const u8 = () => m.HEAPU8;
  const u32 = () => m.HEAPU32;

  const allocString = (s) => {
    const bytes = new TextEncoder().encode(s);
    const p = m._malloc(bytes.length + 1);
    u8().set(bytes, p);
    u8()[p + bytes.length] = 0;
    return p;
  };
  const allocStruct = (n) => {
    const p = m._malloc(n);
    u32().fill(0, p / 4, (p + n) / 4);
    return p;
  };
  // struct retro_system_av_info（本仓库带的 libretro.h:6633-6640）
  //   geometry{u32 base_width, u32 base_height, u32 max_width, u32 max_height, float aspect_ratio} = 20 B
  //   对齐到 8 后 timing{double fps, double sample_rate} 落在 24，总 40 B
  // 注意字段顺序：这份头文件是 fps 在前、sample_rate 在后，且 max_* 是整型不是浮点。
  const readAvInfo = (ptr) => {
    const dv = new DataView(m.HEAPU8.buffer, ptr, 40);
    return {
      baseWidth: dv.getUint32(0, true),
      baseHeight: dv.getUint32(4, true),
      maxWidth: dv.getUint32(8, true),
      maxHeight: dv.getUint32(12, true),
      aspectRatio: dv.getFloat32(16, true),
      fps: dv.getFloat64(24, true),
      sampleRate: dv.getFloat64(32, true),
    };
  };

  const seen = { pixelFormat: null, avInfo: null, geometry: null, messages: [] };
  const env = (cmd, data) => {
    switch (cmd) {
      case ENV.SET_PIXEL_FORMAT:
        seen.pixelFormat = u32()[data >> 2];
        return true;
      case ENV.GET_SYSTEM_DIRECTORY:
      case ENV.GET_SAVE_DIRECTORY:
        // struct retro_system_directory { const char *path; }（libretro.h，两版同布局）
        u32()[data >> 2] = allocString('/');
        return true;
      case ENV.GET_VARIABLE_UPDATE:
        u8()[data] = 0; // bool*：没有改动
        return true;
      case ENV.GET_VARIABLE:
        return false; // 不给核心选项，让它用内置默认值
      case ENV.GET_INPUT_BITMASKS:
        return false; // 只会按单个 id 回答，位掩码给不出（曾误回 true：核心改查 id=256，游戏收不到任何按键）
      case ENV.SET_SYSTEM_AV_INFO:
        seen.avInfo = readAvInfo(data);
        return true;
      case ENV.SET_GEOMETRY:
        // 只给 retro_game_geometry（20 B），不含 timing
        seen.geometry = readAvInfo(data);
        return true;
      case ENV.SET_MESSAGE:
        // struct retro_message { const char *msg; unsigned frames; }
        seen.messages.push(m.UTF8ToString(u32()[data >> 2]));
        return true;
      case ENV.GET_LOG_INTERFACE:
        return false; // 不接可变参数回调
      default:
        return false; // 其余（含 SET_CORE_OPTIONS* / SET_MEMORY_MAPS / VFS）一概不支持，核心走默认路径
    }
  };

  const held = new Set();
  let frames = 0, lastFrame = null, audioSamples = 0, videoFormatMismatch = null;
  const envPtr = m.addFunction(env, 'iii');
  const videoPtr = m.addFunction((data, w, h, pitch) => {
    if (!data) return;
    if (seen.pixelFormat !== PIX_XRGB8888) {
      videoFormatMismatch = seen.pixelFormat;
      return;
    }
    frames++;
    // 逐行拷贝：pitch 是行字节跨度，帧像素按 XRGB8888 小端 = B,G,R,X
    const out = new Uint8Array(w * h * 4);
    const src = u8();
    for (let y = 0; y < h; y++) {
      const from = data + y * pitch;
      out.set(src.subarray(from, from + w * 4), y * w * 4);
    }
    lastFrame = { w, h, data: out };
  }, 'viiii');
  const audioBatchPtr = m.addFunction((data, count) => {
    // 立体声 int16 交织：count 是帧数（每帧左右各一个样本）
    const i16 = new Int16Array(m.HEAPU8.buffer, data, count * 2);
    for (let i = 0; i < count * 2; i++) if (i16[i] !== 0) audioSamples++;
  }, 'iii');
  const pollPtr = m.addFunction(() => {}, 'v');
  const statePtr = m.addFunction((port, device, index, id) => {
    if (device !== RETRO_DEVICE_JOYPAD) return 0;
    return held.has(`${port}:${id}`) ? 1 : 0;
  }, 'iiiii');

  m._retro_set_environment(envPtr);
  m._retro_set_video_refresh(videoPtr);
  m._retro_set_audio_sample(m.addFunction(() => {}, 'vii'));
  m._retro_set_audio_sample_batch(audioBatchPtr);
  m._retro_set_input_poll(pollPtr);
  m._retro_set_input_state(statePtr);
  m._retro_init();
  m._retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);

  // struct retro_game_info { const char *path; void *data; size_t size; const char *meta; }
  // 核心 need_fullpath = true（libretro.c:1846）→ 必须先把 ROM 落进 MEMFS，只传路径
  m.FS.writeFile('/game.nes', romBytes);
  const gi = allocStruct(16);
  u32()[gi >> 2] = allocString('/game.nes');

  const loaded = m._retro_load_game(gi);
  console.log(`load_game: ${loaded ? 'OK' : '失败'}  ROM=${romPath} (${(romBytes.length / 1024).toFixed(0)} KB)`);
  if (!loaded) throw new Error('retro_load_game 返回 false');
  // 核心在 load 时不主动发 SET_SYSTEM_AV_INFO，直接问它要
  const avPtr = allocStruct(40);
  m._retro_get_system_av_info(avPtr);
  const av = readAvInfo(avPtr);
  console.log(`像素格式请求: ${seen.pixelFormat}（${PIX_XRGB8888}=XRGB8888）`);
  console.log(`av_info: ${av.baseWidth}x${av.baseHeight} @ ${av.fps.toFixed(3)}fps，采样率 ${av.sampleRate}`);
  console.log(`区域: ${m._retro_get_region()}（0=NTSC 1=PAL）`);

  for (let i = 0; i < 300; i++) m._retro_run();
  const stat = describeFrame(lastFrame);
  console.log(`跑 300 帧：${frames} 帧送达，${stat}，非零音频样本 ${audioSamples}`);
  if (videoFormatMismatch !== null) console.log(`!! 像素格式不是 XRGB8888（拿到 ${videoFormatMismatch}），宿主按 32 位读会错位`);
  await savePng(lastFrame, path.join(OUT_DIR, `frame-${romLabel}-300.png`));

  // 按键：START 连按 30 帧，看画面有没有变（真在响应输入）
  const before = checksum(lastFrame);
  held.add(`0:${RETRO_DEVICE_ID_JOYPAD_SELECT}`);
  held.add(`0:${RETRO_DEVICE_ID_JOYPAD_START}`);
  for (let i = 0; i < 30; i++) m._retro_run();
  held.delete(`0:${RETRO_DEVICE_ID_JOYPAD_START}`);
  for (let i = 0; i < 60; i++) m._retro_run();
  console.log(`按键前后帧校验和 ${before} → ${checksum(lastFrame)}（变了说明输入进到了核心；标题画面本来就静止时不变不算失败）`);

  // 存档往返：serialize → 改状态 → unserialize → 校验和回到原值
  const size = m._retro_serialize_size();
  const buf = m._malloc(size);
  const okSave = m._retro_serialize(buf, size);
  const atSave = checksum(lastFrame);
  for (let i = 0; i < 120; i++) m._retro_run();
  const drifted = checksum(lastFrame);
  const okLoad = m._retro_unserialize(buf, size);
  m._retro_run();
  console.log(`存档：size=${size} B 写=${okSave} 读=${okLoad}；存点校验和=${atSave} 跑偏后=${drifted} 读档后=${checksum(lastFrame)}`);
  await savePng(lastFrame, path.join(OUT_DIR, `frame-${romLabel}-after-load-state.png`));

  const sramSize = m._retro_get_memory_size(MEM_SAVE_RAM);
  const sysSize = m._retro_get_memory_size(MEM_SYSTEM_RAM);
  console.log(`SRAM: ${sramSize} B（指针 ${m._retro_get_memory_data(MEM_SAVE_RAM)}）  主 RAM: ${sysSize} B`);
  console.log(`核心消息: ${seen.messages.length ? seen.messages.join(' / ') : '(无)'}`);

  m._retro_unload_game();
  m._retro_deinit();
}

/**
 * 存一帧成 PNG，好让眼睛直接看过画面（数字对不等于画面对）。
 * sharp 是 Astro 的依赖，这里只当验证工具用，不进产品代码。
 * 核心给的是 XRGB8888 小端，内存里就是 B,G,R,X；sharp 的 raw 要 RGBA。
 */
async function savePng(frame, file) {
  if (!frame) return;
  const sharp = require('sharp');
  const { w, h, data } = frame;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = data[i * 4 + 2];
    rgba[i * 4 + 1] = data[i * 4 + 1];
    rgba[i * 4 + 2] = data[i * 4];
    rgba[i * 4 + 3] = 255;
  }
  await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toFile(file);
  console.log(`  帧已存图：${file}`);
}

function describeFrame(frame) {
  if (!frame) return '没有收到任何帧';
  const d = frame.data;
  const colors = new Set();
  let nonBlack = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] | d[i + 1] | d[i + 2]) nonBlack++;
    colors.add((d[i + 2] << 16) | (d[i + 1] << 8) | d[i]);
  }
  return `${frame.w}x${frame.h}，非黑像素 ${nonBlack}/${d.length / 4}，颜色数 ${colors.size}`;
}

function checksum(frame) {
  if (!frame) return 0;
  let h = 0;
  for (let i = 0; i < frame.data.length; i += 97) h = (h * 31 + frame.data[i]) >>> 0;
  return h;
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
