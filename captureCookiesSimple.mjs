#!/usr/bin/env node

import puppeteer from 'puppeteer'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const COOKIE_FILE = path.join(__dirname, '../data/cookies.json')

console.log('正在启动浏览器...')
console.log('请使用手机 BOSS 直聘 APP 扫码登录')

const browser = await puppeteer.launch({
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-web-security'
  ],
  defaultViewport: {
    width: 1280,
    height: 800
  }
})

const page = await browser.newPage()

// 设置用户代理
await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36')

// 打开登录页
await page.goto('https://login.zhipin.com/?ka=header-login', {
  waitUntil: 'domcontentloaded'
})

console.log('等待登录...')

// 等待登录成功的标志
let loginSuccess = false

// 监听登录成功
const checkLogin = setInterval(async () => {
  if (loginSuccess) return

  try {
    const url = page.url()

    // 如果不再在登录页，说明登录成功
    if (!url.includes('login') && !url.includes('passport')) {
      const cookies = await page.cookies()

      // 检查关键 Cookie
      const hasKeyCookie = cookies.some(c =>
        c.name === 'wt2' || c.name === '__zp_stoken__'
      )

      if (hasKeyCookie && cookies.length > 5) {
        loginSuccess = true
        clearInterval(checkLogin)

        console.log(`✓ 登录成功！已捕获 ${cookies.length} 个 Cookie`)

        // 保存 Cookie
        await writeFile(COOKIE_FILE, JSON.stringify(cookies, null, 2))
        console.log(`✓ Cookie 已保存到: ${COOKIE_FILE}`)
        console.log('✓ 请复制 Cookie JSON 到 http://127.0.0.1:4173 的「BOSS 登录态」页面')

        console.log('浏览器将在 5 秒后关闭...')

        // 5秒后关闭浏览器
        setTimeout(() => {
          browser.close()
        }, 5000)
      }
    }
  } catch (error) {
    console.error('检查登录状态失败:', error.message)
  }
}, 2000)

// 30分钟后超时
setTimeout(() => {
  clearInterval(checkLogin)
  if (!loginSuccess) {
    console.log('等待登录超时，浏览器已关闭')
    browser.close()
  }
}, 30 * 60 * 1000)
