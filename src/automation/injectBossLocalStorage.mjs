import { addLogEntry } from '../store.js'

const BOSS_SESSION_URL = 'https://www.zhipin.com/web/geek/jobs'

/**
 * 在已打开的真实页面上写入 localStorage（不再拦截全部请求，避免黑屏）
 * @param {import('puppeteer').Page} page
 * @param {Record<string, unknown>} kv
 */
export async function injectBossLocalStorageOnPage(page, kv) {
  if (!kv || typeof kv !== 'object' || Array.isArray(kv)) return
  if (Object.keys(kv).length === 0) return

  const url = page.url()
  if (!url.includes('zhipin.com')) {
    await page.goto(BOSS_SESSION_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
  }

  await page.evaluate((entries) => {
    for (const k of Object.keys(entries)) {
      const v = entries[k]
      const str = typeof v === 'string' ? v : JSON.stringify(v)
      try {
        localStorage.setItem(k, str)
      } catch {
        //
      }
    }
  }, kv)

  await addLogEntry('info', `已注入 BOSS localStorage（${Object.keys(kv).length} 项）`)
}

/**
 * @param {import('puppeteer').Browser} browser
 * @param {Record<string, unknown>} kv
 */
export async function injectBossLocalStorage(browser, kv) {
  const page = await browser.newPage()
  try {
    await page.goto(BOSS_SESSION_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await injectBossLocalStorageOnPage(page, kv)
  } catch (e) {
    await addLogEntry('warning', `localStorage 注入失败（可仅依赖 Cookie 继续）：${e?.message ?? e}`)
  } finally {
    await page.close().catch(() => {})
  }
}
