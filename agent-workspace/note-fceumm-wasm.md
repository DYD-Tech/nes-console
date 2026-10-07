# fceumm wasm：已验证事实与浏览器宿主待办

跑法与产物
- 编译：`npm run build:core`（`scripts/build-core.cjs`）→ `public/cores/fceumm_libretro.{mjs,wasm}`（唯一一份产物，产品与原型工具都加载它）
- ABI 冒烟：`node agent-workspace/smoke-fceumm-host.cjs [ROM 名前缀]` → 控制台指标 + `out/frame-<名>-300.png`
- 源码：`third_party/libretro-fceumm/src`（含 `Makefile.common` / `Makefile.libretro` / `libretro-common`）
- 工具链：emsdk 6.0.11，见 `agent-workspace/env-emsdk.md`

## 冒烟实测结果（node，2026-10-05）

| ROM | 载入 | 帧 | 音频非零样本 | 存档字节 | SRAM | 读档回到存点 |
|---|---|---|---|---|---|---|
| 三国 (112) | OK | 300/300 | 461294 | 13801 | 0 | 是 |
| 热血4合1 (45) | OK | 300/300 | 0 | 13850 | 0 | 画面静止 |
| 重装机兵 (74) | OK | 300/300 | 442014 | 15893 | 8192 | 是 |
| 牧场物语 (163) | OK | 300/300 | 539678 | 21970 | 8192 | 画面静止 |
| 金庸群侠传 (163) | OK | 300/300 | 470118 | 21970 | 8192 | 画面静止 |
| 热血格斗 | OK | 300/300 | 418632 | 13837 | 0 | 画面静止 |
| 最终幻想2 (MMC3) | OK | 300/300 | 0 | 22037 | 8192 | 是 |

- 画面已用眼睛看过：三国「滚滚长江东逝水」开场、金庸群侠传标题（开始/继续）、重装机兵 logo 均正确。
- 输入进到核心：三国、重装机兵按键后帧校验和变化（其余几款此刻画面本就静止）。
- 存档往返：`retro_serialize` → 跑 120 帧 → `retro_unserialize`，帧校验和精确回到存点值。
- 存档大小与探针（RetroArch 官方 fceumm 构建）基本吻合：三国我们报 13801 B，探针写出的 RASTATE 净载荷 13800 B。差 1 字节，原因没查（不影响结论），所以宿主侧**不要对字节数做等值假设**，只按 `retro_serialize_size` 走。量级一致说明我们编的核心与桌面端状态格式同源。

## 浏览器宿主实测（原型，2026-10-05）

文件：页面 `probe/fceumm-host.html` + 静态服务 `host-probe-server.cjs`（7892/7893）。
宿主、worklet、核心**都不另存副本**：页面 import 产品那份 `src/lib/nes/libretro-host.js`
（worklet 由它按 `import.meta.url` 相对取 `src/lib/nes/audio-processor.js`），
二进制取 `public/cores/fceumm_libretro.mjs`。所以这套探针测的就是出厂那份代码。
跑法：`node agent-workspace/verify-host-browser.cjs [ROM 名]`（四项判据全过才算）、
`node agent-workspace/audio-drift.cjs [秒数]`（看音频队列深度趋势）。

| ROM | 载入 | 3 秒帧数 | 即时存档 | 读档后画面 | SRAM |
|---|---|---|---|---|---|
| 三国 (112) | OK | 181（60.10 fps） | 13801 B | 逐像素一致 | 0 |
| 金庸群侠传 (163) | OK | 150（50.01 fps） | 21970 B | 逐像素一致 | 8192 |
| 重装机兵 (74) | OK | 180 | 15893 B | 逐像素一致 | 8192 |
| 热血格斗 | OK | 180 | 13837 B | 逐像素一致 | 0 |

读档判等必须在暂停下做：两边都「存档/读档后再精确跑 1 帧」比像素，运行中比较没意义（闪烁光标本身就不同）。

### 音频出口：结论是用 AudioWorklet，不用 ScriptProcessorNode

- 对标：RetroArch 的 Web 端口就是 `audio/drivers/audioworklet.c`。它的四条语义我们照抄了——
  跑帧侧只当生产者；实时线程里不等待（源码注释原话 "can't use Atomics.wait in AudioWorklet"），
  取干就补静音并计数；写不下就丢最旧并计数；容量按请求延迟取 2 的幂。
