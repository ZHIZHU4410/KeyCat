/**
 * 浏览器 Gamepad API 轮询。
 * 预设里的手柄元素用的是 W3C 标准映射（A=0, B=1, X=2, Y=3, LB=4, RB=5, LT=6, RT=7,
 * Back=8, Start=9, L3=10, R3=11, 十字键=12..15），这里统一转换一次。
 */
export class GamepadPoller {
  constructor() {
    this.pad = null;
    this.connected = [];
    this.lastSeen = 0;
  }

  poll() {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      this.pad = null;
      return null;
    }

    const list = navigator.getGamepads();
    const pads = [];
    for (const pad of list) {
      if (pad) pads.push(pad);
    }
    this.connected = pads.map((pad) => ({
      index: pad.index,
      id: pad.id,
      mapping: pad.mapping,
      axes: pad.axes.length,
      buttons: pad.buttons.length,
    }));

    const chosen = pads[0];
    if (!chosen) {
      this.pad = null;
      return null;
    }

    this.lastSeen = performance.now();
    this.pad = {
      index: chosen.index,
      id: chosen.id,
      mapping: chosen.mapping,
      axes: Array.from(chosen.axes),
      buttons: chosen.buttons.map((button) => ({ pressed: button.pressed, value: button.value })),
    };
    return this.pad;
  }
}
