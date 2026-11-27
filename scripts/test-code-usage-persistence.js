#!/usr/bin/env node
/**
 * 確認 codeusage.sync 只用一次 electron-store.set 寫完整份狀態。
 *
 * 這裡用假的 store 和空的來源，不碰使用者的 code-usage.json。
 */

'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const SOURCE = path.join(ROOT, 'src/main/codeusage/index.js')

class FakeStore {
  constructor() {
    this.values = {
      rulesVersion: 1,
      buckets: [],
      cursors: {},
      dbCursors: {}
    }
    this.writes = []
    activeStore = this
  }

  get(key, fallback) {
    return Object.prototype.hasOwnProperty.call(this.values, key)
      ? this.values[key]
      : fallback
  }

  set(keyOrPatch, value) {
    this.writes.push({ keyOrPatch, value })
    if (typeof keyOrPatch === 'string') this.values[keyOrPatch] = value
    else Object.assign(this.values, keyOrPatch)
  }
}

let activeStore = null

function makeRequire(fakeStore) {
  const pricing = {
    RULES_VERSION: 1,
    needsFullRescan: () => false,
    normalizeModel: (model) => model || 'unknown',
    isJunkModel: () => false
  }
  const parsers = {
    parseClaudeLine: () => null,
    parseCodexLine: () => null,
    parseGrokLine: () => null,
    newState: () => ({})
  }
  const scan = {
    scanSource: async () => ({ files: 0, scannedBytes: 0 }),
    pruneCursors: () => ({})
  }
  const dbSources = {
    readOpencode: () => [],
    readAntigravity: () => [],
    readAntigravityCli: () => [],
    readAllInWorker: async () => ({ agyFiles: [], agyModels: {}, opencodeEvents: [], agyEvents: [] })
  }

  return (request) => {
    if (request === 'os') return { homedir: () => 'C:/fake' }
    if (request === 'fs') return require('fs')
    if (request === 'path') return path
    if (request === './pricing') return pricing
    if (request === './parsers') return parsers
    if (request === './scan') return scan
    if (request === './db-sources') return dbSources
    if (request === '../serial-store') return { createSerialStore: () => ({ getStore: async () => fakeStore }) }
    throw new Error(`Unexpected require: ${request}`)
  }
}

async function run() {
  const code = `${fs.readFileSync(SOURCE, 'utf8')}\nmodule.exports.__runSync = runSync\n`
  const fakeStore = new FakeStore()

  const context = {
    Buffer,
    FakeStore,
    console,
    fakeStore,
    module: { exports: {} },
    process,
    require: makeRequire(fakeStore),
    setTimeout,
    clearTimeout
  }
  vm.runInNewContext(code, context, { filename: SOURCE })
  const codeusage = context.module.exports
  codeusage.configure({ userDataPath: 'C:/fake', homeDir: 'C:/fake' })
  await codeusage.__runSync({})

  const expectedWrites = 1
  const actualWrites = activeStore?.writes.length || 0
  if (actualWrites !== expectedWrites) {
    console.error(`FAIL: expected ${expectedWrites} store write, got ${actualWrites}`)
    process.exitCode = 1
    return
  }
  console.log(`PASS: one store write`)
}

run().catch((error) => {
  console.error(`ERROR: ${error.message}`)
  process.exitCode = 1
})
