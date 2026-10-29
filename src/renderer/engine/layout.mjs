/**
 * KeyCat · input-overlay 5.x 预设渲染引擎（纯逻辑，不依赖 DOM）
 *
 * 兼容 univrsal/input-overlay v5.0.x 的 layout JSON：
 *  - 每个元素用 mapping=[u,v,w,h] 指向图集（texture atlas）中的一帧，
 *    用 pos=[x,y] 指定在画布上的位置；
 *  - 按下态 / 方向帧 / 进度帧都排在图集中相邻的格子里，间隔固定 3px
 *    （input-overlay 的 CFG_INNER_BORDER）；
 *  - z_level 决定绘制顺序（小的先画）。
 *
 * 这个模块同时被 Electron 渲染进程和 Node 端的预览脚本复用，
 * 所以只输出绘制指令，不直接接触任何画布实现。
 */

/** input-overlay layout_constants.h: CFG_INNER_BORDER */
export const FRAME_GAP = 3;

/** input-overlay element_type */
export const ELEMENT_TYPE = {
  TEXTURE: 0,
  KEYBOARD_KEY: 1,
  GAMEPAD_BUTTON: 2,
  MOUSE_BUTTON: 3,
  WHEEL: 4,
  ANALOG_STICK: 5,
  TRIGGER: 6,
  GAMEPAD_ID: 7,
  DPAD_STICK: 8,
  MOUSE_MOVEMENT: 9,
};

export const ELEMENT_TYPE_NAME = {
  0: 'texture',
  1: 'keyboard',
  2: 'gamepad_button',
  3: 'mouse_button',
  4: 'wheel',
  5: 'analog_stick',
  6: 'trigger',
  7: 'gamepad_id',
  8: 'dpad',
  9: 'mouse_movement',
};

/** overlay_flag */
export const OVERLAY_FLAG = {
  LEFT_STICK: 1 << 0,
  RIGHT_STICK: 1 << 1,
  GAMEPAD: 1 << 2,
  MOUSE: 1 << 3,
};

/**
 * SDL GameController 按键序号 -> W3C 标准 Gamepad 按键序号。
 * 预设里 0..16 的 code 用的是 SDL 顺序，而浏览器的 Gamepad API 用的是 W3C 顺序。
 */
const SDL_TO_W3C = [0, 1, 2, 3, 8, 16, 9, 10, 11, 4, 5, 12, 13, 14, 15];

/**
 * 部分预设（GameCube 等）使用 60416 起的扩展手柄键码，
 * 这里按预设里出现的 id（B/A/Y/X/L1/R1/SELECT/START/L3/R3/方向键）映射到 W3C 序号。
 */
const EXTENDED_PAD_BUTTONS = {
  60416: 1, // B
  60417: 0, // A
  60418: 3, // Y
  60419: 2, // X
  60420: 4, // L1
  60421: 5, // R1
  60422: 8, // SELECT
  60423: 9, // START
  60424: 6, // L2
  60425: 10, // L3
  60426: 11, // R3
  60427: 14, // LEFT
  60428: 15, // RIGHT
  60429: 12, // UP
  60430: 13, // DOWN
};

/** 把预设里的手柄键码转成 Gamepad API 的按键序号，未知返回 -1 */
export function padButtonIndex(code) {
  if (code >= 60416) return EXTENDED_PAD_BUTTONS[code] ?? -1;
  if (code >= 0 && code < SDL_TO_W3C.length) return SDL_TO_W3C[code];
  return -1;
}

/** dpad_texture：0 中心、1 左、2 右、3 上、4 下、5..8 四个斜向 */
const DPAD_OFFSETS = {
  '': 0,
  left: 1,
  right: 2,
  up: 3,
  down: 4,
  'up,left': 5,
  'up,right': 6,
  'down,left': 7,
  'down,right': 8,
};

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

