/**
 * 应用主入口：把各个模块接起来，定义菜单内容。
 *
 * 分工：
 *   input-manager   把键盘/手柄/触摸归一成「动作」
 *   screen-ui       把「菜单数据」画成界面并处理导航
 *   game-manager    游戏列表与加载
 *   settings-manager 设置读写
 *   nes/            模拟器本体（libretro 核心宿主）
 * 本文件只做「接线」和「定义菜单里有什么」。
 *
 * 输入分发规则（为什么是这个顺序）：
 * 1. 界面打开时，动作先给界面；界面不消费的（比如 L1/R1）再给游戏。
 * 2. 界面关闭时，动作全部给游戏。
 * 这样界面上不会漏按键，游戏中也不会被界面截走按键。
 */

import { NesConsole, BUTTON } from './nes/console.js';
import { InputManager, ACTIONS, DEFAULT_BINDINGS, formatKeyCode } from './input-manager.js';
import { ScreenUI } from './screen-ui.js';
import { GameManager } from './game-manager.js';
import { SettingsManager, SETTINGS_SCHEMA, DEFAULT_SETTINGS, PAD_MODES, PAD_GROUPS } from './settings-manager.js';
import { TouchLayout } from './touch-layout.js';
import {
  SLOTS, SLOT_LABELS, saveState, loadState, deleteState, getSaveStates,
  saveSRAM, loadSRAM, requestPersistence,
} from './storage.js';

// ==================== 初始化 ====================

const canvas = document.getElementById('nes-canvas');
const screenEl = document.querySelector('.screen');
const toastEl = document.getElementById('toast');
const crtFilter = document.getElementById('crt-filter');
const overlay = document.getElementById('canvas-overlay');
const fileInput = document.getElementById('file-input');
const stageEl = document.querySelector('.stage');
const layoutEditorEl = document.getElementById('layout-editor');

const BASE = import.meta.env.BASE_URL;

/** 关于菜单里「Powered by fceumm」的落地页（libretro 核心的仓库） */
const FCEUMM_URL = 'https://github.com/libretro/libretro-fceumm';

const settings = new SettingsManager({
  onChange: (path, value) => applySetting(path, value),
});

const games = new GameManager({
  basePath: BASE,
  onStatus: (msg) => showToast(msg),
});

const nesConsole = new NesConsole(canvas, {
  onStatus: (msg, important) => showToast(msg, { important }),
  onCrash: (msg) => showError(`游戏崩溃: ${msg}`),
});
// 暴露给测试脚本访问内部状态（host.workletNode、host.frames 等）
window.__nesConsole = nesConsole;

const ui = new ScreenUI(screenEl, {
  // 菜单打开 = 暂停游戏，菜单全部关闭 = 恢复游戏。
  // 对标 RetroArch：菜单打开时暂停核心内容（runloop.c:3516-3521，
  // 由 menu_pause_libretro 控制，默认开启），本实现同样默认暂停。
  onOpen: () => { pauseGame(); },
  onEmpty: () => {
    // 菜单关了还等按键的话，下一个按键会被无声吞掉，所以一并取消
    capturingAction = null;
    input.endKeyCapture();
    resumeGame();
  },
});

const input = new InputManager({
  onAction: (action, pressed) => handleAction(action, pressed),
  // 键盘绑定是用户可改的设置，启动时就按设置里的值建表
  bindings: settings.get().controls.keyMap,
});

/** 虚拟手柄的显隐与摆放（设置在 controls.* 里） */
const layout = new TouchLayout({
  stage: stageEl,
  controls: document.getElementById('touch-controls'),
  editor: layoutEditorEl,
  getSettings: () => settings.get().controls,
  onCommit: (path, value) => settings.setValue(path, value),
  onStatus: (msg) => showToast(msg),
});

// ==================== 状态 ====================

/** 当前是否正在运行游戏（游戏画面可见） */
let playing = false;
/** 快速菜单里选中的存档槽位 */
let quickSlot = SLOTS.SLOT_0;
/** 游戏已运行的秒数，用于游戏信息里显示时长 */
let playSeconds = 0;
let playTimer = null;
/**
 * 待松开的游戏按键：按下时转发给游戏了，松开时也要转发。
 *
 * 必须声明在下面的启动代码之前：启动时会打开主菜单，触发 onOpen ->
 * pauseGame() -> 这里。用 let/const 声明在调用点之后会踩暂时性死区（TDZ），
 * 抛 ReferenceError。
 */
const pendingRelease = new Set();

// ==================== 启动 ====================

// 预加载 wasm 核心（约 800 KB），把编译耗时藏在「还在挑游戏」这段时间里。
// 不 await：主菜单得先出来。真正要用它的 loadROM 会等同一个 Promise（见 nes/console.js）。
nesConsole.init().catch((e) => showError(e.message));
input.start();
ui.push(buildMainMenu());

// 把设置里的初始值应用一遍（CRT 开关、音量等）
for (const cat of SETTINGS_SCHEMA) {
  for (const item of cat.items) {
    applySetting(item.path, settings.getValue(item.path));
  }
}

// 控制设置不在 SETTINGS_SCHEMA 里（它有独立菜单），单独应用一遍
layout.apply();

// 触摸手柄：把 DOM 按钮绑到动作上
// SELECT 在左手、START 在右手，两只拇指一起按就是 SELECT+START 组合键（呼出菜单，
// 见 input-manager.js 的 COMBOS）。屏幕右上角另有一颗独立的「菜单」按钮，
// 给「只想开菜单、不想把两只拇指都挪开」的场合用。
bindTouchControls();

requestPersistence();

// 把游戏列表读全：构建时生成的内置游戏清单 + 上次加入本机库的用户 ROM。
// 上面已经把主菜单推上去了，所以读回完要重画一次，否则恢复出来的游戏看不见。
Promise.all([
  games.loadBuiltIn().catch((e) => showError(e.message)),
  games.restoreROMs().catch((e) => showError('读取已保存的游戏失败: ' + e.message)),
]).then(() => {
  ui.refresh();
});

// ==================== 输入分发 ====================

/**
 * @param {string} action
 * @param {boolean} pressed - true 按下，false 松开
 */
function handleAction(action, pressed) {
  // 松开事件：只关心「之前转发给过游戏的按键」，把它松开。
  // 界面打开时按下的键不会转发给游戏，所以这里也不需要松开。
  if (!pressed) {
    if (pendingRelease.has(action)) {
      pendingRelease.delete(action);
      forwardToGame(action, false);
    }
    return;
  }

  if (action === ACTIONS.MENU) {
    toggleMenu();
    return;
  }

  // 快速存/读：热键，任何时候都有效（对标 RetroArch 的热键设计）
  if (action === ACTIONS.L1) {
    doSave(quickSlot);
    return;
  }
  if (action === ACTIONS.R1) {
    doLoad(quickSlot);
    return;
  }

  // 界面打开：动作先给界面，界面不消费的再给游戏
  if (!ui.isEmpty()) {
    if (ui.handleAction(action)) return;
    if (playing) {
      forwardToGame(action, true);
      pendingRelease.add(action);
    }
    return;
  }

  // 界面关闭：动作全部给游戏
  if (playing) {
    forwardToGame(action, true);
    pendingRelease.add(action);
  }
}

