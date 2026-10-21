// 在模組抓取 DOM、建立下拉與事件前，移除不屬於這個 renderer 的內容。
(() => {
  if (!window.electronAPI?.pages) return
  const params = new URLSearchParams(location.search)
  const owner = params.get('host') === '1' ? 'host' : params.get('page')
  const names = [...document.querySelectorAll('.nav-tab[data-page]')].map(el => el.dataset.page)
  if (owner !== 'host' && !names.includes(owner)) return
  for (const page of document.querySelectorAll('.page')) {
    if (page.id !== `page-${owner}`) page.remove()
  }
  for (const content of document.querySelectorAll('[data-page-content]')) {
    if (!content.dataset.pageContent.split(' ').includes(owner)) content.remove()
  }
})()
