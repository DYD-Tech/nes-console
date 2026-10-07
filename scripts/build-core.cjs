/**
 * 编译 fceumm libretro 核心 → public/cores/fceumm_libretro.{mjs,wasm}
 *
 * 用法：npm run build:core
 * 前置：emsdk（默认取 ~/emsdk，也可用环境变量 EMSDK_DIR / EMSDK 指定）。
 *      CI 不需要 emsdk —— 编译产物随仓库发布，只有换核心版本时才重编。
 *
 * 源码：third_party/libretro-fceumm
 *      上游 https://github.com/libretro/libretro-fceumm.git
 *      commit 7a542dab1e87679921962a9f056186eca425c0c2（2026-09-26）
 *      GPL-2.0-or-later，见该目录下的 Copying。产物旁边会写一份
 *      fceumm_libretro.build.json 记下这次编的到底是哪个版本。
 *
 * 对标来源：fceumm 自己的 `Makefile.common`（源文件清单与宏）+
 * `Makefile.libretro`（各平台开关）。这里用 Node 复刻那份清单而不是跑 GNU make，
 * 因为 Windows 上没有 make，而且清单很短、显式列出的文件比 wildcard 更好审。
 *
 * 与上游有意不同的三处（都有出处）：
 *  1. 目标不是上游 emscripten 分支产出的 `.bc`（Makefile.libretro:428-431，那是给
 *     RetroArch 整包静态链接用的，且它设了 STATIC_LINKING=1，由前端提供
 *     libretro-common）。我们要的是**独立模块**，所以 STATIC_LINKING 保持 0，
 *     把 libretro-common 那批文件一起链进来。
 *  2. HAVE_NTSC / HAVE_HDPACK 关掉：分别拉进 nes_ntsc 滤镜和 png/webp/vorbis 解码器，
 *     对浏览器里的 NES 播放不是必需。
 *  3. 像素格式跟上游 emscripten 分支一致（同 428-431 行 WANT_32BPP := 1）：
 *     `-DFRONTEND_SUPPORTS_RGB888`，核心输出 32 位 XRGB8888。宿主侧直接按字节灌进
 *     ImageData 即可，省掉逐像素 5-6-5 解码。
 *
 * 不传 `-std=c99`：上游没有这个开关（各分支只在需要时用 `-std=gnu11`），clang 默认
 * 即 gnu17。实测 `-std=c99` 会让 libretro-common 的 encoding_utf.c 编不过——严格
 * ANSI 模式下 musl 的 features.h 不暴露 POSIX 的 strdup（4 处 error）。
 *
 * 命令行长度：488 个源文件的绝对路径远超 Windows cmd 的 ~8K 上限，所以全部参数
 * 写进 emcc 的响应文件（`@file`），只在命令行上传这一个问题。转义规则照搬
 * emscripten 自己的 tools/response_file.py:17-38（反斜杠和双引号加 \\ 前缀，
 * 含空格的参数用双引号包住），由 emcc.py:316 substitute_response_files 在解析
 * 命令行最开始就展开，等价于直接传参。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'third_party/libretro-fceumm');
const SRC = path.join(CORE, 'src');
const COMM = path.join(SRC, 'drivers/libretro/libretro-common');
const OUT_DIR = path.join(ROOT, 'public', 'cores');
const SOURCE_COMMIT = '7a542dab1e87679921962a9f056186eca425c0c2';
const EMSDK = process.env.EMSDK_DIR || process.env.EMSDK || path.join(os.homedir(), 'emsdk');
const EMCC = path.join(EMSDK, 'upstream/emscripten', process.platform === 'win32' ? 'emcc.exe' : 'emcc');

/** Makefile.common: FCEU_SRC_DIRS 用 wildcard 的两个目录 */
function dirSources(rel) {
  const dir = path.join(SRC, rel);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.c')).map((f) => path.join(dir, f));
}

