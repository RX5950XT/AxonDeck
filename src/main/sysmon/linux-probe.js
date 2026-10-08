'use strict'

/**
 * Linux 系統監控 probe：讀 /proc、/sys（可選 nvidia-smi 靜態 GPU），
 * 輸出與 probe.ps1／axondeck-probe 相同的 #READY／tick／static／detail 協定，
 * 讓既有 sampler + metrics 路徑不用分叉。
 *
 * 風扇／超頻／PawnIO 不在這裡——那些仍走 sensors stub。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const { execFileSync } = require('child_process')

const CLK_TCK = (() => {
  try {
    const n = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
    return Number.isFinite(n) && n > 0 ? n : 100
  } catch {
    return 100
  }
})()

/** 把 Linux clock ticks 轉成 Windows 那套 100ns 累計單位，供 metrics.diffSamples 使用 */
const TICKS_TO_100NS = 1e7 / CLK_TCK

function esc(value) {
  return String(value ?? '').replace(/[|\r\n]/g, ' ')
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

function numFromMeminfo(text, key) {
  const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)
  return m ? Number(m[1]) * 1024 : 0
}

function bootTimeMs() {
  const up = Number((readText('/proc/uptime').split(/\s+/)[0]) || 0)
  return Date.now() - up * 1000
}

/**
 * @param {string} text /proc/<pid>/stat
 */
function parseProcStat(text) {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const pid = Number(text.slice(0, open).trim())
  const name = text.slice(open + 1, close)
  const rest = text.slice(close + 2).trim().split(/\s+/)
  // man proc: after comm — state ppid ... utime stime ... num_threads ... starttime
  return {
    pid,
    name,
    ppid: Number(rest[1]) || 0,
    utime: Number(rest[11]) || 0,
    stime: Number(rest[12]) || 0,
    threads: Number(rest[17]) || 0,
    starttime: Number(rest[19]) || 0
  }
}

function rssBytes(pid) {
  const status = readText(`/proc/${pid}/status`)
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)
  if (m) return Number(m[1]) * 1024
  const statm = readText(`/proc/${pid}/statm`).trim().split(/\s+/)
  const pages = Number(statm[1]) || 0
  return pages * 4096
}

function privateBytes(pid) {
  const status = readText(`/proc/${pid}/status`)
  const m = /^VmData:\s+(\d+)\s+kB/m.exec(status)
  return m ? Number(m[1]) * 1024 : 0
}

function ioBytes(pid) {
  const text = readText(`/proc/${pid}/io`)
  if (!text) return { read: 0, write: 0 }
  const r = /^read_bytes:\s+(\d+)/m.exec(text)
  const w = /^write_bytes:\s+(\d+)/m.exec(text)
  return { read: r ? Number(r[1]) : 0, write: w ? Number(w[1]) : 0 }
}