- 它用 SharedArrayBuffer 上的 SPSC 环，我们**没有跨源隔离（无 COOP/COEP 头），`SharedArrayBuffer`
  造不出来**，所以环改成 worklet 私有、跨线程用 `port.postMessage` 传 Float32Array（transferable，零拷贝），
  深度/欠载/丢弃由 worklet 每 32 个 quantum（85 ms）回报一次。
- 实测对比（Playwright，三国 = 这批里最重的板卡）：

  | 出口 | 队列积压 | 结果 |
  |---|---|---|
  | ScriptProcessorNode（主线程） | 稳定 12000~15000 帧（250~314 ms），最轻的热血格斗也要 14~107 ms | 主线程被 wasm 挤住，回调排不上队；延迟随负载涨，不溢出但不可用 |
  | AudioWorklet + 深度反馈 | 896~1920 帧（19~40 ms），溢出丢弃 0 | 延迟与负载解耦 |

- **必须有一条深度反馈**：只换 worklet 还不够。跑帧按墙上时钟、消费按声卡时钟，两边差 0.9% 时
  队列 15 秒就堆到 140 ms 并开始丢音（实测丢弃 5248 帧）。做法是拿回报的深度做比例控制，
  把每帧时长微调 ±2%（`_syncSpeedToAudio`）。两次踩坑记在 `doc/值得记住的坑/nes-console.md`：
  ① 拿「已消费的音频量」当计时基准会自锁（消费取决于生产，帧率掉到 5）；
  ② 增益翻倍（1024 帧偏差就修 1%）会在目标带里来回振荡。
- 开局要等 worklet 第一次回报之后再跑帧，否则核心照常出样本、下游一口没吃，一上来就堆满丢音
  （实测开局丢 6016 帧）。
- 目标深度定 **2048 帧（约 43 ms @48k）**。原型阶段这里写的 1024（21 ms）进产品后实测不行：
  生产侧是 rAF 驱动的主线程，一次两帧的停顿（约 33 ms）比整个缓冲还长，四款 ROM 都有
  0.3%~1.4% 的样本靠补静音填（听感是偶发「嗒」）。缓冲余量按**生产侧能抖多久**定，
  不是按想要的延迟定。`ctx.baseLatency` 0.01 s、`outputLatency` 0.048 s 是浏览器到扬声器
  的固定开销，宿主管不了，所以这 21 ms 不是主角。验收看「每秒断音」曲线
  （`node agent-workspace/check-audio-drift.cjs`）。

## 写宿主时要照做的 ABI 事实（都从项目内那份头文件/源码查得，别凭记忆）

