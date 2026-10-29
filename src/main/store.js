'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULTS = {
  version: 1,
  language: 'zh-CN',
  overlay: {
    clickThrough: true,
    alwaysOnTop: true,
    opacity: 1,
    fps: 60,
    mouseSensitivity: 100,
    mouseDeadzone: 0,
    demo: false,
    grid: false,
  },
  instances: [],
  bounds: null,
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(base[key])) out[key] = merge(base[key], value);
    else out[key] = value;
  }
  return out;
}

class Store extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.data = DEFAULTS;
    this._saveTimer = null;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = merge(DEFAULTS, parsed);
    } catch {
      this.data = { ...DEFAULTS };
    }
    if (!Array.isArray(this.data.instances)) this.data.instances = [];
    return this.data;
  }

  get() {
    return this.data;
  }

  patch(partial, options = {}) {
    this.data = merge(this.data, partial);
    if (options.save !== false) this.save();
    this.emit('change', this.data);
    return this.data;
  }

  setInstances(instances) {
    this.data.instances = Array.isArray(instances) ? instances.slice(0, 64) : [];
    this.save();
    this.emit('change', this.data);
    return this.data;
  }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 120);
  }

  flush() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error('[store] 保存配置失败:', error.message);
    }
  }
}

module.exports = { Store, DEFAULTS, merge };
