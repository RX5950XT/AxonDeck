#!/usr/bin/env node
'use strict'
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const src = fs.readFileSync(path.join(__dirname, '../src/main/screen-translate/index.js'), 'utf8')
assert.match(src, /async function captureExcludingWindow/)
assert.match(src, /process\.platform === 'win32'.*setContentProtection/)
assert.match(src, /win32' && process\.platform !== 'linux'/)
assert.doesNotMatch(src, /if \(process\.platform !== 'win32'\) throw fail\('UNSUPPORTED'/)
assert.match(fs.readFileSync(path.join(__dirname, '../scripts/build-unlimited-ocr2-linux.sh'), 'utf8'), /apply --check/)
const models = require('../src/main/models')
if (process.platform === 'linux') {
  assert.ok(models.MODELS.unlimitedocr2q8)
  assert.deepEqual(models.OCR_MODEL_KEYS, ['unlimitedocr2q8'])
}
console.log('test-linux-screen-translate: all passed')
