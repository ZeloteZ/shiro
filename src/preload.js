/**
 * Shiro preload script – IPC bridge between main and renderer.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shiro', {
  /** Listen for status updates from the main process. */
  onStatus: (callback) => {
    ipcRenderer.on('shiro:status', (_event, data) => callback(data));
  },

  /** Submit a Steam Guard code to the main process. */
  submitGuardCode: (code) => {
    ipcRenderer.send('shiro:submit-guard', code);
  },

  /** Request the app to close. */
  close: () => {
    ipcRenderer.send('shiro:close');
  },
});