// Makefile.common 的 SOURCES_C，逐项照搬（HAVE_NTSC / HAVE_HDPACK 分支不取）
const SOURCES = [
  ...dirSources('boards'),
  ...dirSources('input'),
  'drivers/libretro/libretro.c',
  'drivers/libretro/libretro_dipswitch.c',
  'cart.c', 'cheat.c', 'crc32.c', 'fceu-endian.c', 'fceu-memory.c', 'fceu.c',
  'fds.c', 'fds_apu.c', 'file.c', 'filter.c', 'general.c', 'input.c', 'md5.c',
  'nsf.c', 'palette.c', 'ppu.c', 'sound.c', 'state.c', 'video.c', 'vsuni.c',
  'ines.c', 'unif.c', 'x6502.c',
].map((f) => (path.isAbsolute(f) ? f : path.join(SRC, f)));

// Makefile.common 末尾非 STATIC_LINKING 分支的 libretro-common 文件
const COMMON_SOURCES = [
  'streams/memory_stream.c',
  'compat/compat_posix_string.c', 'compat/compat_snprintf.c', 'compat/compat_strcasestr.c',
  'compat/compat_strl.c', 'compat/fopen_utf8.c', 'encodings/encoding_utf.c',
  'file/file_path.c', 'file/file_path_io.c', 'streams/file_stream.c',
  'streams/file_stream_transforms.c', 'string/stdstring.c', 'time/rtime.c',
  'vfs/vfs_implementation.c',
].map((f) => path.join(COMM, f));

const INCLUDES = [
  path.join(SRC, 'drivers/libretro'),
  path.join(COMM, 'include'),
  SRC,
  path.join(SRC, 'input'),
  path.join(SRC, 'boards'),
];

const DEFINES = [
  '__LIBRETRO__',
  'PATH_MAX=1024',
  'FCEU_VERSION_NUMERIC=9900',
  // libretro.c:78 的分支：XRGB8888 帧缓冲
  'FRONTEND_SUPPORTS_RGB888',
];

// 宿主要用到的 RETRO_API 符号（Emscripten 侧要带前导下划线）。
// malloc/free 也在列：libretro 的 environ 回调要往核心给的指针里写字符串
// （ROM 路径、系统目录），retro_game_info.path 也要核心外的调用方分配，
// 不导出就没法在堆上放东西。
const EXPORTS = [
  'retro_init', 'retro_deinit', 'retro_api_version', 'retro_get_system_info',
  'retro_get_system_av_info', 'retro_set_environment', 'retro_set_video_refresh',
  'retro_set_audio_sample', 'retro_set_audio_sample_batch', 'retro_set_input_poll',
  'retro_set_input_state', 'retro_set_controller_port_device', 'retro_reset', 'retro_run',
  'retro_serialize_size', 'retro_serialize', 'retro_unserialize', 'retro_load_game',
  'retro_unload_game', 'retro_get_region', 'retro_get_memory_size', 'retro_get_memory_data',
  'retro_load_game_special', 'retro_cheat_reset', 'retro_cheat_set',
  'malloc', 'free',
].map((n) => `_${n}`);

const RUNTIME_METHODS = [
  'ccall', 'cwrap', 'addFunction', 'removeFunction',
  // 核心 need_fullpath = true（libretro.c:1846），ROM 得先写进 Emscripten 的
  // MEMFS 再按路径交给它，所以 FS 要暴露给宿主。
  'FS',
  'HEAP8', 'HEAPU8', 'HEAP16', 'HEAPU16', 'HEAP32', 'HEAPU32', 'UTF8ToString',
];

function posix(p) {
  return p.replace(/\\/g, '/');
}

/** 照 emscripten create_response_file_contents 的转义规则写一个参数 */
function rspArg(arg) {
  const escaped = arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return escaped.includes(' ') ? `"${escaped}"` : escaped;
}

function requireToolchain() {
  if (!fs.existsSync(EMCC)) {
    console.error(`找不到 emcc：${EMCC}`);
    console.error('装 emsdk 后指过来：git clone https://github.com/emscripten-core/emsdk.git');
    console.error('  cd emsdk && ./emsdk install 6.0.11 && ./emsdk activate 6.0.11');
    console.error('然后 EMSDK_DIR=/path/to/emsdk npm run build:core');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(SRC, 'drivers/libretro/libretro.c'))) {
    console.error(`找不到核心源码：${SRC}`);
    console.error('应该是 third_party/libretro-fceumm，见本文件头部的出处说明。');
    process.exit(1);
  }
}

