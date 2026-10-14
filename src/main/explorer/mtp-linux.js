'use strict'

/**
 * Linux MTP／手機：優先列 gvfs 掛載（/run/user/UID/gvfs）。
 * 有掛載 → 當一般路徑給檔案頁；沒有 → 回空並附說明（UI 藏入口＋文案）。
 * 不做 Windows COM／mtp: 虛擬路徑協定。
 */

const fs = require('fs')
const fsp = require('../raw-fs').promises
const path = require('path')
const os = require('os')

const HINT_NONE =
  'Linux 手機／MTP：請先用系統檔案管理員以 MTP 掛載（gvfs）。未掛載時此處不顯示裝置；完整 Windows MTP（mtp: 虛擬路徑）尚未移植。'
const HINT_GVFS =
  '已偵測 gvfs MTP／相機掛載；點進去以一般資料夾瀏覽（非 Windows mtp: 協定）。'

function gvfsRoot(env = process.env) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid != null) return `/run/user/${uid}/gvfs`
  const runtime = env.XDG_RUNTIME_DIR || ''
  if (runtime) return path.join(runtime, 'gvfs')
  return ''
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function looksLikeMtpMount(name) {
  const lower = String(name || '').toLowerCase()
  return (
    lower.startsWith('mtp:') ||
    lower.startsWith('mtp:host=') ||
    lower.startsWith('gphoto2:') ||
    lower.includes('mtp:host')
  )
}

/**
 * @param {string} mountName
 * @returns {string}
 */
function displayName(mountName) {
  const raw = String(mountName || '')
  const host = /host=([^,/\]]+)/i.exec(raw)
  if (host) {
    try {
      return decodeURIComponent(host[1].replace(/\+/g, ' '))
    } catch {
      return host[1]
    }
  }
  return raw.replace(/^(mtp|gphoto2):/i, '') || '手機'
}

/**
 * @returns {Promise<{ devices: Array<{ name: string, path: string, type: string }>, mode: 'gvfs'|'none', note: string }>}
 */
async function probe(env = process.env) {
  const root = gvfsRoot(env)
  if (!root) {
    return { devices: [], mode: 'none', note: HINT_NONE }
  }
  let names = []
  try {
    names = await fsp.readdir(root)
  } catch {
    return { devices: [], mode: 'none', note: HINT_NONE }
  }
  const devices = []
  for (const name of names) {
    if (!looksLikeMtpMount(name)) continue
    const full = path.join(root, name)
    let st
    try {
      st = await fsp.stat(full)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    devices.push({
      name: displayName(name).slice(0, 128),
      path: full,
      type: 'MTP (gvfs)'
    })
  }
  if (!devices.length) {
    return { devices: [], mode: 'none', note: HINT_NONE }
  }
  return { devices, mode: 'gvfs', note: HINT_GVFS }
}

/** @returns {Promise<Array<{ name: string, path: string, type: string }>>} */
async function listDevices() {
  return (await probe()).devices
}

/** @returns {Promise<{ mode: string, note: string, supported: boolean }>} */
async function supportInfo() {
  const info = await probe()
  return {
    mode: info.mode,
    note: info.note,
    supported: info.mode === 'gvfs'
  }
}

module.exports = {
  HINT_NONE,
  HINT_GVFS,
  gvfsRoot,
  looksLikeMtpMount,
  displayName,
  probe,
  listDevices,
  supportInfo
}