class Element {
  constructor(data) {
    this.data = data;
    this.id = String(data.id ?? '');
    this.type = num(data.type, -1);
    this.code = num(data.code, 0);
    this.u = num(data.mapping?.[0]);
    this.v = num(data.mapping?.[1]);
    this.w = num(data.mapping?.[2]);
    this.h = num(data.mapping?.[3]);
    this.x = num(data.pos?.[0]);
    this.y = num(data.pos?.[1]);
    this.z = num(data.z_level, 0);
    this.side = num(data.side, 0);
    this.direction = num(data.direction, 0);
    this.triggerMode = Boolean(data.trigger_mode);
    this.stickRadius = num(data.stick_radius, 0);
    this.mouseRadius = num(data.mouse_radius, 0);
    this.mouseType = num(data.mouse_type, 0);
  }

  get bounds() {
    return { x: this.x, y: this.y, w: this.w, h: this.h };
  }

  /** 每帧更新内部状态（只有鼠标光点 / 箭头需要） */
  update() {}

  /** 返回绘制指令数组，交给画布实现 */
  draw() {
    return [];
  }

  /** 图集里同一元素的「按下态」帧 */
  get pressedV() {
    return this.v + this.h + FRAME_GAP;
  }

  /**
   * 有些预设只画了基础帧（比如 GameCube 的十字键只有一个造型），
   * 方向帧落在图集之外。出现这种情况时回退到基础帧，避免元素凭空消失。
   */
  hasFrame(view, u, v, w, h) {
    const textureW = view?.textureWidth;
    const textureH = view?.textureHeight;
    if (!textureW || !textureH) return true;
    return u >= 0 && v >= 0 && u + w <= textureW + 1 && v + h <= textureH + 1;
  }

  frame(painter, texture, v) {
    return painter.crop(texture, this.u, v, this.w, this.h, this.x, this.y, this.w, this.h);
  }
}

class TextureElement extends Element {
  draw(view) {
    return [
      {
        texture: view.texture,
        sx: this.u,
        sy: this.v,
        sw: this.w,
        sh: this.h,
        dx: this.x,
        dy: this.y,
        dw: this.w,
        dh: this.h,
      },
    ];
  }
}

/** 键盘 / 鼠标 / 手柄按钮：按下时画下面那一帧 */
class ButtonElement extends Element {
  isPressed() {
    return false;
  }

  draw(view) {
    const wantsPressed = this.isPressed(view.input);
    const pressed = wantsPressed && this.hasFrame(view, this.u, this.pressedV, this.w, this.h);
    return [
      {
        texture: view.texture,
        sx: this.u,
        sy: pressed ? this.pressedV : this.v,
        sw: this.w,
        sh: this.h,
        dx: this.x,
        dy: this.y,
        dw: this.w,
        dh: this.h,
      },
    ];
  }
}

class KeyboardElement extends ButtonElement {
  isPressed(input) {
    return Boolean(input?.keys?.has(this.code));
  }
}

class MouseButtonElement extends ButtonElement {
  isPressed(input) {
    return Boolean(input?.mouseButtons?.has(this.code));
  }
}

class GamepadButtonElement extends ButtonElement {
  isPressed(input) {
    const pad = input?.pad;
    if (!pad) return false;
    const index = padButtonIndex(this.code);
    if (index < 0) return false;
    return Boolean(pad.buttons?.[index]?.pressed);
  }
}

/** 滚轮：基础帧 / 中键帧 / 上滚帧 / 下滚帧依次向右排 */
class WheelElement extends Element {
  draw(view) {
    const cmds = [];
    const gap = this.w + FRAME_GAP;
    const middle = Boolean(view.input?.mouseButtons?.has(3)) && this.hasFrame(view, this.u + gap, this.v, this.w, this.h);
    cmds.push({
      texture: view.texture,
      sx: this.u + (middle ? gap : 0),
      sy: this.v,
      sw: this.w,
      sh: this.h,
      dx: this.x,
      dy: this.y,
      dw: this.w,
      dh: this.h,
    });
    const dir = view.input?.wheelDir ?? 0;
    if (dir !== 0) {
      const sx = this.u + gap * (dir > 0 ? 2 : 3);
      if (this.hasFrame(view, sx, this.v, this.w, this.h)) {
        cmds.push({
          texture: view.texture,
          sx,
          sy: this.v,
          sw: this.w,
          sh: this.h,
          dx: this.x,
          dy: this.y,
          dw: this.w,
          dh: this.h,
        });
      }
    }
    return cmds;
  }
}

