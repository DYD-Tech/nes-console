/**
 * 屏幕内的系统界面（Ozone 风格）
 *
 * 这一层只做三件事：把「菜单数据」画成界面、处理手柄导航、维护菜单栈。
 * 它不知道游戏是什么、存档是什么 —— 那些由调用方传进来的菜单数据决定。
 *
 * 为什么用「菜单栈 + 数据驱动」：
 * 界面有主菜单、设置、存档、游戏信息、游戏中快速菜单五处，如果每处各写一套
 * 渲染和按键处理，就会出现「这个菜单能用十字键、那个不能」的不一致
 * （项目里踩过：触摸手柄的 A 键没绑上，因为判断写法把 0 当成了假值）。
 * 统一成「压入一份菜单数据 -> 引擎负责画和导航」后，按键处理只有一份，
 * 新加菜单只需提供数据，天然获得完整的十字键/A/B/X/Y 支持。
 *
 * 对标 RetroArch Ozone（docs.libretro.com/guides/ozone/）：
 * - 左侧边栏选分类，右侧列表选条目；列表可以带一块详情栏（存档槽位的时间与大小）
 * - 选中项比底色更暗，靠青色描边 + 青绿文字凸显（色值取自 ozone.c 的 ozone_theme_dark，
 *   落在 global.css 的 --oz-* 上），不是「背景提亮」
 * - 「现在能按什么」常驻在底栏右侧（按键图例），跟着菜单开合；底栏左侧放当前列表的数量
 * - 焦点分「在侧栏 / 在列表」两态，← 进侧栏、→ 或 A 回列表，↑↓ 只动当前那一栏
 *   （按键分发见 menu/drivers/ozone.c，细节见 handleAction 的注释）
 * 与 Ozone 的差别：这里整块界面只画一个「高亮框」标焦点所在，另一栏只留背景色；
 * Ozone 是选中项整条反色。理由是窄屏上两处同时反色看不出方向键动的是哪边。
 *
 * 对标 W3C《ARIA Authoring Practices》的 listbox 模式：
 * 列表容器 role="listbox"，条目 role="option" 并标 aria-selected，
 * 屏幕阅读器能正确朗读「第几项、共几项、选中状态」。
 */

import { ACTIONS } from './input-manager.js';

/** 侧边栏图标：内联 SVG，单色线性，颜色跟随文字（currentColor） */
const ICONS = {
  gamepad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/><line x1="15" y1="12" x2="15.01" y2="12"/><line x1="18" y1="10" x2="18.01" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  display: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
  keyboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6.01" y2="10"/><line x1="10" y1="10" x2="10.01" y2="10"/><line x1="14" y1="10" x2="14.01" y2="10"/><line x1="18" y1="10" x2="18.01" y2="10"/><line x1="6" y1="14" x2="6.01" y2="14"/><line x1="18" y1="14" x2="18.01" y2="14"/><line x1="10" y1="14" x2="14" y2="14"/></svg>',
};

/**
 * 菜单数据格式（调用方提供）：
 * {
 *   title: string,
 *   sections: [{
 *     id, label, icon,
 *     items: [{
 *       id, label, sublabel, value,
 *       onSelect?, onSecondary?, onTertiary?, onAdjust?,
 *     }]
 *   }],
 *   detail?: (item) => ({ lines: [{label, value}], empty?: string }),
 *   badge?: string,      // 顶栏右端：这一层是什么（游戏名 / 「游戏中」 / 「确认」）
 *   count?: string | ((section) => string),
 *                        // 左下角数量栏：当前这一列有多少项（「9 款」）
 *                        // 函数版按当前分类给内容（不需要就说空串）
 *   hints?: (focus) => [...] | [...],  // 底栏右侧按键图例；函数版按焦点栏（'sidebar'/'list'）给内容
 *   keepFocus?: boolean,   // 重新渲染后保持当前选中项（默认 true）
 * }
 */

export class ScreenUI {
  /**
   * @param {HTMLElement} rootEl - .screen 元素，界面挂在这里面
   * @param {object} opts
   * @param {function} [opts.onOpen] - 菜单栈从「空」变为「非空」时回调
   * @param {function} [opts.onEmpty] - 菜单栈清空时回调（调用方据此恢复游戏）
   */
  constructor(rootEl, opts = {}) {
    this.root = rootEl;
    this.onOpen = opts.onOpen || (() => {});
    this.onEmpty = opts.onEmpty || (() => {});

    /** 菜单栈：每项是一份菜单数据 + 当前光标位置 */
    this.stack = [];

    this.el = null;
    this._buildDom();
  }

