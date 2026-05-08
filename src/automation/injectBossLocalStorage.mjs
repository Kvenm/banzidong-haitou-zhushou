import { addLogEntry } from '../store.js'

/**
 * 与 GeekGeekRun setDomainLocalStorage 一致：在 zhipin.com 源下写入 localStorage（风控/会话常依赖此项）
 * @param {import('puppeteer').Browser} browser
 * @param {Record<string, unknown>} kv - 键值一般为 string；非 string 会 JSON.stringify
 */
export async function injectBossLocalStorage(browser, kv) {
  if (!kv || typeof kv !== 'object' || Array.isArray(kv)) return
  const n = Object.keys(kv).length
  if (n === 0) return

  const page = await browser.newPage()
  try {
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      void req.respond({ status: 200, contentType: 'text/plain', body: ':)' })
    })
    await page.goto('https://www.zhipin.com/desktop/', { timeout: 45000, waitUntil: 'domcontentloaded' })
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
    await addLogEntry('info', `已注入 BOSS localStorage（${Object.keys(kv).length} 项），与 Geek 流程对齐`)
  } catch (e) {
    await addLogEntry('warning', `localStorage 注入失败（可仅依赖 Cookie 继续）：${e?.message ?? e}`)
  } finally {
    await page.close().catch(() => {})
  }
}