function forwardToGame(action, down) {
  const button = GAME_BUTTONS[action];
  if (button === undefined) return;
  // 端口从 0 起（libretro 的编号），1P = 0
  if (down) nesConsole.buttonDown(0, button);
  else nesConsole.buttonUp(0, button);
}

/**
 * 动作 -> NES 按键（libretro 的 RETRO_DEVICE_ID_JOYPAD_*）。
 *
 * 注意用 `=== undefined` 判断而不是 `if (!button)`：
 * BUTTON.B 的值是 0，用真假值判断会把 B 键当成「没有对应按键」直接跳过，
 * 表现为 B 键完全没反应。
 */
const GAME_BUTTONS = {
  [ACTIONS.UP]: BUTTON.UP,
  [ACTIONS.DOWN]: BUTTON.DOWN,
  [ACTIONS.LEFT]: BUTTON.LEFT,
  [ACTIONS.RIGHT]: BUTTON.RIGHT,
  [ACTIONS.A]: BUTTON.A,
  [ACTIONS.B]: BUTTON.B,
  [ACTIONS.SELECT]: BUTTON.SELECT,
  [ACTIONS.START]: BUTTON.START,
};

// ==================== 菜单：主菜单 ====================

function buildMainMenu() {
  const list = games.getGames();
  const keys = input.getBindings();
  const key = (action) => formatKeyCode(keys[action]);
  return {
    title: 'NES Console',
    // 「几款游戏」只有游戏那一列说得成立；停在别的分类上就空着（整块不占位）
    count: (section) =>
      section && section.id === 'games' && list.length ? `${list.length} 款` : '',
    startSection: 'games',
    rebuild: () => buildMainMenu(),
    sections: [
      {
        id: 'games',
        label: '游戏',
        icon: 'gamepad',
        items: list.map((game) => ({
          id: game.id,
          label: game.nameZh ? `${game.nameZh} · ${game.name}` : game.name,
          sublabel: game.isBuiltIn ? '内置' : '已加载',
          onSelect: () => startGame(game.id),
        })),
      },
      {
        id: 'manage',
        label: '游戏管理',
        icon: 'folder',
        items: [
          {
            id: 'add-rom',
            label: '加入游戏',
            sublabel: '从本机选择 .nes 文件',
            onSelect: () => fileInput.click(),
          },
          {
            id: 'remove-rom',
            label: '删除游戏',
            sublabel: '移除已加入的游戏',
            onSelect: () => ui.push(buildRemoveGameMenu()),
          },
          {
            id: 'manage-saves',
            label: '管理存档',
            sublabel: '查看 / 删除存档',
            onSelect: () => openManageSavesMenu(),
          },
        ],
      },
      {
        id: 'controls',
        label: '控制管理',
        icon: 'keyboard',
        items: [
          {
            id: 'key-map',
            label: '按键映射',
            sublabel: '改键盘上哪个键对应哪个手柄键',
            onSelect: () => ui.push(buildKeyMapMenu()),
          },
          {
            id: 'pad-mode',
            label: '虚拟手柄',
            sublabel: '整块手柄什么时候显示',
            value: padModeLabel(settings.getValue('controls.padMode')),
            onSelect: () => cyclePadMode(),
          },
          {
            id: 'pad-keys',
            label: '手柄按键显隐',
            sublabel: '只留下你要用的那几个键',
            onSelect: () => ui.push(buildPadKeysMenu()),
          },
          {
            id: 'pad-layout',
            label: '自由摆放按键',
            sublabel: '拖动方向键区 / 功能键区到顺手的位置',
            onSelect: () => startLayoutEdit(),
          },
          {
            id: 'reset-controls',
            label: '恢复默认控制',
            sublabel: '按键、显隐、位置一次清零',
            onSelect: () => resetControls(),
          },
        ],
      },
      {
        id: 'system',
        label: '系统',
        icon: 'settings',
        items: [
          {
            id: 'settings',
            label: '设置',
            onSelect: () => ui.push(buildSettingsMenu()),
          },
          {
            id: 'add-rom',
            label: '载入其他 ROM',
            sublabel: '从本机选择 .nes 文件',
            onSelect: () => fileInput.click(),
          },
        ],
      },
      {
        id: 'help',
        label: '操作说明',
        icon: 'list',
        items: [
          { id: 'h-cat', label: '在分类栏里选分类', value: '↑ ↓' },
          { id: 'h-enter', label: '进入该分类的列表', value: 'A 或 →' },
          { id: 'h-back', label: '回到分类栏 / 关闭菜单', value: 'B 或 ←' },
          { id: 'h-confirm', label: '确认列表里选中的条目', value: 'A' },
          {
            id: 'h-menu',
            label: '呼出 / 关闭菜单',
            sublabel: '两颗一个在左手边、一个在右手边，两只拇指一起按就行；也可以点屏幕右上角的「菜单」',
            value: `${key(ACTIONS.MENU)} 或 SELECT + START`,
          },
          {
            id: 'h-quick',
            label: '快速保存 / 快速读取',
            value: `${key(ACTIONS.L1)} / ${key(ACTIONS.R1)}`,
          },
          {
            id: 'h-game',
            label: '操作游戏（方向 / A / B）',
            value: `${key(ACTIONS.UP)} / ${key(ACTIONS.A)} ${key(ACTIONS.B)}`,
          },
          {
            id: 'h-ab',
            label: '手柄中间的 AB 键',
            sublabel: '四颗动作键正中间那颗，和它们一样大，按住不松就是两个键一起按',
            value: '同时按 A 和 B',
          },
          {
            id: 'h-extra',
            label: 'X / Y 键',
            value: '界面不使用',
          },
        ],
      },
      {
        id: 'about',
        label: '关于',
        icon: 'info',
        items: [
          {
            id: 'a-powered',
            label: 'Powered by fceumm',
            sublabel: '按 A 打开项目主页',
            value: 'libretro 核心',
            onSelect: () => window.open(FCEUMM_URL, '_blank', 'noopener'),
          },
          { id: 'a-res', label: '渲染分辨率', value: '256 × 240' },
          { id: 'a-rate', label: '目标帧率', value: '60 / 50（按游戏）' },
          { id: 'a-storage', label: '存档方式', value: 'IndexedDB（本机）' },
        ],
      },
    ],
    // 提示按焦点所在栏给：上下键在分类栏是换分类、在列表是换条目，
    // 底栏只写当前这一栏用得上的那套（见 screen-ui.js 的 _renderHints）。
    hints: (focus) =>
      focus === 'sidebar'
        ? [
            { keys: ['↑', '↓'], label: '选分类' },
            { keys: ['A', '→'], label: '进入' },
            { keys: ['B'], label: '关闭菜单' },
          ]
        : [
            { keys: ['↑', '↓'], label: '选择' },
            { keys: ['A'], label: '确认' },
            { keys: ['←', 'B'], label: '回分类' },
          ],
  };
}

