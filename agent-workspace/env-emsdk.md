# 在 Windows 上装 emsdk 编核心（2026-10-05 装好，记下踩到的坑）

给 `npm run build:core` 用。装到 `~/emsdk`，版本 **Emscripten 6.0.11**
（`sdk-releases-f6264d4a4dd9ba24a9f0a5702835a44d1463de13-64bit`），含 clang / wasm-ld / lld /
自带 node 24.19 / 自带 python 3.13.3。

安装脚本 `emsdk.py` 需要一个**真** python：Windows 上 PATH 里的 `python` 默认是
Microsoft Store 的占位程序（运行即报「Python was not found」），所以要用一个能用的
解释器显式执行它（手上有的话：conda 环境里的 python、或 emsdk 自己下载的那个都行）。

## 关键坑：Git Bash 里不能直接 source emsdk_env.sh

`emsdk_env.sh` 最后一行是 `eval \`EMSDK_BASH=1 "$DIR/emsdk" construct_env\``，
而 `emsdk` 这个入口脚本要调 `python` —— Git Bash 解析到的 `python` 就是上面那个
WindowsApps 占位程序，于是环境变量一条都没导出，后面 `emcc` 同样报错。

**可用做法**（`scripts/build-core.cjs` 里就按这个写，不改全局环境）：

```bash
export PATH="$HOME/emsdk/python/<自带的版本目录>:$HOME/emsdk:$HOME/emsdk/upstream/emscripten:$HOME/emsdk/upstream/bin:$PATH"
```

要点是 **emsdk 自带的 python 必须排在 WindowsApps 之前**，`emcc` / `emcc.exe` 都靠 PATH 上
的 `python` 起 emcc.py。构建脚本不写死那个版本目录名，是把 `$EMSDK/python` 下第一个含
可执行文件的目录现找出来。

等价的临时写法（不用手改 PATH）：

```bash
cd ~/emsdk
eval "$(EMSDK_BASH=1 python emsdk.py construct_env 2>/dev/null | grep '^export')"
```

——但注意 `construct_env` 输出的 PATH 里**没有**它自带 python 那一栏，实测这样 emcc 仍会报
Python not found，所以要么用上面那行显式 export，要么在 `grep '^export'` 之后手工补 python 目录。

## 验证过的最小闭环

```bash
emcc h.c -o h.js && node h.js     # 输出 "wasm ok"
```

clang 能正常产出 wasm + JS glue，`--sysroot` 缓存已就位（首次运行时自动下好）。

## 没有做的

- `emsdk activate --permanent`（会写 Windows 用户级环境变量）。**没做**，因为那是
  项目外的全局改动。只在当前 shell 里 export PATH 就够构建脚本用了。

## 已经做完的

- fceumm 核心的实际编译：不依赖上游 Makefile，用脚本 glob 源文件直接喂 `emcc`
  （`scripts/build-core.cjs`，产物进 `public/cores/` 并随仓库走，CI 不需要 emsdk）。
  一次把几百个源文件交给 emcc 会被无声杀掉，得用响应文件（`.rsp`）—— 记在踩坑文档。
