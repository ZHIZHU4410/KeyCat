'use strict';

const { EventEmitter } = require('events');

/**
 * 全局键鼠监听（uiohook-napi / libuiohook）。
 *
 * 如果原生模块加载失败（比如缺少 VC 运行库、被安全软件拦截），
 * 这里不会让主进程崩溃，而是把 status 置为 'unavailable'，
 * 渲染层会退回到「窗口内键盘事件 + 演示模式」。
 */
class InputHook extends EventEmitter {
  constructor() {
    super();
    this.lib = null;
    this.running = false;
    this.status = 'idle';
    this.error = null;
  }

  load() {
    if (this.lib) return true;
    try {
      // eslint-disable-next-line global-require
      this.lib = require('uiohook-napi');
      this.status = 'ready';
      return true;
    } catch (error) {
      this.status = 'unavailable';
      this.error = error && error.message ? error.message : String(error);
      console.error('[hook] 全局键鼠监听不可用:', this.error);
      return false;
    }
  }

  start() {
    if (this.running) return true;
    if (!this.load()) return false;
    const { uIOhook } = this.lib;
    try {
      uIOhook.on('keydown', (event) => this.emit('key', { code: event.keycode, down: true }));
      uIOhook.on('keyup', (event) => this.emit('key', { code: event.keycode, down: false }));
      uIOhook.on('mousedown', (event) => this.emit('mouseButton', { button: Number(event.button), down: true }));
      uIOhook.on('mouseup', (event) => this.emit('mouseButton', { button: Number(event.button), down: false }));
      uIOhook.on('mousemove', (event) => this.emit('mouseMove', { x: event.x, y: event.y }));
      uIOhook.on('wheel', (event) => {
        const rotation = Number(event.rotation) || 0;
        if (rotation !== 0) this.emit('wheel', { rotation, direction: Number(event.direction) });
      });
      uIOhook.start();
      this.running = true;
      this.status = 'running';
      this.error = null;
      return true;
    } catch (error) {
      this.status = 'error';
      this.error = error && error.message ? error.message : String(error);
      console.error('[hook] 启动失败:', this.error);
      return false;
    }
  }

  stop() {
    if (!this.running || !this.lib) return;
    try {
      this.lib.uIOhook.stop();
    } catch (error) {
      console.error('[hook] 停止失败:', error.message);
    }
    this.running = false;
    this.status = 'stopped';
  }

  info() {
    return {
      status: this.status,
      running: this.running,
      error: this.error,
      keycodes: this.lib ? Object.keys(this.lib.UiohookKey).length : 0,
    };
  }
}

module.exports = { InputHook };