// ==================== 菜单：设置 ====================

function buildSettingsMenu() {
  return {
    title: '设置',
    // 设置项的当前值是在建菜单时读出来、写进 value 字段的。
    // 改了值之后必须重建菜单，否则重绘的还是旧文字
    // （实测：按 → 改了设置，界面仍显示「开」）。
    rebuild: () => buildSettingsMenu(),
    sections: SETTINGS_SCHEMA.map((cat) => ({
      id: cat.category,
      label: cat.label,
      icon: cat.category === 'display' ? 'display' : cat.category === 'audio' ? 'audio' : 'system',
      items: cat.items.map((item) => ({
        id: item.path,
        label: item.label,
        value: formatSettingValue(item, settings.getValue(item.path)),
        // A 键切换/递增该设置项。←→ 用来在「分类栏」和「设置列表」之间进出，
        // 不占来调数值，所以值的变化全放在 A 上：
        // A 在 toggle 上是翻转、在 range 上是 +1 步（到顶回到最小）。
        onSelect: () => adjustSetting(item, 1),
      })),
    })),
    hints: (focus) =>
      focus === 'sidebar'
        ? [
            { keys: ['↑', '↓'], label: '选分类' },
            { keys: ['A', '→'], label: '进入' },
            { keys: ['B'], label: '返回' },
          ]
        : [
            { keys: ['↑', '↓'], label: '选择' },
            { keys: ['A'], label: '切换 / 增加' },
            { keys: ['←', 'B'], label: '回分类' },
          ],
  };
}

function formatSettingValue(item, value) {
  if (item.type === 'toggle') return value ? '开' : '关';
  if (item.type === 'range') return item.format ? item.format(value) : String(value);
  return String(value);
}

/**
 * 调整一个设置项。
 * toggle 直接取反；range 按 step 步进并在边界处回绕，
 * 这样十字键可以一直按着循环选值，不用反向找边界。
 *
 * 不在这里刷新界面：调用方（ScreenUI 的 onAdjust 分支）改完会自动重绘。
 */
function adjustSetting(item, dir) {
  const current = settings.getValue(item.path);
  if (item.type === 'toggle') {
    settings.setValue(item.path, !current);
  } else if (item.type === 'range') {
    const step = item.step || 1;
    const min = item.min ?? 0;
    const max = item.max ?? 100;
    let next = current + dir * step;
    if (next > max) next = min;
    if (next < min) next = max;
    settings.setValue(item.path, next);
  }
}

/** 把设置真正作用到运行时 */
function applySetting(path, value) {
  switch (path) {
    case 'display.crtFilter':
      crtFilter.classList.toggle('off', !value);
      break;
    case 'audio.volume':
      nesConsole.setVolume(value / 100);
      break;
    case 'audio.muted':
      nesConsole.setMuted(value);
      break;
    // 控制相关：整棵 controls 和它的三个子树各走一条路径
    case 'controls':
      input.setBindings(value.keyMap);
      layout.apply();
      break;
    case 'controls.keyMap':
      input.setBindings(value);
      break;
    case 'controls.padMode':
    case 'controls.padKeys':
      layout.apply();
      break;
    case 'controls.padLayout':
      layout.applyLayout();
      break;
    default:
      break;
  }
}

// ==================== 菜单：控制管理 ====================

/**
 * 正在等用户按一个键的动作（改按键的捕获态）。
 * 真正的「等按键」状态存在 InputManager 里（一次性回调），这里只是给界面看的镜像。
 * 两者不一致时以 InputManager 为准 —— 见 buildKeyMapMenu 里的自我纠正。
 */
let capturingAction = null;

/** 界面上把动作念成人话（A/B 这种单字母太干，说明它在游戏里干什么） */
const ACTION_LABELS = {
  [ACTIONS.UP]: '方向 上',
  [ACTIONS.DOWN]: '方向 下',
  [ACTIONS.LEFT]: '方向 左',
  [ACTIONS.RIGHT]: '方向 右',
  [ACTIONS.A]: 'A 键',
  [ACTIONS.B]: 'B 键',
  [ACTIONS.X]: 'X 键',
  [ACTIONS.Y]: 'Y 键',
  [ACTIONS.SELECT]: 'SELECT',
  [ACTIONS.START]: 'START',
  [ACTIONS.L1]: '快速保存',
  [ACTIONS.R1]: '快速读取',
  [ACTIONS.MENU]: '呼出菜单',
};

const ACTION_SUBLABELS = {
  [ACTIONS.A]: '确认 / 游戏里的 A',
  [ACTIONS.B]: '返回 / 取消',
  // NES 手柄只有 A/B 两个动作位，X/Y 送不进游戏；界面也刻意不用它们（不是
  // 所有手柄都有），所以这两个动作目前谁都不做，只是「按得动、可绑定」。
  [ACTIONS.X]: '界面不使用（NES 无此键位）',
  [ACTIONS.Y]: '界面不使用（NES 无此键位）',
  [ACTIONS.SELECT]: '在手柄左下，和右下的 START 一起按也能呼出菜单',
  [ACTIONS.START]: '游戏里的 Start（在手柄右下）',
  [ACTIONS.MENU]: 'Esc 保留作「取消改绑」，所以不能绑到 Esc',
};

function buildKeyMapMenu() {
  // 菜单被关掉又打开时，捕获态可能已经失效（回调不会再来了），这里纠正回来
  if (capturingAction && !input.keyCapture) capturingAction = null;
  const bindings = input.getBindings();
  return {
    title: '按键映射',
    rebuild: () => buildKeyMapMenu(),
    sections: [
      {
        id: 'keys',
        label: '键盘',
        icon: 'keyboard',
        items: Object.values(ACTIONS).map((action) => ({
          id: action,
          label: ACTION_LABELS[action] || action,
          sublabel: ACTION_SUBLABELS[action],
          value: capturingAction === action ? '按下按键…' : formatKeyCode(bindings[action]),
          onSelect: () => beginCapture(action),
        })),
      },
    ],
    hints: capturingAction
      ? [
        { keys: ['任意键'], label: '绑到该行动作' },
        { keys: ['Backspace'], label: '清空' },
        { keys: ['Esc'], label: '取消' },
      ]
      : [
        { keys: ['A'], label: '改绑' },
        { keys: ['B'], label: '返回' },
      ],
  };
}

/** 开始等一个按键。捕获期间所有按键都不会派发动作（见 InputManager.beginKeyCapture）。 */
function beginCapture(action) {
  capturingAction = action;
  input.beginKeyCapture((code) => finishCapture(action, code));
  ui.refresh();
}