/** 摇杆：底图 + 按偏移量跟随的手指/摇杆头；按下摇杆时换成高亮帧 */
class AnalogStickElement extends Element {
  draw(view) {
    const pad = view.input?.pad;
    let ox = 0;
    let oy = 0;
    let pressed = false;
    if (pad) {
      const axis = this.side === 1 ? 2 : 0;
      ox = num(pad.axes?.[axis]) * this.stickRadius;
      oy = num(pad.axes?.[axis + 1]) * this.stickRadius;
      const buttonIndex = this.side === 1 ? 11 : 10; // R3 / L3
      pressed = Boolean(pad.buttons?.[buttonIndex]?.pressed);
    }
    if (pressed && !this.hasFrame(view, this.u, this.pressedV, this.w, this.h)) pressed = false;
    return [
      {
        texture: view.texture,
        sx: this.u,
        sy: pressed ? this.pressedV : this.v,
        sw: this.w,
        sh: this.h,
        dx: this.x + ox,
        dy: this.y + oy,
        dw: this.w,
        dh: this.h,
      },
    ];
  }
}

/** 扳机：trigger_mode 是“按下即高亮”，否则按进度填充 */
class TriggerElement extends Element {
  draw(view) {
    const pad = view.input?.pad;
    const buttonIndex = this.side === 1 ? 7 : 6; // RT / LT
    const value = clamp(num(pad?.buttons?.[buttonIndex]?.value), 0, 1);
    const pressed = value > 0.2 && this.hasFrame(view, this.u, this.pressedV, this.w, this.h);
    const fillV = this.v + this.h + FRAME_GAP;
    const canFill = this.hasFrame(view, this.u, fillV, this.w, this.h);

    if (!pad || this.triggerMode || !canFill) {
      return [
        {
          texture: view.texture,
          sx: this.u,
          sy: pressed ? this.pressedV : this.v,
          sw: this.w,
          sh: this.h,
          dx: this.x,
          dy: this.y,
          dw: this.w,
          dh: this.h,
        },
      ];
    }

    const cmds = [
      {
        texture: view.texture,
        sx: this.u,
        sy: this.v,
        sw: this.w,
        sh: this.h,
        dx: this.x,
        dy: this.y,
        dw: this.w,
        dh: this.h,
      },
    ];

    if (value <= 0) return cmds;

    const progressH = this.h * value;
    const progressW = this.w * value;

    switch (this.direction) {
      case 1: {
        // 从下往上填充
        cmds.push({
          texture: view.texture,
          sx: this.u,
          sy: fillV + (this.h - progressH),
          sw: this.w,
          sh: progressH,
          dx: this.x,
          dy: this.y + (this.h - progressH),
          dw: this.w,
          dh: progressH,
        });
        break;
      }
      case 3: {
        // 从右往左填充
        cmds.push({
          texture: view.texture,
          sx: this.u + (this.w - progressW),
          sy: fillV,
          sw: progressW,
          sh: this.h,
          dx: this.x + (this.w - progressW),
          dy: this.y,
          dw: progressW,
          dh: this.h,
        });
        break;
      }
      case 4: {
        // 从左往右填充
        cmds.push({
          texture: view.texture,
          sx: this.u,
          sy: fillV,
          sw: progressW,
          sh: this.h,
          dx: this.x,
          dy: this.y,
          dw: progressW,
          dh: this.h,
        });
        break;
      }
      case 2:
      default: {
        // 从上往下填充
        cmds.push({
          texture: view.texture,
          sx: this.u,
          sy: fillV,
          sw: this.w,
          sh: progressH,
          dx: this.x,
          dy: this.y,
          dw: this.w,
          dh: progressH,
        });
        break;
      }
    }
    return cmds;
  }
}

