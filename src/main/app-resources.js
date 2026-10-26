'use strict'

/**
 * 這個 App 自己吃了多少 CPU／記憶體，按「部分」分組（額度條上的「資源」）。
 *
 * 兩個來源：
 * 1. Electron 自己的程序（主程序、GPU、各功能頁、內嵌網頁、網路服務…）：`app.getAppMetrics()`，
 *    再用 `webContents.getOSProcessId()` 對出每個 renderer 是哪一頁／哪個網站。
 * 2. 我們開的子程序（終端機宿主與裡面的 shell、本機模型、取樣器…）：系統監控取樣器的程序清單，
 *    從主程序與 `axondeck-*`（終端機宿主是 detached，App 重開後父程序已經不是我們）往下找子孫，
 *    依「掛在誰底下」分組，所以終端機裡跑的 claude／node 會算在終端機那一組。
 *
 * CPU 一律換成「佔整台機器的 %」（跟工作管理員一樣）；Electron 給的是單核 %，要除核心數。
 */

/** 直屬子程序的名字 → 給人看的名稱；沒列到的直接用程序名 */
const CHILD_LABELS = {
  'axondeck-term': '終端機',
  'axondeck-probe': '系統監控取樣器',
  'axondeck-media': '媒體播放器',
  'llama-server': '本機模型',
  python: 'Python 工作',
  ffmpeg: 'ffmpeg',
  powershell: 'PowerShell 工具',
  'nvidia-smi': 'GPU 讀數'
}
/** 沒有 webContents 對得上的 renderer：實測幾乎都是內建瀏覽器擴充功能的背景頁／service worker */
const BACKGROUND = '擴充功能與背景工作'
const UTILITY_LABELS = [
  [/network/i, '網路服務'],
  [/audio/i, '音訊服務'],
  [/storage/i, '儲存服務']
]

/**
 * @param {string} type `webContents.getType()`
 * @param {URL | null} url
 * @param {Map<string, string>} pageLabels
 */
function rendererLabel(type, url, pageLabels) {
  if (!url) return BACKGROUND
  if (url.protocol === 'chrome-extension:') return BACKGROUND
  if (type === 'webview' || /^https?:$/.test(url.protocol)) return `網頁 · ${url.hostname}`
  const page = url.searchParams.get('page')
  if (url.searchParams.get('host') === '1') return '主視窗外殼'
  if (page) return pageLabels.get(page) || page
  return '主視窗'
}

/** @param {string} raw */
function parseUrl(raw) {
  try {
    return raw ? new URL(raw) : null
  } catch {
    return null
  }
}

/**
 * @param {{
 *   metrics: Array<{ pid: number, type: string, serviceName?: string, cpu: { percentCPUUsage: number }, memory: { workingSetSize: number } }>,
 *   contents: Array<{ pid: number, type: string, url: string }>,
 *   processes: Array<{ pid: number, parentPid: number, name: string, cpu: number, memory: number, startedAt?: number }>,
 *   rootPid: number,
 *   cores: number,
 *   pageLabels?: Map<string, string>,
 *   appName?: string
 * }} input
 * @returns {{ total: { cpu: number, memory: number, count: number }, groups: Array<{ label: string, cpu: number, memory: number, count: number }> }}
 */
