/**
 * 邊生成邊播放：把 breeze:chunk 送來的 PCM 排進 Web Audio。
 * - 先攢一小段再開播；同一句裡播到沒東西（生成比播放慢），下次就多攢一點，不會一頓一頓。
 * - 生成完不切掉：已經排好的聲音會播完。
 * - 句子之間照版本補上停頓；某句要重做（模型亂念重試）時，把那句倒回去重排。
 */
const START_LEAD = 0.35
const MAX_LEAD = 3
const FADE = 0.008
const GAP_RATE = 24000

function decode(pcmBase64) {
  const bytes = Uint8Array.from(atob(pcmBase64), (c) => c.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const samples = new Float32Array(bytes.length >> 1)
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768
  return samples
}

export function createStream({ onChange }) {
  let ctx = null
  let pending = [] // 還沒排進播放的片段 { samples, rate, mark }
  const scheduled = new Set() // 已排進播放的 { node, start, mark }
  let playAt = 0
  let lead = START_LEAD
  let flowing = false // 目前排好的聲音還沒播完
  let lastMark = -1
  let mark = 0
  let open = false

  const pendingSeconds = () => pending.reduce((sum, part) => sum + part.samples.length / part.rate, 0)
  const active = () => open || scheduled.size > 0 || pending.length > 0
  const notify = () => onChange(active())

  function scheduleAll(fadeIn) {
    for (const part of pending) {
      const buffer = ctx.createBuffer(1, part.samples.length, part.rate)
      const data = buffer.getChannelData(0)
      data.set(part.samples)
      if (fadeIn) {
        const n = Math.min(data.length, Math.round(FADE * part.rate))
        for (let i = 0; i < n; i++) data[i] *= i / n
        fadeIn = false
      }
      const node = ctx.createBufferSource()
      node.buffer = buffer
      node.connect(ctx.destination)
      const entry = { node, start: playAt, mark: part.mark }
      node.onended = () => { scheduled.delete(entry); if (!active()) notify() }
      scheduled.add(entry)
      node.start(playAt)
      playAt += buffer.duration
      lastMark = part.mark
    }
    pending = []
  }

  /** final：這句已經生成完，手上剩多少就排多少，不用再等。 */
  function pump(final = false) {
    if (!ctx || !pending.length) return
    if (flowing && playAt - ctx.currentTime > 0.02) { scheduleAll(false); return }
    // 播空了。同一句中途斷掉代表生成跟不上，下次多攢一點；換句之間的等待不算
    if (flowing && pending[0].mark === lastMark) lead = Math.min(lead * 1.6, MAX_LEAD)
    flowing = false
    if (!final && pendingSeconds() < lead) return
    playAt = ctx.currentTime + 0.03
    scheduleAll(true)
    flowing = true
  }

  function clear() {
    for (const entry of scheduled) { entry.node.onended = null; try { entry.node.stop() } catch { /* 已播完 */ } }
    scheduled.clear()
    pending = []
    flowing = false
  }

  return {
    get paused() { return ctx?.state === 'suspended' },
    async begin() {
      ctx ||= new AudioContext()
      open = true
      notify()
      await ctx.resume()
    },
    /** 下一句開始。 */
    sentence() { mark++ },
    push(pcmBase64, rate) {
      if (!open || !ctx) return
      pending.push({ samples: decode(pcmBase64), rate, mark })
      pump()
    },
    /** 這句生成完：補上句間停頓，剩下的直接排進去。 */
    endSentence(gap) {
      if (!open || !ctx) return
      if (gap > 0) pending.push({ samples: new Float32Array(Math.round(gap * GAP_RATE)), rate: GAP_RATE, mark })
      pump(true)
    },
    /** 這句要重做：還沒播的部分丟掉，從這句開頭（或現在）重排。 */
    rewind() {
      if (!ctx) return
      pending = pending.filter((part) => part.mark !== mark)
      let from = Infinity
      for (const entry of scheduled) {
        if (entry.mark !== mark) continue
        from = Math.min(from, entry.start)
        entry.node.onended = null
        try { entry.node.stop() } catch { /* 已播完 */ }
        scheduled.delete(entry)
      }
      if (from < Infinity) playAt = Math.max(from, ctx.currentTime)
      if (playAt <= ctx.currentTime + 0.02) flowing = false
      lastMark = -1 // 重做造成的空檔不算生成跟不上
    },
    /** 這次生成全部結束；排好的繼續播完。 */
    end() {
      pump(true)
      open = false
      notify()
    },
    /** 停掉並清空（新的生成、取消、改播版本時）。 */
    stop() {
      clear()
      open = false
      lead = START_LEAD
      lastMark = -1
      if (ctx?.state === 'suspended') void ctx.resume()
      notify()
    },
    /** 暫停／繼續（生成照常進行，聲音先攢著）。 */
    async toggle() {
      if (!ctx) return
      if (ctx.state === 'suspended') await ctx.resume()
      else await ctx.suspend()
    },
    close() { clear(); void ctx?.close() }
  }
}
