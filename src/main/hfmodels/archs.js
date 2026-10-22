'use strict'

/**
 * 我們裝的 llama.cpp 認得、能單獨載入、而且是生成文字的 GGUF 架構（`general.architecture`）。
 *
 * 來源：llama.cpp `src/llama-arch.cpp` 的 `LLM_ARCH_NAMES`，版本跟 `models.js` 的 LLAMA_BUILD 一致；
 * 升級執行環境時要照新版重抄（`test-hf-archs.js` 會擋版本不一致）。
 * 只留「生成文字」的：拿掉 `clip`（只是 mmproj）、草稿頭（eagle3／dflash／gemma4-assistant）、
 * 聲碼器（wavtokenizer-dec），以及 AxonDeck 沒接的向量（bert 家族、gemma-embedding、llama-embed、t5encoder）
 * 與語音生成（qwen3tts、pockettts）。
 * 但很多向量／語音模型底子是 qwen3、llama，光看架構擋不掉，所以另外看檔頭的 pooling_type、HF 用途標籤與名字。
 */
const LLAMA_ARCHS_BUILD = 'b10666'

const LLAMA_ARCHS = new Set(`
llama llama4 deci falcon grok gpt2 gptj gptneox mpt baichuan starcoder refact bloom stablelm qwen qwen2
qwen2moe qwen2vl qwen3 qwen3moe qwen3next qwen3vl qwen3vlmoe qwen35 qwen35moe qwen4exp phi2 phi3 phimoe plamo
plamo2 plamo3 codeshell orion internlm2 minicpm minicpm3 gemma gemma2 gemma3 gemma3n gemma4 starcoder2 mamba
mamba2 jamba falcon-h1 xverse command-r cohere2 cohere2moe dbrx olmo olmo2 olmoe muse-glimmer openelm arctic
deepseek deepseek2 deepseek2-ocr deepseek32 deepseek4 chatglm glm4 glm4moe glm-dsa bitnet t5 jais jais2
nemotron nemotron_h nemotron_h_moe exaone exaone4 exaone-moe rwkv6 rwkv6qwen2 rwkv7 arwkv7 granite granitemoe
granitehybrid graniteswitch granite_swa chameleon plm bailingmoe bailingmoe2 bailingmoe3 dots1 dots3note arcee
afmoe laguna ernie4_5 ernie4_5-moe hunyuan-moe hunyuan-dense hunyuan_vl hy_v3 smollm3 gpt-oss lfm2 lfm2moe
dream smallthinker llada llada-moe seed_oss grovemoe apertus minimax-01 minimax-m2 minimax-m3 cogvlm rnd1
pangu-embedded mistral3 mistral4 paddleocr mimo2 step35 maincoder kimi-linear kimi-k3 talkie mellum nanbeige
`.trim().split(/\s+/))

/** @param {unknown} arch */
const isSupportedArch = (arch) => typeof arch === 'string' && LLAMA_ARCHS.has(arch)

/** HF 用途標籤：這些不是生成文字（向量、重排序、語音、分類） */
const NON_TEXT_TAGS = new Set(['feature-extraction', 'sentence-similarity', 'sentence-transformers', 'text-ranking',
  'text-classification', 'text-to-speech', 'text-to-audio', 'audio-to-audio', 'automatic-speech-recognition'])
// 很多向量／TTS／ASR 模型底子就是 qwen3、llama，架構跟聊天模型一樣，又常常沒標用途，只能看名字
const NON_TEXT_NAME = /(^|[-_./\s])(embed\w*|rerank\w*|tts|asr)(?=[-_./\s]|$)/i

/**
 * repo 層級看得出來的「不是生成文字」：用途標籤或名字
 * @param {{ id?: string, pipelineTag?: string, tags?: string[] }} repo
 */
const isNonTextRepo = (repo) => NON_TEXT_NAME.test(String(repo?.id || '')) ||
  [repo?.pipelineTag, ...(Array.isArray(repo?.tags) ? repo.tags : [])].some((tag) => NON_TEXT_TAGS.has(tag))

/**
 * 執行環境載得起來、而且是生成文字的模型
 * @param {{ arch?: string, pooling?: boolean }} info GGUF 檔頭
 * @param {{ id?: string, pipelineTag?: string, tags?: string[] }} [repo]
 */
const isTextModel = (info, repo) => isSupportedArch(info?.arch) && !info?.pooling && !isNonTextRepo(repo)

module.exports = { LLAMA_ARCHS_BUILD, LLAMA_ARCHS, isSupportedArch, isNonTextRepo, isTextModel }
