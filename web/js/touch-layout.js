/**
 * 虚拟手柄的显隐与摆放
 *
 * 管四件事：整块手柄在哪些设备上显示（padMode）、多大（padSize）、哪些按键组露出来
 * （padKeys）、两组按键摆在哪儿（padLayout）。都只碰 DOM 和 CSS、不碰输入派发，所以独立成模块：
 * 设置值进来，界面状态出去，启动时和每次改动后都走同一个 apply()。
 *
 * 摆放模式的四条取舍：
 * - RetroArch 的覆盖层只有整体开关/缩放/居中（`input_overlay_enable`、`input_overlay_scale`、
 *   `input_overlay_center_x|y`，见其配置模板），没有逐键摆放项，所以「按组拖动 + 按视口比例存」是自研。
 * - 拖动单位是组，不是单个按键：单键位置由 CSS 网格管，逐个绝对定位会和响应式布局打架。
 * - 存比例不存 px：px 换设备或转屏后会跑到屏外。RetroArch 的居中量同样是 0~1 归一值。
 * - 拖动在捕获阶段 stopPropagation：按钮自己的按下监听在冒泡阶段，不拦的话按住按键组拖动
 *   会同时给游戏发出「方向键按住」，角色一路狂奔。
 */

import { PAD_GROUPS } from './settings-manager.js';

/** 按键组 id -> 元素选择器（方向键是整组，其余是单个按钮） */
const GROUP_SELECTOR = {
  dpad: '.touch-dpad',
  a: '.touch-a',
  b: '.touch-b',
  ab: '.touch-ab',
  x: '.touch-x',
  y: '.touch-y',
  select: '.touch-select',
  start: '.touch-start',
};

/**
 * 可拖动的两组，id 与设置里 padLayout 的键一致。
 * 这份列表就是 padLayout 的键名来源（不再有第二份常量）。
 */
export const DRAG_UNITS = [
  { id: 'dpad', selector: '.touch-dpad-group', label: '方向键 + SELECT' },
  { id: 'actions', selector: '.touch-actions-group', label: 'A/B/X/Y、AB 与 START' },
];

export class TouchLayout {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.stage - .stage，视口尺寸的参照物
   * @param {HTMLElement} opts.controls - #touch-controls
   * @param {HTMLElement} opts.editor - 摆放模式的提示条（含完成/复位按钮）
   * @param {function} opts.getSettings - () => controls 设置对象
   * @param {function} opts.onCommit - (path, value) => void，拖动结束后写设置
   * @param {function} [opts.onStatus] - (msg) => void，摆放模式的提示
   */
  constructor(opts) {
    this.stage = opts.stage;
    this.controls = opts.controls;
    this.editor = opts.editor;
    this.getSettings = opts.getSettings;
    this.onCommit = opts.onCommit;
    this.onStatus = opts.onStatus || (() => {});

    this.editing = false;
    /** 摆放模式期间临时强制显示，退出时要还原 */
    this.forcedVisible = false;
    this._dragging = null;
    // move/up 挂 window、只建一次：挂在按键元素上时，
    // 一段没配对到 pointerup 的拖动会把监听留在原地，下次拖动又加一遍。
    this._onDragMove = (e) => this._dragMove(e);
    this._onDragEnd = (e) => this._dragEnd(e);

    this.units = DRAG_UNITS.map((u) => ({ ...u, el: this.controls.querySelector(u.selector) }))
      .filter((u) => !!u.el);

    // 视口变化要重算 px 偏移（存的是比例）
    this._onResize = () => this.applyLayout();
    window.addEventListener('resize', this._onResize);

    this.editor.querySelector('[data-editor="done"]')
      .addEventListener('click', () => this.exitEdit());
    this.editor.querySelector('[data-editor="reset"]')
      .addEventListener('click', () => this.resetLayout());

    for (const unit of this.units) {
      // capture: true —— 见文件头，必须在事件到达按钮之前拦下
      unit.el.addEventListener('pointerdown', (e) => this._onUnitPointerDown(e, unit), true);
    }
  }