function exePathOf(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/exe`) } catch { return '' }
}

function collectTickRows() {
  const rows = []
  const nowMs = Date.now()
  const ts100 = Math.floor(nowMs * 10000)
  rows.push(`T|${nowMs}`)

  const mem = readText('/proc/meminfo')
  const available = numFromMeminfo(mem, 'MemAvailable') || numFromMeminfo(mem, 'MemFree')
  const cached = numFromMeminfo(mem, 'Cached') + numFromMeminfo(mem, 'Buffers')
  const total = numFromMeminfo(mem, 'MemTotal')
  const committed = Math.max(0, total - available)
  const commitLimit = total + numFromMeminfo(mem, 'SwapTotal')
  rows.push(`M|${available}|${cached}|${committed}|${commitLimit}|${cached}`)

  // 磁碟：sectors→bytes；名稱「序號 裝置」對齊 Windows「0 C:」讓 diskIndexOf／PDISK 對得上
  // idle 用「牆鐘 − io_ticks」累計（100ns），metrics 才能算出 busy%
  const diskText = readText('/proc/diskstats')
  let diskIdx = 0
  for (const line of diskText.split('\n')) {
    if (!line.trim()) continue
    const parts = line.trim().split(/\s+/)
    if (parts.length < 14) continue
    const name = parts[2]
    if (!/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|mmcblk\d+)$/.test(name)) continue
    const read = (Number(parts[5]) || 0) * 512
    const write = (Number(parts[9]) || 0) * 512
    const ioTicks = Number(parts[12]) || 0
    const busy100 = Math.floor(ioTicks * 10000)
    const idle100 = Math.max(0, ts100 - busy100)
    rows.push(`D|${diskIdx} ${esc(name)}|${read}|${write}|${idle100}|${ts100}`)
    diskIdx += 1
  }

  const netText = readText('/proc/net/dev')
  for (const line of netText.split('\n').slice(2)) {
    if (!line.includes(':')) continue
    const [ifaceRaw, rest] = line.split(':')
    const iface = ifaceRaw.trim()
    if (!iface || iface === 'lo') continue
    // 虛擬橋／容器介面常無 linkSpeed，仍回報吞吐；表頭占用%另有降級
    const cols = rest.trim().split(/\s+/)
    const rx = Number(cols[0]) || 0
    const tx = Number(cols[8]) || 0
    let linkSpeed = 0
    const speed = readText(`/sys/class/net/${iface}/speed`).trim()
    if (speed && speed !== '-1' && Number.isFinite(Number(speed))) {
      linkSpeed = Number(speed) * 1_000_000
    }
    rows.push(`N|${esc(iface)}|${rx}|${tx}|${linkSpeed}`)
  }

  const boot = bootTimeMs()
  let dirs = []
  try { dirs = fs.readdirSync('/proc') } catch { dirs = [] }
  for (const ent of dirs) {
    if (!/^\d+$/.test(ent)) continue
    const pid = Number(ent)
    if (pid <= 0) continue
    const statText = readText(`/proc/${pid}/stat`)
    if (!statText) continue
    const st = parseProcStat(statText)
    if (!st) continue
    // 核心執行緒（名稱 [kworker/…]）略過，減少噪音
    if (st.name.startsWith('[') && st.name.endsWith(']')) continue
    const cpuTime = Math.floor((st.utime + st.stime) * TICKS_TO_100NS)
    const io = ioBytes(pid)
    const startedAt = Math.floor(boot + (st.starttime / CLK_TCK) * 1000)
    const exe = esc(exePathOf(pid))
    rows.push(
      `P|${pid}|${esc(st.name)}|${cpuTime}|${ts100}|${rssBytes(pid)}|${privateBytes(pid)}|${st.threads}|${io.read}|${io.write}|0|${st.ppid}|${exe}|${startedAt}`
    )
  }
  return rows
}

function osRelease() {
  const text = readText('/etc/os-release')
  /** @type {Record<string, string>} */
  const map = {}
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line)
    if (!m) continue
    map[m[1]] = m[2].replace(/^"(.*)"$/, '$1')
  }
  return map
}

function cpuStaticRows() {
  const info = readText('/proc/cpuinfo')
  const models = [...info.matchAll(/^model name\s*:\s*(.+)$/gm)].map((m) => m[1].trim())
  const name = models[0] || os.cpus()[0]?.model || 'CPU'
  const threads = os.cpus().length || 1
  let cores = 0
  const coreIds = new Set()
  for (const m of info.matchAll(/^core id\s*:\s*(\d+)/gm)) coreIds.add(m[1])
  cores = coreIds.size || Math.max(1, Math.floor(threads / 2))
  const mhz = Number((/^cpu MHz\s*:\s*([\d.]+)/m.exec(info) || [])[1]) || 0
  const vendor = (/^vendor_id\s*:\s*(.+)$/m.exec(info) || [])[1] || ''
  return [`CPU|${esc(name)}|${cores}|${threads}|${Math.round(mhz)}|0|0||${esc(vendor)}`]
}


/**
 * @returns {{ rows: string[], index: Map<string, number> }}
 */
function physicalDiskRows() {
  const rows = []
  /** @type {Map<string, number>} */
  const index = new Map()
  const diskText = readText('/proc/diskstats')
  let idx = 0
  for (const line of diskText.split('\n')) {
    if (!line.trim()) continue
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const name = parts[2]
    if (!/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|mmcblk\d+)$/.test(name)) continue
    let size = 0
    const sizeStr = readText(`/sys/block/${name}/size`).trim()
    if (sizeStr) size = (Number(sizeStr) || 0) * 512
    const model = (readText(`/sys/block/${name}/device/model`) || name).trim() || name
    // HDD／SSD：/sys/block/X/queue/rotational（0＝SSD／NVMe，1＝旋轉碟；virtio 常回 1）
    const rota = readText(`/sys/block/${name}/queue/rotational`).trim()
    let media = rota === '0' ? 'SSD' : (rota === '1' ? 'HDD' : '')
    // virtio_blk／xen-blkfront 的 rotational 是核心預設值（多半是 1），不代表真的是旋轉碟
    if (/^(vd|xvd)/.test(name)) media = '虛擬磁碟'
    let bus = ''
    if (/^nvme/.test(name)) bus = 'NVMe'
    else if (/^vd|^xvd/.test(name)) bus = 'VirtIO'
    else if (/^mmcblk/.test(name)) bus = 'MMC'
    else {
      try {
        const real = fs.realpathSync(`/sys/block/${name}`)
        if (/\/usb/.test(real)) bus = 'USB'
        else if (/\/ata/.test(real) || /\/scsi/.test(real)) bus = 'SATA'
      } catch { /* */ }
    }
    let serial = readText(`/sys/block/${name}/device/serial`).trim()
    if (!serial) serial = readText(`/sys/block/${name}/serial`).trim()
    // 分割區數
    let partitions = 0
    try {
      partitions = fs.readdirSync(`/sys/block/${name}`).filter((n) => n.startsWith(name) && n !== name).length
    } catch { /* */ }
    // PDISK|id|name|media|bus|size|health|serial|firmware|spindle|…|partitions|…
    rows.push(`PDISK|${idx}|${esc(model || name)}|${esc(media)}|${esc(bus)}|${size}|Healthy|${esc(serial)}||||${partitions}|${esc(bus)}|`)
    index.set(name, idx)
    idx += 1
  }
  return { rows, index }
}

/**
 * 把 /dev/sda1、/dev/nvme0n1p2、/dev/mapper/… 對回實體碟名稱（sda、nvme0n1）。
 * @param {string} device
 * @param {Map<string, number>} diskIndex 實體碟名稱 → PDISK id
 */
function resolveDiskId(device, diskIndex) {
  let name = String(device || '').replace(/^\/dev\//, '')
  if (!name || name.includes('/')) return ''
  // 已是實體碟
  if (diskIndex.has(name)) return String(diskIndex.get(name))
  // /sys/class/block/<part>/ → 往上找實體碟（partition 檔存在＝是分割區）
  try {
    let cur = name
    for (let i = 0; i < 4; i++) {
      if (diskIndex.has(cur)) return String(diskIndex.get(cur))
      // 符號連結目標的父目錄名稱就是實體碟（…/block/sda/sda1）
      try {
        const real = fs.realpathSync(`/sys/class/block/${cur}`)
        const parent = path.basename(path.dirname(real))
        if (diskIndex.has(parent)) return String(diskIndex.get(parent))
      } catch { /* sysfs 沒有這個名稱（例如測試或已拔除）→ 走下面的名稱規則 */ }
      // 退路：剝掉尾端數字／pN（sda1→sda、nvme0n1p2→nvme0n1、mmcblk0p1→mmcblk0）
      const next = cur.replace(/p?\d+$/, '')
      if (!next || next === cur) break
      cur = next
    }
  } catch { /* */ }
  return ''
}

/**
 * 容器的 overlay 根目錄看不到底層裝置。overlayfs 的 statfs 回報的是 upper 層所在的檔案系統，
 * upper 一定可寫，所以：核心有掛（/sys/fs/ext4|xfs 列得到）、而且有寫入量的實體碟只有一顆時，就推定是它。
 * 推不出來（零顆或多顆）就回 ''，不亂猜。
 * @param {Map<string, number>} diskIndex
 * @param {string} [root]
 * @returns {string} 實體碟名稱
 */
function guessOverlayBacking(diskIndex, root = '') {
  const mounted = new Set()
  for (const fsType of ['ext4', 'xfs', 'f2fs']) {
    try { fs.readdirSync(`${root}/sys/fs/${fsType}`).forEach((n) => mounted.add(n)) } catch { /* */ }
  }
  const writes = new Map()
  for (const line of readText(`${root}/proc/diskstats`).split('\n')) {
    const p = line.trim().split(/\s+/)
    if (p.length >= 10) writes.set(p[2], Number(p[9]) || 0)
  }
  const candidates = [...diskIndex.keys()].filter((name) => {
    // 分割區也算（vda1 掛著 → vda）
    const hasFs = [...mounted].some((m) => m === name || (m.startsWith(name) && /^p?\d+$/.test(m.slice(name.length))))
    return hasFs && (writes.get(name) || 0) > 0
  })
  return candidates.length === 1 ? candidates[0] : ''
}

/**
 * @param {Map<string, number>} [diskIndex]
 */
function volumeRows(diskIndex) {
  const index = diskIndex || new Map()
  const rows = []
  const mounts = readText('/proc/mounts').split('\n')
  const seen = new Set()
  // 虛擬／容器檔案系統：只有根目錄保留（容量仍要顯示），其他略過
  const virtFs = new Set(['proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2', 'overlay', 'squashfs', 'fuse', 'fuseblk', 'fusectl', 'tracefs', 'debugfs', 'securityfs', 'configfs', 'bpf', 'nsfs', 'ramfs', 'hugetlbfs', 'mqueue', 'efivarfs', 'binfmt_misc', 'autofs'])
  for (const line of mounts) {
    const p = line.split(/\s+/)
    if (p.length < 3) continue
    const device = p[0]
    const mountPoint = p[1]
    const fstype = p[2]
    if (!mountPoint.startsWith('/')) continue
    if (virtFs.has(fstype) || fstype.startsWith('fuse.')) {
      if (!(mountPoint === '/' && (fstype === 'overlay' || fstype === 'rootfs'))) continue
    }
    if (seen.has(mountPoint)) continue
    seen.add(mountPoint)
    try {
      const st = fs.statfsSync(mountPoint)
      const size = Number(st.blocks) * Number(st.bsize)
      const free = Number(st.bavail) * Number(st.bsize)
      if (!(size > 0)) continue
      let diskId = resolveDiskId(device, index)
      let label = ''
      if (!diskId && mountPoint === '/' && fstype === 'overlay') {
        const guess = guessOverlayBacking(index)
        if (guess) { diskId = String(index.get(guess)); label = `（推定位於 ${guess}）` }
      }
      rows.push(`VOL|${esc(mountPoint)}|${esc(label)}|${size}|${free}|${esc(fstype)}|${esc(diskId)}`)
    } catch { /* 無權限或虛擬掛載 */ }
  }
  return rows
}

/** 十六進位小端 → dotted IPv4（/proc/net/route 的 Destination／Gateway） */
function hexIpv4(hex) {
  const n = Number.parseInt(String(hex || ''), 16)
  if (!Number.isFinite(n)) return ''
  return [(n) & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.')
}

/** 預設閘道：/proc/net/route 的 Destination=00000000（IPv4） */
function defaultGateways() {
  /** @type {Map<string, string>} */
  const map = new Map()
  for (const line of readText('/proc/net/route').split('\n').slice(1)) {
    const p = line.trim().split(/\s+/)
    if (p.length < 8 || p[1] !== '00000000') continue
    const gw = hexIpv4(p[2])
    if (gw && gw !== '0.0.0.0') map.set(p[0], gw)
  }
  return map
}

/** DNS：優先 resolvectl，否則 /etc/resolv.conf 的 nameserver */
function dnsServers() {
  try {
    const out = execFileSync('resolvectl', ['dns'], { encoding: 'utf8', timeout: 2000 })
    const all = new Set()
    /** @type {Map<string, string>} */
    const byIface = new Map()
    for (const line of String(out).split('\n')) {
      // Link 2 (enp0s4): 10.0.0.2 8.8.8.8
      const m = /\(([^)]+)\):\s*(.+)$/.exec(line)
      if (!m) continue
      const list = m[2].trim().split(/\s+/).filter((x) => x && x !== ':')
      if (list.length) {
        byIface.set(m[1], list.join(', '))
        list.forEach((x) => all.add(x))
      }
    }
    return { byIface, all: [...all].join(', ') }
  } catch { /* 沒有 systemd-resolved */ }
  const all = []
  for (const line of readText('/etc/resolv.conf').split('\n')) {
    const m = /^nameserver\s+(\S+)/.exec(line)
    if (m) all.push(m[1])
  }
  return { byIface: new Map(), all: all.join(', ') }
}

/**
 * DHCP 狀態：nmcli → systemd-networkd 租約 → dhclient 租約。
 * @returns {{ byIface: Map<string, { mode: string, server: string }>, available: boolean }}
 */
function dhcpStatus() {
  /** @type {Map<string, { mode: string, server: string }>} */
  const byIface = new Map()
  try {
    const out = execFileSync('nmcli', ['-t', '-f', 'GENERAL.DEVICE,GENERAL.CONNECTION,IP4.GATEWAY,DHCP4.OPTION', 'd', 'show'], {
      encoding: 'utf8', timeout: 3000
    })
    let cur = ''
    for (const line of String(out).split('\n')) {
      const m = /^GENERAL\.DEVICE:(.+)$/.exec(line)
      if (m) { cur = m[1]; continue }
      if (!cur) continue
      if (/^DHCP4\.OPTION:/.test(line) || /dhcp_server_identifier/.test(line)) {
        const server = /dhcp_server_identifier\s*=\s*(\S+)/.exec(line)?.[1] || ''
        byIface.set(cur, { mode: 'dhcp', server })
      }
    }
    if (byIface.size) return { byIface, available: true }
  } catch { /* NetworkManager 沒裝或不在 PATH */ }
  // systemd-networkd：/run/systemd/netif/leases/<ifindex>
  try {
    const dir = '/run/systemd/netif/leases'
    for (const name of fs.readdirSync(dir)) {
      const text = readText(`${dir}/${name}`)
      const iface = (/^IFACE=(.+)$/m.exec(text) || [])[1] || ''
      const server = (/^SERVER_ADDRESS=(.+)$/m.exec(text) || [])[1] || ''
      if (iface) byIface.set(iface, { mode: 'dhcp', server })
    }
    if (byIface.size) return { byIface, available: true }
  } catch { /* 沒有 networkd 租約 */ }
  for (const dir of ['/var/lib/dhcp', '/var/lib/dhclient']) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!/lease/i.test(name)) continue
        const text = readText(`${dir}/${name}`)
        const iface = (/interface\s+"([^"]+)"/.exec(text) || [])[1]
        const server = (/option\s+dhcp-server-identifier\s+([0-9.]+)/.exec(text) || [])[1] || ''
        if (iface) byIface.set(iface, { mode: 'dhcp', server })
      }
    } catch { /* */ }
  }
  return { byIface, available: byIface.size > 0 }
}

function nicStaticRows() {
  const rows = []
  let ifaces = []
  try { ifaces = fs.readdirSync('/sys/class/net') } catch { ifaces = [] }
  const addrs = os.networkInterfaces()
  const gateways = defaultGateways()
  const dns = dnsServers()
  const dhcp = dhcpStatus()
  for (const name of ifaces) {
    if (name === 'lo') continue
    const oper = readText(`/sys/class/net/${name}/operstate`).trim()
    const mac = readText(`/sys/class/net/${name}/address`).trim()
    const speedTxt = readText(`/sys/class/net/${name}/speed`).trim()
    const speed = speedTxt && speedTxt !== '-1' ? (Number(speedTxt) || 0) * 1_000_000 : 0
    const status = oper === 'up' ? 2 : 0
    const list = addrs[name] || []
    const v4 = list.filter((a) => a.family === 'IPv4' || a.family === 4)
    const all6 = list.filter((a) => (a.family === 'IPv6' || a.family === 6) && !a.internal)
    const global6 = all6.filter((a) => !a.address.toLowerCase().startsWith('fe80'))
    // 沒有全域 IPv6 就退回連結本機位址（標示清楚），跟 Windows 網路卡內容一樣不留白
    const v6 = global6.length ? global6 : all6.map((a) => ({ ...a, address: `${a.address.replace(/%.*$/, '')}（連結本機）` }))
    const ips = v4.map((a) => a.address).join(', ')
    const subnet = v4.map((a) => a.netmask).filter(Boolean).join(', ')
    const ipv6 = v6.map((a) => a.address).join(', ')
    const gateway = gateways.get(name) || ''
    const dnsList = dns.byIface.get(name) || (gateway || ips ? dns.all : '')
    const d = dhcp.byIface.get(name)
    // dhcp 欄：dhcp／static／空（查不到就空，讓 UI 顯示 —）
    let dhcpMode = ''
    if (d) dhcpMode = d.mode
    else if (ips && dhcp.available) dhcpMode = 'static'
    const dhcpServer = d?.server || ''
    // parseStatic：connection|name|mac|speed|status|ips|gateway|dns|dhcp|subnet|dhcpServer|ipv6|adapterType|pnpId
    rows.push(`NIC|${esc(name)}|${esc(name)}|${esc(mac)}|${speed}|${status}|${esc(ips)}|${esc(gateway)}|${esc(dnsList)}|${esc(dhcpMode)}|${esc(subnet)}|${esc(dhcpServer)}|${esc(ipv6)}||`)
  }
  return rows
}

/** PCI vendor id → 顯示名稱（沒有 lspci／pci.ids 時的退路） */
const PCI_VENDORS = Object.freeze({
  '10de': 'NVIDIA', '1002': 'AMD', '1022': 'AMD', '8086': 'Intel', '1af4': 'Red Hat Virtio', '1b36': 'Red Hat QXL',
  '1234': 'QEMU（Bochs）', '15ad': 'VMware', '80ee': 'VirtualBox', '1414': 'Microsoft Hyper-V', '1a03': 'ASPEED', '102b': 'Matrox', '5143': 'Qualcomm'
})

function nvidiaStaticRows(execFn = execFileSync) {
  try {
    const out = execFn('nvidia-smi', [
      '--query-gpu=name,memory.total,driver_version,pci.bus_id',
      '--format=csv,noheader,nounits'
    ], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    const rows = []
    for (const line of String(out).split('\n')) {
      if (!line.trim()) continue
      const [name, memMiB, driver, busId] = line.split(',').map((s) => s.trim())
      const vram = (Number(memMiB) || 0) * 1024 * 1024
      // GPU|name|adapterRam|driver|mode|driverDate|w|h|Hz|processor|pnpId|vram|source
      rows.push(`GPU|${esc(name)}|${vram}|${esc(driver)}||||||NVIDIA|${esc(String(busId || '').toLowerCase())}|${vram}|nvidia-smi`)
    }
    return rows
  } catch {
    return []
  }
}

/** `lspci -mm -nn -s <slot>`：`00:02.0 "VGA compatible controller [0300]" "Intel Corporation [8086]" "Alder Lake-P GT2 [46a6]" ...` */
function parseLspciName(text) {
  const fields = [...String(text || '').matchAll(/"([^"]*)"/g)].map((m) => m[1].replace(/\s*\[[0-9a-f]{4}\]$/i, '').trim())
  if (fields.length < 3) return ''
  return [fields[1], fields[2]].filter(Boolean).join(' ')
}

/**
 * PCI 顯示控制器（class 0x03xxxx）＋ /sys/class/drm 的 card*；有 lspci 就拿它的型號名稱。
 * NVIDIA 卡已經由 nvidia-smi 列過就不重複。
 * @param {{ root?: string, execFn?: typeof execFileSync, skipNvidia?: boolean }} [opts]
 */
function drmGpuRows(opts = {}) {
  const root = opts.root || ''
  const execFn = opts.execFn || execFileSync
  const pciDir = `${root}/sys/bus/pci/devices`
  const drmDir = `${root}/sys/class/drm`
  /** PCI 位址 → drm card 名稱 */
  const cards = new Map()
  let drmEntries = []
  try { drmEntries = fs.readdirSync(drmDir) } catch { drmEntries = [] }
  for (const name of drmEntries) {
    if (!/^card\d+$/.test(name)) continue
    try {
      const target = fs.realpathSync(`${drmDir}/${name}/device`)
      cards.set(path.basename(target), name)
    } catch { /* 不是 PCI 卡（例如 simpledrm） */ }
  }
  let slots = []
  try { slots = fs.readdirSync(pciDir) } catch { slots = [] }
  let hasLspci = true
  const rows = []
  for (const slot of slots.sort()) {
    const dev = `${pciDir}/${slot}`
    const cls = readText(`${dev}/class`).trim().toLowerCase()
    if (!/^0x03/.test(cls)) continue
    const vendor = readText(`${dev}/vendor`).trim().toLowerCase().replace(/^0x/, '')
    const device = readText(`${dev}/device`).trim().toLowerCase().replace(/^0x/, '')
    if (opts.skipNvidia && vendor === '10de') continue
    let driver = ''
    try { driver = path.basename(fs.readlinkSync(`${dev}/driver`)) } catch { driver = '' }
    let name = ''
    if (hasLspci) {
      try {
        name = parseLspciName(execFn('lspci', ['-mm', '-nn', '-s', slot], { encoding: 'utf8', timeout: 3000 }))
      } catch (err) {
        if (err && err.code === 'ENOENT') hasLspci = false
      }
    }
    const vendorName = PCI_VENDORS[vendor] || (vendor ? `PCI ${vendor}` : '')
    if (!name) name = `${vendorName} 顯示控制器（${vendor}:${device}）`
    const card = cards.get(slot) || ''
    // amdgpu 會給 VRAM 總量；其他驅動沒有就留 0
    const vram = Number(readText(`${dev}/mem_info_vram_total`).trim()) || 0
    const source = [card ? 'sysfs（/sys/class/drm）' : 'sysfs（PCI）', name && hasLspci && !/顯示控制器（/.test(name) ? 'lspci' : ''].filter(Boolean).join('＋')
    rows.push(`GPU|${esc(name)}|${vram}|${esc(driver)}|${esc(card)}|||||${esc(vendorName)}|${esc(`${vendor}:${device} @ ${slot}`)}|${vram}|${esc(source)}`)
  }
  return rows
}

function gpuRows(opts = {}) {
  const nv = nvidiaStaticRows(opts.execFn)
  return [...nv, ...drmGpuRows({ ...opts, skipNvidia: nv.length > 0 })]
}

/**
 * /sys/class/dmi/id：板子／BIOS／系統廠商。有些檔要 root 才能讀 → 讀不到就空字串，不丟錯。
 * 容器／無 DMI 的環境整個目錄不存在 → board／bios 仍為 null，但靜態清單已結束（UI 不再「偵測中」）。
 * @param {string} [root]
 */
function dmiText(name, root = '') {
  const file = `${root}/sys/class/dmi/id/${name}`
  const text = readText(file).trim()
  if (text) return text
  // 序號類（board_serial、product_serial…）預設 0400 root：檔案在但讀不到就明講，不是「沒有」
  try { fs.accessSync(file, fs.constants.F_OK) } catch { return '' }
  try { fs.accessSync(file, fs.constants.R_OK); return '' } catch { return '需要 root 權限' }
}

/**
 * @param {string} [root]
 * @returns {string[]} BOARD／BIOS／SYS 列
 */
function dmiRows(root = '') {
  const boardVendor = dmiText('board_vendor', root)
  const boardName = dmiText('board_name', root)
  const boardVersion = dmiText('board_version', root)
  const boardSerial = dmiText('board_serial', root)
  const biosVendor = dmiText('bios_vendor', root)
  const biosVersion = dmiText('bios_version', root)
  const biosDate = dmiText('bios_date', root)
  const product = dmiText('product_name', root)
  const sysVendor = dmiText('sys_vendor', root)
  const productFamily = dmiText('product_family', root)
  const productSerial = dmiText('product_serial', root)
  const chassisVendor = dmiText('chassis_vendor', root)
  const chassisType = dmiText('chassis_type', root)
  const chassisSerial = dmiText('chassis_serial', root)
  const rows = []
  if (boardVendor || boardName || boardVersion || boardSerial) {
    rows.push(`BOARD|${esc(boardVendor)}|${esc(boardName)}|${esc(boardVersion)}|${esc(boardSerial)}`)
  }
  if (biosVendor || biosVersion || biosDate) {
    rows.push(`BIOS|${esc(biosVendor)}|${esc(biosVersion)}|${esc(biosDate)}||||`)
  }
  // SYS 列在 collectStaticRows 組，這裡只回傳產品資訊給它用
  return {
    rows,
    sysVendor,
    product,
    productFamily,
    productSerial,
    chassisVendor,
    chassisType,
    chassisSerial,
    hasDmi: Boolean(boardVendor || boardName || biosVendor || biosVersion || sysVendor || product)
  }
}

function collectStaticRows() {
  // PLAT：讓 renderer 分得出 Linux（Windows probe 不送這列 → inv.platform 是 undefined，行為不變）
  const rows = ['PLAT|linux']
  const rel = osRelease()
  const hostname = os.hostname()
  const totalMemory = os.totalmem()
  const dmi = dmiRows()
  // 有 DMI 就填廠商／型號；沒有（容器）也要送 SYS，讓 renderer 結束「偵測中」
  let user = ''
  try { user = os.userInfo().username } catch { user = process.env.USER || '' }
  // 虛擬機：/proc/cpuinfo 的 hypervisor 旗標（KVM／VMware／Hyper-V 客體都會設）
  const hypervisor = /^flags\s*:.*\bhypervisor\b/m.test(readText('/proc/cpuinfo'))
  rows.push(`SYS|${esc(dmi.sysVendor)}|${esc(dmi.product)}|${esc(os.arch())}|${totalMemory}|${esc(hostname)}|${esc(dmi.productFamily)}||False|${esc(user)}|${hypervisor ? 'True' : 'False'}|||`)
  if (dmi.chassisType || dmi.chassisVendor || dmi.chassisSerial) {
    rows.push(`CASE|${esc(dmi.chassisVendor)}|${esc(dmi.chassisType)}|${esc(dmi.chassisSerial)}`)
  }
  rows.push(...dmi.rows)
  rows.push(...cpuStaticRows())
  // OS 列沿用 Windows 欄位位置：build＝核心版本（uname -r）、displayVersion＝核心組建字串、
  // systemDrive＝根目錄檔案系統、edition＝版本代號（VERSION_CODENAME）
  const rootFs = (readText('/proc/mounts').split('\n').map((l) => l.split(/\s+/)).find((p) => p[1] === '/') || [])[2] || ''
  const lang = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
  rows.push(
    `OS|${esc(rel.PRETTY_NAME || rel.NAME || 'Linux')}|${esc(rel.VERSION_ID || '')}|${esc(os.release())}|${Math.floor(bootTimeMs())}|${esc(os.arch())}|${esc(typeof os.version === 'function' ? os.version() : '')}|0|${esc(lang)}|${esc(rootFs ? `/（${rootFs}）` : '/')}|||${esc(rel.VERSION_CODENAME || '')}|`
  )
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    if (tz) rows.push(`TZ|${esc(tz)}|${esc(tz)}|${-new Date().getTimezoneOffset()}`)
  } catch { /* 沒有 Intl 時區 */ }
  const disks = physicalDiskRows()
  rows.push(...disks.rows)
  rows.push(...volumeRows(disks.index))
  rows.push(...nicStaticRows())
  rows.push(...gpuRows())
  return rows
}

function collectDetailRows(pid) {
  if (!(pid > 0)) return []
  const statText = readText(`/proc/${pid}/stat`)
  const st = parseProcStat(statText)
  if (!st) return []
  const exe = exePathOf(pid)
  const startedAt = Math.floor(bootTimeMs() + (st.starttime / CLK_TCK) * 1000)
  const rows = [
    `X|${pid}|${esc(st.name)}|${esc(exe)}||${startedAt}|${st.ppid}`
  ]
  return rows
}

function frame(kind, seq, rows) {
  const body = rows.length ? `${rows.join('\n')}\n` : ''
  return `#B ${kind} ${seq}\n${body}#E ${kind} ${seq}\n`
}

