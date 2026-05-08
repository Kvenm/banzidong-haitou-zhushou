#!/usr/bin/env node

import puppeteer from 'puppeteer'

console.log('=== 简单 Puppeteer 测试 ===\n')

async function test() {
  console.log('1. 启动浏览器...')
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox']
  })

  console.log('2. 创建页面...')
  const page = await browser.newPage()

  console.log('3. 访问 BOSS 首页...')
  try {
    await page.goto('https://www.zhipin.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    console.log(`   ✓ 页面加载成功: ${page.url()}`)

    await new Promise(resolve => setTimeout(resolve, 3000))

    const title = await page.title()
    console.log(`   ✓ 页面标题: ${title}`)

  } catch (error) {
    console.log(`   ✗ 页面加载失败: ${error.message}`)
  }

  console.log('\n浏览器将保持打开 10 秒...')
  setTimeout(() => {
    browser.close()
    console.log('测试完成')
  }, 10000)
}

test().catch(console.error)
