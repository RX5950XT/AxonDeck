#!/usr/bin/env node
'use strict'

/**
 * 假的 nvidia-smi：給 test-sysmon-oc-linux.js 用。
 *   --query-gpu=…  印一張 RTX 4080 的 CSV（功耗牆讀 $FAKE_SMI_STATE 裡的值）
 *   -i N -pl W／-lgc a,b／-lmc a,b／-rgc／-rmc  記到 $FAKE_SMI_LOG，-pl 寫回狀態檔
 * 不是 root 也照收（真的 nvidia-smi 會拒絕；權限由 pkexec 那層負責，測試用假 pkexec）。
 */

const fs = require('fs')

const args = process.argv.slice(2)
const stateFile = process.env.FAKE_SMI_STATE
const state = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { pl: 320 }
if (args[0] && args[0].startsWith('--query-gpu=')) {
  process.stdout.write(`0, NVIDIA GeForce RTX 4080, 00000000:01:00.0, ${state.pl.toFixed(2)}, 320.00, 150.00, 352.00, 3105, 11201, 2505, 11201, ${state.temp ?? 48}, 85.20, 12\n`)
  process.exit(0)
}
if (process.env.FAKE_SMI_LOG) fs.appendFileSync(process.env.FAKE_SMI_LOG, args.join(' ') + '\n')
const flagAt = args.findIndex((a) => /^-(pl|lgc|lmc|rgc|rmc)$/.test(a))
if (args[0] !== '-i' || flagAt !== 2) {
  process.stderr.write('bad args\n')
  process.exit(2)
}
if (args[2] === '-pl') {
  state.pl = Number(args[3])
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state))
}
process.exit(0)
