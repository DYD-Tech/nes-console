// 基础测试：直接跑各模块的逻辑，不经过浏览器（用户明确要求不做 GUI 测试）
//
// 被测模块是浏览器代码，用到的浏览器 API 在这里用最小替身（stub）补上：
// window / document / localStorage / requestAnimationFrame。
// 替身只实现被测逻辑真正用到的部分，不是模拟整个浏览器 ——
// 目的是验证「逻辑对不对」，不是「浏览器跑不跑得起来」。
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

// ---------- 浏览器替身 ----------

/** 最小 DOM 元素替身：只需要 screen-ui 用到的那些方法和属性 */
function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    hidden: false,
    dataset: {},
    style: {},
    textContent: '',
    _html: '',
    attributes: {},
    listeners: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; this.children = []; },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    append(...cs) { cs.forEach((c) => this.appendChild(c)); },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollIntoView() {},
    focus() {},
    click() { (this.listeners.click || []).forEach((f) => f({ preventDefault() {} })); },
  };
  return el;
}

const documentStub = {
  createElement: (tag) => makeEl(tag),
  querySelectorAll: () => [],
  addEventListener: () => {},
};

global.document = documentStub;
global.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};

// localStorage 替身：设置模块要读写它
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// ---------- 载入被测模块 ----------
// 源码是 ESM，用动态 import；Node 能直接跑 .js 里的 ESM（package.json 有 "type": "module"）

// 被测模块路径相对项目根解析，不依赖当前工作目录
const ROOT = path.resolve(__dirname, '..');
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

