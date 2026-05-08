#!/usr/bin/env node

import puppeteer from 'puppeteer'

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

  console.log('\n4. 设置 Cookie 后重新访问')

  // 设置你的 Cookie
  const testCookies = [
    {
      name: "wt2",
      value: "DMajDYtnk5Y8eryQ7VJxP9ZChgOwXThcX-5DNY05w9L0jubMXHhmS8EFmLpzi1y6KekvW4RBoqEN-SbKjXIWCCA~~",
      domain: ".zhipin.com",
      path: "/"
    },
    {
      name: "__zp_stoken__",
      value: "3ac4gOkXDl8K5w7fCuUA2cE46KU5GTTpFOERPOkV5NDlFOkdBTifClcOHw5HCm8ORbcOXYsOBOyg4RkE6RU5GRk8YOEI5RUVHRznDhEM5OcKhOzUbwqzCucOdwpjDk27DiQl5C0cVP8OFC8S4wrkJPMK4KiluZlkJYh0dbBNiHxMJFxISElsUZRxkbRMQHxJZERUVEicmTMKlw4FHw4%2FDh8OOOsOBwo7DgkXDjEc5OUUqOznCqUMaTEdHOkI6xLjEuMWExLvFhcS4xLjFhMOTxIbDrMS4xYTEu8OGxLjEuMWEw7vDpsS4xLjFhMS7xIfCuT86wpHDh8KWxIrFjcSKw7bEp8KYwrrDqsK5w7fDhcOCwqfCi8KywpzCq8OEwqVcw4JeUMKWYMOBwoBiwrnDjVrDj8K6wr54wqhgw4BvZlLDjFt0acOAXcOHahMRYmccRRHCmGfDiA%3D%3D",
      domain: ".zhipin.com",
      path: "/"
    }
  ]

  await page.setCookie(...testCookies)
  console.log('   ✓ Cookie 已设置')

  await page.goto('https://www.zhipin.com/web/geek/job?query=测试工程师', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  })

  await new Promise(resolve => setTimeout(resolve, 3000))

  console.log(`   ✓ URL: ${page.url()}`)
  console.log(`   ✓ 标题: ${await page.title()}`)

  // 检查是否有登录状态
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

  console.log('\n浏览器将保持打开 15 秒...')
  setTimeout(() => {
    browser.close()
    console.log('\n测试完成')
  }, 15000)
}

test().catch(console.error)