  // ==================== 对外 API ====================

  /** 菜单栈是否为空（空 = 界面不显示，游戏可见） */
  isEmpty() {
    return this.stack.length === 0;
  }

  /** 打开一份菜单（压栈） */
  push(model) {
    const wasEmpty = this.stack.length === 0;
    this.stack.push({
      model,
      sectionIndex: this._initialSectionIndex(model),
      itemIndex: 0,
      // 有分类栏的菜单停在分类栏上，单栏的停在列表上（见 _initialFocus）
      focus: this._initialFocus(model),
      transparent: this._resolveTransparent(model),
    });
    this._render();
    // 从「界面关着」变成「界面开着」时通知调用方（据此暂停游戏）。
    // 只在跨越这个边界时通知，往已打开的界面里再压一层不重复通知。
    if (wasEmpty) this.onOpen();
  }

  /**
   * 判断这一层菜单要不要半透明背景。
   *
   * 存在「栈帧」上而不是「菜单数据」上：菜单数据每次 refresh 都会被
   * rebuild() 重新生成，写在数据上会在刷新时丢掉（实测踩过：从快速菜单
   * 进设置，一刷新背景就变回不透明，画面被完全盖住）。
   * 而且它本来就是「后面有没有游戏在跑」的属性，属于这一层，不属于数据。
   *
   * 子菜单（设置、存档、游戏信息）没显式声明时继承父级 —— 从游戏中进去
   * 就该保持能看见画面。
   */
  _resolveTransparent(model) {
    if (model.transparent !== undefined) return !!model.transparent;
    const parent = this.stack[this.stack.length - 1];
    return parent ? parent.transparent === true : false;
  }

  /** 替换栈顶菜单（同级切换，如从设置切到存档） */
  replace(model) {
    if (this.stack.length === 0) return this.push(model);
    const prev = this.stack[this.stack.length - 1];
    this.stack[this.stack.length - 1] = {
      model,
      sectionIndex: this._initialSectionIndex(model),
      itemIndex: 0,
      // 同级替换（如「读取中」占位换成真列表）不挪动用户，焦点区沿用；
      // 只有换成一份根本没有分类栏的菜单时才退回列表 ——
      // 焦点不能停在一个不存在的区域上。
      focus: prev.focus === 'sidebar' && !this._hasSidebar(model) ? 'list' : prev.focus,
      // 同级替换不改变「后面有没有游戏」，沿用原值
      transparent: model.transparent !== undefined ? !!model.transparent : prev.transparent,
    };
    this._render();
  }

  /** 返回上一级；栈空时通知调用方 */
  pop() {
    this.stack.pop();
    if (this.stack.length === 0) {
      this._hide();
      this.onEmpty();
      return;
    }
    this._render();
  }

  /**
   * 清空整个菜单栈。
   * 行为和「一路按 B 退到没有菜单」一致，所以同样要通知调用方 ——
   * 否则用 clear() 关菜单时游戏侧的恢复逻辑（如计时）不会执行。
   */
  clear() {
    const wasOpen = this.stack.length > 0;
    this.stack = [];
    this._hide();
    if (wasOpen) this.onEmpty();
  }

  /**
   * 重绘当前菜单。
   *
   * 如果菜单数据里带了 rebuild（异步函数，返回新的菜单数据），就先重新
   * 取一遍数据再画 —— 存档列表、游戏列表这类「内容会变」的菜单需要它：
   * 存完档后槽位上的时间要立刻更新，不能还显示「空」。
   * 没带 rebuild 的就直接重画（如设置菜单，值改完刷新一下即可）。
   */
  async refresh() {
    if (this.stack.length === 0) return;
    const frame = this.stack[this.stack.length - 1];
    if (typeof frame.model.rebuild === 'function') {
      const model = await frame.model.rebuild();
      // 等待期间用户可能已经退出这个菜单了，栈空了就别再塞回去
      if (this.stack.length === 0) return;
      const cur = this.stack[this.stack.length - 1];
      cur.model = model;
      // 重建后的数据通常不带 transparent（它属于栈帧，不属于数据）。
      // 只在数据显式声明时才改，否则保留栈帧上已有的值 ——
      // 不能在这里调 _resolveTransparent：它查的是「父级」，而当前帧就是栈顶，
      // 会读到自己，逻辑上说不通。
      if (model.transparent !== undefined) cur.transparent = !!model.transparent;
      // 保持光标位置：重建后分类/条目数量可能变了，越界就回到第一项
      const section = model.sections[cur.sectionIndex];
      if (!section) {
        cur.sectionIndex = 0;
        cur.itemIndex = 0;
      } else if (cur.itemIndex >= section.items.length) {
        cur.itemIndex = 0;
      }
    }
    this._render();
  }