function finishCapture(action, code) {
  const label = ACTION_LABELS[action] || action;
  capturingAction = null;
  // Esc 留作取消：不然进了捕获态就没有反悔的键了
  if (code === 'Escape') {
    showToast('已取消改绑');
    ui.refresh();
    return;
  }
  // Backspace 留作清空：「这个动作不要键盘键」也是常见需求（比如腾出某个键）
  if (code === 'Backspace') {
    clearBinding(action);
    return;
  }
  const displaced = input.setBinding(action, code);
  settings.setValue('controls.keyMap', input.getBindings());
  showToast(
    displaced
      ? `${label} 已绑到 ${formatKeyCode(code)}（${ACTION_LABELS[displaced] || displaced} 已解绑）`
      : `${label} 已绑到 ${formatKeyCode(code)}`,
    // 抢了别的动作的键时，「哪个动作被解绑了」要让人来得及看清
    { important: !!displaced },
  );
  ui.refresh();
}

function clearBinding(action) {
  input.setBinding(action, '');
  settings.setValue('controls.keyMap', input.getBindings());
  showToast(`${ACTION_LABELS[action] || action} 已解绑`);
  ui.refresh();
}

function padModeLabel(mode) {
  const found = PAD_MODES.find((m) => m.value === mode);
  return found ? found.label : PAD_MODES[0].label;
}

/** 三档循环切换（自动 → 始终 → 隐藏 → 自动），和设置里 toggle 的按 A 循环一致 */
function cyclePadMode() {
  const cur = settings.getValue('controls.padMode');
  const i = PAD_MODES.findIndex((m) => m.value === cur);
  const next = PAD_MODES[(i + 1) % PAD_MODES.length].value;
  settings.setValue('controls.padMode', next);
  showToast(`虚拟手柄：${padModeLabel(next)}`);
}

function buildPadKeysMenu() {
  const keys = settings.getValue('controls.padKeys');
  return {
    title: '手柄按键显隐',
    rebuild: () => buildPadKeysMenu(),
    sections: [
      {
        id: 'padkeys',
        label: '按键',
        icon: 'gamepad',
        items: PAD_GROUPS.map((g) => ({
          id: g.id,
          label: g.label,
          value: keys[g.id] === false ? '隐藏' : '显示',
          onSelect: () => togglePadKey(g.id),
        })),
      },
    ],
    hints: [
      { keys: ['A'], label: '显示/隐藏' },
      { keys: ['B'], label: '返回' },
    ],
  };
}

function togglePadKey(id) {
  const keys = { ...settings.getValue('controls.padKeys') };
  keys[id] = keys[id] !== true;
  settings.setValue('controls.padKeys', keys);
}

/**
 * 进入摆放模式。必须先关掉菜单：菜单在 .screen 里，
 * 而虚拟手柄在画面之外的区域，菜单开着拖不到、也看不见拖的结果。
 */
function startLayoutEdit() {
  ui.clear();
  layout.enterEdit();
}

/** 按键、显隐、位置一次回到出厂值 */
function resetControls() {
  settings.setValue('controls', JSON.parse(JSON.stringify(DEFAULT_SETTINGS.controls)));
  showToast('控制设置已恢复默认');
}

// ==================== 菜单：游戏中快速菜单 ====================

function buildQuickMenu() {
  const game = games.getCurrentGame();
  return {
    title: game ? game.name : '快速菜单',
    badge: '游戏中',
    // 游戏中呼出：背景半透明，让后面的画面透出来（Ozone 的做法）
    transparent: true,
    rebuild: () => buildQuickMenu(),
    sections: [
      {
        id: 'quick',
        label: '快速菜单',
        icon: 'play',
        items: [
          {
            id: 'resume',
            label: '继续游戏',
            onSelect: () => ui.clear(),
          },
          {
            id: 'save',
            label: '保存存档',
            sublabel: SLOT_LABELS[quickSlot],
            onSelect: () => doSave(quickSlot),
            onAdjust: (dir) => { cycleQuickSlot(dir); ui.refresh(); },
          },
          {
            id: 'load',
            label: '读取存档',
            sublabel: SLOT_LABELS[quickSlot],
            onSelect: () => doLoad(quickSlot),
            onAdjust: (dir) => { cycleQuickSlot(dir); ui.refresh(); },
          },
          {
            id: 'slots',
            label: '存档管理',
            onSelect: () => openSaveMenu(),
          },
          {
            id: 'reset',
            label: '重置游戏',
            onSelect: () => { nesConsole.reset(); ui.clear(); },
          },
          {
            id: 'info',
            label: '游戏信息',
            onSelect: () => ui.push(buildGameInfo(games.getCurrentGame().id)),
          },
          {
            id: 'settings',
            label: '设置',
            onSelect: () => ui.push(buildSettingsMenu()),
          },
          {
            id: 'exit',
            label: '退出到主菜单',
            onSelect: () => exitToMenu(),
          },
        ],
      },
    ],
    hints: [
      { keys: ['↑', '↓'], label: '选择' },
      { keys: ['A'], label: '确认' },
      { keys: ['←', '→'], label: '换槽位' },
      { keys: ['B'], label: '继续' },
    ],
  };
}

function cycleQuickSlot(dir) {
  const keys = Object.values(SLOTS);
  const idx = keys.indexOf(quickSlot);
  quickSlot = keys[(idx + dir + keys.length) % keys.length];
}

// ==================== 菜单：存档管理 ====================

/**
 * 打开存档管理菜单。
 *
 * 存档列表要读 IndexedDB（异步），而 onSelect 是同步回调，
 * 不能直接 ui.push(await ...)。所以这里先压一个「读取中」的占位菜单，
 * 数据回来后再替换成真内容 —— 用户马上看到反应，而不是点了没动静。
 */
async function openSaveMenu() {
  ui.push({
    title: '存档管理',
    sections: [{ id: 'loading', label: '槽位', icon: 'save', items: [
      { id: 'loading', label: '读取中…' },
    ] }],
    hints: [{ keys: ['B'], label: '返回' }],
  });

  const model = await buildSaveMenu();
  ui.replace(model);
}

async function buildSaveMenu() {
  const game = games.getCurrentGame();
  if (!game) return buildMainMenu();

  const states = game.hash ? await getSaveStates(game.hash) : [];
  const bySlot = new Map(states.map((s) => [s.slot, s]));

  return {
    title: '存档管理',
    badge: game.name,
    // 存/删/读之后要重新读一遍 IndexedDB，槽位时间才会更新
    rebuild: () => buildSaveMenu(),
    sections: [
      {
        id: 'slots',
        label: '槽位',
        icon: 'save',
        items: Object.entries(SLOT_LABELS).map(([slot, label]) => {
          const entry = bySlot.get(slot);
          return {
            id: slot,
            label,
            sublabel: entry ? formatTime(entry.timestamp) : '空',
            // 空槽位按 A 直接存；有存档的按 A 进「槽位操作」，读/覆盖/删除都在里面
            onSelect: () => (entry
              ? openSlotMenu({ slot, entry, game, onLoad: doLoad, onSave: doSave })
              : doSave(slot)),
            hints: entry
              ? [
                { keys: ['A'], label: '操作' },
                { keys: ['B'], label: '返回' },
              ]
              : [
                { keys: ['A'], label: '保存到此处' },
                { keys: ['B'], label: '返回' },
              ],
          };
        }),
      },
    ],
    detail: (item) => {
      const entry = bySlot.get(item.id);
      if (!entry) return { empty: '空槽位。按 A 把当前进度存到这里。' };
      return { lines: saveInfoLines(entry) };
    },
    hints: [
      { keys: ['↑', '↓'], label: '选择槽位' },
      { keys: ['B'], label: '返回' },
    ],
  };
}

