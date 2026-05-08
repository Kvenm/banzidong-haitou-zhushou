import { addLogEntry, updateDb } from '../store.js'

export async function captureCookies() {
  let puppeteer
  try {
    puppeteer = (await import('puppeteer')).default
  } catch {
    await addLogEntry('error', 'Puppeteer 未安装，请运行: npm install puppeteer')
    return
  }

  await addLogEntry('info', '正在启动浏览器...请手动登录 BOSS 直聘')

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ],
    defaultViewport: {
      width: 1280,
      height: 800
    }
  })

  const page = await browser.newPage()

  // 设置用户代理
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36')

  // 监听页面变化，检测登录状态
  let loginChecked = false

  // 每2秒检查一次是否登录成功
  const checkLogin = setInterval(async () => {
    if (loginChecked) return

    try {
      const url = page.url()

      // 如果在登录页，等待用户操作
      if (url.includes('login') || url.includes('passport')) {
        // 登录页，继续等待
        return
      }

      // 如果已登录，获取 Cookie
      const cookies = await page.cookies()

      // 检查关键 Cookie
      const hasKeyCookie = cookies.some(c =>
        c.name === 'wt2' || c.name === '__zp_stoken__'
      )

      if (hasKeyCookie && cookies.length > 5) {
        loginChecked = true
        clearInterval(checkLogin)

        await addLogEntry('success', `✓ 检测到登录成功！已捕获 ${cookies.length} 个 Cookie`)

        // 保存 Cookie
        await updateDb((db) => {
          db.auth.bossCookieJson = JSON.stringify(cookies)
          db.auth.savedAt = new Date().toISOString()
          db.auth.lastCheckAt = new Date().toISOString()
          db.auth.lastCheckResult = 'Cookie 已通过浏览器自动捕获'
          addLog(db, 'success', `Cookie 已保存：${cookies.length} 个`)
        })

        await addLogEntry('success', '✓ Cookie 已保存！浏览器将在 5 秒后自动关闭')

        // 5秒后自动关闭浏览器
        setTimeout(() => {
          browser.close()
        }, 5000)
      }
    } catch (error) {
      // 忽略检查过程中的错误，继续等待
      console.error('检查登录状态失败:', error.message)
    }
  }, 2000)

  // 打开 BOSS 登录页
  try {
    await page.goto('https://login.zhipin.com/?ka=header-login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
  } catch (error) {
    await addLogEntry('warning', `页面加载超时，但浏览器已打开，请手动操作`)
  }

  // 等待页面稳定
  await new Promise(resolve => setTimeout(resolve, 2000))

  await addLogEntry('info', '请在打开的浏览器中完成登录...')

  // 30分钟后自动关闭
  setTimeout(() => {
    clearInterval(checkLogin)
    browser.close()
    if (!loginChecked) {
      addLogEntry('warning', '等待登录超时，浏览器已关闭')
    }
  }, 30 * 60 * 1000)
}