/**
 * 處理一行 stdin 指令，回傳要寫到 stdout 的字串（可能多行）。
 * @param {string} line
 * @returns {string}
 */
function handleCommand(line) {
  const trimmed = String(line || '').trim()
  if (!trimmed) return ''
  const parts = trimmed.split(/\s+/)
  const cmd = parts[0]
  const seq = parts[1] || '0'
  const arg = parts[2] || ''
  try {
    if (cmd === 'tick') return frame('tick', seq, collectTickRows())
    if (cmd === 'static') return frame('static', seq, collectStaticRows())
    if (cmd === 'detail') return frame('detail', seq, collectDetailRows(Number(arg) || 0))
    if (cmd === 'bye') return ''
    return frame(cmd, seq, [])
  } catch (err) {
    const msg = esc(err && err.message ? err.message : 'error')
    return `#B ${cmd} ${seq}\n#ERR|${msg}\n#E ${cmd} ${seq}\n`
  }
}

/**
 * 給 sampler 用的假 child_process：stdin／stdout 管線 + EventEmitter。
 * @returns {import('child_process').ChildProcess}
 */
function createLinuxProbeChild() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const proc = new EventEmitter()
  let alive = true
  let buf = ''

  Object.assign(proc, {
    stdin,
    stdout,
    stderr,
    pid: process.pid,
    kill() {
      if (!alive) return
      alive = false
      try { stdin.end() } catch { /* */ }
      try { stdout.end() } catch { /* */ }
      queueMicrotask(() => proc.emit('close', 0))
    }
  })

  stdin.setEncoding('utf8')
  stdin.on('data', (chunk) => {
    if (!alive) return
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      const out = handleCommand(line)
      if (out && alive) stdout.write(out)
      if (line.trim().startsWith('bye')) {
        proc.kill()
        return
      }
    }
  })
  stdin.on('end', () => { if (alive) proc.kill() })

  queueMicrotask(() => {
    if (alive) stdout.write('#READY\n')
  })

  return /** @type {any} */ (proc)
}

module.exports = {
  CLK_TCK,
  esc,
  parseProcStat,
  collectTickRows,
  collectStaticRows,
  collectDetailRows,
  drmGpuRows,
  parseLspciName,
  dmiRows,
  resolveDiskId,
  guessOverlayBacking,
  defaultGateways,
  dnsServers,
  hexIpv4,
  handleCommand,
  createLinuxProbeChild,
  frame
}
