#!/usr/bin/env node

import puppeteer from 'puppeteer'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_FILE = path.join(__dirname, '../data/db.json')

console.log('=== Cookie 有效性测试 ===\n')

// 读取保存的 Cookie
const db = JSON.parse(await readFile(DB_FILE, 'utf-8'))
const cookieJson = db.auth?.bossCookieJson

if (!cookieJson) {
  console.log('❌ 未找到 Cookie，请先在 http://127.0.0.1:4173 保存 Cookie')
  process.exit(1)
}

let cookies
try {
  cookies = JSON.parse(cookieJson)
  console.log(`✓ 找到 ${cookies.length} 个 Cookie`)
} catch {
  console.log('❌ Cookie 格式错误')
  process.exit(1)
}

// 启动浏览器测试
console.log('\n正在启动浏览器...')

const browser = await puppeteer.launch({
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled'
  ],
  ignoreDefaultArgs: ['--enable-automation']
})

const page = await browser.newPage()

// 反检测
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined
  })
})

await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

// 设置 Cookie
const cleanCookies = cookies.map(c => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path || '/',
  httpOnly: c.httpOnly || false,
  secure: c.secure || false,
  sameSite: c.sameSite || 'Lax'
}))
await page.setCookie(...cleanCookies)

console.log('✓ Cookie 已设置')
console.log('\n正在打开 BOSS 首页验证...')

// 打开 BOSS 首页
try {
  await page.goto('https://www.zhipin.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })
} catch {
  console.log('⚠️  页面加载超时')
}

await new Promise(resolve => setTimeout(resolve, 3000))

const currentUrl = page.url()
console.log(`\n当前页面: ${currentUrl}`)

if (currentUrl.includes('login')) {
  console.log('\n❌ Cookie 已失效！')
  console.log('请重新获取 Cookie:')
  console.log('1. 访问 https://www.zhipin.com 并登录')
  console.log('2. 使用 F12 → Application → Cookies 导出')
  console.log('3. 粘贴到 http://127.0.0.1:4173')
} else if (currentUrl.includes('security')) {
  console.log('\n⚠️  需要安全验证')
  console.log('请在浏览器中完成验证')
} else {
  console.log('\n✅ Cookie 有效！')

  // 检查是否能看到用户信息
  try {
    const userInfo = await page.evaluate(() => {
      const nameEl = document.querySelector('.user-nav-name')
      return nameEl ? nameEl.textContent.trim() : null
    })

    if (userInfo) {
      console.log(`✓ 登录用户: ${userInfo}`)
    } else {
      console.log('⚠️  未找到用户信息，但未跳转到登录页')
    }
  } catch {
    console.log('⚠️  无法检测用户信息')
  }
}

console.log('\n浏览器将保持打开 30 秒供你检查...')
console.log('如果 Cookie 有效，请手动检查页面是否正常')
console.log('按 Ctrl+C 可提前关闭\n')

setTimeout(() => {
  console.log('测试完成，浏览器将关闭...')
  browser.close()
}, 30000)