/** 一条存档的键值行。槽位列表和「槽位操作」子菜单共用，免得两处说法不一致 */
function saveInfoLines(entry) {
  if (!entry) return [];
  return [
    { label: '时间', value: formatTime(entry.timestamp) },
    // 体积是写入时记在记录里的（一份 RASTATE 14~22 KB，不用把存档读进内存才知道大小）
    { label: '大小', value: formatBytes(entry.bytes) },
  ];
}

/**
 * 槽位操作子菜单：有存档的槽位按 A 进这里。
 *
 * 读 / 覆盖保存 / 删除做成一屏里的三行，只用 A 确认、B 返回。
 * 以前这些挤在同一行上靠 X/Y 两个键触发，而**不是所有手柄都有 X/Y**
 * （NES 原生手柄只有 A/B），只有一套十字键 + A/B 的手柄就够不到删除了。
 *
 * @param {object} opts
 * @param {string} opts.slot - 槽位 id
 * @param {object} opts.entry - 存档记录
 * @param {object} opts.game - 这款游戏（删除时要按它的哈希去取档）
 * @param {function} opts.onLoad - (slot) => void，读取
 * @param {function} [opts.onSave] - (slot) => void，覆盖保存；没在跑这款游戏的场合不传
 */
function openSlotMenu({ slot, entry, game, onLoad, onSave }) {
  ui.push({
    title: SLOT_LABELS[slot],
    badge: game?.name || '',
    sections: [
      {
        id: 'ops',
        label: '操作',
        icon: 'save',
        items: [
          { id: 'load', label: '读取存档', onSelect: () => onLoad(slot) },
          ...(onSave ? [{
            id: 'save',
            label: '覆盖保存',
            sublabel: '用当前进度替换这一份',
            onSelect: async () => {
              await onSave(slot);
              // 存完退回槽位列表：时间变了要重读一遍 IndexedDB 才显示得对
              ui.pop();
              ui.refresh();
            },
          }] : []),
          {
            id: 'delete',
            label: '删除存档',
            sublabel: '此操作不可撤销',
            onSelect: () => confirmDelete(slot, game),
          },
        ],
      },
    ],
    detail: () => ({ lines: saveInfoLines(entry) }),
    hints: [{ keys: ['A'], label: '确认' }, { keys: ['B'], label: '返回' }],
  });
}

/**
 * 删除确认：不直接删，先弹一个二级菜单让用户确认。
 * 存档删了找不回来，误触代价太高。
 */
function confirmDelete(slot, game = games.getCurrentGame()) {
  ui.push({
    title: '删除存档',
    badge: '确认',
    sections: [
      {
        id: 'confirm',
        label: '确认',
        icon: 'info',
        items: [
          {
            id: 'yes',
            label: `删除「${SLOT_LABELS[slot]}」`,
            sublabel: '此操作不可撤销',
            onSelect: async () => {
              if (!game?.hash) return;
              try {
                await deleteState(game.hash, slot);
                showToast('存档已删除');
              } catch (e) {
                showError('删除失败: ' + e.message);
              }
              // 退两层：确认页 → 槽位操作 → 槽位列表，再重建让该槽位显示成「空」
              ui.pop();
              ui.pop();
              ui.refresh();
            },
          },
          {
            id: 'no',
            label: '取消',
            onSelect: () => ui.pop(),
          },
        ],
      },
    ],
    hints: [{ keys: ['A'], label: '确认' }, { keys: ['B'], label: '取消' }],
  });
}

// ==================== 菜单：游戏信息 ====================

/**
 * 一款游戏的键值信息行：游戏中「菜单 → 游戏信息」用。
 * 主菜单不带这块信息（曾经有过右侧详情栏，后来去掉了），
 * 所以要看某款游戏的年份/类型/大小/内容标识，得进游戏再看。
 */
function gameInfoLines(game) {
  return [
    { label: '名称', value: game.name },
    ...(game.nameZh ? [{ label: '中文名', value: game.nameZh }] : []),
    ...(game.year ? [{ label: '发行年份', value: String(game.year) }] : []),
    ...(game.genre ? [{ label: '类型', value: game.genre }] : []),
    ...(game.publisher ? [{ label: '发行商', value: game.publisher }] : []),
    { label: '来源', value: game.isBuiltIn ? '内置' : '本机载入' },
    { label: '文件大小', value: game.size ? formatBytes(game.size) : '未加载' },
    { label: '内容标识', value: game.hash ? game.hash.slice(0, 12) : '未加载' },
  ];
}

function buildGameInfo(gameId) {
  const game = games.getGame(gameId);
  if (!game) return buildMainMenu();

  return {
    title: '游戏信息',
    badge: game.name,
    sections: [
      {
        id: 'info',
        label: '信息',
        icon: 'info',
        items: gameInfoLines(game).map((line, i) => ({ id: `line-${i}`, label: line.label, value: line.value })),
      },
    ],
    detail: () => ({
      empty: game.description || '（没有描述）',
    }),
    hints: [
      { keys: ['↑', '↓'], label: '翻看' },
      { keys: ['B'], label: '返回' },
    ],
  };
}

// ==================== 菜单：删除游戏 ====================

function buildRemoveGameMenu() {
  const userGames = games.getGames().filter((g) => !g.isBuiltIn);
  return {
    title: '删除游戏',
    count: userGames.length ? `${userGames.length} 款` : '',
    sections: [
      {
        id: 'games',
        label: '已加入的游戏',
        icon: 'gamepad',
        items: userGames.length
          ? userGames.map((game) => ({
              id: game.id,
              label: game.name,
              sublabel: game.size ? formatBytes(game.size) : '',
              onSelect: () => ui.push(buildConfirmRemoveGame(game.id)),
            }))
          : [{ id: 'empty', label: '（没有已加入的游戏）', sublabel: '先到「加入游戏」添加' }],
      },
    ],
    hints: [{ keys: ['B'], label: '返回' }],
  };
}

function buildConfirmRemoveGame(gameId) {
  const game = games.getGame(gameId);
  if (!game) return buildMainMenu();
  return {
    title: '确认删除',
    badge: game.name,
    sections: [
      {
        id: 'confirm',
        label: '确认',
        icon: 'info',
        items: [
          {
            id: 'yes',
            label: `删除「${game.name}」`,
            sublabel: '游戏和存档都会移除',
            onSelect: async () => {
              try {
                await games.removeUserGame(gameId);
                showToast(`已删除: ${game.name}`);
              } catch (e) {
                showError('删除失败: ' + e.message);
              }
              ui.pop();
              ui.refresh();
            },
          },
          { id: 'no', label: '取消', onSelect: () => ui.pop() },
        ],
      },
    ],
    hints: [{ keys: ['A'], label: '确认' }, { keys: ['B'], label: '取消' }],
  };
}

