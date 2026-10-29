'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel) {
  return (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('keycat', {
  getState: () => ipcRenderer.invoke('state:get'),
  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),
  updateInstances: (instances) => ipcRenderer.invoke('instances:update', instances),
  getLayout: (id) => ipcRenderer.invoke('preset:layout', id),
  rescanPresets: () => ipcRenderer.invoke('presets:rescan'),
  setEditMode: (value) => ipcRenderer.invoke('overlay:edit-mode', value),
  setOverlayVisible: (value) => ipcRenderer.invoke('overlay:visible', value),
  setMousePause: (value) => ipcRenderer.invoke('overlay:mouse-pause', value),
  openPresetFolder: () => ipcRenderer.invoke('preset:open-folder'),
  openBuiltinFolder: () => ipcRenderer.invoke('preset:builtin-folder'),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  quit: () => ipcRenderer.invoke('app:quit'),
  setLoginItem: (value) => ipcRenderer.invoke('app:set-login', value),
  getLoginItem: () => ipcRenderer.invoke('app:login-status'),
  workArea: () => ipcRenderer.invoke('overlay:work-area'),
  reportViewport: (size) => ipcRenderer.send('viewport:report', size),
  onInput: subscribe('input:batch'),
  onConfigChanged: subscribe('config:changed'),
  onInstancesChanged: subscribe('instances:changed'),
  onEditModeChanged: subscribe('overlay:edit-mode'),
  onVisibleChanged: subscribe('overlay:visible'),
});