  /**
   * 处理一个输入动作。
   * 返回 true 表示已消费，调用方不应再把它传给游戏。
   *
   * 带分类栏的菜单（主菜单、设置）里，方向键的含义看焦点在哪一栏：
   *   焦点在分类栏 -> ↑↓ 换分类，A 或 → 进入该分类的列表，B 退一级
   *   焦点在列表   -> ↑↓ 换条目，A 执行，← 或 B 回到分类栏
   *
   * 对标 RetroArch Ozone 的按键分发（menu/drivers/ozone.c 里菜单动作的 switch）：
   * - MENU_ACTION_LEFT：光标已在侧栏就原地不动，否则 ozone_go_to_sidebar() 把
   *   焦点送进侧栏 —— ← 是「进侧栏」，不是「换分类」。
   * - MENU_ACTION_RIGHT / MENU_ACTION_OK：光标在侧栏时都调 ozone_leave_sidebar()
   *   进到列表 —— 所以这里 A 和 → 都能进列表。
   * - MENU_ACTION_SCROLL_UP/DOWN：光标在侧栏时动的是侧栏的分类，否则动列表条目。
   * - 进出侧栏带 menu_remember_selection，回到列表时光标还在原来那一行，
   *   所以下面 _goCategory/_enterList 也不重置 itemIndex。
   * 不用「←→ 切分类」：那是把方向键的含义绑死在栏目布局上。一级菜单是竖排的，
   * 按左右直觉上该在两栏之间走，实际却在上下换分类（用户反馈：太反直觉）。
   *
   * @param {string} action - ACTIONS 中的动作
   * @returns {boolean}
   */
  handleAction(action) {
    if (this.stack.length === 0) return false;

    // 快速存/读是「热键」：菜单开着也有效，交给调用方处理（见 app.js）
    if (action === ACTIONS.L1 || action === ACTIONS.R1) return false;

    const frame = this.stack[this.stack.length - 1];
    return this._inCategory(frame)
      ? this._handleCategory(frame, action)
      : this._handleList(frame, action);
  }

  /** 焦点是否停在分类栏上（没有分类栏的菜单永远停在列表上）。 */
  _inCategory(frame) {
    return frame.focus === 'sidebar' && this._hasSidebar(frame.model);
  }

  /** ↑↓ 换分类，A/→ 进列表，B 退一级；← 不动（已经在这一栏了）。 */
  _handleCategory(frame, action) {
    switch (action) {
      case ACTIONS.UP:
        this._moveSection(-1);
        return true;

      case ACTIONS.DOWN:
        this._moveSection(1);
        return true;

      case ACTIONS.A:
      case ACTIONS.RIGHT:
        this._enterList(frame);
        return true;

      case ACTIONS.B:
        this.pop();
        return true;

      default:
        // 其余动作（含 X/Y）吞掉：菜单开着时按键绝不能漏给游戏
        return true;
    }
  }

