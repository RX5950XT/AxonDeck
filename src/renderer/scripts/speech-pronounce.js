/**
 * 讀音字典：指定破音字或專有名詞怎麼念。生成前替換，原稿不變；存在設定 speechPronunciations。
 */
import { electronAPI } from './app.js'
import { applyPronunciations } from './speech-script.js'
import { svgIcon } from './speech-wave.js'

const $ = (id) => document.getElementById(id)

export function createPronounce({ onError }) {
  let list = []

  function render() {
    $('speechPronounceCount').textContent = String(list.length)
    $('speechPronounceCount').hidden = !list.length
    $('speechPronounceList').replaceChildren(...list.map((item, index) => {
      const row = document.createElement('li')
      row.innerHTML = `<span class="pron-word"></span><span aria-hidden="true">→</span><span class="pron-sound"></span><button type="button" class="btn-icon">${svgIcon('trash')}</button>`
      row.querySelector('.pron-word').textContent = item.word
      row.querySelector('.pron-sound').textContent = item.sound
      const remove = row.querySelector('button')
      remove.setAttribute('aria-label', `移除「${item.word}」的讀音`)
      remove.addEventListener('click', () => { list = list.filter((_, i) => i !== index); void save() })
      return row
    }))
  }

  async function save() {
    render()
    try { await electronAPI.store.set('speechPronunciations', list) } catch (error) { onError(error) }
  }

  function add() {
    const word = $('speechPronounceWord').value.trim()
    const sound = $('speechPronounceSound').value.trim()
    if (!word || !sound) { onError(new Error('原字和念法都要填。')); return }
    list = [...list.filter((item) => item.word !== word), { word, sound }]
    $('speechPronounceWord').value = ''
    $('speechPronounceSound').value = ''
    void save()
    $('speechPronounceWord').focus()
  }

  /** 選取了稿子裡的字就直接帶入原字；沒選就開關面板。 */
  function toggle() {
    const panel = $('speechPronounce')
    const text = $('speechText')
    const selected = text.value.slice(text.selectionStart, text.selectionEnd).trim()
    if (selected && selected.length <= 50) { panel.hidden = false; $('speechPronounceWord').value = selected; $('speechPronounceSound').focus() }
    else panel.hidden = !panel.hidden
    $('speechPronounceBtn').setAttribute('aria-expanded', String(!panel.hidden))
  }

  $('speechPronounceBtn').addEventListener('click', toggle)
  $('speechPronounceAdd').addEventListener('click', add)
  $('speechPronounceSound').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); add() } })

  return {
    apply: (text) => applyPronunciations(text, list),
    async load() {
      try {
        const value = await electronAPI.store.get('speechPronunciations', [])
        list = Array.isArray(value) ? value.filter((item) => item?.word && item?.sound) : []
      } catch (error) { console.error('[speech] 讀音字典讀取失敗:', error); list = [] }
      render()
    }
  }
}
