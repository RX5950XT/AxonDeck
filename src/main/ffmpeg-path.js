'use strict'

/**
 * ffmpeg-static 的可執行路徑（檔案轉錄、檔案頁的影音詳細資訊共用）。
 */

const fs = require('fs')
const path = require('path')

/**
 * 解析 asar 內 ffmpeg-static 路徑
 * @returns {string}
 */
function resolveFfmpegPath() {
  let bin = require('ffmpeg-static')
  if (typeof bin !== 'string' || !bin) {
    throw new Error('ffmpeg-static 未正確安裝')
  }
  // 打包後 ffmpeg 留在 asar（不進 asar.unpacked，少 80MB 給 Defender 掃）。
  // spawn 不能執行 asar 內檔案，第一次轉錄拷到 userData。
  if (/app\.asar(?!\.unpacked)/.test(bin)) {
    const { app } = require('electron')
    const dest = path.join(app.getPath('userData'), 'native', 'ffmpeg.exe')
    if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      // 不用 copyFileSync：從 asar 複製會先在 %TEMP% 解壓一份 80MB 的中繼檔，程序被強制結束就留著
      fs.writeFileSync(dest, fs.readFileSync(bin))
    }
    return dest
  }
  bin = bin.replace(/app\.asar(?!\.unpacked)/g, 'app.asar.unpacked')
  if (!fs.existsSync(bin)) {
    throw new Error(`找不到 ffmpeg 執行檔: ${bin}`)
  }
  return bin
}

module.exports = { resolveFfmpegPath }