  /** ↑↓ 换条目，A 执行，←/B 回分类栏。 */
  _handleList(frame, action) {
    const section = frame.model.sections[frame.sectionIndex];
    const items = section ? section.items : [];
    const item = items[frame.itemIndex];
    const hasBar = this._hasSidebar(frame.model);

    switch (action) {
      case ACTIONS.UP:
        this._moveItem(-1);
        return true;

      case ACTIONS.DOWN:
        this._moveItem(1);
        return true;

      case ACTIONS.LEFT:
      case ACTIONS.RIGHT: {
        const dir = action === ACTIONS.RIGHT ? 1 : -1;
        if (hasBar) {
          // 带分类栏的菜单里，←→ 是「在两栏之间进出」，不拿来调数值：
          // 这类菜单（主菜单、设置）的数值全靠 A 循环，没有 onAdjust。
          if (dir < 0) this._goCategory(frame);
        } else if (item && item.onAdjust) {
          // 单栏菜单（快速菜单的槽位）：←→ 调该项的数值
          item.onAdjust(dir);
          this.refresh();
        }
        return true;
      }

      case ACTIONS.A:
        if (item && item.onSelect) {
          item.onSelect();
          // onSelect 可能压入新菜单（栈变长）或让菜单关闭（栈清空），
          // 两种情况都不该再用旧的 frame，交给回调里处理。
          if (this.stack.length > 0) this.refresh();
        }
        return true;

      case ACTIONS.X:
        if (item && item.onSecondary) {
          item.onSecondary();
          if (this.stack.length > 0) this.refresh();
        }
        return true;

      case ACTIONS.Y:
        if (item && item.onTertiary) {
          item.onTertiary();
          if (this.stack.length > 0) this.refresh();
        }
        return true;

      case ACTIONS.B:
        // 有分类栏：B 先把焦点收回分类栏，再按一次才退这一层菜单
        //（和 ← 等价，两条路径都得通，用户按哪个全凭手感）。
        // 这里和 Ozone 不一样：Ozone 的 MENU_ACTION_CANCEL 在列表里是直接退一级，
        // 回分类栏只认 ←。有意偏离 —— 手机上左手拇指只管方向键、右手拇指只管
        // A/B，退回去时用 B 的人比用 ← 的多，两条都走通才不用记规则。
        // 没有分类栏：B 直接退一级，否则单栏菜单就退不出去了。
        if (hasBar) this._goCategory(frame);
        else this.pop();
        return true;

      default:
        // 其余动作一律吞掉。菜单打开时游戏按键绝不能漏给游戏 ——
        // 否则在菜单里按 A 选条目，游戏里的角色也会跟着跳一下。
        return true;
    }
  }

  // ==================== 导航 ====================

  /** 这份菜单要不要画分类栏（多分类才有）。 */
  _hasSidebar(model) {
    return model.sections.length > 1;
  }

  /**
   * 打开菜单时焦点落在哪一栏。
   * 有分类栏就先停在分类栏：用户第一眼看到的是「我在选分类」，
   * 按 A 或 → 才进到列表里 —— 和真实主机的层级一致。
   */
  _initialFocus(model) {
    return this._hasSidebar(model) ? 'sidebar' : 'list';
  }

  _enterList(frame) {
    frame.focus = 'list';
    this._render();
  }

  _goCategory(frame) {
    frame.focus = 'sidebar';
    this._render();
  }

  _initialSectionIndex(model) {
    if (model.startSection) {
      const idx = model.sections.findIndex((s) => s.id === model.startSection);
      if (idx >= 0) return idx;
    }
    return 0;
  }

  _moveItem(delta) {
    const frame = this.stack[this.stack.length - 1];
    const section = frame.model.sections[frame.sectionIndex];
    const count = section ? section.items.length : 0;
    if (count === 0) return;
    frame.itemIndex = (frame.itemIndex + delta + count) % count;
    this._render();
  }

  _moveSection(delta) {
    const frame = this.stack[this.stack.length - 1];
    const count = frame.model.sections.length;
    if (count === 0) return;
    frame.sectionIndex = (frame.sectionIndex + delta + count) % count;
    // 切分类后光标回到第一项，否则会落在新分类不存在的下标上
    frame.itemIndex = 0;
    this._render();
  }

  // ==================== 渲染 ====================

  _buildDom() {
    const el = document.createElement('div');
    el.className = 'sys-ui';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', '系统菜单');
    el.hidden = true;

    el.innerHTML = `
      <div class="sys-topbar">
        <button class="sys-back" type="button" aria-label="返回" hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="sys-title"></span>
        <span class="sys-badge"></span>
      </div>
      <div class="sys-body">
        <nav class="sys-sidebar" role="tablist"></nav>
        <div class="sys-content">
          <ul class="sys-list" role="listbox"></ul>
        </div>
        <aside class="sys-detail" hidden></aside>
      </div>
      <!--
        底栏：左边是这一列的数量（「9 款」），右边是「现在能按什么」的按键图例。
        两边都是菜单的一部分（写在 .sys-ui 里）：菜单关掉整栏跟着没，
        不需要在屏幕外留位置，也不需要每次关闭时手动清空。
      -->
      <div class="sys-hintbar">
        <span class="sys-count" hidden></span>
        <div class="sys-hints"></div>
      </div>
    `;

    this.root.appendChild(el);
    this.el = el;
    this.titleEl = el.querySelector('.sys-title');
    this.badgeEl = el.querySelector('.sys-badge');
    this.backEl = el.querySelector('.sys-back');
    this.sidebarEl = el.querySelector('.sys-sidebar');
    this.listEl = el.querySelector('.sys-list');
    this.detailEl = el.querySelector('.sys-detail');
    // 底栏整条是菜单的一部分（写在 .sys-ui 里）：菜单关掉整栏跟着没，
    // 所以不需要在屏幕外给它留位置，也不需要每次关闭时手动清空。
    this.countEl = el.querySelector('.sys-count');
    this.hintEl = el.querySelector('.sys-hints');

    // 返回按钮：子菜单里点一下退一级（和按 B 一样）
    this.backEl.addEventListener('click', () => this.pop());
  }

