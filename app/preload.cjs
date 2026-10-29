// Minimal bridge between the call UI and the app's main process.
const { contextBridge, ipcRenderer } = require('electron');

const unwrap = (p) => p.catch((err) => {
  // Electron prefixes IPC errors with "Error invoking remote method '…': Error: "
  throw new Error(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
});

contextBridge.exposeInMainWorld('streamroomApp', {
  startHosting: () => unwrap(ipcRenderer.invoke('host:start')),
  stopHosting: () => unwrap(ipcRenderer.invoke('host:stop')),
  findMeeting: (code, address) => unwrap(ipcRenderer.invoke('host:find', { code, address })),
  onPickScreen: (handler) => ipcRenderer.on('screen:pick', (_e, req) => handler(req)),
  screenPicked: (id, choice) => ipcRenderer.send('screen:picked', { id, choice }),
});
