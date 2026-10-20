'use strict'

/**
 * `src/main/opencc.js` 自己組的共用字典樹，輸出必須跟 opencc-js 的 `Converter()` 逐字相同。
 * opencc-js 升版改了 s2tw／s2twp 的設定組，這支會先紅。
 */

const assert = require('assert')
const OpenCC = require('opencc-js')
const { s2twp } = require('../src/main/opencc')

const { configs } = OpenCC.Locale
const same = (a, b) => a.length === b.length && a.every((dict, i) => dict === b[i])
assert.ok(same(configs.s2tw.segmentation, configs.s2twp.segmentation), 's2tw 與 s2twp 斷詞字典不同')
assert.ok(same(configs.s2tw.conversionChain[0], configs.s2twp.conversionChain[0]), 's2tw 與 s2twp 簡轉繁字典不同')
assert.ok(same(configs.s2tw.normalizationChain[0], configs.s2twp.normalizationChain[0]), '正規化字典不同')

const refTw = OpenCC.Converter({ from: 'cn', to: 'tw' })
const refTwp = OpenCC.Converter({ from: 'cn', to: 'twp' })
const reference = (text) => {
  if (!text) return text
  return refTw(text) === text ? text : refTwp(text).replace(/([證說表聲查闡指標發])明瞭/g, '$1明了')
}

// 字典裡每個簡體詞條都跑一次，再拼成長句測斷詞跨詞邊界
const words = configs.s2twp.conversionChain[0]
  .flatMap((dict) => (typeof dict === 'string' ? dict.split('|') : dict.map((pair) => pair.join(' '))))
  .map((line) => line.split(' ')[0])
const samples = [
  '', '记忆体参数设定', '参数', '这个软件的内存不够用了，鼠标也坏了', '证明了这一点', '已經是繁體的參數設定',
  '日本語の文章です', 'mixed English 和中文 text', '𠮷野家的服务器', '⿰氵青'
]
for (let i = 0; i < words.length; i += 40) samples.push(words.slice(i, i + 40).join(''), words.slice(i, i + 40).join(' '))

let checked = 0
for (const text of samples) {
  assert.strictEqual(s2twp(text), reference(text), `轉換結果不同：${text.slice(0, 40)}`)
  checked += 1
}
console.log(`opencc 共用字典樹與 Converter() 一致（${checked} 段、${words.length} 詞條）`)