  _hide() {
    this.el.hidden = true;
    // 通知屏幕容器「菜单已关闭」：右上角那排常驻按钮据此变淡（菜单按钮同时从「实心」变回「半透明」）。
    // 用根元素上的类而不是相邻兄弟选择器，
    // 因为 .sys-ui 是运行时插入的，DOM 顺序不可依赖（见 global.css 说明）。
    this.root.classList.remove('menu-open');
  }

  _render() {
    if (this.stack.length === 0) return this._hide();
    this.el.hidden = false;
    this.root.classList.add('menu-open');

    const frame = this.stack[this.stack.length - 1];
    const model = frame.model;
    const section = model.sections[frame.sectionIndex];
    const items = section ? section.items : [];
    const item = items[frame.itemIndex];

    // 游戏中呼出菜单时背景半透明（Ozone 的观感：不打断游戏，画面透出来）。
    // 读栈帧上的值，见 _resolveTransparent。
    this.el.dataset.running = frame.transparent ? 'true' : 'false';
    const focus = this._inCategory(frame) ? 'sidebar' : 'list';
    // 焦点在哪一栏写成属性，靠它来决定「高亮框」画在哪个区（见 global.css）：
    // 整块界面只有一个框，框在哪，方向键就动哪一栏。
    // 用 _inCategory 而不是直接读 frame.focus：没有分类栏时不能把框画在一个
    // 不存在的栏上，那样整块界面就没框了。
    this.el.dataset.focus = focus;

    this.titleEl.textContent = model.title || '';

    // 顶栏右侧徽标：这一层是什么（游戏名 / 「游戏中」 / 「确认」）
    this.badgeEl.textContent = model.badge || '';
    // 底栏左侧数量：当前这一列有多少项。没得说就整块隐藏（不占位）。
    // 函数版按当前分类给内容 —— 主菜单只有「游戏」那一列的数量是「几款游戏」，
    // 停在「控制管理」这类分类上还写着「9 款」就是在说假话。
    const count = typeof model.count === 'function' ? model.count(section) : model.count;
    this.countEl.textContent = count || '';
    this.countEl.hidden = !count;

    // 子菜单（stack.length > 1）时显示返回按钮，主菜单时隐藏
    this.backEl.hidden = this.stack.length <= 1;

    this._renderSidebar(model, frame.sectionIndex);
    this._renderList(items, frame.itemIndex);
    this._renderDetail(model, item);
    this._renderHints(model, item, focus);
  }