function summarize({ metrics, contents, processes, rootPid, cores, pageLabels = new Map(), appName = '' }) {
  /** @type {Map<string, { label: string, cpu: number, memory: number, count: number }>} */
  const groups = new Map()
  const add = (label, cpu, memory) => {
    const row = groups.get(label) || { label, cpu: 0, memory: 0, count: 0 }
    groups.set(label, { label, cpu: row.cpu + cpu, memory: row.memory + memory, count: row.count + 1 })
  }

  /** @type {Map<number, Set<string>>} 一個 renderer 可能同時裝好幾個 webContents */
  const labelsByPid = new Map()
  for (const wc of contents) {
    const set = labelsByPid.get(wc.pid) || new Set()
    set.add(rendererLabel(wc.type, parseUrl(wc.url), pageLabels))
    labelsByPid.set(wc.pid, set)
  }

  const coreCount = Math.max(1, cores || 1)
  const electronPids = new Set()
  for (const m of metrics) {
    electronPids.add(m.pid)
    const cpu = (m.cpu?.percentCPUUsage || 0) / coreCount
    const memory = (m.memory?.workingSetSize || 0) * 1024
    let label = BACKGROUND
    if (m.type === 'Browser') label = '主程序'
    else if (m.type === 'GPU') label = 'GPU 程序'
    else if (m.type === 'Utility') {
      label = UTILITY_LABELS.find(([re]) => re.test(m.serviceName || ''))?.[1] || '其他 Chromium 服務'
    } else if (labelsByPid.has(m.pid)) label = [...labelsByPid.get(m.pid)].join('＋')
    add(label, cpu, memory)
  }

  // 子孫：父 → 子的對照，從主程序與每個 axondeck-* 往下走
  /** @type {Map<number, typeof processes>} */
  const kids = new Map()
  for (const p of processes) {
    if (!kids.has(p.parentPid)) kids.set(p.parentPid, [])
    kids.get(p.parentPid).push(p)
  }
  const byPid = new Map(processes.map((p) => [p.pid, p]))
  // pid 會被重用：比父程序還早開的「子程序」其實是別人的（原本的父程序死了、pid 被我們拿走）
  const childrenOf = (pid) => (kids.get(pid) || []).filter((child) => {
    const parent = byPid.get(pid)
    return !parent?.startedAt || !child.startedAt || child.startedAt >= parent.startedAt
  })
  const seen = new Set(electronPids)
  const walk = (proc, label) => {
    if (seen.has(proc.pid)) return
    seen.add(proc.pid)
    add(label, proc.cpu || 0, proc.memory || 0)
    for (const child of childrenOf(proc.pid)) walk(child, label)
  }
  // 用自己的 exe 開的子程序（ELECTRON_RUN_AS_NODE 的終端機宿主、crashpad）不在 getAppMetrics 裡
  const labelOf = (name) => (name === appName ? '內建背景工作' : CHILD_LABELS[String(name).toLowerCase()] || name)
  const roots = [
    ...childrenOf(rootPid),
    ...[...electronPids].flatMap((pid) => (pid === rootPid ? [] : childrenOf(pid))),
    ...processes.filter((p) => /^axondeck-/i.test(p.name))
  ]
  for (const proc of roots) walk(proc, labelOf(proc.name))

  const list = [...groups.values()].sort((a, b) => b.memory - a.memory)
  const total = list.reduce((acc, g) => ({
    cpu: acc.cpu + g.cpu, memory: acc.memory + g.memory, count: acc.count + g.count
  }), { cpu: 0, memory: 0, count: 0 })
  return { total, groups: list }
}

/**
 * @param {{ app: import('electron').App, webContents: typeof import('electron').webContents, sysmon: { rawProcesses: () => { at: number, list: any[] } }, pageLabels?: Map<string, string> }} deps
 */
function collectAppResources({ app, webContents, sysmon, pageLabels }) {
  const contents = webContents.getAllWebContents()
    .filter((wc) => !wc.isDestroyed())
    .map((wc) => ({ pid: wc.getOSProcessId(), type: wc.getType(), url: wc.getURL() }))
  const raw = sysmon.rawProcesses()
  const result = summarize({
    metrics: app.getAppMetrics(),
    contents,
    processes: raw.list,
    rootPid: process.pid,
    cores: require('os').cpus().length,
    pageLabels,
    appName: require('path').basename(process.execPath, '.exe')
  })
  return { ...result, childrenAt: raw.at }
}

module.exports = { summarize, collectAppResources }