  /** 按当前设置应用显隐 + 大小 + 位置。启动时和每次设置变更后都调它。 */
  apply() {
    const c = this.getSettings();
    this._applyMode(c.padMode);
    this._applyKeys(c.padKeys);
    this._applySize(c.padSize);
    this.applyLayout();
  }

  applyLayout() {
    // 拖动过程中不重测基准盒：那时元素正带着 transform，量到的是移动后的位置
    if (!this._dragging) this._measureBase();
    const c = this.getSettings();
    const stageRect = this.stage.getBoundingClientRect();
    for (const unit of this.units) {
      const off = (c.padLayout && c.padLayout[unit.id]) || { x: 0, y: 0 };
      const clamped = this._clamp(unit, off, stageRect);
      unit.el.style.transform = clamped.x || clamped.y
        ? `translate(${clamped.x * stageRect.width}px, ${clamped.y * stageRect.height}px)`
        : '';
    }
  }

  /**
   * 量一次「没有偏移时」的盒子，作为夹取边界的参照。
   * 必须先摘掉 transform 再量：getBoundingClientRect 给的是变换后的盒子，
   * 直接拿它当基准会让偏移越算越偏（每次夹取都基于已移动的位置）。
   */
  _measureBase() {
    const prev = this.units.map((u) => u.el.style.transform);
    this.units.forEach((u) => { u.el.style.transform = ''; });
    this.units.forEach((u) => { u.baseRect = u.el.getBoundingClientRect(); });
    this.units.forEach((u, i) => { u.el.style.transform = prev[i]; });
  }

  /** 进入摆放模式：菜单要关掉，否则拖不到手柄（菜单在画面里，手柄在画面外） */
  enterEdit() {
    if (this.editing) return;
    this.editing = true;
    const c = this.getSettings();
    // 摆放模式必须看得见手柄。这里两个类一起改：
    // .stage.pad-always 和 .stage.pad-never 的选择器权重相同，只加不换的话
    // 「隐藏」那条规则仍然生效，结果就是进了摆放模式却什么都拖不到。
    if (c.padMode !== 'always') {
      this.forcedVisible = true;
      this.stage.classList.remove('pad-never');
      this.stage.classList.add('pad-always');
    }
    this.stage.classList.add('layout-edit');
    this.editor.hidden = false;
    // 强制显示会改变元素本身的位置（display:none 时量不到），基准盒要重测
    this.applyLayout();
    this.onStatus('摆放模式：按住按键组拖动，松手即保存');
  }

  exitEdit() {
    if (!this.editing) return;
    this.editing = false;
    this.stage.classList.remove('layout-edit');
    this.editor.hidden = true;
    if (this.forcedVisible) {
      this.forcedVisible = false;
      this.apply();   // 回到设置里指定的显示模式
    }
    this.onStatus('摆放模式已结束');
  }

  /** 恢复默认位置（不动显隐和按键绑定） */
  resetLayout() {
    const c = this.getSettings();
    const blank = {};
    for (const unit of this.units) blank[unit.id] = { x: 0, y: 0 };
    this.onCommit('controls.padLayout', { ...c.padLayout, ...blank });
    this.applyLayout();
    this.onStatus('按键位置已恢复默认');
  }

  isEditing() {
    return this.editing;
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('pointermove', this._onDragMove);
    window.removeEventListener('pointerup', this._onDragEnd);
    window.removeEventListener('pointercancel', this._onDragEnd);
  }

  // ==================== 内部 ====================

  _applyMode(mode) {
    this.stage.classList.toggle('pad-always', mode === 'always');
    this.stage.classList.toggle('pad-never', mode === 'never');
  }

