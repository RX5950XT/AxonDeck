#!/usr/bin/env node
'use strict'
const assert = require('assert/strict')
const runtime = require('../src/main/miroxen/runtime')

if (process.platform === 'win32') {
  assert.equal(runtime.ENGINE, 'miroxen-win-x64.zip')
  assert.equal(runtime.DEPS, 'miroxen-deps-win-x64.zip')
} else {
  assert.match(runtime.ENGINE, /^miroxen-linux-(x64|arm64)\.tar\.gz$/)
  assert.match(runtime.DEPS, /^miroxen-deps-linux-(x64|arm64)\.tar\.gz$/)
  assert.deepEqual(runtime.ENGINE_FILES[0], 'miroxen')
}

const tag = 'v0.1.2'
const prefix = `https://github.com/${runtime.REPO}/releases/download/`
try {
  runtime.parseRelease({
    tag_name: tag,
    assets: [{
      name: 'miroxen-win-x64.zip', digest: 'sha256:' + 'a'.repeat(64),
      browser_download_url: prefix + 'v0.1.2/miroxen-win-x64.zip', size: 10
    }, {
      name: 'miroxen-deps-win-x64.zip', digest: 'sha256:' + 'b'.repeat(64),
      browser_download_url: prefix + 'v0.1.2/miroxen-deps-win-x64.zip', size: 20
    }]
  })
  assert.equal(process.platform, 'win32', 'Linux 不該接受只有 Windows 資產的發行')
} catch (error) {
  if (process.platform === 'linux') {
    assert.match(error.message, /Linux 發行檔尚未上傳|build\.sh/)
  } else if (process.platform !== 'win32') {
    assert.ok(error.message)
  }
}

if (process.platform === 'linux') {
  const linux = runtime.parseRelease({
    tag_name: tag,
    assets: [{
      name: runtime.ENGINE, digest: 'sha256:' + 'c'.repeat(64),
      browser_download_url: prefix + `v0.1.2/${runtime.ENGINE}`, size: 11
    }, {
      name: runtime.DEPS, digest: 'sha256:' + 'd'.repeat(64),
      browser_download_url: prefix + `v0.1.2/${runtime.DEPS}`, size: 22
    }]
  })
  assert.equal(linux.tag, 'v0.1.2')
  assert.equal(linux.assets[runtime.ENGINE].size, 11)
}

console.log('test-linux-miroxen: all passed')
