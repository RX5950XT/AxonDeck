/**
 * 網頁版 AI 登入分區（persist:ai-*）每個 frame 的 preload。由 main 用 session.registerPreloadScript 掛上，
 * 不是 renderer 指定的（webview 自帶的 preload 仍一律被 main 拿掉）。
 *
 * 只做一件事：Electron 的 window.chrome 是空的，真 Chrome 有 app／csi／loadTimes。
 * hCaptcha（Claude）、Cloudflare（Grok）、Google 登入的機器人偵測看到空的 window.chrome 就當成內嵌瀏覽器擋掉。
 * 不暴露任何 Node／IPC 能力給網頁。
 */
const { contextBridge } = require('electron')

contextBridge.executeInMainWorld({
  func: () => {
    const c = window.chrome || (window.chrome = {})
    if (!c.app) {
      c.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: () => null,
        getIsInstalled: () => false,
        runningState: () => 'cannot_run'
      }
    }
    if (!c.csi) {
      c.csi = () => ({ startE: Math.round(performance.timeOrigin), onloadT: Date.now(), pageT: performance.now(), tran: 15 })
    }
    if (!c.loadTimes) {
      c.loadTimes = () => {
        const t = performance.timeOrigin / 1000
        return {
          requestTime: t, startLoadTime: t, commitLoadTime: t, finishDocumentLoadTime: t, finishLoadTime: t,
          firstPaintTime: t, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true,
          wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2'
        }
      }
    }
  }
})