- 常量（`libretro-common/include/libretro.h`）：`RETRO_DEVICE_JOYPAD=1`(:176)；按键 id B=0 Y=1 SELECT=2 START=3 UP=4 DOWN=5 LEFT=6 RIGHT=7 A=8 X=9(:320-347)；`XRGB8888=1 RGB565=2`(:5901-5914)；`SAVE_RAM=0 RTC=1 SYSTEM_RAM=2`(:510-518)。
- `retro_system_av_info`：`geometry` 20 B（base_width/base_height/max_width/max_height 是 u32，aspect_ratio 是 f32），`timing` 因 double 对齐落在偏移 24，顺序是 **fps 在前、sample_rate 在后**(:6567-6640)，总 40 B。
- 核心 `need_fullpath = true`(:1846)、`valid_extensions = "fds|nes|unf|unif"` → **ROM 必须先 `FS.writeFile` 落进 MEMFS，再只传路径**；`retro_game_info` 的 data/size 留 0。
- 环境回调必须处理的：`SET_PIXEL_FORMAT`(10) 记格式并回 true；`GET_SYSTEM_DIRECTORY`(9)/`GET_SAVE_DIRECTORY`(31) 写路径指针回 true；`GET_VARIABLE_UPDATE`(17) 写 false 回 true；`GET_VARIABLE`(15) 回 false（用核心默认选项）；
**`GET_INPUT_BITMASKS`(51|EXP) 必须回 false** —— 我们的 input_state 只按单个 id 回答，
回 true 核心就改查 `RETRO_DEVICE_ID_JOYPAD_MASK`(256)，每帧拿到 0，
表现为「游戏完全收不到按键、页面一条报错都没有」（原型期就是这么写的，进产品后才查出，
见 `agent-workspace/verify-input-reaches-core.cjs`）；`SET_SYSTEM_AV_INFO`(32)/`SET_GEOMETRY`(37) 读结构回 true；`GET_LOG_INTERFACE`(27) 回 false（可变参数回调不接）。其余（含 `SET_MEMORY_MAPS`、`SET_CORE_OPTIONS*`、`GET_VFS_INTERFACE`）回 false 即可，核心走默认路径。
- 回调注册：`addFunction(fn, sig)`，签名 `env='iii'`、`video='viiii'`、`audio_batch='iii'`、`audio_sample='vii'`、`input_poll='v'`、`input_state='iiiii'`。
- 帧缓冲：`video_refresh(data, w, h, pitch)`，XRGB8888 小端在内存里是 **B,G,R,X**，而 ImageData 要 **R,G,B,A** → 不能整块 `memcpy`，必须换 R/B 通道（`smoke-fceumm-host.cjs` 的 `savePng` 里就是这么做的）；`pitch` 是行字节跨度，要逐行取。
- `ALLOW_MEMORY_GROWTH=1` 下堆视图会换：每次访问重新取 `Module.HEAPU8`，不要缓存成局部常量。
- 节奏按 `av_info.fps` 走：牧场物语/金庸群侠传这类板卡报 **50.007 fps**（`retro_get_region()` 仍回 0=NTSC），写死 60 会跑快。
- 电池存档用 `retro_get_memory_data/size(SAVE_RAM)`，8 KB 的那几款就是它；`SAVE_RAM=0` 的板卡没有电池 RAM，别当错误。

## 已落地（2026-10-05 进产品，任务 #47~#51 完成）

上面那五条差异全部按现状实现，代码在这里：
`src/lib/nes/libretro-host.js`（宿主）· `audio-processor.js`（AudioWorklet 出口）·
`rastate.js`（RASTATE 容器）· `console.js`（对 `app.js` 暴露的面）·
`storage.js` v3（二进制槽位 + SAVE_RAM 镜像 + ROM 落盘）·
`scripts/build-core.cjs`（正式构建步骤，产物进 `public/cores/`，wasm 随仓库走，CI 不需要 emsdk）。

原来的两条「未决」都已经有答案：
- 核心构建**已**提升为正式步骤（`npm run build:core`），不再只出到 agent-workspace。
- jsnes 旧存档**已**确认作废：数据库升到 v3 时 `onupgradeneeded` 删表重建，
  不留兼容层（项目规则）。用户侧的影响和原因写在 `doc/游戏库与存档.md`「存档：IndexedDB 三张表」一节，
  坑记在 `doc/值得记住的坑/nes-console.md`「升级模拟器内核会让用户已有的存档读不出来」。

## 宿主的几处实现选择，理由都在注释里

- **按键位掩码（`GET_INPUT_BITMASKS`）回 false，走逐 id 查询**：宿主的
  `input_state` 只会按单个 id 回答 0/1。要接位掩码就照 `libretro.h:1793-1807` 的约定
  （`id = RETRO_DEVICE_ID_JOYPAD_MASK`(256)，返回 `1 << 按键 id` 的按位或），
  但实测逐 id 一点不慢，接它属于过早优化。
- **核心每帧实际查 19 次**（`agent-workspace/verify-input-reaches-core.cjs` 的账本实测）：
  两个手柄各按其 `bindmap` 9 项（libretro.c:209-219 = A/B/L3/SELECT/START/UP/DOWN/LEFT/RIGHT，
  注意 NES 没有 Y/X 位，所以 id 1、9 从不被查），外加 0 号手柄单独查一次 L2(13) 做换色。
  写测试时按这张表断言，别按「八个 NES 按键 = id 0~7」想当然。
- **`GET_LOG_INTERFACE` 回 false**：核心日志走可变参数回调，宿主不接。
- **toast（卡带信息提示）只认 `SET_MESSAGE`(6)**：对标 `frontend/libretro.c:69`
  `rarch_assert(g_fceutools.msg_cb != NULL)` 与 `video: FCEUD_DispMessage` 的调用点
  （`cart.c:401`、`fds.c:688`，源码缓存在 `%TEMP%/ra/fceumm/`）。