/** 手柄编号（1~4 号灯） */
class GamepadIdElement extends Element {
  draw(view) {
    const pad = view.input?.pad;
    const cmds = [];
    const gap = this.w + FRAME_GAP;
    const index = clamp(num(pad?.index, 0), 0, 3);
    let sx = this.u + gap * index;
    if (!this.hasFrame(view, sx, this.v, this.w, this.h)) sx = this.u;
    cmds.push({
      texture: view.texture,
      sx: this.u + gap * index,
      sy: this.v,
      sw: this.w,
      sh: this.h,
      dx: this.x,
      dy: this.y,
      dw: this.w,
      dh: this.h,
    });
    const pressedSx = this.u + gap * 4;
    if (pad?.buttons?.[16]?.pressed && this.hasFrame(view, pressedSx, this.v, this.w, this.h)) {
      cmds.push({
        texture: view.texture,
        sx: pressedSx,
        sy: this.v,
        sw: this.w,
        sh: this.h,
        dx: this.x,
        dy: this.y,
        dw: this.w,
        dh: this.h,
      });
    }
    return cmds;
  }
}

/** 十字键：按方向组合切换 9 帧 */
class DpadElement extends Element {
  draw(view) {
    const pad = view.input?.pad;
    const gap = this.w + FRAME_GAP;
    const dirs = [];
    if (pad) {
      if (pad.buttons?.[12]?.pressed) dirs.push('up');
      if (pad.buttons?.[13]?.pressed) dirs.push('down');
      if (pad.buttons?.[14]?.pressed) dirs.push('left');
      if (pad.buttons?.[15]?.pressed) dirs.push('right');
    }
    const has = (name) => dirs.includes(name);
    const vertical = has('up') ? 'up' : has('down') ? 'down' : '';
    const horizontal = has('left') ? 'left' : has('right') ? 'right' : '';
    const key = [vertical, horizontal].filter(Boolean).join(',');
    let offset = DPAD_OFFSETS[key] ?? 0;
    if (!this.hasFrame(view, this.u + gap * offset, this.v, this.w, this.h)) offset = 0;
    return [
      {
        texture: view.texture,
        sx: this.u + gap * offset,
        sy: this.v,
        sw: this.w,
        sh: this.h,
        dx: this.x,
        dy: this.y,
        dw: this.w,
        dh: this.h,
      },
    ];
  }
}

/** 鼠标移动：光点（位移向量）或箭头（指向移动方向） */
class MouseMovementElement extends Element {
  constructor(data) {
    super(data);
    this.smoothX = 0;
    this.smoothY = 0;
    this.angle = 0;
  }

  update(view, dt) {
    const input = view.input || {};
    const sensitivity = Math.max(1, num(input.mouseSensitivity, 100));
    const deadzone = Math.max(0, num(input.mouseDeadzone, 0));
    let dx = num(input.mouseDX);
    let dy = num(input.mouseDY);
    if (Math.abs(dx) < deadzone) dx = 0;
    if (Math.abs(dy) < deadzone) dy = 0;

    // 指数平滑，让光点 / 箭头在事件间隙里自然回落
    const factor = clamp(1 - Math.exp(-Math.max(0, dt) / 45), 0.05, 1);
    this.smoothX += (dx - this.smoothX) * factor;
    this.smoothY += (dy - this.smoothY) * factor;
    if (Math.abs(this.smoothX) < 0.01) this.smoothX = 0;
    if (Math.abs(this.smoothY) < 0.01) this.smoothY = 0;

    if (Math.hypot(this.smoothX, this.smoothY) > 0.5) {
      this.angle = Math.atan2(this.smoothY, this.smoothX) + Math.PI / 2;
    }
  }

