'use strict'

// sidecar 是唯一網路來源；PID 與視窗時間必須符合正在顯示的這輪程序。
function readProcessNetwork(value, now = Date.now()) {
  if (!value || value.available !== true || !Number.isFinite(value.t) || !Number.isFinite(value.from)
    || value.t > now + 1000 || now - value.t > 5000 || value.from >= value.t
    || value.t - value.from > 20000 || !value.pids || typeof value.pids !== 'object' || Array.isArray(value.pids)) return null
  const entries = Object.entries(value.pids)
  if (entries.length > 8192) return null
  const pids = Object.create(null)
  for (const [pid, rate] of entries) {
    if (!/^\d{1,10}$/.test(pid) || !Number.isFinite(rate) || rate < 0) return null
    pids[pid] = rate
  }
  return { available: true, from: value.from, t: value.t, pids }
}

function processNetworkRate(network, p) {
  if (!network || !(p.startedAt > 0) || p.startedAt > network.from) return null
  return network.pids[p.pid] ?? 0
}

module.exports = { readProcessNetwork, processNetworkRate }
