/**
 * 统一输入系统
 *
 * 把键盘、手柄、触摸三种输入来源，归一成同一组「动作」（ACTIONS）。
 * 界面和游戏都只认动作，不认具体是哪个设备按的。
 *
 * 为什么这样分层：
 * 同一个动作在不同设备上的物理按键不同（手柄 A 键 / 键盘 X 键 / 触摸 A 按钮），
 * 如果界面直接判断「按了 X 键」，就得为每种设备写一遍逻辑，而且很容易漏掉
 * 某个设备（实测踩过：触摸手柄的 A 键没反应，因为 Controller.BUTTON_A 的值是 0，
 * 被 `if (!button) return` 当成了「没有这个键」）。归一成动作后，
 * 「哪些设备能触发这个动作」是数据（映射表），判断逻辑只有一份。
 *
 * 动作命名以手柄按键为准（A/B/X/Y/L1/R1/Select/Start），
 * 因为设计上以手柄为标准，键盘和触摸只是替代方案。
 *
 * 对标：
 * - W3C《Gamepad》规范（https://www.w3.org/TR/gamepad/）：标准布局下
 *   buttons[0..3] 依次是下排/上排四个面键，[4][5] 是 L1/R1，[8][9] 是
 *   Select/Start，[12..15] 是十字键。本文件的 GAMEPAD_MAP 按此顺序。
 * - RetroArch 的「热键」（hotkey）做法：菜单键不与游戏键冲突，而是用
 *   Select+Start 组合键呼出菜单（见 docs.libretro.com/guides/ozone/）。
 *   本文件的 COMBOS 实现同一思路：游戏中 SELECT+START 呼出快速菜单。
 * - RetroArch 配置模板 `retroarch.cfg` 的键盘段同样是「动作 = 键」的一张表
 *   （`input_player1_a = x`、`input_player1_b = z`），所以 DEFAULT_BINDINGS
 *   以动作为键、并让默认值和它一致（A->X、B->Z）。
 *   改绑交互（一个动作一个键、按下即换、抢键自动让位）是本项目的自行设计：
 *   配置模板里没有「两个动作绑同一个键」的处理规则可对标，
 *   Web 上让一个键同时代表两个动作只会互相吞按键，所以选择「让位 + 状态栏说明」。
 */

/** 输入动作。以手柄按键命名，键盘/触摸都映射到这些值。 */
export const ACTIONS = {
  UP: 'UP',
  DOWN: 'DOWN',
  LEFT: 'LEFT',
  RIGHT: 'RIGHT',
  A: 'A',           // 确认 / 启动
  B: 'B',           // 返回 / 取消
  X: 'X',           // 次要操作（游戏信息）
  Y: 'Y',           // 次要操作（设置）
  SELECT: 'SELECT',
  START: 'START',
  L1: 'L1',         // 快速保存
  R1: 'R1',         // 快速读取
  MENU: 'MENU',     // 组合键产生：呼出/关闭菜单
};

/**
 * 键盘默认绑定：动作 -> KeyboardEvent.code。
 *
 * 方向选「动作 -> 键」而不是「键 -> 动作」，是因为这份数据要持久化、要给用户改：
 * 一个动作在同一时刻只有一个键（改绑即换），按动作索引才能直接写
 * `bindings[A] = 'KeyJ'`；反向表查询频繁，运行时由 buildKeyMap() 反查生成。
 * 值为空串表示该动作未绑定键盘。用空串而不是 null：设置要经 JSON 存进
 * localStorage，读回来时和默认值做类型比对（见 settings-manager 的 mergeWithDefaults），
 * null 的类型是 object，和默认值的 string 对不上会被当成「无效数据」丢掉，解绑就存不住。
 *
 * 键名用 KeyboardEvent.code（物理按键位置，不受输入法/键盘布局影响）。
 */
