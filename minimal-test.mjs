#!/usr/bin/env node
/**
 * 最小 Puppeteer 测试。若存在本机 data/db.json 或 BOSS_COOKIE_JSON，则再测登录态；勿在源码中写真实 Cookie。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))

function loadTestCookies() {
  const env = process.env.BOSS_COOKIE_JSON?.trim()
  if (env) {
    try {
      return JSON.parse(env)
    } catch {
      return null
    }
  }
  try {
    const dbPath = path.join(root, 'data', 'db.json')
    const db = JSON.parse(readFileSync(dbPath, 'utf8'))
    const raw = db.auth?.bossCookieJson
    if (raw && String(raw).trim()) return JSON.parse(String(raw))
  } catch {
    //
  }
  return null
}

console.log('=== 最简单的测试 ===\n')

async function test() {
  console.log('1. 启动浏览器（最小配置）')
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox']
  })

  console.log('2. 创建页面')
  const page = await browser.newPage()

  console.log('3. 访问 BOSS 首页（无 Cookie）')
  await page.goto('https://www.zhipin.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  })

  console.log(`   ✓ URL: ${page.url()}`)
  console.log(`   ✓ 标题: ${await page.title()}`)

  const testCookies = loadTestCookies()
  if (!testCookies?.length) {
    console.log('\n4. 跳过：无 data/db.json / BOSS_COOKIE_JSON，不测试登录 Cookie')
  } else {
    console.log('\n4. 使用本机 db 或环境变量中的 Cookie 后重新访问')

    await page.setCookie(...testCookies)
    console.log('   ✓ Cookie 已设置')

    await page.goto('https://www.zhipin.com/web/geek/job?query=测试工程师', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })

    await new Promise((resolve) => setTimeout(resolve, 3000))

    console.log(`   ✓ URL: ${page.url()}`)
    console.log(`   ✓ 标题: ${await page.title()}`)

    const isLoggedIn = await page.evaluate(() => {
      const userNav = document.querySelector('.user-nav')
      const loginBtn = document.querySelector('.btn-login')
      return {
        hasUserNav: !!userNav,
        hasLoginBtn: !!loginBtn
      }
    })

    console.log(`   ✓ 用户导航: ${isLoggedIn.hasUserNav}`)
    console.log(`   ✓ 登录按钮: ${isLoggedIn.hasLoginBtn}`)

    if (!isLoggedIn.hasLoginBtn) {
      console.log('\n✅✅✅ Cookie 有效！已登录状态 ✅✅✅')
    } else {
      console.log('\n❌ Cookie 无效，未登录')
    }
  }

  console.log('\n浏览器将保持打开 15 秒...')
  setTimeout(() => {
    browser.close()
    console.log('\n测试完成')
  }, 15000)
}

test().catch(console.error)
