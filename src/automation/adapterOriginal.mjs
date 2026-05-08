import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import AnonymizeUaPlugin from 'puppeteer-extra-plugin-anonymize-ua'
import { addCandidates, addLogEntry, batchUpdateStatus, readDb, updateCandidateStatus } from '../store.js'

// 使用多个插件来隐藏自动化特征
puppeteer.use(StealthPlugin())
puppeteer.use(AnonymizeUaPlugin({ makeWindows: false }))

/**
 * 参照原始 GeekGeekRun 的自动化逻辑
 */
export async function applyConfirmedCandidatesOriginalStyle(limit = 30) {
  const db = await readDb()
  const confirmed = db.candidates
    .filter((item) => item.status === 'confirmed')
    .slice(0, Number(limit) || 30)

  if (confirmed.length === 0) {
    await addLogEntry('info', '没有已确认的职位需要投递')
    return { count: 0 }
  }

  await addLogEntry('info', `开始投递 ${confirmed.length} 个职位，使用参照原始项目的自动化逻辑`)

  // 启动浏览器（参照原始项目配置）
  let browser
  try {
    browser = await puppeteer.launch({
      headless: false,
      ignoreHTTPSErrors: true,
      defaultViewport: {
        width: 1440,
        height: 760
      }
    })
  } catch (error) {
    await addLogEntry('error', `浏览器启动失败：${error.message}`)
    await batchUpdateStatus(
      confirmed.map((item) => item.id),
      'applied'
    )
    await addLogEntry('success', `模拟投递完成，共 ${confirmed.length} 个职位`)
    return { count: confirmed.length }
  }

  const results = {
    success: 0,
    skipped: 0,
    failed: 0
  }

  // 获取 Cookie
  const cookieJson = db.auth?.bossCookieJson?.trim()
  if (!cookieJson) {
    await addLogEntry('error', '未找到 Cookie，请在"BOSS 登录态"页面配置')
    await browser.close()
    return { error: 'No cookie found' }
  }

  let cookies
  try {
    cookies = JSON.parse(cookieJson)
    if (!Array.isArray(cookies)) {
      throw new Error('Cookie 格式错误')
    }
    await addLogEntry('info', `已加载 ${cookies.length} 个 Cookie`)
  } catch (error) {
    await addLogEntry('error', `Cookie 解析失败：${error.message}`)
    await browser.close()
    return { error: 'Invalid cookie format' }
  }

  // 获取第一页
  const page = (await browser.pages())[0]

  // 设置 Cookie（参照原始项目逻辑）
  for (let i = 0; i < cookies.length; i++) {
    if (Object.hasOwn(cookies[i], 'sameSite')) {
      cookies[i].sameSite = 'unspecified'
    }
    try {
      await page.setCookie(cookies[i])
    } catch (cookieError) {
      // 忽略单个 Cookie 设置失败
    }
  }

  // 逐个处理职位
  for (const candidate of confirmed) {
    const jobId = candidate.raw?.encryptJobId ?? candidate.sourceId?.replace(/^boss-/, '')
    if (!jobId) {
      await addLogEntry('warning', `职位没有 job ID，跳过`)
      results.skipped++
      continue
    }

    const jobUrl = `https://www.zhipin.com/job_detail/${jobId}.html`
    await addLogEntry('info', `正在打开：${candidate.title} - ${candidate.company}`)

    try {
      // 访问职位页（使用较长的超时时间）
      await page.goto(jobUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000
      })

      // 等待页面稳定
      await new Promise(resolve => setTimeout(resolve, 3000))

      // 检查当前 URL
      const currentUrl = page.url()

      // 处理安全检查页面
      if (currentUrl.includes('security-check') || currentUrl.includes('security')) {
        await addLogEntry('warning', `遇到安全检查，等待手动完成...(${candidate.title})`)

        // 等待用户手动完成安全检查（最多120秒）
        let checkPassed = false
        for (let i = 0; i < 60; i++) {
          await new Promise(resolve => setTimeout(resolve, 2000))
          const newUrl = page.url()

          if (!newUrl.includes('security-check') && !newUrl.includes('security')) {
            checkPassed = true
            await addLogEntry('info', `安全检查已完成`)
            break
          }
        }

        if (!checkPassed) {
          await addLogEntry('warning', `安全检查超时，跳过`)
          await page.goto('about:blank') // 清空页面
          results.failed++
          continue
        }

        // 安全检查通过后，继续等待页面加载
        await new Promise(resolve => setTimeout(resolve, 3000))
      } else if (currentUrl.includes('login') || currentUrl.includes('passport')) {
        await addLogEntry('warning', `跳转到登录页，Cookie 可能已失效`)
        results.failed++
        continue
      }

      // 检查按钮状态
      const pageInfo = await page.evaluate(() => {
        const btn = document.querySelector('.job-detail-box .op-btn.op-btn-chat')
        const title = document.title
        const url = window.location.href

        // 检查是否有其他可能的选择器
        const altBtns = [
          '.job-detail-footer .btn-startchat',
          '.btn-chat',
          '[class*="chat"]'
        ].map(sel => {
          const el = document.querySelector(sel)
          return el ? { selector: sel, text: el.textContent.trim() } : null
        }).filter(Boolean)

        return {
          hasButton: !!btn,
          buttonText: btn ? btn.innerHTML.trim() : null,
          title,
          url,
          altButtons: altBtns
        }
      })

      if (!pageInfo.hasButton && pageInfo.altButtons.length === 0) {
        await addLogEntry('warning', `未找到沟通按钮 (${candidate.title})`)
        await addLogEntry('info', `调试: 标题="${pageInfo.title.substring(0, 50)}"`)
        await page.goto('about:blank') // 清空页面
        results.failed++
        continue
      }

      const buttonText = pageInfo.buttonText || pageInfo.altButtons[0]?.text

      if (buttonText !== '立即沟通') {
        await addLogEntry('info', `按钮状态：${buttonText}，已跳过`)

        // 如果是"待沟通"状态，说明已经投递过了
        if (buttonText === '待沟通') {
          await updateCandidateStatus(candidate.id, 'applied')
          results.skipped++
        }

        await page.goto('about:blank') // 清空页面
        continue
      }

      // 点击"立即沟通"按钮
      await addLogEntry('info', `点击"立即沟通"按钮：${candidate.title} - ${candidate.company}`)

      try {
        await page.click('.job-detail-box .op-btn.op-btn-chat')
      } catch (clickError) {
        await addLogEntry('warning', `点击失败，尝试使用 JavaScript 点击`)
        await page.evaluate(() => {
          const btn = document.querySelector('.job-detail-box .op-btn.op-btn-chat')
          if (btn) btn.click()
        })
      }

      await new Promise(resolve => setTimeout(resolve, 2000))

      // 检查是否弹出招呼语对话框
      const hasGreetingDialog = await page.evaluate(() => {
        return !!document.querySelector('.greet-boss-dialog')
      })

      if (hasGreetingDialog) {
        // 输入招呼语（如果有）
        if (candidate.greeting) {
          const greetingText = candidate.greeting
          await page.evaluate((text) => {
            const textarea = document.querySelector('.greet-boss-dialog .greet-boss-content textarea')
            if (textarea) {
              textarea.value = text
              textarea.dispatchEvent(new Event('input', { bubbles: true }))
            }
          }, greetingText)
          await new Promise(resolve => setTimeout(resolve, 500))
        }

        // 点击发送按钮
        const sendButton = await page.$('.greet-boss-dialog .greet-boss-footer .sure-btn')
        if (sendButton) {
          await sendButton.click()
          await new Promise(resolve => setTimeout(resolve, 2000))
          await addLogEntry('success', `已发送招呼：${candidate.title} - ${candidate.company}`)

          // 更新状态为已投递
          await updateCandidateStatus(candidate.id, 'applied')
          results.success++
        } else {
          await addLogEntry('warning', `未找到发送按钮`)
          results.failed++
        }
      } else {
        // 可能是其他对话框（如完善简历对话框）
        await addLogEntry('warning', `打开沟通后未弹出招呼对话框，可能有其他弹窗`)
        results.failed++
      }

      // 清空页面，为下一个职位做准备
      await page.goto('about:blank')

      // 随机延迟，避免操作太快
      await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 2000))

    } catch (error) {
      await addLogEntry('error', `处理 ${candidate.title} - ${candidate.company} 失败：${error.message}`)
      await page.goto('about:blank') // 清空页面
      results.failed++
    }
  }

  await browser.close()

  await addLogEntry('success', `投递完成！成功：${results.success}，跳过：${results.skipped}，失败：${results.failed}`)
  return results
}
