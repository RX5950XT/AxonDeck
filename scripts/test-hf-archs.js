'use strict'
// 架構清單要跟裝的 llama.cpp 同版；升級執行環境卻沒重抄清單，這支會先擋下來
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LLAMA_ARCHS_BUILD, isSupportedArch } = require('../src/main/hfmodels/archs')

const modelsSrc = fs.readFileSync(path.join(__dirname, '../src/main/models.js'), 'utf8')
assert.equal(LLAMA_ARCHS_BUILD, modelsSrc.match(/const LLAMA_BUILD = '([^']+)'/)[1], 'archs.js 要照新版 llama.cpp 重抄')
for (const arch of ['llama', 'qwen35', 'gemma4', 'gpt-oss', 'paddleocr']) assert.ok(isSupportedArch(arch), arch)
for (const arch of ['clip', 'qwen_image21', 'flux', 'wan', '', undefined, 'dflash', 'bert', 'gemma-embedding', 't5encoder', 'qwen3tts', 'pockettts']) assert.ok(!isSupportedArch(arch), String(arch))
console.log('PASS 架構清單：版本同步、只留生成文字的架構')
const { isNonTextRepo, isTextModel } = require('../src/main/hfmodels/archs')
for (const id of ['Qwen/Qwen3-Embedding-0.6B-GGUF', 'mradermacher/Qwen3-Reranker-0.6B-GGUF', 'mysanit/qwen3-tts-gguf',
  'bombman/MOSS-TTS-v1.5-GGUF', 'ggml-org/Qwen3-ASR-0.6B-GGUF', 'jinaai/jina-embeddings-v4-text-retrieval-GGUF']) {
  assert.ok(isNonTextRepo({ id }), id)
}
for (const id of ['unsloth/Qwen3.8-27B-GGUF', 'mradermacher/Liliths-Whisper-L3.3-70b-0.2b-i1-GGUF', 'owner/Fantasy-GGUF', 'owner/Nasrudin-7B']) {
  assert.ok(!isNonTextRepo({ id }), id)
}
assert.ok(isNonTextRepo({ id: 'a/b', pipelineTag: 'feature-extraction' }))
assert.ok(isNonTextRepo({ id: 'a/b', tags: ['sentence-transformers'] }))
assert.ok(!isTextModel({ arch: 'qwen3', pooling: true }, { id: 'a/b' }), '有 pooling_type 的是向量模型')
assert.ok(isTextModel({ arch: 'qwen3', pooling: false }, { id: 'a/b', pipelineTag: 'text-generation' }))
console.log('PASS 向量／重排序／TTS／ASR 擋得掉，一般聊天模型不誤擋')
