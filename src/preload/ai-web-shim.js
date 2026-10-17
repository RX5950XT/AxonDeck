/**
 * 網頁版 AI 登入分區（persist:ai-*）與工作區瀏覽器（persist:wsbrowser）每個 frame 的 preload。由 main 用 session.registerPreloadScript 掛上，
 * 不是 renderer 指定的（webview 自帶的 preload 仍一律被 main 拿掉）。
 *
 * 只做一件事：Electron 的 window.chrome 是空的，真 Chrome 有 app／csi／loadTimes。
 * hCaptcha（Claude）、Cloudflare（Grok）、Google 登入的機器人偵測看到空的 window.chrome 就當成內嵌瀏覽器擋掉。
 * 不暴露任何 Node／IPC 能力給網頁。
 */
const { contextBridge } = require('electron')

contextBridge.executeInMainWorld({
  func: () => {
    // 被 Cloudflare 擋而改回 Electron 識別的分頁（main 的 installChallengeFallback）：照原版 Electron，什麼都不補
    if (/\sElectron\//.test(navigator.userAgent)) return
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
    // Electron 的 userAgentData 只有 Chromium、沒有 Google Chrome。補成跟 main 送的 Sec-CH-UA 同一份
    // （算法同 ai-web.js 的 brandList：假品牌與順序由主版號決定）
    const uad = navigator.userAgentData
    const chromium = uad?.brands?.find((b) => b.brand === 'Chromium')
    const uaVersion = /(?:Chrome|Chromium)\/([\d.]+)/.exec(navigator.userAgent)?.[1]
    const major = Number(uaVersion?.split('.')[0] || chromium?.version)
    const browserBrand = navigator.userAgent.includes('Edg/') ? 'Microsoft Edge' : 'Google Chrome'
    if (!uad || !major || (uad.brands.some((b) => b.brand === browserBrand) && Number(chromium?.version) === major)) return
    const brandList = (version) => {
      const order = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]][major % 6]
      const chars = ' (:-./);=?_'
      const grease = ['8', '99', '24'][major % 3]
      const out = []
      out[order[0]] = { brand: `Not${chars[major % 11]}A${chars[(major + 1) % 11]}Brand`, version: version.includes('.') ? `${grease}.0.0.0` : grease }
      out[order[1]] = { brand: 'Chromium', version }
      out[order[2]] = { brand: browserBrand, version }
      return out
    }
    const proto = Object.getPrototypeOf(uad)
    const high = proto.getHighEntropyValues
    const json = proto.toJSON
    const fix = (values) => {
      const out = { ...values, brands: brandList(String(major)) }
      const nativeFull = values?.fullVersionList?.find((b) => b.brand === 'Chromium')?.version
      const full = Number(nativeFull?.split('.')[0]) === major ? nativeFull : (uaVersion || nativeFull)
      if (values && Object.hasOwn(values, 'uaFullVersion') && full) out.uaFullVersion = full
      if (full) out.fullVersionList = brandList(full)
      return out
    }
    Object.defineProperty(proto, 'brands', { configurable: true, enumerable: true, get: () => brandList(String(major)) })
    proto.getHighEntropyValues = function getHighEntropyValues(hints) { return high.call(this, hints).then(fix) }
    proto.toJSON = function toJSON() { return fix(json.call(this)) }
  }
})
