export const EXTENSIONS_PAGE_URL = 'axon-extensions://manager/pages/browser-extensions.html'

export function isExtensionManagerUrl(value) {
  try {
    const url = new URL(value)
    return !url.username && !url.password && url.href.split(/[?#]/)[0] === EXTENSIONS_PAGE_URL
  } catch { return false }
}

export function isInternalBrowserUrl(value) {
  if (isExtensionManagerUrl(value)) return true
  try {
    const url = new URL(value)
    return url.protocol === 'chrome-extension:' && /^[a-p]{32}$/.test(url.host) && !url.username && !url.password
  } catch { return false }
}
