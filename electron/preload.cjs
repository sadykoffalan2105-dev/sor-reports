// Мост для страницы: голос Windows для голосовой базы имён (только проговорить текст в WAV).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sorNative', { synth: (texts) => ipcRenderer.invoke('synth', texts) });
