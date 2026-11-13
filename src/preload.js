// Ponte entre a interface e o processo principal. A interface só enxerga
// estas funções; ela não tem acesso direto a arquivos nem ao sistema.

const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['job', 'job-removed', 'focus', 'whisper']);

contextBridge.exposeInMainWorld('api', {
    detect: (text) => ipcRenderer.invoke('detect', text),
    preview: (text) => ipcRenderer.invoke('preview', text),
    readClipboard: () => ipcRenderer.invoke('clipboard:read'),

    jobs: {
        list: () => ipcRenderer.invoke('jobs:list'),
        start: (payload) => ipcRenderer.invoke('jobs:start', payload),
        retry: (id, action) => ipcRenderer.invoke('jobs:retry', id, action),
        remove: (id) => ipcRenderer.invoke('jobs:remove', id),
        clear: () => ipcRenderer.invoke('jobs:clear'),
    },

    openFile: (file) => ipcRenderer.invoke('file:open', file),
    showFile: (file) => ipcRenderer.invoke('file:show', file),
    dragJob: (id) => ipcRenderer.send('file:drag', id),
    openFolder: () => ipcRenderer.invoke('folder:open'),

    settings: {
        get: () => ipcRenderer.invoke('settings:get'),
        set: (patch) => ipcRenderer.invoke('settings:set', patch),
        pickFolder: () => ipcRenderer.invoke('settings:pick-folder'),
    },

    whisper: {
        status: () => ipcRenderer.invoke('whisper:status'),
        install: () => ipcRenderer.invoke('whisper:install'),
        cancel: () => ipcRenderer.invoke('whisper:cancel'),
        dismiss: () => ipcRenderer.invoke('whisper:dismiss'),
    },

    instagram: {
        connect: () => ipcRenderer.invoke('ig:connect'),
        disconnect: () => ipcRenderer.invoke('ig:disconnect'),
    },

    on: (event, handler) => {
        if (!EVENTS.has(event)) return;
        ipcRenderer.on(event, (_e, payload) => handler(payload));
    },
});
