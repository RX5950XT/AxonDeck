'use strict'

/**
 * IPC 靜態對齊檢查（取代各 test-*.js 裡「三份清單對得起來」的守衛，不啟動 Electron）。
 *
 *     node scripts/lint-ipc.js            # 專案根目錄
 *     node scripts/lint-ipc.js <根目錄>    # 指到別份 src（mutation 驗證用）
 *
 * 三條，任一條失敗就 exit 1：
 *   1. preload 送出的每個 channel（invoke／send），main 端在同一行有 handle／on 註冊。
 *   2. renderer 呼叫的 electronAPI.<ns>.<fn> 在 preload 的 exposeInMainWorld 物件裡都有定義。
 *   3. ipc.js 用到的 service.<X> 都在 main.js 傳給 registerXIpc({ service: {…} }) 的白名單裡。
 * 只做字面比對；動態拼出來的 channel 不在檢查範圍內。
 */

const fs = require('fs')
const path = require('path')
const espree = require('espree')

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const listFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]))
const sourcesIn = (rel, pattern) => listFiles(path.join(root, rel)).filter((f) => pattern.test(f))

const preload = read('src/preload/preload.js')
const failures = []

// 1. preload 的 channel 都有 main 端註冊
const channels = new Set([...preload.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*['"]([\w.-]+:[\w.-]+)['"]/g)].map((m) => m[1]))
const registerLines = sourcesIn('src/main', /\.m?js$/)
  .flatMap((f) => fs.readFileSync(f, 'utf8').split(/\r?\n/))
  .filter((line) => /\b(handle|on)\(/.test(line))
for (const channel of channels) {
  if (!registerLines.some((line) => line.includes(`'${channel}'`) || line.includes(`"${channel}"`))) {
    failures.push(`preload 送出 ${channel}，但 main 沒有 handle／on 註冊`)
  }
}

// 2. renderer 的 electronAPI.<ns>.<fn> 都在 preload 定義過
const keyName = (prop) => prop.key.name ?? prop.key.value
const ast = espree.parse(preload, { ecmaVersion: 2024, sourceType: 'script' })
const expose = ast.body.find((s) => s.type === 'ExpressionStatement' && s.expression.type === 'CallExpression' &&
  s.expression.callee.property?.name === 'exposeInMainWorld' && s.expression.arguments[0]?.value === 'electronAPI')
if (!expose) throw new Error('preload 找不到 exposeInMainWorld(\'electronAPI\', …)')
const exposed = new Map(expose.expression.arguments[1].properties
  .filter((ns) => ns.type === 'Property')
  .map((ns) => [keyName(ns), new Set(ns.value.type === 'ObjectExpression'
    ? ns.value.properties.filter((p) => p.type === 'Property').map(keyName)
    : [])]))
for (const file of sourcesIn('src/renderer', /\.js$/)) {
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(/electronAPI\.(\w+)\.(\w+)/g)) {
    const [, ns, fn] = m
    if (!exposed.get(ns)?.has(fn)) {
      const line = text.slice(0, m.index).split('\n').length
      failures.push(`${path.relative(root, file)}:${line} 呼叫 electronAPI.${ns}.${fn}，preload 沒有定義`)
    }
  }
}

// 3. ipc.js 用到的 service.X 都在 main.js 的 registerXIpc({ service: {…} }) 白名單裡（漏轉發＝handler 在但呼叫時 undefined）
const walk = (node, visit) => {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit))
    else if (value && typeof value.type === 'string') walk(value, visit)
  }
}
// main.js 頂層有 `if (!hasInstanceLock) return`（CJS 合法），要允許頂層 return
const mainAst = espree.parse(read('src/main/main.js'), { ecmaVersion: 2024, sourceType: 'script', ecmaFeatures: { globalReturn: true } })
const serviceKeysOf = (fnName) => {
  let keys = null
  walk(mainAst, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== fnName) return
    const svc = node.arguments[0]?.properties?.find((p) => p.type === 'Property' && keyName(p) === 'service')
    if (svc?.value.type === 'ObjectExpression') keys = new Set(svc.value.properties.filter((p) => p.type === 'Property').map(keyName))
  })
  return keys
}
for (const file of sourcesIn('src/main', /ipc\.js$/)) {
  const text = fs.readFileSync(file, 'utf8')
  const rel = path.relative(root, file)
  const fnName = text.match(/module\.exports = \{\s*(\w+)/)?.[1]
  if (!fnName) continue
  const keys = serviceKeysOf(fnName)
  if (!keys) {
    failures.push(`${rel} 匯出 ${fnName}，但 main.js 找不到 ${fnName}({ service: {…} }) 呼叫`)
    continue
  }
  for (const m of text.matchAll(/\bservice\.(\w+)/g)) {
    if (!keys.has(m[1])) {
      const line = text.slice(0, m.index).split('\n').length
      failures.push(`${rel}:${line} 用到 service.${m[1]}，main.js 的 ${fnName} 白名單沒有`)
    }
  }
}

console.log(`[lint-ipc] preload channel ${channels.size} 支、electronAPI 命名空間 ${exposed.size} 個`)
if (failures.length) {
  console.log(failures.map((f) => `  ✖ ${f}`).join('\n'))
  process.exitCode = 1
} else {
  console.log('[lint-ipc] 通過')
}