  /**
   * 大小档位：这里只写一个 data 属性，三档各是多少 px、窄屏怎么封顶都在 CSS 里
   * （.stage 的 --pad-u / --pad-u-base）。
   * 小档也照写：属性记的是「用户选了哪档」，而小档就是 CSS 的默认值，写不写尺寸都一样。
   * 值不在三档里（比如设置被手改坏）时没有规则匹配，自然落回小档，不用在这里加校验。
   */
  _applySize(size) {
    this.stage.dataset.padSize = size;
  }

  _applyKeys(padKeys) {
    for (const group of PAD_GROUPS) {
      const el = this.controls.querySelector(GROUP_SELECTOR[group.id]);
      if (!el) continue;
      // 方向键是整组，其余是单个按钮，用同一个类名隐藏
      el.classList.toggle('pad-off', padKeys[group.id] === false);
    }
  }

  /**
   * 把偏移夹到「整组仍在视口内」。
   * 变换后的位置 = 基准位置 + translate，所以溢出量可以直接按比例回推，一次算准。
   */
  _clamp(unit, off, stageRect) {
    const base = unit.baseRect || unit.el.getBoundingClientRect();
    let x = off.x || 0;
    let y = off.y || 0;
    const left = base.left + x * stageRect.width;
    const top = base.top + y * stageRect.height;
    if (left < stageRect.left) x = (stageRect.left - base.left) / stageRect.width;
    if (left + base.width > stageRect.right) {
      x = (stageRect.right - base.width - base.left) / stageRect.width;
    }
    if (top < stageRect.top) y = (stageRect.top - base.top) / stageRect.height;
    if (top + base.height > stageRect.bottom) {
      y = (stageRect.bottom - base.height - base.top) / stageRect.height;
    }
    return { x, y };
  }

  _onUnitPointerDown(e, unit) {
    if (!this.editing) return;
    // 拦住：摆放模式下按按键组只用来拖动，不给游戏发按键
    e.preventDefault();
    e.stopPropagation();

    const stageRect = this.stage.getBoundingClientRect();
    this._dragging = {
      unit,
      startX: e.clientX,
      startY: e.clientY,
      origin: { ...(this.getSettings().padLayout[unit.id] || { x: 0, y: 0 }) },
      stageRect,
    };
    window.addEventListener('pointermove', this._onDragMove);
    window.addEventListener('pointerup', this._onDragEnd);
    window.addEventListener('pointercancel', this._onDragEnd);
  }

  _dragMove(e) {
    const d = this._dragging;
    // buttons===0：指针没有按住（比如只是划过）就不是拖动
    if (!d || e.buttons === 0) return;
    const next = {
      x: d.origin.x + (e.clientX - d.startX) / d.stageRect.width,
      y: d.origin.y + (e.clientY - d.startY) / d.stageRect.height,
    };
    // 拖动过程中直接改 transform，不写设置（松手才落盘，避免每帧写 localStorage）
    const clamped = this._clamp(d.unit, next, d.stageRect);
    d.unit.el.style.transform =
      `translate(${clamped.x * d.stageRect.width}px, ${clamped.y * d.stageRect.height}px)`;
    d.current = clamped;
  }

  _dragEnd() {
    const d = this._dragging;
    window.removeEventListener('pointermove', this._onDragMove);
    window.removeEventListener('pointerup', this._onDragEnd);
    window.removeEventListener('pointercancel', this._onDragEnd);
    if (!d) return;
    this._dragging = null;
    const unit = d.unit;
    const off = d.current || d.origin;
    const c = this.getSettings();
    // 整份 padLayout 一起提交：设置变更按一个路径走，applySetting 只需认 'controls.padLayout'
    this.onCommit('controls.padLayout', {
      ...c.padLayout,
      [unit.id]: { x: round(off.x), y: round(off.y) },
    });
    this.onStatus(`${unit.label} 已放到新位置`);
  }
}

/** 偏移存 4 位小数：视口 1000px 时精度 0.04px，够用又不占存储 */
function round(n) {
  return Math.round(n * 10000) / 10000;
}
