#!/usr/bin/env node

import puppeteer from 'puppeteer'

const userCookies = [
    {
        "name": "__a",
        "value": "23897323.1777798500.1778163659.1778164550.42.7.1.42",
        "domain": ".zhipin.com",
        "path": "/",
        "httpOnly": false,
        "secure": false,
        "sameSite": "Lax"
    },
    {
        "name": "__zp_stoken__",
        "value": "3ac4gOkXDl8K5w7fCuUA2cE46KU5GTTpFOERPOkV5NDlFOkdBTifClcOHw5HCm8ORbcOXYsOBOyg4RkE6RU5GRk8YOEI5RUVHRznDhEM5OcKhOzUbwqzCucOdwpjDk27DiQl5C0cVP8OFC8S4wrkJPMK4KiluZlkJYh0dbBNiHxMJFxISElsUZRxkbRMQHxJZERUVEicmTMKlw4FHw4%2FDh8OOOsOBwo7DgkXDjEc5OUUqOznCqUMaTEdHOkI6xLjEuMWExLvFhcS4xLjFhMOTxIbDrMS4xYTEu8OGxLjEuMWEw7vDpsS4xLjFhMS7xIfCuT86wpHDh8KWxIrFjcSKw7bEp8KYwrrDqsK5w7fDhcOCwqfCi8KywpzCq8OEwqVcw4JeUMKWYMOBwoBiwrnDjVrDj8K6wr54wqhgw4BvZlLDjFt0acOAXcOHahMRYmccRRHCmGfDiA%3D%3D",
        "domain": ".zhipin.com",
        "path": "/",
        "httpOnly": false,
        "secure": false,
        "sameSite": "Lax"
    },
    {
        "name": "wt2",
        "value": "DMajDYtnk5Y8eryQ7VJxP9ZChgOwXThcX-5DNY05w9L0jubMXHhmS8EFmLpzi1y6KekvW4RBoqEN-SbKjXIWCCA~~",
        "domain": ".zhipin.com",
        "path": "/",
        "httpOnly": true,
        "secure": false,
        "sameSite": "Lax"
    },
    {
        "name": "zp_at",
        "value": "dRV9pqjuzJ0ejdfVWPCFVsm7LDHkDOVjVweClkyTFh4~",
        "domain": ".zhipin.com",
        "path": "/",
        "httpOnly": true,
        "secure": false,
        "sameSite": "Lax"
    },
    {
        "name": "lastCity",
        "value": "101210100",
        "domain": ".zhipin.com",
        "path": "/",
        "httpOnly": false,
        "secure": false,
        "sameSite": "Lax"
    }
]

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

  // 反检测
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

  // 设置 Cookie
  await page.setCookie(...userCookies)
  console.log('✓ Cookie 已设置')

  // 访问 BOSS 首页
  console.log('正在访问 BOSS 首页...')
  await page.goto('https://www.zhipin.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 15000
  })

  await new Promise(resolve => setTimeout(resolve, 3000))

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

    // 尝试获取用户信息
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

      // 测试打开一个职位页
      console.log('\n正在测试打开职位页...')
      const jobUrl = 'https://www.zhipin.com/job_detail/33c81237592c52cc1nJ_3Nm5EVNR.html'
      await page.goto(jobUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      })

      await new Promise(resolve => setTimeout(resolve, 5000))

      const currentJobUrl = page.url()
      console.log(`职位页 URL: ${currentJobUrl}`)

      if (jobUrl.includes('login')) {
        console.log('❌ 职位页跳转到登录页')
      } else {
        // 检查按钮
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
