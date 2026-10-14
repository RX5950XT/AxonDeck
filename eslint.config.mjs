// 靜態檢查閘門：只抓「執行期才炸、單元測試抓不到」的三類錯（未定義名字、未使用變數、import 不到）。
// 不套風格規則，避免大量噪音；執行 `npm run lint`，打包前也會先跑。
import globals from 'globals'
import importPlugin from 'eslint-plugin-import'

const unused = ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }]

export default [
  {
    // main／preload（CJS）與 scripts：Node 環境
    files: ['src/main/**/*.js', 'src/preload/**/*.js', 'scripts/**/*.js'],
    ignores: ['src/preload/ai-web-shim.js'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2024, globals: { ...globals.node } },
    rules: { 'no-undef': 'error', 'no-unused-vars': unused }
  },
  {
    // ai-web-shim：preload 但用 contextBridge.executeInMainWorld 注入網頁執行，`window` 是網頁的
    files: ['src/preload/ai-web-shim.js'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2024, globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-undef': 'error', 'no-unused-vars': unused }
  },
  {
    // renderer（ESM，瀏覽器）
    files: ['src/renderer/**/*.js'],
    plugins: { import: importPlugin },
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2024,
      globals: { ...globals.browser, monaco: 'readonly', pdfjsLib: 'readonly' }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': unused,
      'import/named': 'error',
      'import/no-unresolved': ['error', { ignore: ['^https?:'] }]
    }
  },
  {
    // OpenCode 插件（ESM，跑在 Node）：@opentui/core 由 OpenCode 宿主在執行期提供，不在本專案 node_modules
    files: ['src/main/**/*.mjs'],
    plugins: { import: importPlugin },
    languageOptions: { sourceType: 'module', ecmaVersion: 2024, globals: { ...globals.node } },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': unused,
      'import/named': 'error',
      'import/no-unresolved': ['error', { ignore: ['^https?:', '^@opentui/core$'] }]
    }
  }
]
