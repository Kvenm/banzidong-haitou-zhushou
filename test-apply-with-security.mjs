#!/usr/bin/env node

import puppeteer from 'puppeteer'
import { readFile } from 'node:fs/promises'

async function testApplyWithSecurityCheck() {
  const db = JSON.parse(await readFile('/Users/kven/Desktop/Project/海投助手/haitou-assistant-next/data/db.json', 'utf-8'))
  const cookies = JSON.parse(db.auth.bossCookieJson)

  const cleanCookies = cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/'
  }))

  console.log('=== 测试投递（包含安全检查处理）===\n')

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox']
  })

  const page = await browser.newPage()
  await page.setCookie(...cleanCookies)
  console.log('✓ Cookie 已设置')

  const jobUrl = 'https://www.zhipin.com/job_detail/33c81237592c52cc1nJ_3Nm5EVNR.html'
  console.log(`\n正在打开: ${jobUrl}`)

  await page.goto(jobUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  })

  await new Promise(resolve => setTimeout(resolve, 3000))

  let url = page.url()
  console.log(`当前页面: ${url}`)

  // 检查是否遇到安全检查
  if (url.includes('security-check') || url.includes('security')) {
    console.log('\n⚠️  遇到安全检查页面')
    console.log('请在浏览器中完成验证（滑块、点击等）')
    console.log('程序将等待最多60秒...\n')

    // 等待用户完成验证
    let checkPassed = false
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      const newUrl = page.url()

      if (!newUrl.includes('security-check') && !newUrl.includes('security')) {
        checkPassed = true
        console.log('✓ 安全检查已完成！')
        await new Promise(resolve => setTimeout(resolve, 3000))
        break
      }

      process.stdout.write(`等待中... ${i * 2}/${60}秒\r`)
    }

    if (!checkPassed) {
      console.log('\n❌ 安全检查超时')
      await browser.close()
      return
    }

    // 重新获取当前 URL
    url = page.url()
  }

  if (url.includes('login')) {
    console.log('❌ Cookie 无效，跳转到登录页')
    await browser.close()
    return
  }

  console.log(`\n最终页面: ${url}`)

  // 检查按钮
  const pageInfo = await page.evaluate(() => {
    const btn = document.querySelector('.job-detail-box .op-btn.op-btn-chat')
    return {
      hasButton: !!btn,
      buttonText: btn ? btn.innerHTML.trim() : null,
      title: document.title
    }
  })

  console.log(`页面标题: ${pageInfo.title}`)
  console.log(`找到按钮: ${pageInfo.hasButton}`)
  console.log(`按钮文字: ${pageInfo.buttonText}`)

  if (pageInfo.buttonText === '立即沟通') {
    console.log('\n✅ 可以投递！')
    console.log('浏览器将保持打开 30 秒供你查看...')
    setTimeout(() => {
      browser.close()
      console.log('\n测试完成')
    }, 30000)
  } else if (pageInfo.buttonText === '待沟通') {
    console.log('\n✅ 已投递状态')
    await browser.close()
  } else {
    console.log('\n⚠️  未找到沟通按钮或状态未知')
    console.log('浏览器将保持打开 30 秒供你检查...')
    setTimeout(() => {
      browser.close()
      console.log('\n测试完成')
    }, 30000)
  }
}

testApplyWithSecurityCheck().catch(console.error)
