#!/usr/bin/env node

import puppeteer from 'puppeteer'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 读取用户 Cookie
const db = JSON.parse(await readFile('/Users/kven/Desktop/Project/海投助手/haitou-assistant-next/data/db.json', 'utf-8'))
const cookieJson = db.auth.bossCookieJson
const cookies = JSON.parse(cookieJson)

console.log('=== 模拟真实投递测试 ===\n')
console.log(`使用 ${cookies.length} 个 Cookie`)

async function testApply() {
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

  // 反检测
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5]
    })
  })

  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

  // 清理并设置 Cookie
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

  // 步骤 1: 访问首页
  console.log('\n步骤 1: 访问 BOSS 首页')
  await page.goto('https://www.zhipin.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })
  await new Promise(resolve => setTimeout(resolve, 2000))

  let url = page.url()
  console.log(`当前页面: ${url}`)

  if (url.includes('login')) {
    console.log('❌ 首页跳转到登录页 - Cookie 无效')
    await browser.close()
    return
  }
  console.log('✓ 首页访问成功')

  // 步骤 2: 打开职位详情页
  console.log('\n步骤 2: 打开职位详情页')
  const jobUrl = 'https://www.zhipin.com/job_detail/33c81237592c52cc1nJ_3Nm5EVNR.html'
  console.log(`职位 URL: ${jobUrl}`)

  try {
    await page.goto(jobUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    console.log('✓ page.goto() 完成')
  } catch (gotoError) {
    console.log(`⚠️  page.goto() 超时: ${gotoError.message}`)
    console.log('继续等待页面加载...')
  }

  await new Promise(resolve => setTimeout(resolve, 5000))

  url = page.url()
  console.log(`当前页面: ${url}`)

  if (url.includes('login')) {
    console.log('❌ 职位页跳转到登录页')
    await browser.close()
    return
  }
  console.log('✓ 职位页访问成功')

  // 步骤 3: 检查按钮
  console.log('\n步骤 3: 检查页面和按钮')
  try {
    const pageInfo = await page.evaluate(() => {
      // 检查多个可能的按钮选择器
      const selectors = [
        '.job-detail-box .op-btn.op-btn-chat',
        '.job-detail-footer .btn-startchat',
        '.btn-chat',
        '[class*="chat"]'
      ]

      const found = []
      selectors.forEach(sel => {
        const els = document.querySelectorAll(sel)
        if (els.length > 0) {
          found.push({ selector: sel, count: els.length })
        }
      })

      const btn = document.querySelector('.job-detail-box .op-btn.op-btn-chat')
      return {
        buttonText: btn ? btn.innerHTML.trim() : null,
        hasButton: !!btn,
        title: document.title,
        foundSelectors: found,
        bodyText: document.body ? document.body.textContent.substring(0, 200) : null
      }
    })

    console.log(`页面标题: ${pageInfo.title}`)
    console.log(`找到的主要按钮: ${pageInfo.hasButton}`)
    console.log(`按钮文字: ${pageInfo.buttonText}`)
    console.log(`找到的其他选择器: ${JSON.stringify(pageInfo.foundSelectors)}`)

    // 如果没有找到按钮，输出页面内容帮助调试
    if (!pageInfo.hasButton) {
      console.log('\n⚠️  未找到沟通按钮，页面内容预览:')
      console.log(pageInfo.bodyText)
    }

    if (pageInfo.buttonText === '立即沟通') {
      console.log('✅ 状态: 可以投递')

      // 测试点击
      console.log('\n步骤 4: 测试点击"立即沟通"')
      await page.click('.job-detail-box .op-btn.op-btn-chat')
      await new Promise(resolve => setTimeout(resolve, 2000))

      const hasDialog = await page.evaluate(() => {
        return !!document.querySelector('.greet-boss-dialog')
      })

      if (hasDialog) {
        console.log('✓ 成功弹出招呼对话框')
        console.log('\n✅✅✅ 测试成功！可以正常投递 ✅✅✅')
      } else {
        console.log('⚠️  未弹出对话框，可能有其他弹窗')
      }
    } else if (pageInfo.buttonText === '待沟通') {
      console.log('✅ 状态: 已投递')
    } else {
      console.log(`⚠️  未知状态: ${pageInfo.buttonText}`)
    }
  } catch (e) {
    console.log(`检查失败: ${e.message}`)
  }

  console.log('\n浏览器将保持打开 15 秒供你检查...')
  setTimeout(() => {
    browser.close()
    console.log('\n测试完成')
  }, 15000)
}

testApply().catch(console.error)
