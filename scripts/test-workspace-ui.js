'use strict'

/**
 * 工作區 renderer 純邏輯的行為測試（不啟動 Electron）：
 * AI 會話檔案路徑邊界、git status 共用快取、Ctrl+滾輪倍率、「在終端機執行」組出的指令。
 * 只放真的執行程式碼的斷言；DOM／CSS 長相改用打包版 CDP 或真畫面驗。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { tempDir, removeTree } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const agents = require(path.join(ROOT, 'src/main/workspace/agents.js'))

let passed = 0
let failed = 0

/** @param {string} name @param {boolean} condition */
function check(name, condition) {
  if (condition) {
    passed += 1
    console.log(`PASS ${name}`)
  } else {
    failed += 1
    console.log(`FAIL ${name}`)
  }
}

/** @param {string} rel @param {string} names */
function loadRenderer(rel, names, context = {}) {
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts', rel), 'utf8')
    .replace(/^import [\s\S]*?from '[^']*'$/gm, '')
    .replace(/^export /gm, '')
  vm.createContext(context)
  vm.runInContext(`${source}\nthis.api = { ${names} }`, context)
  return context.api
}

async function agentPathChecks() {
  console.log('\n[A] AI 會話檔案路徑')
  const home = tempDir('vi-agent-ui-')
  const project = path.join(home, 'project')
  const outside = path.join(home, 'outside.txt')
  const sessionId = 'ui-test-123'
  const sessionDir = path.join(home, '.claude', 'projects', agents.encodeClaudeDir(project))
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(outside, 'outside')
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Read', input: { path: path.join(project, 'src', 'inside.js') } },
      { type: 'tool_use', name: 'Write', input: { file_path: outside } },
      { type: 'tool_use', name: 'Edit', input: { path: 'src/relative.js' } }
    ] } })
  ].join('\n'))

  const originalHome = os.homedir
  os.homedir = () => home
  try {
    const detail = await agents.sessionDetail(project, 'claude', sessionId)
    const all = [...detail.editedFiles, ...detail.readFiles]
    check('專案內絕對路徑轉成相對路徑', all.includes('src/inside.js'))
    check('專案內相對路徑保留', all.includes('src/relative.js'))
    check('專案外路徑不回傳給 renderer', !all.some((file) => file.includes('outside.txt')))
    check('回傳路徑不含反斜線', all.every((file) => !file.includes('\\')))
    // 讀過的不可以被說成改過的（Read 進 readFiles、Edit 進 editedFiles）
    check('Read 只算讀過', detail.readFiles.includes('src/inside.js')
      && !detail.editedFiles.includes('src/inside.js'))
    check('Edit 算改過', detail.editedFiles.includes('src/relative.js'))
  } finally {
    os.homedir = originalHome
    removeTree(home)
  }
}

/**
 * 檔案樹與「未提交變更」鈕共用同一趟 `git status`（`ws-git-status.js`）。
 * `git status` 是這裡最貴的一支 git 指令，切一次分頁本來會打兩三趟。
 */
async function gitStatusCacheChecks() {
  console.log('\n[B] git status 共用快取')
  let calls = 0
  let fail = false
  const context = {
    Date,
    electronAPI: { workspace: { gitStatus: async () => {
      calls += 1
      if (fail) throw new Error('boom')
      return { ok: true }
    } } }
  }
  const { gitStatusShared, invalidateGitStatus } = loadRenderer('ws-git-status.js', 'gitStatusShared, invalidateGitStatus', context)

  await Promise.all([gitStatusShared('A'), gitStatusShared('A')])
  check('同時要同一個專案只打一趟', calls === 1)
  await gitStatusShared('A')
  check('短時間內重複呼叫重用結果', calls === 1)
  await gitStatusShared('B')
  check('換專案一定要重打', calls === 2)
  invalidateGitStatus()
  await gitStatusShared('B')
  check('動過 git 之後不可以再拿快取', calls === 3)
  fail = true
  await gitStatusShared('C').catch(() => {})
  await gitStatusShared('C').catch(() => {})
  check('失敗不留在快取裡（下一次要能重試）', calls === 5)
  let now = 0
  context.Date = { now: () => now }
  let complete
  context.electronAPI.workspace.gitStatus = () => {
    calls += 1
    return new Promise((resolve) => { complete = resolve })
  }
  const slow = gitStatusShared('slow')
  now = 1000
  const repeated = gitStatusShared('slow')
  check('慢請求超過 500ms 仍只打一趟', calls === 6 && repeated === slow)
  complete({ ok: true })
  await repeated
  now = 1200
  check('快取從完成時計算，剛回來的結果可重用', gitStatusShared('slow') === repeated)
  now = 1600
  check('完成後超過 500ms 會重新讀取', gitStatusShared('slow') !== repeated)
  complete({ ok: true })
}

/** Ctrl+滾輪縮放的倍率算法（`ws-zoom.js`） */
function zoomChecks() {
  console.log('\n[C] Ctrl+滾輪縮放')
  const { nextZoom, ZOOM_MIN, ZOOM_MAX } = loadRenderer('ws-zoom.js', 'nextZoom, ZOOM_MIN, ZOOM_MAX')
  check('往上滾放大', nextZoom(1, -120) > 1)
  check('往下滾縮小', nextZoom(1, 120) < 1)
  check('放大再縮小回得到原點', nextZoom(nextZoom(1, -120), 120) === 1)
  check('一直放大會停在上限', [...Array(80)].reduce((z) => nextZoom(z, -120), 1) === ZOOM_MAX)
  check('一直縮小會停在下限', [...Array(80)].reduce((z) => nextZoom(z, 120), 1) === ZOOM_MIN)
  check('沒有滾動就不動', nextZoom(1.3, 0) === 1.3)
  check('壞掉的倍率當成 100%', nextZoom(NaN, -120) > 1 && nextZoom(0, 0) === 1)
}

/** 「在終端機執行」：每種副檔名組出的指令，以及只有啟動腳本才經過網址改道 */
async function runInTerminalChecks() {
  console.log('\n[D] 在終端機執行')
  const tabs = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/ws-tabs.js'), 'utf8')
  const runFn = tabs.slice(tabs.indexOf('export async function runInTerminal'), tabs.indexOf('export async function openEditorTab'))
  const commands = []
  const launches = []
  const run = new Function('newTerminalWithCommand', 'extOf', 'isLaunchScript', `${runFn.replace('export ', '')}; return runInTerminal`)(
    async (_title, command, _resume, rel) => { commands.push(command); launches.push(rel) },
    (rel) => rel.split('.').pop().toLowerCase(), (rel) => /\.(bat|cmd|ps1|sh)$/i.test(rel))
  for (const [file, expected] of [
    ['hello.js', "node './hello.js'"], ['hello.mjs', "node './hello.mjs'"],
    ['hello.py', "python './hello.py'"], ['hello.jar', "java -jar './hello.jar'"],
    ['hello.sh', "bash './hello.sh'"], ["it's.ps1", "& './it''s.ps1'"]
  ]) {
    await run(file)
    check(`執行 ${file} 使用對應程式`, commands.pop() === expected)
    check(`${file} 只有啟動腳本才經過網址改道`, launches.pop() === (/\.(bat|cmd|ps1|sh)$/.test(file) ? file : ''))
  }
  const before = commands.length
  await run('bad\nname.ps1')
  check('路徑有換行就不送（送進終端機的是按鍵）', commands.length === before)
}

agentPathChecks().then(gitStatusCacheChecks).then(zoomChecks).then(runInTerminalChecks).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