// ==================== 菜单：管理存档 ====================

async function openManageSavesMenu() {
  ui.push({
    title: '管理存档',
    sections: [{ id: 'loading', label: '读取中…', icon: 'save', items: [{ id: 'loading', label: '读取中…' }] }],
    hints: [{ keys: ['B'], label: '返回' }],
  });
  const model = await buildManageSavesMenu();
  ui.replace(model);
}

async function buildManageSavesMenu() {
  const allGames = games.getGames();
  const gamesWithSaves = [];
  for (const game of allGames) {
    // 清单里就带 hash（构建时算好的），所以没进过游戏也能直接查它的存档，
    // 不用为了知道哈希把 ROM 下载一遍。
    const hash = game.hash;
    if (!hash) continue;
    const states = await getSaveStates(hash);
    if (states.length > 0) {
      gamesWithSaves.push({ game, states });
    }
  }

  return {
    title: '管理存档',
    count: gamesWithSaves.length ? `${gamesWithSaves.length} 款游戏有存档` : '',
    sections: [
      {
        id: 'games',
        label: '游戏',
        icon: 'save',
        items: gamesWithSaves.length
          ? gamesWithSaves.map(({ game, states }) => ({
              id: game.id,
              label: game.name,
              sublabel: `${states.length} 个存档`,
              onSelect: () => openGameSavesMenu(game.id),
            }))
          : [{ id: 'empty', label: '（没有存档）', sublabel: '先玩游戏并保存' }],
      },
    ],
    hints: [{ keys: ['B'], label: '返回' }],
  };
}

async function openGameSavesMenu(gameId) {
  ui.push({
    title: '存档列表',
    sections: [{ id: 'loading', label: '读取中…', icon: 'save', items: [{ id: 'loading', label: '读取中…' }] }],
    hints: [{ keys: ['B'], label: '返回' }],
  });
  const model = await buildGameSavesMenu(gameId);
  ui.replace(model);
}

async function buildGameSavesMenu(gameId) {
  const game = games.getGame(gameId);
  if (!game) return buildMainMenu();
  const states = game.hash ? await getSaveStates(game.hash) : [];
  const bySlot = new Map(states.map((s) => [s.slot, s]));

  return {
    title: '存档列表',
    badge: game.name,
    rebuild: () => buildGameSavesMenu(gameId),
    sections: [
      {
        id: 'slots',
        label: '槽位',
        icon: 'save',
        items: Object.entries(SLOT_LABELS).map(([slot, label]) => {
          const entry = bySlot.get(slot);
          return {
            id: slot,
            label,
            sublabel: entry ? formatTime(entry.timestamp) : '空',
            onSelect: () => (entry
              ? openSlotMenu({ slot, entry, game, onLoad: (s) => loadSaveFromList(game, s) })
              : showError('这个槽位是空的')),
            hints: entry
              ? [
                  { keys: ['A'], label: '操作' },
                  { keys: ['B'], label: '返回' },
                ]
              : [{ keys: ['B'], label: '返回' }],
          };
        }),
      },
    ],
    detail: (item) => {
      const entry = bySlot.get(item.id);
      if (!entry) return { empty: '空槽位' };
      return { lines: saveInfoLines(entry) };
    },
    hints: [{ keys: ['B'], label: '返回' }],
  };
}

// ==================== 游戏运行 ====================

async function startGame(gameId) {
  const game = games.getGame(gameId);
  if (!game) return;

  try {
    ui.clear();
    overlay.style.display = 'none';
    // 先把「正在启动」写出来：核心是 800 KB 的 wasm，首次加载要几百毫秒，
    // 没这句话的话点了没反应，分不清是没点上还是在加载
    showToast(`正在启动: ${game.name}...`);
    const data = await games.ensureLoaded(gameId);
    // 电池存档（卡带里那块 SRAM）在跑第一帧之前灌进去，游戏开机读进度才读得到。
    // 读不到不影响启动，可能这游戏压根没有电池存档。
    const sram = await loadSRAM(game.hash).catch(() => null);
    games.setCurrent(game);
    if (!(await nesConsole.loadROM(data, game.name, sram))) {
      throw new Error('核心不支持这个 ROM 文件（换个格式或换一款试试）');
    }
    playing = true;
    quickSlot = SLOTS.SLOT_0;
    // 等 ROM 和核心的这几秒里玩家可能已经按过 MENU 了：那一刻 playing 还是 false，
    // pauseGame() 什么都不做，而核心是在 loadROM 内部自己跑起来的 ——
    // 所以在这里补一次检查：菜单开着就立刻停帧，别让游戏在菜单背后偷偷跑。
    if (!ui.isEmpty()) {
      pauseGame();
      return;
    }
    startPlayTimer();
    // 浏览器不给建音频出口时（例如用手机走 http://192.168.x.x 这种局域网地址访问），
    // 宿主会静音降级而不是启动失败。原因必须说出来，否则玩家以为游戏坏了。
    const muted = nesConsole.host.audioBlocked;
    showToast(muted ? `${game.name}：${muted}` : `正在运行: ${game.name}`);
  } catch (e) {
    playing = false;
    overlay.style.display = 'flex';
    showError('启动失败: ' + e.message);
    console.error(e);
  }
}

function exitToMenu() {
  stopPlayTimer();
  // 退游戏前把电池存档落盘：真机上卡带里的进度不会因为拔游戏就丢
  persistProgress();
  nesConsole.stop();
  playing = false;
  games.clearCurrent();
  ui.clear();
  overlay.style.display = 'flex';
  ui.push(buildMainMenu());
  showToast('已退出游戏');
}

/**
 * 暂停游戏（菜单打开时）。
 * 具体的暂停动作（停帧、松键、静音）由 NesConsole.pause() 负责，见那里的说明。
 */
function pauseGame() {
  if (!playing) return;
  nesConsole.pause();
  pendingRelease.clear();
  stopPlayTimer();
  const game = games.getCurrentGame();
  showToast(`已暂停: ${game ? game.name : '游戏'}`);
}

/** 菜单全部关闭后回到游戏 */
function resumeGame() {
  if (!playing) return;
  nesConsole.start();
  startPlayTimer();
  showToast('继续游戏');
}

/**
 * 呼出/关闭菜单。
 *
 * MENU 键（手柄 SELECT+START、键盘 Esc、屏幕右上角「菜单」按钮）的行为分三种：
 *   菜单没开        -> 打开（游戏中的快速菜单 / 非游戏中主菜单）
 *   在子菜单里      -> 退一级（设置 -> 主菜单），符合「Esc 是返回」的直觉
 *   已在最顶层      -> 全部关闭，回到游戏
 * 这样 Esc 既能逐级返回，也能一按到底退出，不用记两套键。
 */