  _renderSidebar(model, activeIndex) {
    this.sidebarEl.innerHTML = '';
    // 只有一个分类时不画分类栏，把宽度留给列表（如游戏中快速菜单）。
    // 带分类栏的子菜单（设置）要画：那一栏就是它自己的分类（显示/音频/系统），
    // ↑↓ 选分类、A 或 → 进去，和主菜单同一套操作。
    if (!this._hasSidebar(model)) {
      this.sidebarEl.hidden = true;
      return;
    }
    this.sidebarEl.hidden = false;

    model.sections.forEach((section, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sys-nav-item' + (i === activeIndex ? ' selected' : '');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
      btn.innerHTML = `
        <span class="sys-nav-icon">${ICONS[section.icon] || ICONS.list}</span>
        <span class="sys-nav-label"></span>
      `;
      btn.querySelector('.sys-nav-label').textContent = section.label;
      // 点分类 = 选中并直接进它的列表（触摸上没有「先按 A」这一步的必要）
      btn.addEventListener('click', () => {
        const frame = this.stack[this.stack.length - 1];
        frame.sectionIndex = i;
        frame.itemIndex = 0;
        frame.focus = 'list';
        this._render();
      });
      this.sidebarEl.appendChild(btn);
    });

    // 窄屏上分类栏会放不下（六项竖排超过屏幕高度），
    // 用 ↑/↓ 切分类时把当前这一项滚进视野，否则光标跑到看不见的地方。
    const active = this.sidebarEl.children[activeIndex];
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  _renderList(items, activeIndex) {
    this.listEl.innerHTML = '';
    this.listEl.setAttribute('aria-label', '菜单项');

    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'sys-empty';
      empty.textContent = '（空）';
      this.listEl.appendChild(empty);
      return;
    }

    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = 'sys-item' + (i === activeIndex ? ' selected' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');

      const main = document.createElement('div');
      main.className = 'sys-item-main';

      const label = document.createElement('div');
      label.className = 'sys-item-label';
      label.textContent = item.label;
      main.appendChild(label);

      if (item.sublabel) {
        const sub = document.createElement('div');
        sub.className = 'sys-item-sub';
        sub.textContent = item.sublabel;
        main.appendChild(sub);
      }

      li.appendChild(main);

      if (item.value !== undefined && item.value !== null) {
        const val = document.createElement('div');
        val.className = 'sys-item-value';
        val.textContent = item.value;
        li.appendChild(val);
      }

      // 点击：先选中，再执行。双击在触摸上不可靠，所以单击就够 ——
      // 点一下未选中的项 = 选中并执行，点已选中的项 = 再执行一次。
      // 重绘走 refresh() 而不是 _render()：和 A 键那条路径（handleAction 里
      // 也是 onSelect 后 refresh）保持一致，都会调 rebuild() 重新取数据。
      // 用 _render() 会把建菜单时算好的 value 原样再画一遍，
      // 表现为「点了虚拟手柄，模式真变了，行上的字还是旧的」。
      li.addEventListener('click', () => {
        const frame = this.stack[this.stack.length - 1];
        frame.itemIndex = i;
        // 焦点跟着手指走：点在列表上，框就落到这一行（不然框还停在分类栏，
        // 看着像什么都没选中）。
        frame.focus = 'list';
        if (item.onSelect) item.onSelect();
        if (this.stack.length > 0) this.refresh();
      });

      this.listEl.appendChild(li);
    });

    // 让选中项始终可见（列表可能比可视区高）
    const selected = this.listEl.children[activeIndex];
    if (selected && selected.scrollIntoView) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }

  _renderDetail(model, item) {
    const detail = model.detail && item ? model.detail(item) : null;
    if (!detail || (!detail.lines?.length && !detail.empty)) {
      this.detailEl.hidden = true;
      return;
    }
    this.detailEl.hidden = false;
    this.detailEl.innerHTML = '';

    if (detail.lines?.length) {
      for (const line of detail.lines) {
        const row = document.createElement('div');
        row.className = 'sys-detail-row';
        const k = document.createElement('span');
        k.className = 'sys-detail-key';
        k.textContent = line.label;
        const v = document.createElement('span');
        v.className = 'sys-detail-val';
        v.textContent = line.value;
        row.append(k, v);
        this.detailEl.appendChild(row);
      }
    } else if (detail.empty) {
      const p = document.createElement('p');
      p.className = 'sys-detail-empty';
      p.textContent = detail.empty;
      this.detailEl.appendChild(p);
    }
  }

  /**
   * 底栏右侧的按键图例（「现在能按什么」）。常驻，跟着菜单开合。
   *
   * 条目自带提示优先（比如「删除」项要提示会丢数据），否则用菜单的默认提示。
   * 默认提示可以是个函数，按焦点所在栏给出不同内容 ——
   * 带分类栏的菜单里上下键的含义在两栏是不一样的（一边换分类、一边换条目），
   * 图例只说当前这一栏用得上的那套，不写用不上的那半套。
   */
  _renderHints(model, item, focus) {
    const declared = typeof model.hints === 'function' ? model.hints(focus) : model.hints;
    const hints = item?.hints || declared || [];
    this.hintEl.innerHTML = '';
    for (const hint of hints) {
      const span = document.createElement('span');
      span.className = 'sys-hint';
      const keys = document.createElement('span');
      keys.className = 'sys-hint-keys';
      for (const key of hint.keys) {
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        keys.appendChild(kbd);
      }
      const label = document.createElement('span');
      label.textContent = hint.label;
      span.append(keys, label);
      this.hintEl.appendChild(span);
    }
  }
}
