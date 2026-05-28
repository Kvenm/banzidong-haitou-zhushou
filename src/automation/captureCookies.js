import { addLogEntry, updateDb, addLog } from '../store.js'
import { launchBossBrowser } from './launchBossBrowser.mjs'
import { resolveBossPuppeteer, waitThroughBossSecurityCheck } from './bossPuppeteer.mjs'

/** 从主站进入，避免 login.zhipin.com 子域在自动化浏览器里黑屏 */
const BOSS_ENTRY_URL = 'https://www.zhipin.com/web/geek/job'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function isLoginUrl(url) {
  return /login|passport|signin/i.test(url)
}

function hasBossSessionCookies(cookies) {
  return (
    cookies.length > 5 &&
    cookies.some((c) => c.name === 'wt2' || c.name === '__zp_stoken__' || c.name === 'bst')
  )
}

async function readLocalStorageJson(page) {
  try {
    const kv = await page.evaluate(() => {
      const out = {}
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i)
        if (k) out[k] = localStorage.getItem(k)
      }
      return out
    })
    const text = JSON.stringify(kv)
    return text.length > 2 ? text : ''
  } catch {
    return ''
  }
}

export async function captureCookies() {
  await addLogEntry('info', '正在启动浏览器…请在弹出窗口中登录 BOSS（推荐扫码）')

  const { puppeteer } = await resolveBossPuppeteer()

  let browser
  try {
    browser = await launchBossBrowser(puppeteer, {
      defaultViewport: { width: 1280, height: 900 }
    })
  } catch (e) {
    await addLogEntry('error', `浏览器启动失败：${e.message}`)
    return
  }

  let loginChecked = false
  let checkLogin = null

  const finish = async () => {
    if (checkLogin) clearInterval(checkLogin)
    await browser?.close().catch(() => {})
  }

  try {
    for (const p of await browser.pages()) {
      await p.close().catch(() => {})
    }
    const page = await browser.newPage()
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    )

    await addLogEntry('info', '正在打开 BOSS 主站（避免登录子域黑屏）…')
    await page.goto(BOSS_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    await sleep(2000)
    await waitThroughBossSecurityCheck(page)

    const startUrl = page.url()
    if (isLoginUrl(startUrl)) {
      await addLogEntry(
        'info',
        '当前为登录页：若短暂黑屏请等待几秒，或切换「APP扫码登录」；登录成功前请勿关闭浏览器'
      )
    } else {
      await addLogEntry('info', '若未登录，请在页面右上角点击「登录」并完成扫码')
    }

    checkLogin = setInterval(async () => {
      if (loginChecked) return
      try {
        if (page.isClosed()) {
          clearInterval(checkLogin)
          return
        }

        const url = page.url()
        if (isLoginUrl(url)) return
        if (!url.includes('zhipin.com')) return

        const cookies = await page.cookies()
        if (!hasBossSessionCookies(cookies)) return

        loginChecked = true
        clearInterval(checkLogin)

        const lsJson = await readLocalStorageJson(page)

        await updateDb((db) => {
          db.auth.bossCookieJson = JSON.stringify(cookies)
          if (lsJson) db.auth.bossLocalStorageJson = lsJson
          db.auth.savedAt = new Date().toISOString()
          db.auth.lastCheckAt = new Date().toISOString()
          db.auth.lastCheckResult = lsJson
            ? 'Cookie 与 LocalStorage 已通过浏览器自动捕获'
            : 'Cookie 已通过浏览器自动捕获'
          addLog(
            db,
            'success',
            `登录凭据已保存：${cookies.length} 个 Cookie${lsJson ? ' + LocalStorage' : ''}`
          )
        })

        await addLogEntry(
          'success',
          `✓ 登录成功！已保存 ${cookies.length} 个 Cookie${lsJson ? ' 与 LocalStorage' : ''}（含持久化浏览器配置），15 秒后关闭窗口`
        )

        await page.evaluate(() => {
          const banner = document.createElement('div')
          banner.id = '__haitou_cookie_toast'
          banner.style.cssText =
            'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:99999;' +
            'background:#4caf50;color:#fff;padding:14px 28px;border-radius:8px;' +
            'font-size:16px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,.3);' +
            'display:flex;align-items:center;gap:10px;animation:__haitouFadeIn .3s ease;'
          banner.innerHTML =
            '<span style="font-size:22px;">&#10003;</span> 登录凭据已自动保存，窗口将在 15 秒后自动关闭'
          const style = document.createElement('style')
          style.textContent =
            '@keyframes __haitouFadeIn{from{opacity:0;transform:translateX(-50%) translateY(-10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}'
          document.head.appendChild(style)
          document.body.appendChild(banner)
        }).catch(() => {})

        setTimeout(() => {
          browser.close().catch(() => {})
        }, 15000)
      } catch (error) {
        if (!String(error.message).includes('Session closed')) {
          console.error('检查登录状态失败:', error.message)
        }
      }
    }, 2000)

    setTimeout(async () => {
      if (!loginChecked) {
        clearInterval(checkLogin)
        await addLogEntry('warning', '等待登录超时（30 分钟），浏览器已关闭')
        await finish()
      }
    }, 30 * 60 * 1000)
  } catch (e) {
    await addLogEntry('error', `Cookie 捕获异常：${e.message}`)
    await finish()
  }
}
