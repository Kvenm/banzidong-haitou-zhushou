#!/usr/bin/env node
/**
 * 本地调试：从 data/db.json（勿提交）或环境变量 BOSS_COOKIE_JSON 读取 Cookie。
 * 勿在源码中粘贴真实 Cookie。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))

function loadCookies() {
  const env = process.env.BOSS_COOKIE_JSON?.trim()
  if (env) {
    try {
      return JSON.parse(env)
    } catch {
      console.error('BOSS_COOKIE_JSON 不是合法 JSON')
      process.exit(1)
    }
  }
  const dbPath = path.join(root, 'data', 'db.json')
  try {
    const db = JSON.parse(readFileSync(dbPath, 'utf8'))
    const raw = db.auth?.bossCookieJson
    if (raw && String(raw).trim()) return JSON.parse(String(raw))
  } catch {
    //
  }
  return null
}

const userCookies = loadCookies()
if (!userCookies?.length) {
  console.error(
    '未找到 Cookie：请在 Web 里保存登录态生成 data/db.json，或导出后执行：\n  BOSS_COOKIE_JSON=\'[{"name":"wt2",...}]\' node test-user-cookie.mjs'
  )
  process.exit(1)
}

console.log('=== 测试用户 Cookie ===\n')

async function testCookie() {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    defaultViewport: { width: 1280, height: 800 }
  })

  const page = await browser.newPage()

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  )

  await page.setCookie(...userCookies)
  console.log('✓ Cookie 已设置')

  console.log('正在访问 BOSS 首页...')
  await page.goto('https://www.zhipin.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })

  await new Promise((resolve) => setTimeout(resolve, 3000))

  const url = page.url()
  console.log(`当前页面: ${url}`)

  if (url.includes('login')) {
    console.log('\n❌ Cookie 无效 - 跳转到登录页')
    console.log('\n可能的原因:')
    console.log('1. Cookie 已过期（请在 BOSS 直聘重新登录后重新导出）')
    console.log('2. IP 地址变化导致 Cookie 失效')
    console.log('3. BOSS 检测到自动化行为')
  } else if (url.includes('security')) {
    console.log('\n⚠️  需要安全验证')
    console.log('请在浏览器中完成验证')
  } else {
    console.log('\n✅ Cookie 有效！')

    try {
      const info = await page.evaluate(() => {
        const nameEl = document.querySelector('.user-nav-name')
        return {
          userName: nameEl ? nameEl.textContent.trim() : null,
          hasNav: !!document.querySelector('.user-nav')
        }
      })

      if (info.userName) {
        console.log(`✓ 登录用户: ${info.userName}`)
      }

      console.log('\n正在测试打开职位页...')
      const jobUrl = 'https://www.zhipin.com/job_detail/33c81237592c52cc1nJ_3Nm5EVNR.html'
      await page.goto(jobUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      })

      await new Promise((resolve) => setTimeout(resolve, 5000))

      const currentJobUrl = page.url()
      console.log(`职位页 URL: ${currentJobUrl}`)

      if (jobUrl.includes('login')) {
        console.log('❌ 职位页跳转到登录页')
      } else {
        const buttonText = await page.evaluate(() => {
          const btn = document.querySelector('.job-detail-box .op-btn.op-btn-chat')
          return btn ? btn.innerHTML.trim() : null
        })

        if (buttonText) {
          console.log(`✓ 找到沟通按钮: "${buttonText}"`)

          if (buttonText === '立即沟通') {
            console.log('✅ 状态: 可以投递')
          } else if (buttonText === '待沟通') {
            console.log('✅ 状态: 已投递，等待回复')
          }
        } else {
          console.log('⚠️  未找到沟通按钮')
        }
      }
    } catch (e) {
      console.log('⚠️  无法获取详细信息:', e.message)
    }
  }

  console.log('\n浏览器将保持打开 20 秒供你检查...')
  setTimeout(() => {
    console.log('测试完成')
    browser.close()
  }, 20000)
}

testCookie().catch(console.error)
