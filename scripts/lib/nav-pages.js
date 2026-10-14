'use strict'

// 頂端導覽的頁面順序，直接讀 index.html 的 nav，CDP 測試不手抄（手抄的清單每次加減頁面都會過期）
const fs = require('fs')
const path = require('path')

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'), 'utf8')
const NAV_PAGES = [...html.matchAll(/class="nav-tab[^"]*" data-page="(\w+)"/g)].map((m) => m[1])
if (NAV_PAGES.length < 5) throw new Error(`nav-pages：index.html 只讀到 ${NAV_PAGES.length} 個 nav-tab，標記格式可能改了`)

module.exports = { NAV_PAGES }
