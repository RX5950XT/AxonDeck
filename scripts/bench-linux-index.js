'use strict'

/**
 * Linux 整機檔名索引的效能量測：建置、落盤／載回、無變動重掃、查詢延遲（含 stat 補欄位）。
 *
 *   node scripts/bench-linux-index.js                 # $HOME＋合成 30 萬筆的樹
 *   node scripts/bench-linux-index.js /some/dir ...   # 指定根目錄（不建合成樹）
 *   SYNTH=0 node scripts/bench-linux-index.js         # 只量 $HOME
 *
 * 只讀不寫（合成樹與索引檔都在 test-temp 暫存區，結束自動刪）。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { tempDir } = require('./lib/test-temp')
const { createFileIndex } = require('../src/main/explorer/linux-index')
const { createMachineSearch } = require('../src/main/explorer/linux-machine-search')

function ms(t0) {
  return Number(process.hrtime.bigint() - t0) / 1e6
}

function synth(count) {
  const root = tempDir('synth-')
  const words = ['report', 'invoice', 'photo', 'candy', 'notes', 'backup', 'draft', 'song', 'clip', 'data']
  const exts = ['pdf', 'docx', 'jpg', 'wav', 'md', 'zip', 'txt', 'mp4', 'json', 'png']
  let made = 0
  for (let a = 0; made < count; a += 1) {
    for (let b = 0; b < 30 && made < count; b += 1) {
      const dir = path.join(root, `dir-${a}`, `sub-${b}`)
      fs.mkdirSync(dir, { recursive: true })
      for (let c = 0; c < 50 && made < count; c += 1, made += 1) {
        fs.writeFileSync(path.join(dir, `${words[(a + c) % 10]}-${a}-${b}-${c}.${exts[(b + c) % 10]}`), '')
      }
    }
  }
  return root
}

async function bench(label, roots) {
  const idx = createFileIndex()
  global.gc?.()
  const heap0 = process.memoryUsage().heapUsed
  let t = process.hrtime.bigint()
  await idx.build(roots)
  const buildMs = ms(t)
  const st = idx.stats()
  t = process.hrtime.bigint()
  idx.query(() => false, { needle: 'zz-warmup', limit: 1 })
  const flattenMs = ms(t)
  const heapMb = (process.memoryUsage().heapUsed - heap0) / 1048576
  const file = path.join(tempDir('bench-idx-'), 'index-v1.gz')
  t = process.hrtime.bigint()
  const bytes = await idx.save(file)
  const saveMs = ms(t)
  const again = createFileIndex()
  t = process.hrtime.bigint()
  await again.load(file)
  const loadMs = ms(t)
  t = process.hrtime.bigint()
  const changed = await idx.refresh()
  const refreshMs = ms(t)
  console.log(`\n[${label}] roots=${roots.join(', ')}`)
  console.log(`  建置 ${buildMs.toFixed(0)} ms · ${st.records.toLocaleString()} 筆 · ${st.dirs.toLocaleString()} 個資料夾 · 平坦化 ${flattenMs.toFixed(0)} ms · heap +${heapMb.toFixed(1)} MB`)
  console.log(`  落盤 ${saveMs.toFixed(0)} ms（${(bytes / 1024).toFixed(0)} KB gzip）· 載回 ${loadMs.toFixed(0)} ms · 無變動重掃 ${refreshMs.toFixed(0)} ms（變動 ${changed}）`)
  const patterns = ['candy', 'report-1', 'zzzz-not-found', '.md', '*.wav', 'config']
  for (const p of patterns) {
    const glob = /[*?]/.test(p)
    const re = glob ? new RegExp(`^${p.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`, 'i') : null
    const runs = []
    let n = 0
    for (let i = 0; i < 5; i += 1) {
      t = process.hrtime.bigint()
      n = idx.query((name) => re.test(name), { needle: glob ? '' : p, limit: 2000 }).length
      runs.push(ms(t))
    }
    runs.sort((a, b) => a - b)
    console.log(`  查詢 ${JSON.stringify(p).padEnd(18)} 命中 ${String(n).padStart(4)}（上限 2000）· 中位數 ${runs[2].toFixed(2)} ms · 最慢 ${runs[4].toFixed(2)} ms`)
  }
  return { idx, roots }
}

async function endToEnd(roots) {
  // 走整條服務路徑（含 stat 補欄位、篩選、排序），量使用者看到的延遲
  const svc = createMachineSearch({ roots: () => roots, home: '', probeLocate: async () => ({ available: false }) })
  svc.configure('')
  await svc.ensure({})
  await svc._job()
  for (const p of ['candy', 'report-1', '*.wav']) {
    const runs = []
    let n = 0
    for (let i = 0; i < 5; i += 1) {
      const t = process.hrtime.bigint()
      n = (await svc.search(p, {})).hits.length
      runs.push(ms(t))
    }
    runs.sort((a, b) => a - b)
    console.log(`  服務 search(${JSON.stringify(p)}) 回 ${n} 筆（含 stat）· 中位數 ${runs[2].toFixed(1)} ms`)
  }
  await svc.stop()
}

;(async () => {
  const args = process.argv.slice(2)
  console.log(`CPU ${os.cpus()[0]?.model} ×${os.cpus().length} · Node ${process.version}`)
  if (args.length) {
    await bench('指定根目錄', args)
    await endToEnd(args)
    return
  }
  await bench('家目錄', [os.homedir()])
  if (process.env.SYNTH !== '0') {
    const t = process.hrtime.bigint()
    const root = synth(Number(process.env.SYNTH_COUNT) || 300_000)
    console.log(`\n（合成樹建立 ${ms(t).toFixed(0)} ms）`)
    await bench('合成 30 萬筆', [root])
    await endToEnd([root])
  }
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