(async () => {
  const { InputManager, ACTIONS, GAMEPAD_MAP, DEFAULT_BINDINGS, buildKeyMap, formatKeyCode } =
    await load('src/lib/input-manager.js');
  const { SettingsManager, DEFAULT_SETTINGS, SETTINGS_SCHEMA, PAD_MODES, PAD_GROUPS } =
    await load('src/lib/settings-manager.js');
  // padLayout 的键名以 DRAG_UNITS 为准（两份常量迟早会对不上）
  const { DRAG_UNITS } = await load('src/lib/touch-layout.js');
  const { ScreenUI } = await load('src/lib/screen-ui.js');

  // ==================== 输入系统 ====================

  console.log('\n【输入系统】');

  {
    // 键盘事件用 code（物理位置），不是 key（受布局/输入法影响）
    check('默认绑定表是「动作 -> code」', DEFAULT_BINDINGS[ACTIONS.A] === 'KeyX');
    check('反查表把 code 映射回动作', buildKeyMap(DEFAULT_BINDINGS).KeyX === ACTIONS.A);
    check('反查表不引入 key 字段（用 code 不用 key）', !('x' in buildKeyMap(DEFAULT_BINDINGS)));
    check('Z 键映射到动作 B', buildKeyMap(DEFAULT_BINDINGS).KeyZ === ACTIONS.B);
    check('Escape 映射到 MENU', buildKeyMap(DEFAULT_BINDINGS).Escape === ACTIONS.MENU);
    check('F5/F9 映射到 L1/R1（快速存读）',
      buildKeyMap(DEFAULT_BINDINGS).F5 === ACTIONS.L1
      && buildKeyMap(DEFAULT_BINDINGS).F9 === ACTIONS.R1);
    check('每个动作都在默认绑定表里',
      Object.values(ACTIONS).every((a) => a in DEFAULT_BINDINGS),
      `缺: ${Object.values(ACTIONS).filter((a) => !(a in DEFAULT_BINDINGS)).join(',')}`);
    // 界面上要能把 code 念成人话，否则「KeyX」「ShiftRight」这种字符串没人看得懂
    check('code 转显示名：字母键', formatKeyCode('KeyX') === 'X');
    check('code 转显示名：方向键', formatKeyCode('ArrowUp') === '↑');
    check('code 转显示名：右 Shift', formatKeyCode('ShiftRight') === '右 Shift');
    check('code 转显示名：未绑定', formatKeyCode(null) === '未绑定');
    check('code 转显示名：认不出的原样返回', formatKeyCode('AudioVolumeUp') === 'AudioVolumeUp');
  }

  {
    // 改按键：一个动作一个键，按下即换，被抢走的键自动解绑
    const input = new InputManager({});
    check('改绑前 A 是 X 键', input.getBindings()[ACTIONS.A] === 'KeyX');
    const displaced = input.setBinding(ACTIONS.A, 'KeyZ');
    check('改绑后 A 变成 J 位（Z 键）', input.getBindings()[ACTIONS.A] === 'KeyZ');
    check('被抢走的键报告原动作', displaced === ACTIONS.B, `实际 ${displaced}`);
    check('原动作 B 自动解绑', input.getBindings()[ACTIONS.B] === '');
    check('反查表里 Z 键现在归 A', input.keyMap.KeyZ === ACTIONS.A);
    input.setBinding(ACTIONS.A, null);
    check('显式解绑后键不再派发动作', input.keyMap.KeyZ === undefined);

    // 捕获态：原始按键不派发为动作，只回调一次并自动退出
    const events = [];
    const cap = new InputManager({ onAction: (a, p) => events.push([a, p]) });
    let captured = null;
    cap.beginKeyCapture((code) => { captured = code; });
    cap._onKeyDown({ code: 'KeyX', preventDefault() {} });
    cap._onKeyUp({ code: 'KeyX', preventDefault() {} });
    check('捕获期按下不派发动作', events.length === 0, `实际 ${events.length} 条`);
    check('捕获回调拿到原始 code', captured === 'KeyX', `实际 ${captured}`);
    check('捕获是一次性的（按完即退出）', cap.keyCapture === null);
    cap._onKeyDown({ code: 'KeyX', preventDefault() {} });
    check('退出捕获后同一个键恢复正常派发',
      events.some(([a, p]) => a === ACTIONS.A && p === true), JSON.stringify(events));
  }

  {
    // 手柄映射必须覆盖 A/B/X/Y/L1/R1/Select/Start/十字键
    const actions = new Set(Object.values(GAMEPAD_MAP));
    const required = ['A', 'B', 'X', 'Y', 'L1', 'R1', 'SELECT', 'START',
      'UP', 'DOWN', 'LEFT', 'RIGHT'];
    const missing = required.filter((a) => !actions.has(a));
    check('手柄映射覆盖全部 12 个动作', missing.length === 0, `缺: ${missing.join(',')}`);
    check('手柄下标 0 是 A 键（W3C 标准布局）', GAMEPAD_MAP[0] === ACTIONS.A);
    check('手柄下标 12-15 是十字键',
      GAMEPAD_MAP[12] === ACTIONS.UP && GAMEPAD_MAP[15] === ACTIONS.RIGHT);
  }

  {
    // 组合键：SELECT+START 产生 MENU，且只产生一次
    const events = [];
    const input = new InputManager({ onAction: (a, p) => events.push([a, p]) });

    input._set(ACTIONS.SELECT, true);
    input._set(ACTIONS.START, true);
    const menuOn = events.filter(([a, p]) => a === ACTIONS.MENU && p === true);
    check('SELECT+START 产生一次 MENU 按下', menuOn.length === 1, `实际 ${menuOn.length} 次`);

    input._set(ACTIONS.START, false);
    const menuOff = events.filter(([a, p]) => a === ACTIONS.MENU && p === false);
    check('松开 START 后 MENU 松开', menuOff.length === 1, `实际 ${menuOff.length} 次`);

    // 单独按 START 不应触发 MENU（START 要留给游戏自己用）
    events.length = 0;
    input._set(ACTIONS.SELECT, false);
    input._set(ACTIONS.START, true);
    check('单独按 START 不触发 MENU',
      !events.some(([a]) => a === ACTIONS.MENU));
  }

  {
    // MENU 有两个来源（组合键 + 直接绑定），不能重复派发
    const events = [];
    const input = new InputManager({ onAction: (a, p) => events.push([a, p]) });

    input._set(ACTIONS.SELECT, true);
    input._set(ACTIONS.START, true);       // 来源一：组合键
    input._set(ACTIONS.MENU, true);        // 来源二：直接绑定（触摸按钮）
    const on = events.filter(([a, p]) => a === ACTIONS.MENU && p === true);
    check('MENU 两个来源同时按下只派发一次', on.length === 1, `实际 ${on.length} 次`);

    input._set(ACTIONS.START, false);      // 组合键失效，但直接来源仍按住
    check('还有来源按住时 MENU 不松开', input.isDown(ACTIONS.MENU) === true);

    input._set(ACTIONS.MENU, false);       // 最后一个来源也松开
    check('所有来源松开后 MENU 才松开', input.isDown(ACTIONS.MENU) === false);
  }

  {
    // 状态去重：按住不放不应反复触发
    const events = [];
    const input = new InputManager({ onAction: (a, p) => events.push([a, p]) });
    input._set(ACTIONS.A, true);
    input._set(ACTIONS.A, true);
    input._set(ACTIONS.A, true);
    check('重复按下同一动作只派发一次',
      events.filter(([a, p]) => a === ACTIONS.A && p).length === 1);
  }

  // ==================== 设置系统 ====================

  console.log('\n【设置系统】');

  {
    const s = new SettingsManager({});
    check('默认 CRT 滤镜为开', s.getValue('display.crtFilter') === true);
    check('默认音量 80', s.getValue('audio.volume') === 80);
    check('默认自动存档为开', s.getValue('system.autoSave') === true);
  }

  {
    // 控制设置：整棵 controls 子树都要能存住、读回来（深合并按默认值的键走）
    const s = new SettingsManager({});
    check('默认键盘绑定取自 DEFAULT_BINDINGS',
      s.getValue('controls.keyMap.A') === DEFAULT_BINDINGS.A);
    check('默认手柄显示模式为自动', s.getValue('controls.padMode') === 'auto');
    check('手柄显示模式三档且取值唯一',
      PAD_MODES.length === 3 && new Set(PAD_MODES.map((m) => m.value)).size === 3);
    check('每个可隐藏按键组都有默认值',
      PAD_GROUPS.every((g) => typeof s.getValue(`controls.padKeys.${g.id}`) === 'boolean'));
    check('每个可拖动组的默认偏移是原点',
      DRAG_UNITS.every((u) => s.getValue(`controls.padLayout.${u.id}.x`) === 0
        && s.getValue(`controls.padLayout.${u.id}.y`) === 0));

    s.setValue('controls.keyMap', { ...DEFAULT_BINDINGS, A: 'KeyJ', B: '' });
    s.setValue('controls.padMode', 'always');
    s.setValue('controls.padKeys', { dpad: true, a: false, b: true, select: true, start: true });
    s.setValue('controls.padLayout', { dpad: { x: -0.12, y: 0.05 }, actions: { x: 0, y: 0 } });
    const s2 = new SettingsManager({});
    check('改绑的按键能存住', s2.getValue('controls.keyMap.A') === 'KeyJ');
    // 解绑存的是空串而不是 null：null 的类型是 object，和默认值的 string 对不上，
    // 深合并会把它当无效数据丢弃（见 input-manager 的说明）
    check('解绑（空串）能存住且不被默认值覆盖', s2.getValue('controls.keyMap.B') === '');
    check('手柄显示模式能存住', s2.getValue('controls.padMode') === 'always');
    check('单个按键的显隐能存住', s2.getValue('controls.padKeys.a') === false);
    check('拖动偏移能存住', s2.getValue('controls.padLayout.dpad.x') === -0.12);
    store.clear();
  }

  {
    // 只存了一半的 controls：缺的键要回落到默认值，而不是 undefined
    store.set('nes-console.settings', JSON.stringify({
      controls: { padMode: 'never', keyMap: { A: 'KeyJ' } },
    }));
    const s = new SettingsManager({});
    check('部分 controls 数据补齐其余默认值',
      s.getValue('controls.padMode') === 'never'
      && s.getValue('controls.keyMap.A') === 'KeyJ'
      && s.getValue('controls.keyMap.B') === DEFAULT_BINDINGS.B
      && s.getValue('controls.padKeys.a') === true);
    store.clear();
  }

  {
    const changes = [];
    const s = new SettingsManager({ onChange: (p, v) => changes.push([p, v]) });
    s.setValue('audio.muted', true);
    check('写设置会通知监听者',
      changes.some(([p, v]) => p === 'audio.muted' && v === true));
    check('写设置立即生效', s.getValue('audio.muted') === true);

    // 重新构造一个实例，验证真的落盘了
    const s2 = new SettingsManager({});
    check('设置持久化到 localStorage', s2.getValue('audio.muted') === true);
  }

  {
    // 损坏的数据不应该让页面起不来
    store.set('nes-console.settings', '{这不是合法 JSON');
    const s = new SettingsManager({});
    check('设置数据损坏时回退默认值', s.getValue('audio.volume') === 80);
    store.clear();
  }

  {
    // 旧版本遗留的、已删除的设置项不应复活（项目要求不留历史包袱）
    store.set('nes-console.settings', JSON.stringify({
      audio: { volume: 50 },
      removedFeature: { enabled: true },
    }));
    const s = new SettingsManager({});
    check('读取时丢弃已废弃的设置项', s.get().removedFeature === undefined);
    check('保留仍然有效的设置项', s.getValue('audio.volume') === 50);
    store.clear();
  }

  {
    // 类型不符的脏数据不应覆盖默认值（防止手改坏配置导致界面崩）
    store.set('nes-console.settings', JSON.stringify({ audio: { volume: '很大声' } }));
    const s = new SettingsManager({});
    check('类型不符的脏数据被忽略', s.getValue('audio.volume') === 80);
    store.clear();
  }

  {
    // 每一项设置都必须有界面能用的元数据
    const bad = [];
    for (const cat of SETTINGS_SCHEMA) {
      for (const item of cat.items) {
        if (!item.path || !item.label || !item.type) bad.push(item.path || '(无路径)');
        if (item.type === 'range' && (item.min === undefined || item.max === undefined)) {
          bad.push(item.path + '(缺 min/max)');
        }
      }
    }
    check('设置项元数据完整', bad.length === 0, `问题项: ${bad.join(',')}`);

    // schema 里的每一项都要在默认值里存在，否则读出来是 undefined
    const orphans = [];
    for (const cat of SETTINGS_SCHEMA) {
      for (const item of cat.items) {
        const v = item.path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), DEFAULT_SETTINGS);
        if (v === undefined) orphans.push(item.path);
      }
    }
    check('每个设置项都有默认值', orphans.length === 0, `缺默认值: ${orphans.join(',')}`);
  }

  // ==================== 屏幕界面 ====================

  console.log('\n【屏幕界面】');

  const makeUI = () => {
    const root = makeEl('div');
    // ScreenUI 用 innerHTML 建 DOM，替身里 querySelector 返回 null 会崩，
    // 所以这里只测不依赖 DOM 查询的部分：菜单栈、导航、动作分发。
    const ui = Object.create(ScreenUI.prototype);
    ui.root = root;
    ui.onOpen = () => { ui._opened = (ui._opened || 0) + 1; };
    ui.onEmpty = () => { ui._emptied = true; };
    ui.stack = [];
    ui.el = makeEl('div');
    ui.titleEl = makeEl('span');
    ui.badgeEl = makeEl('span');
    ui.sidebarEl = makeEl('nav');
    ui.listEl = makeEl('ul');
    ui.detailEl = makeEl('aside');
    ui.hintEl = makeEl('div');
    ui._renders = 0;
    ui._render = () => { ui._renders++; };
    ui._hide = () => { ui._hidden = true; };
    // refresh 是真方法（会走 rebuild 分支），这里只把渲染计数拦下来，
    // 这样测试能验证「值改了之后确实触发了重建」。
    const realRefresh = ScreenUI.prototype.refresh;
    ui.refresh = function () {
      return realRefresh.call(this);
    };
    return ui;
  };

  const menuModel = () => ({
    title: '测试菜单',
    sections: [
      {
        id: 'a', label: '分类一', items: [
          { id: 'a1', label: '项目 1' },
          { id: 'a2', label: '项目 2' },
          { id: 'a3', label: '项目 3' },
        ],
      },
      {
        id: 'b', label: '分类二', items: [
          { id: 'b1', label: '项目 B1' },
        ],
      },
    ],
  });

  {
    const ui = makeUI();
    check('初始状态菜单为空', ui.isEmpty() === true);
    ui.push(menuModel());
    check('压栈后菜单不为空', ui.isEmpty() === false);
  }

  {
    // onOpen 只在「界面从关着变成开着」时触发一次 —— 游戏暂停靠它。
    // 往已打开的界面里再压一层不重复通知，否则每进一次子菜单都会再暂停一次。
    const ui = makeUI();
    check('初始未触发过 onOpen', ui._opened === undefined);
    ui.push(menuModel());
    check('首次打开触发 onOpen（游戏据此暂停）', ui._opened === 1, `实际 ${ui._opened}`);
    ui.push(menuModel());
    check('压第二层不重复触发 onOpen', ui._opened === 1, `实际 ${ui._opened}`);
    ui.pop();
    check('退一层也不触发 onOpen', ui._opened === 1, `实际 ${ui._opened}`);
    ui.pop();
    check('全部关闭触发 onEmpty（游戏据此恢复）', ui._emptied === true);
    ui.push(menuModel());
    check('关闭后再次打开会重新触发 onOpen', ui._opened === 2, `实际 ${ui._opened}`);
  }

  {
    // clear() 走的也是「界面关掉」这条路，之后重新打开同样要触发 onOpen
    const ui = makeUI();
    ui.push(menuModel());
    ui.push(menuModel());
    ui.clear();
    check('clear 触发 onEmpty', ui._emptied === true);
    ui.push(menuModel());
    check('clear 后重新打开触发 onOpen', ui._opened === 2, `实际 ${ui._opened}`);
  }

  {
    // 焦点模型（handleAction）：带分类栏的菜单开在分类栏上，↑↓ 只动当前那一栏。
    const ui = makeUI();
    ui.push(menuModel());
    check('多分类菜单初始焦点在分类栏', ui.stack[0].focus === 'sidebar');
    ui.handleAction(ACTIONS.DOWN);
    check('分类栏里 ↓ 换下一个分类', ui.stack[0].sectionIndex === 1);
    ui.handleAction(ACTIONS.UP);
    check('分类栏里 ↑ 换回上一个分类', ui.stack[0].sectionIndex === 0);
    check('换分类把列表光标送回第一行（换了分类就是换了内容）', ui.stack[0].itemIndex === 0);
  }

  {
    // 进出列表：来回一趟位置不变（对标 Ozone 出侧栏时用 menu_remember_selection 回到原行）
    const ui = makeUI();
    ui.push(menuModel());
    ui.handleAction(ACTIONS.RIGHT);
    check('分类栏里按 → 进列表', ui.stack[0].focus === 'list' && ui.stack[0].sectionIndex === 0);
    ui.handleAction(ACTIONS.DOWN);
    check('列表里 ↓ 移动光标', ui.stack[0].itemIndex === 1);
    ui.handleAction(ACTIONS.LEFT);
    check('列表里按 ← 回分类栏', ui.stack[0].focus === 'sidebar');
    ui.handleAction(ACTIONS.RIGHT);
    check('再进列表仍停在原来那一行（不重置）', ui.stack[0].itemIndex === 1);
    ui.handleAction(ACTIONS.B);
    check('列表里按 B 也是回分类栏（手机右手只有 A/B，不该逼用户去按 ←）',
      ui.stack[0].focus === 'sidebar');
    ui.handleAction(ACTIONS.A);
    check('分类栏里按 A 与按 → 等价，都是进列表', ui.stack[0].focus === 'list');
  }

  {
    // 列表首尾循环，不会卡在边界（手柄上不用反向找边界）。
    // 这里用单分类菜单：没有分类栏，焦点直接落在列表上，↑↓ 动的就是条目。
    const ui = makeUI();
    ui.push({
      title: 't',
      sections: [{
        id: 's', label: 'S',
        items: [{ id: '1', label: '一' }, { id: '2', label: '二' }, { id: '3', label: '三' }],
      }],
    });
    check('单分类菜单没有分类栏，焦点直接落在列表上', ui.stack[0].focus === 'list');
    ui.handleAction(ACTIONS.UP);
    check('在第一项按 ↑ 回到最后一项', ui.stack[0].itemIndex === 2);
    ui.handleAction(ACTIONS.DOWN);
    check('在最后一项按 ↓ 回到第一项', ui.stack[0].itemIndex === 0);
  }

  {
    // 单分类菜单：←→ 调节数值（此时没有分类可切，左右归还给数值）
    let adjusted = 0;
    const ui = makeUI();
    ui.push({
      title: 't',
      sections: [{
        id: 's', label: 'S', items: [
          { id: 'x', label: '槽位', onAdjust: (d) => { adjusted += d; } },
        ],
      }],
    });
    ui.handleAction(ACTIONS.RIGHT);
    check('单分类时 → 调节数值', adjusted === 1);
    ui.handleAction(ACTIONS.LEFT);
    check('单分类时 ← 反向调节', adjusted === 0);
  }

  {
    // 有分类栏时 ←→ 归给「进出分类栏」，不能被数值调节抢走，否则用户回不到分类栏
    let adjusted = 0;
    const ui = makeUI();
    ui.push({
      title: 't',
      sections: [
        { id: 'a', label: 'A', items: [{ id: 'x', label: '项', onAdjust: (d) => { adjusted += d; } }] },
        { id: 'b', label: 'B', items: [{ id: 'y', label: '项2' }] },
      ],
    });
    ui.handleAction(ACTIONS.RIGHT);   // 进列表
    ui.handleAction(ACTIONS.RIGHT);
    check('有分类栏时 → 不调节数值', adjusted === 0);
    ui.handleAction(ACTIONS.LEFT);
    check('有分类栏时 ← 是回分类栏，也不调节数值',
      adjusted === 0 && ui.stack[0].focus === 'sidebar',
      `adjusted=${adjusted} focus=${ui.stack[0].focus}`);
  }

  {
    let selected = 0;
    const ui = makeUI();
    ui.push({
      title: 't',
      sections: [{
        id: 's', label: 'S', items: [
          { id: 'x', label: '项', onSelect: () => { selected++; } },
        ],
      }],
    });
    ui.handleAction(ACTIONS.A);
    check('A 键触发 onSelect', selected === 1);
  }

  {
    // X / Y 是次要操作，不是「和 A 一样」
    let sec = 0, ter = 0;
    const ui = makeUI();
    ui.push({
      title: 't',
      sections: [{
        id: 's', label: 'S', items: [
          { id: 'x', label: '项', onSecondary: () => { sec++; }, onTertiary: () => { ter++; } },
        ],
      }],
    });
    ui.handleAction(ACTIONS.X);
    ui.handleAction(ACTIONS.Y);
    check('X 键触发 onSecondary', sec === 1);
    check('Y 键触发 onTertiary', ter === 1);
  }

  {
    const ui = makeUI();
    ui.push(menuModel());
    ui.handleAction(ACTIONS.B);
    check('B 键弹出当前菜单', ui.stack.length === 0);
    check('菜单清空时通知调用方（恢复游戏）', ui._emptied === true);
  }

  {
    // 菜单打开时吞掉其余动作，避免误触游戏
    const ui = makeUI();
    ui.push(menuModel());
    const consumed = ui.handleAction(ACTIONS.START);
    check('界面打开时吞掉 START（不传给游戏）', consumed === true);
  }

  {
    const ui = makeUI();
    check('菜单关闭时不消费动作（交给游戏）',
      ui.handleAction(ACTIONS.A) === false);
  }

  {
    // 多级菜单：设置 -> 存档，返回后回到设置
    const ui = makeUI();
    ui.push({ title: '主菜单', sections: [{ id: 'm', label: 'M', items: [{ id: '1', label: '设置' }] }] });
    ui.push({ title: '设置', sections: [{ id: 's', label: 'S', items: [{ id: '2', label: '存档' }] }] });
    check('菜单栈支持多级', ui.stack.length === 2);
    ui.handleAction(ACTIONS.B);
    check('返回后停在上一级菜单', ui.stack.length === 1 && ui.stack[0].model.title === '主菜单');
  }

  {
    // 单选分类：只有一栏时不画侧边栏，把宽度让给列表
    const ui = makeUI();
    ui.push({ title: 't', sections: [{ id: 's', label: 'S', items: [{ id: '1', label: '项' }] }] });
    check('单分类菜单能正常压栈', ui.stack.length === 1);
  }

  {
    // startSection：打开存档菜单时直接定位到「槽位」分类
    const ui = makeUI();
    ui.push({
      title: 't',
      startSection: 'second',
      sections: [
        { id: 'first', label: 'F', items: [{ id: '1', label: 'a' }] },
        { id: 'second', label: 'S', items: [{ id: '2', label: 'b' }] },
      ],
    });
    check('startSection 生效', ui.stack[0].sectionIndex === 1);
  }

  {
    // 空分类不应崩
    const ui = makeUI();
    ui.push({ title: 't', sections: [{ id: 'e', label: '空', items: [] }] });
    let ok = true;
    try {
      ui.handleAction(ACTIONS.UP);
      ui.handleAction(ACTIONS.DOWN);
      ui.handleAction(ACTIONS.A);
    } catch (e) { ok = false; }
    check('空分类导航不崩溃', ok);
  }

  {
    // rebuild：内容会变的菜单（存档列表、设置值）刷新时要重新取数据
    let rebuildCount = 0;
    const ui = makeUI();
    ui.push({
      title: 't',
      rebuild: async () => {
        rebuildCount++;
        return {
          title: 't',
          sections: [{ id: 's', label: 'S', items: [{ id: '1', label: '新的' }] }],
        };
      },
      sections: [{ id: 's', label: 'S', items: [{ id: '1', label: '旧的' }] }],
    });
    await ui.refresh();
    check('refresh 会调用 rebuild 重新取数据', rebuildCount === 1);
    check('rebuild 后菜单内容已更新',
      ui.stack[0].model.sections[0].items[0].label === '新的');
  }

  {
    // 没有 rebuild 的菜单：refresh 直接重绘，不应报错
    const ui = makeUI();
    ui.push({ title: 't', sections: [{ id: 's', label: 'S', items: [{ id: '1', label: 'x' }] }] });
    const before = ui._renders;
    await ui.refresh();
    check('无 rebuild 的菜单也能刷新', ui._renders > before);
  }

  {
    // rebuild 后条目变少时，光标不能停在越界位置（否则渲染读不到条目）
    const ui = makeUI();
    ui.push({
      title: 't',
      rebuild: async () => ({
        title: 't',
        sections: [{ id: 's', label: 'S', items: [{ id: '1', label: '只剩一项' }] }],
      }),
      sections: [{ id: 's', label: 'S', items: [
        { id: '1', label: 'a' }, { id: '2', label: 'b' }, { id: '3', label: 'c' },
      ] }],
    });
    ui.stack[0].itemIndex = 2;  // 光标在第三项
    await ui.refresh();
    check('rebuild 后光标越界时回到第一项', ui.stack[0].itemIndex === 0,
      `实际 ${ui.stack[0].itemIndex}`);
  }

  {
    // clear() 也要通知调用方，和一路按 B 退回的行为一致
    const ui = makeUI();
    ui.push(menuModel());
    ui.clear();
    check('clear 后菜单为空', ui.stack.length === 0);
    check('clear 会通知调用方恢复游戏', ui._emptied === true);
  }

  {
    // 半透明背景：从游戏中呼出的子菜单要继承，且不能被 refresh 刷掉
    const ui = makeUI();
    ui.push({
      title: '快速菜单',
      transparent: true,
      rebuild: async () => ({
        title: '快速菜单',
        // 注意：rebuild 返回的数据不带 transparent（它属于栈帧，不属于数据）
        sections: [{ id: 'q', label: 'Q', items: [{ id: '1', label: '继续' }] }],
      }),
      sections: [{ id: 'q', label: 'Q', items: [{ id: '1', label: '继续' }] }],
    });
    check('显式声明的半透明生效', ui.stack[0].transparent === true);

    ui.push({ title: '设置', sections: [{ id: 's', label: 'S', items: [{ id: '1', label: 'x' }] }] });
    check('子菜单继承父级的半透明', ui.stack[1].transparent === true);

    await ui.refresh();
    check('refresh 后半透明不被刷掉', ui.stack[1].transparent === true);

    ui.pop();
    check('退回后父级仍半透明', ui.stack[0].transparent === true);

    // 从主菜单（非游戏中）进的子菜单不应半透明
    const ui2 = makeUI();
    ui2.push({ title: '主菜单', sections: [{ id: 'm', label: 'M', items: [{ id: '1', label: '设置' }] }] });
    check('主菜单不半透明', ui2.stack[0].transparent === false);
    ui2.push({ title: '设置', sections: [{ id: 's', label: 'S', items: [{ id: '1', label: 'x' }] }] });
    check('非游戏中的子菜单也不半透明', ui2.stack[1].transparent === false);

    // 显式声明优先于继承
    ui2.push({
      title: '特殊',
      transparent: true,
      sections: [{ id: 's', label: 'S', items: [{ id: '1', label: 'x' }] }],
    });
    check('显式声明覆盖继承值', ui2.stack[2].transparent === true);
  }

  // ==================== 结果 ====================

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试运行出错:', e);
  process.exit(1);
});