function build() {
  requireToolchain();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // emsdk 自带的 python 目录名带版本号（python/3.13.3_64bit 这类），不能写死。
  // 但要把它放进 PATH：Windows 上 PATH 里的 `python` 常常是 Microsoft Store 的
  // 占位程序（运行即报「Python was not found」），emcc 内部调 python 就失败。
  const pyDir = (() => {
    const root = path.join(EMSDK, 'python');
    const exe = process.platform === 'win32' ? 'python.exe' : 'python';
    const dirs = fs.existsSync(root) ? fs.readdirSync(root) : [];
    const hit = dirs.find((d) => fs.existsSync(path.join(root, d, exe)));
    return hit ? path.join(root, hit) : null;
  })();
  const env = {
    ...process.env,
    EMSDK,
    PATH: [
      pyDir,
      EMSDK,
      path.join(EMSDK, 'upstream/emscripten'),
      path.join(EMSDK, 'upstream/bin'),
      process.env.PATH,
    ].filter(Boolean).join(path.delimiter),
  };

  const args = [
    ...[...SOURCES, ...COMMON_SOURCES].map(posix),
    ...INCLUDES.map((d) => `-I${posix(d)}`),
    ...DEFINES.map((d) => `-D${d}`),
    '-O2',
    '-s', 'MODULARIZE=1',
    // ESM 输出：本项目 package.json 是 "type": "module"，而默认（CJS）胶水用的
    // `module.exports` 在 ESM 解析下不生效。另外 ESM 版用
    // `new URL('….wasm', import.meta.url)` 定位 wasm，胶水与 wasm 放在
    // public/cores/ 同一目录下即可自寻址（走 base 前缀也不用改）。
    '-s', 'EXPORT_ES6=1',
    '-s', 'EXPORT_NAME=createFceummCore',
    '-s', 'ENVIRONMENT=web,worker,node',
    '-s', 'ALLOW_MEMORY_GROWTH=1',
    // 回调是 JS 函数注册进 C 的函数表，宿主靠 addFunction 拿到指针
    '-s', 'ALLOW_TABLE_GROWTH=1',
    '-s', `EXPORTED_FUNCTIONS=${JSON.stringify(EXPORTS)}`,
    '-s', `EXPORTED_RUNTIME_METHODS=${JSON.stringify(RUNTIME_METHODS)}`,
    '-o', posix(path.join(OUT_DIR, 'fceumm_libretro.mjs')),
  ];

  const rsp = path.join(OUT_DIR, 'fceumm.rsp.utf-8');
  fs.writeFileSync(rsp, args.map(rspArg).join('\n') + '\n');

  console.log(`源文件 ${SOURCES.length + COMMON_SOURCES.length} 个（核心 ${SOURCES.length} + libretro-common ${COMMON_SOURCES.length}）`);
  const r = spawnSync(EMCC, [`@${posix(rsp)}`], { env, stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`\nemcc 失败（退出码 ${r.status ?? r.error?.message}）。上面是编译器的原始输出。`);
    process.exit(r.status || 1);
  }
  fs.rmSync(rsp);

  const glue = path.join(OUT_DIR, 'fceumm_libretro.mjs');
  const wasm = path.join(OUT_DIR, 'fceumm_libretro.wasm');
  // 记编译器的**版本**，不记它装在哪：安装路径是各人机器上的私事，版本才别人能对上。
  const ver = spawnSync(EMCC, ['--version'], { env, encoding: 'utf-8' });
  const toolchain = (ver.stdout || '').split('\n')[0].trim() || 'emcc';
  // 产物边上的出处记录：别人拿到 dist 里的 wasm，能查到它是哪份源码、哪套开关编的
  fs.writeFileSync(path.join(OUT_DIR, 'fceumm_libretro.build.json'), JSON.stringify({
    source: 'https://github.com/libretro/libretro-fceumm.git',
    commit: SOURCE_COMMIT,
    license: 'GPL-2.0-or-later (third_party/libretro-fceumm/Copying)',
    toolchain,
    builtAt: new Date().toISOString(),
    defines: DEFINES,
    optimization: '-O2',
  }, null, 2) + '\n');
  console.log(`\n产出：public/cores/fceumm_libretro.mjs (${(fs.statSync(glue).size / 1024).toFixed(0)} KB)`);
  console.log(`      public/cores/fceumm_libretro.wasm (${(fs.statSync(wasm).size / 1024 / 1024).toFixed(2)} MB)`);
}

build();
