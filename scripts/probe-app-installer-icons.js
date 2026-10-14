// npx electron scripts/probe-app-installer-icons.js — 唯讀，不安裝或移除程式。
'use strict'
const { app } = require('electron')
const { tempDir } = require('./lib/test-temp')
const { displayIcons, readIcon } = require('../src/main/app-installer/icons')
const { list } = require('../src/main/app-installer/winget')
app.setPath('userData', tempDir('installer-icon-probe-'))
app.whenReady().then(async () => {
  const [lookup, rows] = await Promise.all([displayIcons(), list()])
  const cache = new Map(), missing = [], selected = []
  let found = 0
  for (const row of rows) {
    let picked = ''
    for (const file of lookup(row)) {
      if (!cache.has(file)) cache.set(file, await readIcon(file).then((image) => !!image && !image.isEmpty()).catch(() => false))
      if (cache.get(file)) { picked = file; break }
    }
    if (picked) found++
    else missing.push(row.name)
    if (/Git$|Epic Games|Corsair iCUE5|Bambu|RustDesk|Google Cloud|Pandoc|LLVM|Ollama|Meta Horizon|Z-Library/.test(row.name)) selected.push({ name: row.name, picked })
  }
  console.log(JSON.stringify({ total: rows.length, found, missing, selected }, null, 2))
  require('../src/main/explorer/shell').shutdown()
  app.exit(0)
}).catch((error) => { console.error(error.message); require('../src/main/explorer/shell').shutdown(); app.exit(1) })
