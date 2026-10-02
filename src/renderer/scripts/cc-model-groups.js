/** CC 掃描清單：主流 lab 在前，同一家依模型名稱的世代由新到舊。 */
const LABS = [
  ['Anthropic', /^(?:anthropic\/|claude(?:-|$))/i],
  ['OpenAI', /^(?:openai\/|gpt(?:-|$)|o[1-9](?:-|$)|codex(?:-|$))/i],
  ['Google', /^(?:google\/|gemini(?:-|$)|gemma\d*(?:-|:|$))/i],
  ['xAI', /^(?:(?:xai|x-ai)\/|grok(?:-|$))/i],
  ['DeepSeek', /^(?:deepseek(?:-ai)?\/|deepseek(?:-|$))/i],
  ['Alibaba · Qwen', /^(?:qwen\/|qwen\d)/i],
  ['Moonshot AI · Kimi', /^(?:moonshotai\/|kimi(?:-|$))/i],
  ['Z.ai · GLM', /^(?:(?:z-ai|zai-org|zhipuai)\/|glm(?:-|$))/i],
  ['MiniMax', /^(?:minimax(?:ai)?\/|minimax(?:-|$))/i],
  ['Meta', /^(?:(?:meta|meta-llama)\/|llama\d|muse-spark(?:-|$))/i],
  ['Mistral AI', /^(?:mistralai\/|mistral(?:-|$)|mixtral(?:-|$)|codestral(?:-|$)|devstral(?:-|$)|magistral(?:-|$))/i],
  ['NVIDIA', /^(?:nvidia\/|nemotron(?:\d|-|$))/i],
  ['Xiaomi · MiMo', /^(?:xiaomi\/|mimo(?:-|$))/i],
  ['Tencent · Hunyuan', /^(?:tencent\/|hunyuan(?:-|$)|hy\d)/i],
  ['StepFun', /^(?:stepfun(?:-ai)?\/|step(?:-|$))/i],
  ['Meituan · LongCat', /^(?:meituan\/|longcat(?:-|$))/i],
  ['Sakana AI', /^sakana\//i],
  ['Thinking Machines', /^thinkingmachines\//i],
  ['Poolside', /^poolside\//i],
  ['InclusionAI', /^inclusionai\//i]
]
const MODEL_NAMES = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

function generation(id) {
  const name = id.slice(id.lastIndexOf('/') + 1)
  // ponytail: 名稱沒有世代就按名稱排；上游提供可靠發行日期時再改用日期。
  // 限制數字段長及結尾，避免把日期或 120b 參數量當成世代。
  const match = name.match(/(?:^|[a-z_-])(\d{1,2}(?:[.-]\d{1,2})*)(?=$|[-_:]|o(?:-|$))/i)
  return match ? match[1].split(/[.-]/).map(Number) : []
}

function compareModels(a, b) {
  const left = generation(a)
  const right = generation(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (right[i] || 0) - (left[i] || 0)
    if (difference) return difference
  }
  const preview = /(?:^|[-_:])(?:preview|exp|experimental|alpha|beta)(?:[-_:]|$)/i
  return Number(preview.test(a)) - Number(preview.test(b)) || MODEL_NAMES.compare(a, b)
}

/** @param {string[]} models @returns {{ label: string, models: string[] }[]} */
export function groupCcModels(models) {
  const groups = new Map()
  for (const model of new Set(models)) {
    if (typeof model !== 'string' || !model) continue
    const found = LABS.findIndex(([, pattern]) => pattern.test(model))
    const index = found < 0 ? LABS.length : found
    if (!groups.has(index)) groups.set(index, [])
    groups.get(index).push(model)
  }
  return [...groups].sort(([a], [b]) => a - b)
    .map(([index, values]) => ({ label: LABS[index]?.[0] || '其他／未分類', models: values.sort(compareModels) }))
}