  draw(view) {
    if (this.mouseType === 1) {
      // input-overlay 的旋转绘制是「以 pos - (w/2, -h/2) 为圆心」：
      // 元素左上角实际落在 (pos.x - w, pos.y)，预设正是按这个偏移摆放的，
      // 少了这个偏移箭头会跑到鼠标右边缘外面去。
      return [
        {
          texture: view.texture,
          sx: this.u,
          sy: this.v,
          sw: this.w,
          sh: this.h,
          dx: this.x - this.w,
          dy: this.y,
          dw: this.w,
          dh: this.h,
          rotation: this.angle,
          pivotX: this.w / 2,
          pivotY: this.h / 2,
        },
      ];
    }

    const sensitivity = Math.max(1, num(view.input?.mouseSensitivity, 100));
    const fx = clamp(this.smoothX / sensitivity, -1, 1);
    const fy = clamp(this.smoothY / sensitivity, -1, 1);
    return [
      {
        texture: view.texture,
        sx: this.u,
        sy: this.v,
        sw: this.w,
        sh: this.h,
        dx: this.x + this.mouseRadius * fx,
        dy: this.y + this.mouseRadius * fy,
        dw: this.w,
        dh: this.h,
      },
    ];
  }
}

const ELEMENT_CLASSES = {
  [ELEMENT_TYPE.TEXTURE]: TextureElement,
  [ELEMENT_TYPE.KEYBOARD_KEY]: KeyboardElement,
  [ELEMENT_TYPE.GAMEPAD_BUTTON]: GamepadButtonElement,
  [ELEMENT_TYPE.MOUSE_BUTTON]: MouseButtonElement,
  [ELEMENT_TYPE.WHEEL]: WheelElement,
  [ELEMENT_TYPE.ANALOG_STICK]: AnalogStickElement,
  [ELEMENT_TYPE.TRIGGER]: TriggerElement,
  [ELEMENT_TYPE.GAMEPAD_ID]: GamepadIdElement,
  [ELEMENT_TYPE.DPAD_STICK]: DpadElement,
  [ELEMENT_TYPE.MOUSE_MOVEMENT]: MouseMovementElement,
};

export function createElement(data) {
  const Cls = ELEMENT_CLASSES[num(data?.type, -1)];
  return Cls ? new Cls(data) : null;
}

/**
 * 解析一份 layout JSON，返回可直接渲染的预设对象。
 * @param {object} layout input-overlay 5.x layout
 * @returns {{width:number,height:number,elements:Element[],flags:number,unknown:string[]}}
 */
export function createPreset(layout) {
  const elements = [];
  const unknown = [];
  const raw = Array.isArray(layout?.elements) ? layout.elements : [];

  for (const data of raw) {
    const element = createElement(data);
    if (element) elements.push(element);
    else unknown.push(String(data?.id ?? data?.type));
  }

  // 稳定排序：z_level 小的先画
  elements.sort((a, b) => a.z - b.z);

  // 画布尺寸：优先用预设声明值，否则按元素包围盒推算
  let width = num(layout?.overlay_width, 0);
  let height = num(layout?.overlay_height, 0);
  if (!width || !height) {
    for (const el of elements) {
      width = Math.max(width, el.x + el.w);
      height = Math.max(height, el.y + el.h);
    }
  }

  return {
    width,
    height,
    flags: num(layout?.flags, 0),
    elements,
    unknown,
    raw: layout,
  };
}

/** 预设是否包含某一大类元素，用于 UI 提示 */
export function presetInfo(preset) {
  const counts = {};
  for (const el of preset.elements) {
    const name = ELEMENT_TYPE_NAME[el.type] ?? 'unknown';
    counts[name] = (counts[name] ?? 0) + 1;
  }
  const has = (name) => (counts[name] ?? 0) > 0;
  return {
    counts,
    keyboard: Object.entries(counts).some(([k, v]) => v > 0 && (k === 'keyboard' || k === 'mouse_button' || k === 'wheel' || k === 'mouse_movement')),
    gamepad: Object.entries(counts).some(([k, v]) => v > 0 && ['gamepad_button', 'analog_stick', 'trigger', 'gamepad_id', 'dpad'].includes(k)),
    mouse: has('mouse_button') || has('wheel') || has('mouse_movement'),
  };
}

/** 渲染一帧：返回扁平绘制指令列表 */
export function drawPreset(preset, view, dt = 16) {
  const commands = [];
  for (const el of preset.elements) {
    if (el.update) el.update(view, dt);
    for (const cmd of el.draw(view)) commands.push(cmd);
  }
  return commands;
}
