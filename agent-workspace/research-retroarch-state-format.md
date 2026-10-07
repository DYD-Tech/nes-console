# RetroArch 存档格式（查证记录，2026-10-05）

给「换 wasm 内核」的可行性验证用。结论都带出处，本机缓存在 `%TEMP%/ra/`。
检索范围：libretro/RetroArch 的 master 与 v1.22.2 / v1.20 / v1.18 / v1.15 / v1.10.3 /
v1.9.0 / v1.7.4（`tasks/task_save.c`、根 `save.c`、`libretro-common/streams/rzip_stream.c`、
`config.def.h`、`msg_hash.h`），libretro/libretro-fceumm master（`src/drivers/libretro/libretro.c`、
`src/state.c`、`src/boards/mmc3.c`），以及 libretro/docs master 的全部 md 清单。

## 先记一条被推翻的假设

`.state` 文件头里**没有**游戏名、核心名、核心版本、CRC —— 一个都没有。
`RARCH_STATE_HEADER_PREFIX` 和 `struct rarch_state_header` 在 v1.7.4～v1.22.2 全版本 0 命中。
所以 RetroArch 既不校验也不拦「装错游戏/错核心」的状态，兼容性完全由核心的解析器裁定。
（网上和模型记忆里常见的「头里有 CRC、版本不符会拒载」是过时或错误说法。）

## 即时存档（.state）容器

v1.10 起是流式块格式，没有固定头长：

| 偏移 | 长度 | 内容 |
|---|---|---|
| 0 | 7 | ASCII `RASTATE` |
| 7 | 1 | 版本号 = `1`（`RASTATE_VERSION`） |
| 每块 +0 | 4 | 块 ID ASCII：`RPLY` / `MEM ` / `ACHV` / `END ` |
| 每块 +4 | 4 | uint32 **小端**，载荷长度（未压缩真实长度） |
| 每块 +8 | n | 载荷，零填充到 8 字节倍数（`CONTENT_ALIGN_SIZE`） |

总长 = 8 + 8 + align8(retro_serialize_size) + 8。`RPLY` 只在 BSV 录制/回放时写，
`ACHV` 只在 RetroAchievements 激活时写。
出处：`tasks/task_save.c` v1.22.2:340,349,381-388,397-446；master:93-97,566-671。

读侧的判定（决定我们自己写能不能被桌面读）：

- `len < 8` → 直接拒（master:1379-1381）。
- 前 7 字节不是 `RASTATE` → 注释 `/* old format is just core data, load it directly */`，
  **整包裸喂 `retro_unserialize`**（v1.22.2:936-943、master:1384）。即裸的核心状态缓冲也能载入。
- 版本字节不是 1 → 返回 false。
- 块声明长度超过缓冲 → `RARCH_ERR ... refusing`（master:1274-1282）。
- `core_unserialize` 返回 false → 报 `MSG_FAILED_TO_LOAD_STATE`（v1.22.2:877,1106-1117）。

## 压缩：互通的最大坑

核心状态本身不压缩，压缩是**文件级**的 RZIP 容器，桌面默认开着
（`savestate_file_compression` 默认 true，`config.def.h` v1.22.2:1440；
写入走 `intfstream_open_rzip_file`，v1.22.2:513-515 / master:842）。
读侧永远走 RZIP 接口，**自动识别未压缩数据**（master:1108-1111）。

RZIP v1 头 20 字节：`#RZIPv<ver>#`(8) + uint32LE 名义未压缩块大小（默认 131072）
+ uint64LE 总未压缩大小，其后循环 `uint32LE 压缩块长 + 块数据`（`rzip_stream.c`:206-331,60）。
每块是独立的 zlib 流，`windowBits=15` → RFC1950 带 adler32（`trans_stream_zlib.c`:76）。
master 新增 v2 = Zstandard（`rzip_stream.c`:44-45,76-78，默认 codec 1）；v1.22.2 只有 deflate。
状态路径里没有任何 CRC/checksum 字段。

推论：我们写**不加压缩**的 `RASTATE`，桌面照样读；反过来读桌面文件要么能剥 RZIP v1/v2，
要么让用户在桌面端关掉 Save State File Compression。

## 电池存档（.srm）

无头，纯字节。`content_save_ram_file` 直接写 `mem_info.data × mem_info.size`
（`save.c`:577-579），注册类型 `RETRO_MEMORY_SAVE_RAM`（`save.c`:674），另有 `.rtc`（:678）。
`save_file_compression` 默认 false（`config.def.h`:1678）。
读：`rzipstream_read_file`(:433) 后 `memcpy`，文件偏大只截断并 `RARCH_WARN`(:441-451)。
→ 网页与桌面双向完全通用，是最稳的互通通道。前提同一个核心（fceumm↔fceumm）。

## 核心版本才是实际风险（fceumm）

载荷内部还有核心自己的 16 字节头：`FCS\xFF` + uint32LE totalsize + uint32LE
`FCEU_VERSION_NUMERIC`（`state.c`:460-499,528-537）。
fceumm `libretro.c`:3428-3439 的注释自陈 SFORMAT 内容跨 build 会变（举例 FDS 音频改写 #560
增删 chunk tag 导致旧存档尺寸不同），因此 `retro_unserialize` 放弃了等长校验，改成
「≥16 且 ≤4× 当前尺寸」（:3438），未知 chunk tag 由 `ReadStateChunks` 跳过
（`state.c`:379-415,455）。
→ RetroArch 层不挡版本，但 chunk 表变化是真实风险，要 pin 的是 **fceumm 核心 build**，
不是 RetroArch 版本号（文件里根本没有它）。

## 对我们设计的一条约束

即时存档**内含电池 RAM**（`mmc3.c`:311 `AddExState(WRAM…)`），载入状态会覆盖内存中的 SRAM。
桌面用 `block_sram_overwrite` + 备份规避（`task_save.c`:214-229,1063-1099）。
→ 我们做「即时存档槽 + 电池存档」两层时，必须显式定一条谁覆盖谁的规则，不能靠巧合。

## 未验证

- v0.9～v1.6 是否曾有 352 字节头（没取该区间源码）。
- `RASTATE` 引入的确切 commit/版本（只由「v1.9.0 无、v1.10.3 有」推得）。
- RetroArch 官方「不可跨核心版本」的措辞：docs 里没有 save-states 页（那个 URL 404），
  `msg_hash.h` grep 无命中 —— 不许编造，就写没有官方文档。
- zstd 版 RZIP 在实际发行构建里的启用范围（只读了 master 源码，未核对二进制构建的 `HAVE_RZSTD`）。
