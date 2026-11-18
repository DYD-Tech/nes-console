# NES Console

浏览器里的 NES（红白机 / FC）模拟器。纯静态站点，没有后端，**也不需要构建**：
`web/` 目录就是网站本身，任何静态文件服务器直接就能跑。模拟核心用 libretro 生态的
**fceumm**，编译成 WebAssembly 在浏览器里跑，外面套一层自研的薄 libretro 宿主
（只实现视频、音频、按键、存档、环境变量这几样 libretro 规定的接口，不含 NES 逻辑）。

屏幕内是一台完整的「游戏机系统」：游戏列表、设置、存档管理、帮助都在 4:3 画面里完成，
界面风格对标 RetroArch 的 [Ozone](https://docs.libretro.com/guides/ozone/) 菜单。
所有操作都能用手柄（或键盘的方向键 + 两个动作键）完成，不存在只能用键鼠的功能。

在线试玩：<https://dyd-tech.github.io/nes-console/>

## 特性

- **屏幕内系统界面**：主菜单六个分类（游戏 / 游戏管理 / 控制管理 / 系统 / 操作说明 / 关于），
  设置、存档管理、游戏信息、游戏中快速菜单全在画面里，配色取 RetroArch Ozone 默认深色主题的实取值
- **手柄优先的导航**：菜单焦点分「分类栏」和「列表」两处，↑↓ 在当前栏内移动，→/A 进入，←/B 返回
- **菜单打开时自动暂停游戏**（对标 RetroArch 的 `menu_pause_libretro`，默认开启）
- **触摸虚拟手柄**：左边四片软拨片拼成的十字方向键（四个方向各占一个扇区，斜向是外切圆上
  四段独立的细弧键，跟拨片之间留着空隙 —— 按空白什么都不给，不误触）+
  下面一条 SELECT；右边五颗同尺寸圆片（上排 X/Y、中排 A/B，正方形正中还有一颗 A+B 组合键）+
  下面一条 START。两块同构、各管一个拇指，横竖屏都是左右分家，可以整块拖动摆位、可以逐颗显隐。
  按键大小三档可调（小 / 中 / 大，默认中档；屏太窄会自动收小，两块不会挤到一起）。
  两颗胶囊键一边一颗，就是为了两只拇指一起按出「呼出菜单」的组合键
- **屏幕右上角两颗常驻按钮**：写着「菜单」的那颗呼出菜单，左边一颗全屏图标铺满屏幕
  （触屏设备上顺手锁成横屏）。两颗同排同尺寸，都不随菜单关闭而消失；描边一深一浅两条，
  压在深色还是浅色游戏画面上都看得见
- **即时存档**：自动存档 + 10 个手动槽位 + 快速存读，格式是不压缩的 RASTATE，
  可以直接拖进桌面 RetroArch 读取，RetroArch 存出来的档这里也能读；
  游戏自己写的电池进度另存一份，等价于 `.srm`
- **按键映射可改**：13 个动作逐个改绑键盘按键，存 localStorage
- **加自己的游戏**：把 `.nes` 拖到页面任意位置，或走「游戏管理 → 加入游戏」。
  这条路存进浏览器 IndexedDB，只在这台设备可见，不占站点体积
- **内置演示卡带**：清单 `web/games.json` 里列的游戏（目前一款），在列表里标为「内置」
- **AudioWorklet 音频**：实时线程消费，跑帧侧按队列深度微调速度，音画不漂
- **画面自适应**：任何分辨率下都取该视口内能放下的最大 4:3 矩形，界面不额外吃掉画面高度

## 快速开始

不需要 `npm install`，也不需要构建。把 `web/` 目录交给任何一个静态文件服务器就能玩：

```bash
python -m http.server -d web 8000     # 打开 http://localhost:8000/
npx serve web                         # 或者用 Node 生态的 serve
npm run serve                         # 仓库自带的零依赖服务器：http://localhost:7890/nes-console/（测试脚本打的就是它）
```

**不能直接双击 `index.html` 用 `file://` 打开**：浏览器不允许本地文件加载 JS 模块、
wasm 和音频线程（AudioWorklet），页面会白屏或没声音。一定要经过一个 http 服务器。
另外声音需要「安全上下文」：`localhost` 或 `https` 才有声音，用局域网 IP（`http://192.168.x.x`）访问会静音运行。

页面里所有资源都用相对路径，所以站点放在根目录还是子目录（比如 GitHub Pages 的 `/nes-console/`）都不用改配置。

核心的 wasm 产物（`web/cores/`）随仓库发布，日常开发不需要重编、也不需要 emsdk。
只有换核心版本时才编一次：

```bash
npm run build:core                     # 需要 emsdk，默认取 ~/emsdk
EMSDK_DIR=/path/to/emsdk npm run build:core
```

### 加游戏

- 只想**自己玩**：把文件拖进页面，或走「游戏管理 → 加入游戏」。ROM 存在浏览器的 IndexedDB 里，
  只在这台设备可见，不上传、不占站点体积。这是站点的主要用法。
- 想让它成为**站点的内置游戏**（很少需要）：`.nes` 放进 `web/rom/`，再在 `web/games.json` 里加一条
  （要写这份 ROM 的内容哈希，算法和一行命令见 [`doc/游戏库与存档.md`](doc/游戏库与存档.md)）。
  浏览器没法列出服务器上的目录，所以内置游戏只能靠这份清单告诉页面。
  放进这个目录即随站点分发，请只放你有权分发的卡带（自制、公有领域，或已获授权）。

仓库默认带一张能跑的演示卡带，克隆下来就能试玩，不用先去找 ROM。

### 部署

仓库配了 GitHub Actions（`.github/workflows/deploy.yml`）：推到 `main` 就把 `web/` 目录原样发布到 GitHub Pages，
不装 Node、不跑任何构建。放到别的静态托管也一样：上传 `web/` 里的全部文件即可。

## 操作

**以手柄为标准设计**，键盘默认映射到对应的手柄按键，可以在「控制管理 → 按键映射」里逐个动作改绑：

| 手柄 | 键盘 | 作用 |
|------|------|------|
| 十字键 | 方向键 | 导航（斜向要按十字键外面那四段弧键，按空白没有斜向） |
| A | <kbd>X</kbd> | 确认 / 启动 / 进入列表 |
| B | <kbd>Z</kbd> 或 <kbd>Esc</kbd> | 返回 / 取消 / 回到分类栏 |
| SELECT + START | <kbd>Shift</kbd> + <kbd>Enter</kbd>，或 <kbd>Esc</kbd> | 呼出 / 关闭菜单（触摸手柄上一边一颗，两只拇指同时按） |
| L1 / R1 | <kbd>F5</kbd> / <kbd>F9</kbd> | 快速保存 / 快速读取 |

界面只用 **十字键 + A + B（+ 菜单键）**，刻意不用 X/Y：NES 一个端口只有 A/B 两个动作位，
X/Y 送不进游戏；而且不是所有手柄都有 X/Y，功能绑上去就等于绑在一颗不一定存在的键上。
触摸手柄上仍然有 X、Y 两枚可按、可绑的按钮（默认 <kbd>C</kbd>、<kbd>V</kbd>），只是界面不依赖它们。

改过绑定之后，菜单里的「操作说明」会显示当前键位 —— 那一栏就是上面这张表在界面里的版本，
不用翻文档。

菜单里的提示分三处：底栏**右侧**常驻写「这一屏现在能按什么」（跟着焦点换文案），
底栏**左侧**写当前列表有多少项（「9 款」，没数量可说时整块不占位），
系统提示（进度、报错、「已保存到槽位 3」）是画面顶部居中的一次性 toast，
例行回执约 2.8 秒、报错类约 6 秒后自动消失。游戏画面下没有任何常驻提示条。

## 项目结构

```
web/                         网站本身（原样发布，不经构建）
├── index.html               页面骨架
├── css/
│   ├── reset.css            基础样式重置（Tailwind Preflight 原文，当第三方代码看待）
│   └── global.css           布局 + 屏幕内界面样式
├── js/                      浏览器原生 ES 模块，index.html 只引 app.js
│   ├── app.js               接线 + 菜单内容定义（入口）
│   ├── nes/                 模拟器这一侧（换核心只动这个目录）
│   │   ├── console.js       门面：界面只认它（载 ROM、存/读档、按键、生命周期）
│   │   ├── libretro-host.js libretro ABI 宿主：视频/音频/按键/environ/内存存取
│   │   ├── audio-processor.js AudioWorklet 里的音频出口（环形缓冲 + 计数回报）
│   │   └── rastate.js       RASTATE 容器的打包/拆包（与 RetroArch 互通）
│   ├── input-manager.js     键盘/手柄/触摸 -> 统一动作（含按键绑定与改绑）
│   ├── screen-ui.js         屏幕内界面：菜单栈、焦点模型、Ozone 风格渲染
│   ├── touch-layout.js      虚拟手柄的显隐、按键大小与拖动摆放
│   ├── game-manager.js      游戏列表与加载
│   ├── settings-manager.js  设置读写（localStorage）
│   └── storage.js           存档、电池 RAM、ROM 落盘（IndexedDB，三张表）
├── cores/                   fceumm 的 wasm 产物 + build.json（记下是哪份源码编的）
├── rom/                     内置 ROM（只入库一张演示卡带）
├── games.json               内置游戏清单（手写入库，带每款的内容哈希）
└── favicon.svg
scripts/
├── serve.cjs                零依赖静态服务器，把 web/ 挂到 7890（npm run serve）
└── build-core.cjs           emsdk 编核心（npm run build:core）
third_party/
└── libretro-fceumm/         核心源码（GPL-2.0，带上游 commit 记录）
agent-workspace/             回归脚本与开发笔记（日志、截图在 out/、shots/，不入库）
doc/                         实现文档，见下面「文档」
```

## 测试

```bash
npm run test:fast                              # 快档：3 条脚本 225 条断言，约 1 秒，不用起站点
npm run serve                                  # 浏览器脚本打 http://localhost:7890/nes-console/，先把站点起着
node agent-workspace/run-regression.cjs        # 全量：25 条约 1000 条断言，约 6 分钟，汇总带每条耗时
node agent-workspace/run-regression.cjs wasm   # 参数是脚本名关键字，只跑相关的几条
```

**改哪处该测到什么程度、每条脚本测什么、已知的环境假失败，都在
[`doc/测试方案.md`](doc/测试方案.md)。** 一句话原则：改样子看样子，改规则测规则，
碰共享的东西才跑全量。跑测试要先 `npm install`（只装 playwright 一个开发依赖），浏览器脚本还需要一个 Chromium：`npx playwright install chromium`。

## 文档

| 文件 | 讲什么 |
|------|--------|
| [`doc/模拟器核心与宿主.md`](doc/模拟器核心与宿主.md) | 为什么是 fceumm + 自研宿主；libretro 接线的几条硬约束；AudioWorklet 音频；与 RetroArch 的存档互通 |
| [`doc/界面与交互.md`](doc/界面与交互.md) | 画面最大化的布局推导、Ozone 配色、菜单焦点模型、菜单暂停、常驻按钮与顶栏排布、提示、长按抑制 |
| [`doc/控制与手柄.md`](doc/控制与手柄.md) | 按键映射的数据模型、虚拟手柄显隐与三档大小、十字方向键的扇区判定、自由摆放 |
| [`doc/游戏库与存档.md`](doc/游戏库与存档.md) | 内置游戏清单怎么写、IndexedDB 三张表、即时存档与电池 RAM 的分工 |
| [`doc/测试方案.md`](doc/测试方案.md) | 测试分档、脚本清单与耗时、环境前置 |
| [`doc/color.md`](doc/color.md) | 色板数值（屏幕内 Ozone / 屏幕外石墨 + 强调青）与对比度实测 |
| [`doc/值得记住的坑/nes-console.md`](doc/值得记住的坑/nes-console.md) | 踩坑记录，每条「现象 → 原因 → 做法」 |

## 技术栈

- **原生 HTML + CSS + ES 模块** — 不用框架、不打包、不构建，浏览器直接读源码
- **fceumm（libretro 核心）→ WebAssembly** — NES 模拟核心，源码在 `third_party/`，产物在 `web/cores/`
- **自研薄 libretro 宿主** — 没有用现成的整套前端（EmulatorJS / Nostalgist），理由见
  [`doc/模拟器核心与宿主.md`](doc/模拟器核心与宿主.md)

## License

本项目代码 MIT。内含的 fceumm 核心是 GPL-2.0，源码与上游 commit 记录一起放在
`third_party/libretro-fceumm/`。
