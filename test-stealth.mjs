#!/usr/bin/env node

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { readFile } from 'node:fs/promises'

puppeteer.use(StealthPlugin())

console.log('=== 使用 Stealth 插件测试 ===\n')

async function test() {
  console.log('1. 启动浏览器（带 stealth 插件）')
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox']
  })

  const page = await browser.newPage()

  // 读取 Cookie
  const db = JSON.parse(await readFile('/Users/kven/Desktop/Project/海投助手/haitou-assistant-next/data/db.json', 'utf-8'))
  const cookies = JSON.parse(db.auth.bossCookieJson)

  const cleanCookies = cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/'
  }))

  console.log('2. 设置 Cookie')
  await page.setCookie(...cleanCookies)
  console.log('   ✓ Cookie 已设置')

  console.log('3. 访问职位详情页')
  const jobUrl = 'https://www.zhipin.com/job_detail/33c81237592c52cc1nJ_3Nm5EVNR.html'

  await page.goto(jobUrl, {
    waitUntil: 'networkidle2',
    timeout: 30000
  })

  await new Promise(resolve => setTimeout(resolve, 5000))

  const url = page.url()
  console.log(`   当前页面: ${url}`)

  if (url.includes('security-check')) {
    console.log('   ❌ 仍然跳转到安全检查页面')
    console.log('   说明：stealth 插件可能不够，或者需要手动完成验证')
  } else if (url.includes('login')) {
    console.log('   ❌ 跳转到登录页，Cookie 无效')
  } else {
    console.log('   ✅ 页面加载成功！')

    // 检查按钮
    const pageInfo = await page.evaluate(() => {
      const btn = document.querySelector('.job-detail-box .op-btn.op-btn-chat')
      return {
        hasButton: !!btn,
        buttonText: btn ? btn.innerHTML.trim() : null,
        title: document.title
      }
    })

    console.log(`   页面标题: ${pageInfo.title}`)
    console.log(`   找到按钮: ${pageInfo.hasButton}`)
    console.log(`   按钮文字: ${pageInfo.buttonText}`)

    if (pageInfo.buttonText === '立即沟通') {
      console.log('\n✅✅✅ 成功！可以投递 ✅✅✅')
    } else if (pageInfo.buttonText === '待沟通') {
      console.log('\n✅ 已投递状态')
    }
  }

  console.log('\n浏览器将保持打开 20 秒...')
  setTimeout(() => {
    browser.close()
    console.log('\n测试完成')
  }, 20000)
}

test().catch(console.error)
