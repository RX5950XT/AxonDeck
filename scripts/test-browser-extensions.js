'use strict'
// 工作區瀏覽器擴充功能：商店網址、CRX3 拆包與公鑰對 ID：`node scripts/test-browser-extensions.js`
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { storeIdFromUrl, idFromKey, parseCrx, isNewer, parseUpdateXml } = require('../src/main/browser-extensions')

const ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh'
assert.equal(storeIdFromUrl(`https://chromewebstore.google.com/detail/ublock-origin-lite/${ID}`), ID)
assert.equal(storeIdFromUrl(`https://chromewebstore.google.com/detail/${ID}?hl=zh-TW`), ID)
assert.equal(storeIdFromUrl(`https://evil.example/detail/x/${ID}`), '', '別的網域不算')
assert.equal(storeIdFromUrl('https://chromewebstore.google.com/'), '')

// 自己做一個 CRX3：欄位 2（RSA 證明）裡放公鑰
const varint = (n) => { const out = []; while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128) } out.push(n); return Buffer.from(out) }
const field = (no, buf) => Buffer.concat([varint(no * 8 + 2), varint(buf.length), buf])
const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 })
const key = publicKey.export({ type: 'spki', format: 'der' })
const id = idFromKey(key)
assert.match(id, /^[a-p]{32}$/)
const header = Buffer.concat([field(2, Buffer.concat([field(1, key), field(2, Buffer.from('sig'))])), field(10000, Buffer.from('x'))])
const zip = Buffer.from('PK\u0003\u0004zip-body')
const prefix = Buffer.alloc(12)
prefix.write('Cr24', 0, 'latin1')
prefix.writeUInt32LE(3, 4)
prefix.writeUInt32LE(header.length, 8)
const crx = Buffer.concat([prefix, header, zip])

const parsed = parseCrx(crx, id)
assert.deepEqual(parsed.zip, zip)
assert.equal(parsed.key, key.toString('base64'))
assert.throws(() => parseCrx(crx, ID), /對不上/, '公鑰跟 ID 不符要擋')
assert.throws(() => parseCrx(Buffer.from('PK not a crx'), id), /CRX3/)
assert.throws(() => parseCrx(Buffer.concat([prefix, header.subarray(0, 5)]), id), /不完整/)

// 自動更新：版本比較與商店更新檢查的 XML
assert.ok(isNewer('2026.1012.1545', '2026.1005.1'))
assert.ok(isNewer('1.10', '1.9'), '逐段比數字，不是比字串')
assert.ok(!isNewer('1.0.0', '1.0'), '補零後一樣不算新')
assert.ok(!isNewer('0', '3.2'))
const xml = '<gupdate><app appid="ddkjiahejlhfcafbddmgiahcphecmpfh" status="ok"><updatecheck codebase="https://x/a.crx" status="ok" version="2026.1012.1545"/></app>'
  + '<app appid="eimadpbcbfnmbkopoojfekhnkhdbieeh" status="ok"><updatecheck status="noupdate"/></app></gupdate>'
assert.deepEqual([...parseUpdateXml(xml)], [['ddkjiahejlhfcafbddmgiahcphecmpfh', '2026.1012.1545']])
assert.equal(parseUpdateXml('not xml').size, 0)

console.log('test-browser-extensions: 通過')
