'use strict'
const assert = require('node:assert/strict')
const { latestPerAgent } = require('../src/main/workspace/agents')

const rows = []
for (let i = 0; i < 40; i++) rows.push({ agent: 'grok', id: `g${i}`, mtime: 1000 + i, title: '' })
rows.push({ agent: 'agy', id: 'a1', mtime: 1, title: '較早的 Antigravity' })
rows.push({ agent: 'agy', id: 'a1', mtime: 2, title: '' })
const kept = latestPerAgent(rows, 30)
assert.equal(kept.filter(row => row.agent === 'grok').length, 30, '同一家只留最新 30 筆')
assert.equal(kept.some(row => row.agent === 'agy' && row.id === 'a1'), true, '另一家不能被總上限擠掉')
assert.equal(kept.find(row => row.id === 'a1').title, '較早的 Antigravity', '去重時保留有標題的那份')
assert.equal(kept.find(row => row.agent === 'grok').id, 'g39', '仍由新到舊')
console.log('PASS 五家各自保留最新對話，不被總數 30 截掉')