export const DEFAULT_BINDINGS = {
  [ACTIONS.UP]: 'ArrowUp',
  [ACTIONS.DOWN]: 'ArrowDown',
  [ACTIONS.LEFT]: 'ArrowLeft',
  [ACTIONS.RIGHT]: 'ArrowRight',
  [ACTIONS.A]: 'KeyX',
  [ACTIONS.B]: 'KeyZ',
  [ACTIONS.X]: 'KeyC',
  [ACTIONS.Y]: 'KeyV',
  [ACTIONS.SELECT]: 'ShiftRight',
  [ACTIONS.START]: 'Enter',
  [ACTIONS.L1]: 'F5',
  [ACTIONS.R1]: 'F9',
  [ACTIONS.MENU]: 'Escape',
};

/** 由「动作 -> 键」反查出「键 -> 动作」的查询表（keydown/keyup 用）。 */
export function buildKeyMap(bindings) {
  const map = {};
  for (const [action, code] of Object.entries(bindings)) {
    if (code) map[code] = action;
  }
  return map;
}

/**
 * 把 KeyboardEvent.code 转成界面上给人看的键名。
 * 只处理常见前缀，认不出的原样返回（浏览器新增的 code 不至于显示成空白）。
 */
const KEY_LABELS = {
  Escape: 'Esc',
  Enter: 'Enter',
  Space: '空格',
  Tab: 'Tab',
  Backspace: '退格',
  ShiftLeft: '左 Shift',
  ShiftRight: '右 Shift',
  ControlLeft: '左 Ctrl',
  ControlRight: '右 Ctrl',
  AltLeft: '左 Alt',
  AltRight: '右 Alt',
  MetaLeft: '左 Win',
  MetaRight: '右 Win',
  CapsLock: 'Caps',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Delete: 'Del',
  Insert: 'Ins',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

export function formatKeyCode(code) {
  if (!code) return '未绑定';
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad./.test(code)) return `小键盘 ${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return code;
}


/** 手柄映射：Gamepad.buttons 下标 -> 动作（W3C 标准布局） */
export const GAMEPAD_MAP = {
  0: ACTIONS.A,
  1: ACTIONS.B,
  2: ACTIONS.X,
  3: ACTIONS.Y,
  4: ACTIONS.L1,
  5: ACTIONS.R1,
  8: ACTIONS.SELECT,
  9: ACTIONS.START,
  12: ACTIONS.UP,
  13: ACTIONS.DOWN,
  14: ACTIONS.LEFT,
  15: ACTIONS.RIGHT,
};

/**
 * 组合键：全部按下时产生 combos.action。
 * 用来把「菜单键」和「游戏键」分开 —— 游戏中 START 要留给游戏本身用
 * （很多游戏用它暂停），不能同时兼作呼出菜单。
 */
const COMBOS = [
  { keys: [ACTIONS.SELECT, ACTIONS.START], action: ACTIONS.MENU },
];

/**
 * 输入管理器
 *
 * 用法：
 *   const input = new InputManager({ onAction: (action, pressed) => {...} });
 *   input.start();
 */
export class InputManager {
  /**
   * @param {object} opts
   * @param {function} [opts.onAction] - 动作回调 (action, pressed) => void
   * @param {object} [opts.bindings] - 覆盖默认键盘绑定（动作 -> code）
   */
  constructor(opts = {}) {
    this.onAction = opts.onAction || (() => {});
    this.bindings = { ...DEFAULT_BINDINGS, ...(opts.bindings || {}) };
    this.keyMap = buildKeyMap(this.bindings);
    /** 捕获中的回调：非空时所有 keydown 原样交给它，不派发为动作（改按键用） */
    this.keyCapture = null;

    // 动作的当前状态：action -> bool
    this.state = new Map();
    // 组合键的当前状态：action -> bool
    this.comboState = new Map();
    // MENU 的最终状态（两个来源：组合键、直接绑定）
    this.menuActive = false;

    this.rafId = null;
    this.running = false;
    // 手柄按钮的上一帧状态，用于识别「刚按下」
    this.prevGamepadButtons = new Map();
    // 已绑定到触摸按钮的元素，销毁时要解绑
    this.touchBindings = [];
    // 已绑定成方向面的元素（十字键），同上
    this.touchPads = [];

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._pollGamepad = this._pollGamepad.bind(this);
  }

  /** 开始监听键盘和手柄 */
  start() {
    if (this.running) return;
    this.running = true;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    // 窗口失焦时把所有按键置为松开，否则切回来会「粘键」
    window.addEventListener('blur', this._onBlur);
    this.rafId = requestAnimationFrame(this._pollGamepad);
  }

  /** 停止监听 */
  stop() {
    this.running = false;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** 查询某个动作当前是否按下（游戏中轮询用） */
  isDown(action) {
    return this.state.get(`__final_${action}`) === true;
  }

  /** 读取当前键盘绑定（返回副本，调用方改了要再 setBindings 回来） */
  getBindings() {
    return { ...this.bindings };
  }

  /** 整体替换键盘绑定（启动时从设置里读回来用这个） */
  setBindings(bindings) {
    this.bindings = { ...DEFAULT_BINDINGS, ...bindings };
    this.keyMap = buildKeyMap(this.bindings);
  }

  /**
   * 给某个动作绑一个键，code 传空表示解绑。
   *
   * 一个键只能属于一个动作：如果它原本绑在别的动作上，那个动作自动让位（解绑）。
   * 不弹「冲突」确认 —— 用户刚按下这个键，意图就是「它归这个动作」，
   * 让位结果在界面上直接读得出来（原动作那行变成「未绑定」）。
   *
   * @returns {string|null} 被让位的原动作（用于界面提示）
   */
  setBinding(action, code) {
    let displaced = null;
    if (code) {
      displaced = Object.keys(this.bindings).find(
        (other) => other !== action && this.bindings[other] === code,
      ) || null;
      if (displaced) this.bindings[displaced] = '';
    }
    this.bindings[action] = code || '';
    this.keyMap = buildKeyMap(this.bindings);
    return displaced;
  }

  /**
   * 进入「等用户按一个键」的捕获状态。
   *
   * 为什么要 InputManager 配合，而不是界面自己加一个 window keydown 监听：
   * 两边的事件顺序由注册顺序决定，界面层后注册就永远慢一步，
   * 那个键会先被当成动作派发出去（按 A 想改绑，结果菜单往下走一格）。
   * 收口在这里，捕获期只有一条路径。
   *
   * 只捕获 keydown：松开事件仍然正常走原逻辑，避免「改绑后旧键还卡在按下」。
   */
  beginKeyCapture(cb) {
    this.keyCapture = cb;
  }

  endKeyCapture() {
    this.keyCapture = null;
  }

  /**
   * 把一个 DOM 元素绑定成触摸按钮。
   * 用 Pointer Events 而不是分开写 touch/mouse：一套代码覆盖手指、鼠标、触控笔，
   * 且 setPointerCapture 保证「手指滑出按钮外再松开」也收得到松开事件。
   *
   * @param {HTMLElement} el - 按钮元素
   * @param {string[]} actions - 同时代表的动作（ACTIONS 里的值）；
   *   多于一个就是「一键多键」，比如手柄簇心的 AB 键传 [A, B]
   */
  attachTouchButton(el, actions) {
    const press = (e) => {
      e.preventDefault();
      if (el.setPointerCapture && e.pointerId !== undefined) {
        try { el.setPointerCapture(e.pointerId); } catch { /* 忽略不支持的情况 */ }
      }
      for (const action of actions) this._set(action, true);
    };
    const release = (e) => {
      e.preventDefault();
      for (const action of actions) this._set(action, false);
    };

    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    this.touchBindings.push({ el, press, release });
  }

  /**
   * 把四片拨片拼成的十字方向键绑成方向输入。
   *
   * 为什么不像 A/B 那样一键一动作：拇指按不出「同时按上和右」，而真机的斜向本来就靠
   * 按在两个臂中间。对标 Microsoft《Touch Adaptation Kit》d-pad（activationType 默认
   * allowNeighboring，死区是轴向方形）与 RetroArch 覆盖层的 dir-8-way：
   * 按指针相对十字中心的角度分扇区，落在两臂中间就同时给两个方向。
   *
   * 四个臂的方位不写死：每次按下现量臂的 data-action 与实际盒子，
   * 所以拖动过、转屏后都不用同步常量，也不会在 display:none 时量到全 0。
   *
   * 监听挂在容器上（命中的是子元素 .touch-dpad-hit / 臂）：摆放模式的拦截在同一容器的
   * 捕获阶段，只有目标是后代元素时拦截才发生在目标之前 —— 见 touch-layout.js 的 _onUnitPointerDown。
   *
   * @param {HTMLElement} el - .touch-dpad
   */
  attachTouchDpad(el) {
    // 死区是边长为十字 16% 的方形（0.08 是半宽）。四片尖头收在离中心 11%，
    // 刚好落在死区外：画出来的部分都按得动，中间那道空缝就是死区，不必再画中心点。
    const DEADZONE = 0.08;
    const dirActions = Array.from(el.querySelectorAll('[data-action]')).map((a) => a.dataset.action);
    /** 每根手指当前按住的行动作：pointerId -> [action] */
    const fingers = new Map();

    /** 指针位置 -> 该按下的方向（0、1 或 2 个） */
    const directionsAt = (e) => {
      const box = el.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      if (Math.abs(dx) <= box.width * DEADZONE && Math.abs(dy) <= box.height * DEADZONE) return [];
      const angle = Math.atan2(dy, dx);
      const arms = Array.from(el.querySelectorAll('[data-action]'))
        .map((arm) => {
          const r = arm.getBoundingClientRect();
          return {
            action: arm.dataset.action,
            // 指针方向与这个臂方向的夹角（-π~π，绝对值越小越靠近）
            delta: shortAngle(angle - Math.atan2(r.top + r.height / 2 - cy, r.left + r.width / 2 - cx)),
          };
        })
        .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
      const out = [arms[0].action];
      const next = arms[1];
      // 最近的臂已经超出它的独占范围（±22.5°），且第二近的臂在另一侧 —— 就是斜向
      if (next && Math.abs(arms[0].delta) > Math.PI / 8
        && Math.sign(next.delta) !== Math.sign(arms[0].delta)
        && Math.abs(next.delta) < Math.PI / 2) {
        out.push(next.action);
      }
      return out;
    };

    /** 所有手指按住的方向取并集，再分发给动作 */
    const apply = () => {
      const on = new Set();
      for (const list of fingers.values()) {
        for (const action of list) on.add(action);
      }
      for (const action of dirActions) this._set(action, on.has(action));
      const lit = dirActions.filter((action) => on.has(action));
      if (lit.length) el.dataset.active = lit.join(' ');
      else el.removeAttribute('data-active');
    };

    const press = (e) => {
      e.preventDefault();
      // 捕获指针：手指滑出十字外面也继续算方向、松开一定收得到
      if (el.setPointerCapture && e.pointerId !== undefined) {
        try { el.setPointerCapture(e.pointerId); } catch { /* 忽略不支持的情况 */ }
      }
      fingers.set(e.pointerId, directionsAt(e));
      apply();
    };
    const move = (e) => {
      if (!fingers.has(e.pointerId)) return;
      fingers.set(e.pointerId, directionsAt(e));
      apply();
    };
    const release = (e) => {
      if (fingers.delete(e.pointerId)) apply();
    };

    el.addEventListener('pointerdown', press);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    this.touchPads.push({ el, press, move, release });
  }

  /** 销毁：解绑所有事件 */
  destroy() {
    this.stop();
    for (const { el, press, release } of this.touchBindings) {
      el.removeEventListener('pointerdown', press);
      el.removeEventListener('pointerup', release);
      el.removeEventListener('pointercancel', release);
      el.removeEventListener('lostpointercapture', release);
    }
    this.touchBindings = [];
    for (const { el, press, move, release } of this.touchPads) {
      el.removeEventListener('pointerdown', press);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', release);
      el.removeEventListener('pointercancel', release);
      el.removeEventListener('lostpointercapture', release);
    }
    this.touchPads = [];
  }

  // ==================== 内部方法 ====================

  /**
   * 设置某个「原始动作」的状态，然后重算受影响的动作。
   *
   * 为什么要把「原始状态」和「最终状态」分开：
   * MENU 这个动作有两个来源 —— 手柄上的 SELECT+START 组合键，
   * 以及触摸界面上的独立菜单按钮（还有键盘的 Esc）。如果两个来源各自
   * 直接回调，同时触发时界面会收到两次 MENU，菜单开了又关。
   * 所以这里只更新来源状态，最终状态按「或」合成后再统一派发，
   * 谁先谁后都只会产生一次状态变化。
   */
  _set(action, down) {
    const was = this.state.get(action) === true;
    if (was === down) return;
    this.state.set(action, down);
    this._emit(action);
    // 原始动作变化可能让组合键成立/失效（如按住 SELECT 再按 START）
    this._checkCombos();
  }

  /** 按组合键规则重算组合动作，并派发状态变化 */
  _checkCombos() {
    for (const combo of COMBOS) {
      const allDown = combo.keys.every((k) => this.state.get(k) === true);
      const was = this.comboState.get(combo.action) === true;
      if (allDown === was) continue;
      this.comboState.set(combo.action, allDown);
      this._emit(combo.action);
    }
  }

  /** 重算某个动作的最终状态并派发（组合键来源 + 直接绑定来源，取或） */
  _emit(action) {
    const fromCombo = this.comboState.get(action) === true;
    const fromDirect = this.state.get(action) === true;
    const now = fromCombo || fromDirect;

    const key = `__final_${action}`;
    const was = this.state.get(key) === true;
    if (was === now) return;
    this.state.set(key, now);
    this.onAction(action, now);
  }

  _onKeyDown(e) {
    if (this.keyCapture) {
      const cb = this.keyCapture;
      this.keyCapture = null;
      e.preventDefault();
      cb(e.code);
      return;
    }
    const action = this.keyMap[e.code];
    if (!action) return;
    e.preventDefault();
    this._set(action, true);
  }

  _onKeyUp(e) {
    const action = this.keyMap[e.code];
    if (!action) return;
    e.preventDefault();
    this._set(action, false);
  }

  /** 窗口失焦：清空所有状态，防止粘键 */
  _onBlur() {
    for (const action of Object.values(ACTIONS)) {
      this._set(action, false);
    }
    this.prevGamepadButtons.clear();
  }

  /**
   * 轮询手柄。
   *
   * Gamepad API 是「轮询」模型：没有按键事件，必须在每帧主动读取
   * navigator.getGamepads()（W3C Gamepad 规范第 4 节）。所以这里用
   * requestAnimationFrame 持续轮询，并且自己对比上一帧状态来产生
   * 按下/松开事件 —— 界面需要的是事件，而 API 只给状态。
   */
  _pollGamepad() {
    if (!this.running) return;

    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    // 只取第一个连接的手柄，多个手柄同时控制一套界面会互相打架
    const pad = Array.from(gamepads).find((g) => g && g.connected);

    if (pad) {
      for (const [indexStr, action] of Object.entries(GAMEPAD_MAP)) {
        const index = Number(indexStr);
        const pressed = pad.buttons[index] ? pad.buttons[index].pressed : false;
        const key = `${pad.index}:${index}`;
        const was = this.prevGamepadButtons.get(key) === true;
        if (pressed !== was) {
          this.prevGamepadButtons.set(key, pressed);
          this._set(action, pressed);
        }
      }
    } else if (this.prevGamepadButtons.size > 0) {
      // 手柄被拔掉：清掉它的按键状态，避免动作卡在「按下」
      for (const [key, was] of this.prevGamepadButtons) {
        if (!was) continue;
        const index = Number(key.split(':')[1]);
        const action = GAMEPAD_MAP[index];
        if (action) this._set(action, false);
      }
      this.prevGamepadButtons.clear();
    }

    this.rafId = requestAnimationFrame(this._pollGamepad);
  }
}

/** 把角度差折到 -π~π：算「两个方向之间夹了多少度」要用最短的那段，不是有符号的差值 */
function shortAngle(rad) {
  let a = rad % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a <= -Math.PI) a += Math.PI * 2;
  return a;
}
