'use strict'

/** Grok 反代的流量日誌：跟 AGY 同一套表與統計，存在 `<userData>/grok-proxy-logs.db` */
module.exports = require('../agy/logs').createLogStore('grok-proxy-logs.db')
