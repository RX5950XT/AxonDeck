/**
 * Linux 播放視窗專用 preload：只開放播放器自己的幾個 IPC（不共用主視窗那份大 API）。
 */
const { contextBridge, ipcRenderer } = require('electron')

function listen(channel, cb) {
  const handler = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('axdPlayer', {
  state: () => ipcRenderer.invoke('mediaPlayer:state'),
  select: (index) => ipcRenderer.invoke('mediaPlayer:select', index),
  subtitles: (index) => ipcRenderer.invoke('mediaPlayer:subtitles', index),
  mpv: (req) => ipcRenderer.invoke('mediaPlayer:mpv', req),
  external: (index, which) => ipcRenderer.invoke('mediaPlayer:external', index, which),
  onQueue: (cb) => listen('mediaPlayer:queue', cb),
  onMpvState: (cb) => listen('mediaPlayer:mpvState', cb)
})