function toggleMenu() {
  if (!ui.isEmpty()) {
    if (ui.stack.length > 1) {
      ui.pop();
    } else {
      ui.clear();
    }
    return;
  }

  // 暂停/恢复由 ScreenUI 的 onOpen/onEmpty 回调统一处理（见文件开头 ui 的定义），
  // 这里只负责决定打开哪份菜单 —— 菜单从哪里打开都走同一条路径，
  // 不会出现「某个入口忘了暂停」的情况。
  ui.push(playing ? buildQuickMenu() : buildMainMenu());
}

function startPlayTimer() {
  if (playTimer) return;
  playTimer = setInterval(() => { playSeconds++; }, 1000);
}

function stopPlayTimer() {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
}

// ==================== 存档操作 ====================

/**
 * 把卡带电池 RAM 写回库里（对应 RetroArch 的 .srm）。
 *
 * 取数据是同步的、落盘是异步的：调用点（退游戏、切后台、关页面）紧接着就会
 * 停模拟器，所以内存快照必须在返回前拿到。
 *
 * 跟「自动存档」设置无关：电池存档是游戏自己写的进度，玩家没做任何操作，
 * 关掉页面就该还在 —— 静默丢档不是可选项。
 */
function persistProgress() {
  const game = games.getCurrentGame();
  if (!game?.hash) return;
  const sram = nesConsole.saveRam(); // 没有电池存档的游戏返回 null
  if (sram) saveSRAM(game.hash, sram).catch((e) => console.warn('电池存档写入失败:', e));
}

async function doSave(slot, game = games.getCurrentGame()) {
  if (!game?.hash) { showError('请先启动游戏'); return; }
  const state = nesConsole.getState();
  if (!state) { showError('无法读取模拟器状态'); return; }

  showToast('正在保存...');
  try {
    await saveState(game.hash, slot, state);
    showToast(`已保存到 ${SLOT_LABELS[slot]}`);
    ui.refresh();
  } catch (e) {
    showError('保存失败: ' + e.message);
  }
}

async function doLoad(slot, game = games.getCurrentGame()) {
  if (!game?.hash) { showError('请先启动游戏'); return; }

  showToast('正在读取...');
  try {
    const state = await loadState(game.hash, slot);
    if (!state) { showError(`${SLOT_LABELS[slot]} 没有存档`); return; }
    // loadState 失败会抛异常，原因直接显示出来，别只写「读取失败」
    nesConsole.loadState(state);
    // 先关菜单再报结果：ui.clear() 会同步触发 resumeGame()，它也要写状态栏，
    // 后写的覆盖先写的。把「已读取」放在 clear 之后，结果才留得住。
    ui.clear();
    showToast(`已读取 ${SLOT_LABELS[slot]}`);
  } catch (e) {
    showError('读取失败: ' + e.message);
  }
}

/**
 * 从「游戏管理 → 存档列表」里读档。
 *
 * 这款游戏此时通常没在运行（退出游戏会清掉「当前游戏」），而存档状态只有
 * 装着同一个 ROM 的模拟器才能恢复。列表把这行标成「A = 读取」，那就得真读进去：
 * 先把游戏带起来再读，而不是按下去只得到一句「请先启动游戏」。
 */
async function loadSaveFromList(game, slot) {
  if (!playing || games.getCurrentGame()?.id !== game.id) {
    showToast(`正在启动 ${game.name}...`);
    await startGame(game.id);
    if (!playing) return;   // 启动失败时 startGame 已经把原因写在状态栏了
  }
  await doLoad(slot, game);
}

// ==================== 触摸手柄 ====================

/**
 * 触摸按钮的动作映射。
 * 用 data-action 属性在 HTML 里声明，这里按属性自动绑定 ——
 * 加一个按钮只改 HTML，不用改这段代码。
 * 属性值可以写多个动作（空格隔开，如「A B」），按住这个按钮就等于同时按住那几个键。
 *
 * 十字键例外：它的四个臂和四段斜向弧只是「哪个方向 / 哪两个方向占哪块位置」的声明，
 * 按键由整块十字统一判定（一个臂一个按钮按不出「上+右」，也划不出独立于拨片的斜向键）。
 */
function bindTouchControls() {
  const dpad = document.querySelector('.touch-dpad');
  document.querySelectorAll('[data-action]').forEach((el) => {
    if (dpad && dpad.contains(el)) return;
    const actions = el.dataset.action.trim().split(/\s+/);
    if (actions.every((a) => ACTIONS[a])) {
      input.attachTouchButton(el, actions.map((a) => ACTIONS[a]));
    }
  });
  if (dpad) input.attachTouchDpad(dpad);
}

// ==================== 界面辅助 ====================

/**
 * 一次性提示：显示完自动消失，游戏画面下不留常驻状态位。
 *
 * 计时在 CSS 里（.toast 的 --toast-ms 动画演完就收），这里只换文案并重播动画。
 * 重播要先 hidden 再取消 hidden：元素从 display:none 回到显示，动画才会从头播；
 * 中间读一次 offsetWidth 强制回流，否则同帧内的「隐藏→显示」浏览器视作没发生。
 * 连按快速存档时新消息直接顶掉旧的，不排队。
 *
 * important 是给「错过就查不出来」的消息用的（报错、没做成、有意外副作用）：
 * 停留时间换成 CSS 里的 --toast-ms-long。普通的成功回执按默认时长走。
 */
function showToast(msg, { important = false } = {}) {
  toastEl.classList.toggle('toast-important', important);
  toastEl.hidden = true;
  void toastEl.offsetWidth;
  toastEl.textContent = msg;
  toastEl.hidden = false;
}

/** 报错 / 没做成 / 需要多看一眼的消息：走 toast，但多停留一会儿 */
function showError(msg) {
  showToast(msg, { important: true });
}

// 播完收起并清空文案：留着上一条会让人以为它还是当前状态
toastEl.addEventListener('animationend', () => {
  toastEl.hidden = true;
  toastEl.textContent = '';
});

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ==================== 全屏 ====================

/**
 * 右上角的全屏按钮：桌面把页面铺满窗口，手机直接躺横。
 *
 * 对标（MDN「Element.requestFullscreen」「ScreenOrientation.lock」、
 * caniuse「fullscreen」、W3C Screen Orientation 规范）：
 * - 全屏的是整个文档，不是 .screen 那一块：要铺满的是「屏幕 + 虚拟手柄」这一整片，
 *   只框住屏幕的话手机上下的网页底色会露出来。
 * - requestFullscreen() 要求「瞬时用户激活」（transient activation），所以只能在
 *   click 里直接调用，不能延到定时器或异步回调里。
 * - 显示状态以 fullscreenchange 为准，不拿 promise 的返回值当准：用户还能按 Esc
 *   或安卓返回键退出全屏，那条路只有 fullscreenchange 会通知页面。
 * - 方向锁只在「已全屏 + 触屏设备」时才可能成功（MDN：orientation locking 通常只在
 *   移动端且全屏时启用）。桌面不锁：显示器本来就是宽的。
 * - 退出全屏时方向锁由规范自动解开（W3C Screen Orientation），不用再调 unlock。
 * - iPhone Safari 没有元素全屏（caniuse：iPad 有、iPhone 没有），走下面的报错分支。
 */
