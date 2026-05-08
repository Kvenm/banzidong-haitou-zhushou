#!/usr/bin/env node

import puppeteer from 'puppeteer'
import { readFile } from 'node:fs/promises'

const db = JSON.parse(await readFile('/Users/kven/Desktop/Project/海投助手/haitou-assistant-next/data/db.json', 'utf-8'))
const cookies = JSON.parse(db.auth.bossCookieJson)

console.log('=== 通过首页导航测试 ===\n')

async function test() {
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
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
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
    sameSite: 'Lax'
  }))
  await page.setCookie(...cleanCookies)
  console.log('✓ Cookie 已设置')

  // 步骤 1: 访问首页并等待
  console.log('\n步骤 1: 访问首页')
  await page.goto('https://www.zhipin.com/web/geek/job?query=测试工程师&city=101210100', {
    waitUntil: 'networkidle2',
    timeout: 30000
  })
  await new Promise(resolve => setTimeout(resolve, 3000))

  console.log(`首页 URL: ${page.url()}`)
  console.log('✓ 首页加载成功')

  // 步骤 2: 在首页中找到职位链接并点击
  console.log('\n步骤 2: 查找职位链接')
  const jobLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="job_detail/"]'))
    return links.slice(0, 3).map(a => ({
      href: a.href,
      text: a.textContent.substring(0, 50)
    }))
  })

  console.log(`找到 ${jobLinks.length} 个职位链接`)
  jobLinks.forEach((link, i) => {
    console.log(`  ${i+1}. ${link.text}...`)
  })

  if (jobLinks.length > 0) {
    console.log('\n步骤 3: 点击第一个职位')
    await page.evaluate((url) => {
      window.location.href = url
    }, jobLinks[0].href)

    await new Promise(resolve => setTimeout(resolve, 5000))

    console.log(`职位页 URL: ${page.url()}`)

    // 检查按钮
    const buttonInfo = await page.evaluate(() => {
      const btn = document.querySelector('.job-detail-box .op-btn.op-btn-chat')
      return {
        hasButton: !!btn,
        buttonText: btn ? btn.innerHTML.trim() : null,
        title: document.title
      }
    })

    console.log(`页面标题: ${buttonInfo.title}`)
    console.log(`找到按钮: ${buttonInfo.hasButton}`)
    console.log(`按钮文字: ${buttonInfo.buttonText}`)

    if (buttonInfo.buttonText === '立即沟通') {
      console.log('\n✅✅✅ 成功！可以投递 ✅✅✅')
    } else if (buttonInfo.buttonText === '待沟通') {
      console.log('\n✅ 已投递')
    }
  }

  console.log('\n浏览器将保持打开 20 秒...')
  setTimeout(() => {
    browser.close()
    console.log('\n测试完成')
  }, 20000)
}

test().catch(console.error)
