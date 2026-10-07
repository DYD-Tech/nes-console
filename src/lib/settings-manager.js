/**
 * 设置系统
 *
 * 保存用户的偏好（画面、音频、控制、系统），持久化到 localStorage。
 *
 * 为什么用 localStorage 而不是 IndexedDB：
 * 设置是一小块结构化数据（几百字节），需要「页面一加载就同步读到」，
 * 否则会出现「先按默认值渲染、再跳到用户设置」的闪烁。localStorage 是同步
 * API，正好满足；IndexedDB 是异步的，会让首屏闪一下。
 * 存档（几十 KB 到几 MB）才需要 IndexedDB，见 storage.js。
 *
 * 对标：
 * - RetroArch 的配置文件（retroarch.cfg）按「键 = 值」平铺存储，
 *   本模块的键名沿用同样的 `分类.选项` 形式（如 display.crtFilter）。
 * - MDN《Window.localStorage》：只存字符串，存对象要自己序列化。
 *   本模块统一用 JSON。
 */

import { DEFAULT_BINDINGS } from './input-manager.js';

const STORAGE_KEY = 'nes-console.settings';

/**
 * 虚拟手柄（屏幕外那组触摸按键）的显示模式。
 * 只有三档，不做「桌面显示/手机显示」这类组合开关：
 * auto 沿用「只在触摸设备显示」的原始行为，另外两档是用户明确覆盖。
 */
export const PAD_MODES = [
  { value: 'auto', label: '自动（仅触摸设备）' },
  { value: 'always', label: '始终显示' },
  { value: 'never', label: '隐藏' },
];

/** 可单独隐藏的按键组。方向键整组一起关：只留「上下」的十字键没有意义。 */
export const PAD_GROUPS = [
  { id: 'dpad', label: '方向键' },
  { id: 'a', label: 'A 键' },
  { id: 'b', label: 'B 键' },
  { id: 'ab', label: 'A+B 键（四颗键中间）' },
  { id: 'x', label: 'X 键（界面）' },
  { id: 'y', label: 'Y 键（界面）' },
  { id: 'select', label: 'SELECT 键' },
  { id: 'start', label: 'START 键' },
];

/** 设置的默认值。结构即文档：想加设置项，在这里加一条。 */
export const DEFAULT_SETTINGS = {
  display: {
    crtFilter: true,
  },
  audio: {
    volume: 80,       // 0-100
    muted: false,
  },
  system: {
    autoSave: true,   // 页面隐藏时自动存档
  },
  /**
   * 控制相关设置。不进 SETTINGS_SCHEMA（那份表驱动「设置」菜单的 UI），
   * 它有专门的「控制管理」菜单，因为改按键需要「等用户按一个键」的交互，
   * 不是 toggle/range 能表达的。
   */
  controls: {
    // 动作 -> KeyboardEvent.code，空串表示该动作没绑键盘
    keyMap: { ...DEFAULT_BINDINGS },
    padMode: 'auto',
    padKeys: Object.fromEntries(PAD_GROUPS.map((g) => [g.id, true])),
    // 拖动偏移：相对 CSS 默认位置，按「占视口宽/高的比例」存，
    // 这样换设备、转屏后仍是同一个相对位置（存 px 会在别的分辨率上跑到屏外）
    padLayout: {
      dpad: { x: 0, y: 0 },
      actions: { x: 0, y: 0 },
    },
  },
};


/**
 * 设置项的描述表 —— 界面靠它自动生成列表，不用手写每一项的 UI。
 *
 * 每一项：
 *   path    在设置对象里的位置，用点号分隔
 *   label   界面显示的名字
 *   type    'toggle' 开关 | 'range' 数值 | 'select' 单选
 *   options 仅 select 用
 *   min/max/step  仅 range 用
 *   format  仅 range 用，把数值变成显示文字
 */
export const SETTINGS_SCHEMA = [
  {
    category: 'display',
    label: '显示',
    items: [
      { path: 'display.crtFilter', label: 'CRT 滤镜', type: 'toggle' },
    ],
  },
  {
    category: 'audio',
    label: '音频',
    items: [
      {
        path: 'audio.volume', label: '音量', type: 'range',
        min: 0, max: 100, step: 10,
        format: (v) => `${v}%`,
      },
      { path: 'audio.muted', label: '静音', type: 'toggle' },
    ],
  },
  {
    category: 'system',
    label: '系统',
    items: [
      { path: 'system.autoSave', label: '自动存档', type: 'toggle' },
    ],
  },
];

/** 深拷贝一份默认设置 */
function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

/** 按点号路径读值，如 get(obj, 'display.crtFilter') */
function getByPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/** 按点号路径写值，如 set(obj, 'display.crtFilter', false) */
function setByPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((acc, key) => {
    if (acc[key] == null) acc[key] = {};
    return acc[key];
  }, obj);
  target[last] = value;
}

/**
 * 把读到的数据和默认值合并。
 * 只合并「默认值里有的键」，这样旧版本遗留的、已经删掉的设置项不会复活，
 * 也不用写迁移脚本（遵循项目的「不留历史包袱」原则）。
 */
function mergeWithDefaults(defaults, stored) {
  if (stored == null || typeof stored !== 'object') return defaults;
  for (const key of Object.keys(defaults)) {
    const defVal = defaults[key];
    const storedVal = stored[key];
    if (defVal != null && typeof defVal === 'object') {
      defaults[key] = mergeWithDefaults(defVal, storedVal);
    } else if (storedVal !== undefined && typeof storedVal === typeof defVal) {
      defaults[key] = storedVal;
    }
  }
  return defaults;
}

export class SettingsManager {
  /**
   * @param {object} opts
   * @param {function} [opts.onChange] - 设置变化回调 (path, value) => void
   */
  constructor(opts = {}) {
    this.onChange = opts.onChange || (() => {});
    this.settings = this._load();
  }

  /** 读取全部设置（返回的是内部对象，调用方不要直接改） */
  get() {
    return this.settings;
  }

  /** 按路径读一项 */
  getValue(path) {
    return getByPath(this.settings, path);
  }

  /** 按路径写一项，写后立即持久化并通知监听者 */
  setValue(path, value) {
    setByPath(this.settings, path, value);
    this._save();
    this.onChange(path, value);
  }

  /** 恢复默认值 */
  reset() {
    this.settings = cloneDefaults();
    this._save();
    // 通知所有设置项都变了，界面据此整体重绘
    for (const cat of SETTINGS_SCHEMA) {
      for (const item of cat.items) {
        this.onChange(item.path, this.getValue(item.path));
      }
    }
  }

  /** 从 localStorage 读；读不到或数据损坏时回退到默认值 */
  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return cloneDefaults();
      return mergeWithDefaults(cloneDefaults(), JSON.parse(raw));
    } catch (e) {
      // 数据损坏（比如被手动改坏）不应该让整个页面起不来，用默认值继续
      console.warn('设置读取失败，使用默认值:', e);
      return cloneDefaults();
    }
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch (e) {
      console.warn('设置保存失败:', e);
    }
  }
}
