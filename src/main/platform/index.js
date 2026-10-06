'use strict'

/**
 * 平台分流入口。短線不拆 monorepo：Explorer／監控／熱鍵等透過這裡選 windows／linux 實作。
 * 不刪 Windows 行為；Linux 缺能力時由各模組 stub／降級。
 */

const windows = require('./windows')
const linux = require('./linux')

const name = process.platform
const isWindows = name === 'win32'
const isLinux = name === 'linux'
const isDarwin = name === 'darwin'

/** @type {typeof windows | typeof linux} */
const current = isWindows ? windows : isLinux ? linux : linux

module.exports = {
  name,
  isWindows,
  isLinux,
  isDarwin,
  current,
  windows,
  linux,
  /** 本機預設「根」路徑（bootstrap 退路） */
  fallbackRoot: () => current.fallbackRoot(),
  /** 是否為本平台可接受的絕對路徑字串（不碰磁碟） */
  looksAbsolute: (raw) => current.looksAbsolute(raw)
}