const fullscreenBtn = document.getElementById('fullscreen-btn');

fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch((e) => showError(`退出全屏失败: ${e.message}`));
    return;
  }
  const wantLandscape = window.matchMedia('(pointer: coarse)').matches;
  document.documentElement
    .requestFullscreen()
    .then(() => {
      if (!wantLandscape) return;
      // 锁不上不算失败：全屏已经成了，剩下的用户自己转手机。
      return screen.orientation.lock('landscape').catch(() => {
        showError('没能自动横屏，请手动把手机转过来');
      });
    })
    .catch((e) => {
      showError(e.name === 'NotSupportedError' ? '这个浏览器不支持全屏' : `进入全屏失败: ${e.message}`);
    });
});

// 图标朝向和读屏文案跟着实际状态走：Esc / 返回键退出全屏时页面只能靠这个事件知道。
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  fullscreenBtn.dataset.on = String(on);
  fullscreenBtn.setAttribute('aria-label', on ? '退出全屏' : '全屏');
});

// ==================== 文件载入 ====================

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) loadRomFile(file);
  // 清空 value，否则连续选同一个文件不会触发 change
  fileInput.value = '';
});

/**
 * 长按弹出的系统菜单：整页屏蔽。
 *
 * 手机上拇指压在按键上不动，Android Chrome 会把它当成长按并派发 contextmenu，
 * 弹出系统菜单；菜单一出现，pointerup 就发不回按键，游戏变成"按住不放手"。
 * iOS 的那套气泡靠 CSS 挡（见 global.css 的 -webkit-touch-callout），
 * Android 只能在这里 preventDefault —— 两条都要，CSS 挡不住这个事件。
 * 本页没有任何地方需要原生右键菜单（只有一个隐藏的文件输入框）。
 */
document.addEventListener('contextmenu', (e) => e.preventDefault());

/**
 * 长按不当成一个操作：整页掐掉，游戏画面和「靠 click 工作的控件」除外。
 *
 * 为什么拦了 contextmenu 还要再来一手：安卓 Chrome 识别到长按会自己震一下（等同桌面右键），
 * 这一下出自手势识别阶段、早于页面拿到任何事件，所以不弹菜单也照震。真正能介入的点是
 * touchstart —— preventDefault 之后浏览器不再把这串触摸编成长按手势。
 * 必须显式 { passive: false }：touchstart 在 document/body 上默认是 passive 的，
 * 那种监听里 preventDefault 会被直接忽略（MDN「addEventListener / touchstart」）。
 * `touch-action` 帮不上忙，Pointer Events 规范把它的作用限定在平移和缩放。
 *
 * 为什么要留这些例外：取消 touchstart 会连带吃掉这次触摸的兼容鼠标事件，实测（agent-workspace/
 * probe-longpress-scope.cjs）掐掉之后菜单行的 tap 不再产生 click、手指也滑不动列表 ——
 * 那正是菜单唯一的两条手指路径，所以 .sys-ui（行/分类/返回都监听 click）和 #layout-editor
 * （完成 / 恢复默认位置）整块留给它们自己，代价是这两块长按仍会震。
 * #fullscreen-btn 同理：它靠 click 工作（requestFullscreen 要的瞬时用户激活就由 click 给），
 * 掐掉就点不动了。菜单按钮不在例外里，因为它走的是 pointerdown（input-manager 绑的），不受影响。
 * 游戏画面按需求保留原生长按：canvas 和它的占位层都在例外里。
 *
 * 副作用说清楚：document 上挂了非 passive 的 touchstart，Chromium 就不能再把滚动放在合成线程，
 * 列表滚动改走主线程（功能不变，手感略钝）。
 */
const LONG_PRESS_KEEP = 'canvas, #canvas-overlay, .sys-ui, #layout-editor, #fullscreen-btn';
document.addEventListener('touchstart', (e) => {
  if (e.target instanceof Element && e.target.closest(LONG_PRESS_KEEP)) return;
  e.preventDefault();
}, { passive: false });

/**
 * 拖拽载入 ROM：整页都是投放区。
 * 屏幕外不再有控制面板，所以没有专门的「拖到这里」框，改成给屏幕描一圈边：
 * 松手前就知道会发生什么（有反馈），松手后状态栏写读取结果。
 * dragover/drop 必须 preventDefault，否则浏览器会丢掉模拟器页面去打开那个文件。
 */
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  stageEl.classList.add('dragging');
});
// 只有真正拖出窗口才取消高亮：拖过子元素时 dragleave 会一路触发，
// 靠 relatedTarget 是否为空判断「离开了页面」。
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) stageEl.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  stageEl.classList.remove('dragging');
  const file = e.dataTransfer?.files?.[0];
  if (file && /\.nes$/i.test(file.name)) loadRomFile(file);
  else showError('请拖入 .nes 文件');
});

function loadRomFile(file) {
  showToast(`正在读取 ${file.name}...`);
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = new Uint8Array(reader.result);
      // addUserROM 现在是异步的（要写 IndexedDB），存好了才算加入
      const game = await games.addUserROM(data, file.name);
      // 先关菜单再报结果：关菜单的副作用（resumeGame）也写状态栏，
      // 后写的覆盖先写的。重建主菜单是为了让用户直接看到新加入的那款。
      ui.clear();
      ui.push(buildMainMenu());
      showToast(`已加入列表: ${game.name}`);
    } catch (e) {
      showError('载入失败: ' + e.message);
    }
  };
  reader.onerror = () => showError('读取文件失败');
  reader.readAsArrayBuffer(file);
}

// ==================== 自动存档 ====================

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  persistProgress();
  if (!settings.getValue('system.autoSave')) return;
  const game = games.getCurrentGame();
  if (!game?.hash || !playing) return;
  const state = nesConsole.getState();
  if (state) {
    saveState(game.hash, SLOTS.AUTO, state).catch((e) => console.warn('自动保存失败:', e));
  }
});

// ==================== 全局错误 ====================

window.addEventListener('error', (e) => {
  showError('错误: ' + e.message);
  console.error('全局错误:', e);
});
window.addEventListener('unhandledrejection', (e) => {
  showError('异步错误: ' + e.reason);
  console.error('未处理的 Promise 拒绝:', e);
});

// 关页面：电池存档再兜一次底。主路径是上面的 visibilitychange（hidden 一定先于
// unload 触发），这里只是防止有些浏览器直接 unload 不给 hidden 的机会。
window.addEventListener('beforeunload', () => {
  persistProgress();
  input.destroy();
  nesConsole.destroy();
});
