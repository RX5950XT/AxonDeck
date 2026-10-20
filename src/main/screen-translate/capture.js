'use strict'

const { desktopCapturer, screen } = require('electron')

const fail = (code, message) => Object.assign(new Error(message), { code, userMessage: message })

/** thumbnail 的實際像素與 DIP 分開算，支援負座標與不同縮放倍率的副螢幕。 */
function cropRect(region, display, size) {
  if (region.width < 1 || region.height < 1 || region.x < display.x || region.y < display.y
    || region.x + region.width > display.x + display.width || region.y + region.height > display.y + display.height) {
    throw fail('CROSS_DISPLAY', '請把取景框完整移到同一個螢幕內，再按繼續')
  }
  const x = Math.round((region.x - display.x) * size.width / display.width)
  const y = Math.round((region.y - display.y) * size.height / display.height)
  return { x, y, width: Math.min(size.width - x, Math.max(1, Math.round(region.width * size.width / display.width))),
    height: Math.min(size.height - y, Math.max(1, Math.round(region.height * size.height / display.height))) }
}

/** 視窗本身設了 content protection，擷取得到的是它蓋住的畫面，整個視窗就是取景範圍。 */
async function capture(region) {
  const display = screen.getDisplayMatching(region)
  // 先驗範圍，跨螢幕時不擷取，避免使用者以為整框都已辨識。
  cropRect(region, display.bounds, { width: display.bounds.width, height: display.bounds.height })
  const sources = await desktopCapturer.getSources({ types: ['screen'], fetchWindowIcons: false,
    thumbnailSize: { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) } })
  const source = sources.find((item) => item.display_id === String(display.id))
  if (!source || source.thumbnail.isEmpty()) throw fail('CAPTURE_FAILED', '無法擷取這個螢幕，請確認螢幕仍連接後重試')
  let image = source.thumbnail.crop(cropRect(region, display.bounds, source.thumbnail.getSize()))
  const size = image.getSize()
  if (Math.max(size.width, size.height) > 2048) image = image.resize({ [size.width >= size.height ? 'width' : 'height']: 2048 })
  return image
}

/** 小幅游標閃爍不重跑模型；取景框改變時由 caller 清掉前一張。 */
function changed(previous, current) {
  if (!previous || previous.length !== current.length) return true
  let difference = 0
  for (let i = 0; i < current.length; i += 4) {
    difference += Math.abs(previous[i] - current[i]) + Math.abs(previous[i + 1] - current[i + 1]) + Math.abs(previous[i + 2] - current[i + 2])
  }
  return difference / (current.length / 4 * 3 * 255) > 0.003
}

module.exports = { fail, cropRect, capture, changed }
