import {
  addCandidates,
  addLogEntry,
  batchUpdateStatus,
  pickConfirmedCandidatesForApply,
  readDb,
  syncExcludedFromCandidates,
  updateCandidateStatus
} from '../store.js'
import { normalizeSourceId } from '../jobFilters.js'
import { launchBossBrowser } from './launchBossBrowser.mjs'

const companies = [
  '晨星智能',
  '蓝桥科技',
  '北斗云',
  '新航线数据',
  '墨远互动',
  '飞轮软件',
  '知野网络',
  '云上引擎'
]

const titles = [
  '前端开发工程师',
  'Vue 前端工程师',
  'React 开发工程师',
  '全栈开发工程师',
  'Web 自动化工程师',
  '低代码平台前端'
]

export async function collectCandidates(config) {
  const db = await readDb()
  if (db.auth?.bossCookieJson?.trim()) {
    return collectCandidatesFromBoss(config, db.auth)
  }

  await addLogEntry('info', '开始采集职位，当前版本使用模拟适配器')
  const keywords = config.keywords?.length ? config.keywords : ['前端']
  const cities = config.cities?.length ? config.cities : ['北京']
  const blacklist = new Set(config.blacklistCompanies ?? [])
  const excludeKeywords = config.excludeKeywords ?? []
  const blocked = getBlockedSourceIdsForCollect(db)
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  const scaleRot = ['20-99人', '100-499人', '500-999人', '0-20人']
  const items = []

  for (let i = 0; i < 12; i += 1) {
    const title = titles[i % titles.length]
    const company = companies[i % companies.length]
    const city = cities[i % cities.length]
    if (blacklist.has(company)) continue
    if (excludeKeywords.some((word) => title.includes(word) || company.includes(word))) continue

    const salaryLow = Number(config.salaryMin || 12) + (i % 4)
    const salaryHigh = Number(config.salaryMax || 30)
    const sourceId = `mock-${runId}-${i}`
    if (blocked.has(sourceId)) continue

    const job = {
      sourceId,
      title,
      company,
      companyScale: scaleRot[i % scaleRot.length],
      city,
      salary: `${salaryLow}-${Math.max(salaryHigh, salaryLow + 5)}K`,
      experience: config.experience || '经验不限',
      jobRequirement: `[模拟] 岗位要求：${title}。熟悉 ${keywords[i % keywords.length]} 技术栈，有项目经验；与 HR 协作完成需求迭代。`,
      tags: [keywords[i % keywords.length], '模拟数据'],
      reason: `命中关键词 ${keywords[i % keywords.length]}，城市 ${city}`,
      greeting: renderGreeting(config.greetingTemplates, { title, company, city })
    }
    items.push(job)
  }

  const inserted = await addCandidates(items)
  await addLogEntry('success', `模拟采集完成，新增 ${inserted.length} 条候选`)
  return inserted
}

export async function collectCandidatesViaMobile(config) {
  const db = await readDb()
  const synced = syncExcludedFromCandidates(db)
  if (synced > 0) {
    const { writeDb } = await import('../store.js')
    await writeDb(db)
    await addLogEntry('info', `已补全 ${synced} 条历史「已投递/已拒绝」到排除列表`)
  }

  await addLogEntry('info', '启动 Android 模拟器 App 采集（BOSS App 原生接口）')
  const keywords = config.keywords?.length ? config.keywords : ['测试工程师']
  const cities = config.cities?.length ? config.cities : ['杭州']

  const { spawn, execSync } = await import('node:child_process')

  // 确保模拟器在后台运行
  const avdName = 'boss_android'
  const androidHome = process.env.ANDROID_HOME || process.env.HOME + '/Library/Android/sdk'
  const emulatorPath = androidHome + '/emulator/emulator'
  const adbPath = androidHome + '/platform-tools/adb'

  try {
    const devices = execSync(`"${adbPath}" devices`, { timeout: 5000 }).toString()
    if (!devices.includes('emulator')) {
      await addLogEntry('info', '[App采集] 正在启动 Android 模拟器...')
      spawn(emulatorPath, ['-avd', avdName, '-no-boot-anim'], {
        detached: true,
        stdio: 'ignore'
      }).unref()
      await addLogEntry('info', '[App采集] 模拟器正在启动，约需 30-60 秒...')
    }
  } catch (e) {
    await addLogEntry('warning', `[App采集] 模拟器启动检查失败: ${e.message}`)
  }

  const scriptPath = new URL('./collect_boss_app.py', import.meta.url).pathname

  const result = await new Promise((resolve) => {
    const child = spawn(
      '.venv/bin/python3',
      [
        scriptPath,
        '--keyword', keywords.join(','),
        '--city', cities.join(','),
        '--target', String(config.collectTargetPerQuery || 20),
        '--skip-emulator-check'
      ],
      {
        cwd: new URL('../../', import.meta.url).pathname,
        timeout: 10 * 60 * 1000 // 10分钟超时
      }
    )

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      const line = chunk.toString().trim()
      if (line) addLogEntry('info', `[App采集] ${line.replace(/^\[collect_app\] /, '')}`)
    })

    child.on('close', (code) => {
      try {
        const data = JSON.parse(stdout.trim())
        resolve(data)
      } catch {
        addLogEntry('error', `[App采集] Python脚本输出解析失败 (exit=${code}): ${stderr.slice(-200)}`)
        resolve({ error: `脚本异常退出(${code})`, raw: stderr.slice(-500) })
      }
    })

    child.on('error', (err) => {
      addLogEntry('error', `[App采集] 无法启动脚本: ${err.message}`)
      resolve({ error: err.message })
    })
  })

  if (result.error) {
    await addLogEntry('error', `[App采集] 失败: ${result.error}`)
    return []
  }

  if (!Array.isArray(result) || result.length === 0) {
    await addLogEntry('warning', '[App采集] 未采集到职位。请在模拟器中确认 BOSS App 已登录且网络正常。')
    return []
  }

  // 转换卡片为候选格式
  const items = result.map((card) => {
    const normalized = normalizeBossJob(card, { keyword: keywords.join(','), city: cities.join(','), config })
    if (!normalized) {
      return {
        sourceId: card.sourceId || `boss-app-${Date.now()}-${Math.random().toString(36).slice(2,9)}`,
        title: card.title || '',
        company: card.company || '',
        city: card.city || '',
        salary: card.salary || '',
        experience: card.experience || '',
        reason: `App端采集: ${keywords.join(',')} - ${cities.join(',')}`,
      }
    }
    return normalized
  }).filter(Boolean)

  const inserted = await addCandidates(items)
  if (inserted.length > 0) {
    await addLogEntry('success', `[App采集] 完成，新增 ${inserted.length} 个候选职位（Python 脚本返回 ${result.length} 条）`)
  } else {
    await addLogEntry('warning', `[App采集] Python 脚本返回 ${result.length} 条，但在排除列表或已存在，未新增。`)
  }
  return inserted
}

function isBossAntiBotMessage(msg) {
  const s = String(msg ?? '')
  return /环境.*异常|异常|频繁|验证|风控|risk|denied/i.test(s)
}

function appendBossSearchParams(url, { keyword, cityCode, page, pageSize }) {
  url.searchParams.set('scene', '1')
  url.searchParams.set('query', keyword)
  url.searchParams.set('page', String(page))
  url.searchParams.set('pageSize', String(pageSize))
  if (cityCode) url.searchParams.set('city', cityCode)
  for (const k of [
    'experience',
    'payType',
    'partTime',
    'degree',
    'industry',
    'scale',
    'stage',
    'position',
    'jobType',
    'salary',
    'multiBusinessDistrict',
    'multiSubway'
  ]) {
    if (!url.searchParams.has(k)) url.searchParams.set(k, '')
  }
}

async function collectCandidatesFromBossFetch(config, auth) {
  const cookieHeader = buildCookieHeader(auth.bossCookieJson)
  const keywords = config.keywords?.length ? config.keywords : ['软件测试']
  const cities = config.cities?.length ? config.cities : ['杭州']
  const items = []
  const dedupe = new Set()
  const pageSize = 30
  const maxPages = 30
  let grossJobCardsSeen = 0
  let antiBotHits = 0

  for (const keyword of keywords) {
    for (const city of cities) {
      const cityCode = cityCodeMap[city] ?? ''
      for (let page = 1; page <= maxPages; page += 1) {
        const url = new URL('https://www.zhipin.com/wapi/zpgeek/search/joblist.json')
        appendBossSearchParams(url, { keyword, cityCode, page, pageSize })

        const response = await fetch(url, {
          headers: {
            accept: 'application/json, text/plain, */*',
            cookie: cookieHeader,
            referer: `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(keyword)}${cityCode ? `&city=${cityCode}` : ''}`,
            origin: 'https://www.zhipin.com',
            'x-requested-with': 'XMLHttpRequest',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'user-agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
          }
        })

        const text = await response.text()
        if (!response.ok) {
          await addLogEntry('error', `BOSS 接口请求失败：HTTP ${response.status}`)
          antiBotHits += 1
          break
        }

        let payload
        try {
          payload = JSON.parse(text)
        } catch {
          await addLogEntry('error', 'BOSS 返回内容不是 JSON，可能 Cookie 失效或触发风控')
          antiBotHits += 1
          break
        }

        if (payload.code !== 0) {
          const msg = payload.message || payload.msg || `code=${payload.code}`
          await addLogEntry('error', `BOSS 返回失败：${msg}`)
          if (isBossAntiBotMessage(msg)) antiBotHits += 1
          break
        }

        const jobList = extractBossJobList(payload)
        if (!jobList.length) break

        grossJobCardsSeen += jobList.length
        await addLogEntry('info', `${city} / ${keyword} 第 ${page} 页返回 ${jobList.length} 个职位`)
        for (const raw of jobList) {
          const normalized = normalizeBossJob(raw, { keyword, city, config })
          if (!normalized) continue
          const sid = normalizeSourceId(normalized.sourceId)
          if (!sid || dedupe.has(sid)) continue

          normalized.sourceId = sid
          dedupe.add(sid)
          items.push(normalized)
        }
        if (jobList.length < pageSize) break
      }
    }
  }

  const useBrowserFallback = grossJobCardsSeen === 0 && antiBotHits > 0

  return {
    items,
    grossJobCardsSeen,
    keywords,
    cities,
    useBrowserFallback
  }
}

async function collectCandidatesFromBoss(config, auth) {
  await addLogEntry('info', '开始真实采集：使用浏览器直连 BOSS（避免 Node fetch 触发「环境异常」风控）')
  const db = await readDb()
  const synced = syncExcludedFromCandidates(db)
  if (synced > 0) {
    const { writeDb } = await import('../store.js')
    await writeDb(db)
    await addLogEntry('info', `已补全 ${synced} 条历史「已投递/已拒绝」到排除列表，避免重复采集`)
  }

  const { collectBossJobsViaBrowser } = await import('./collectBossViaBrowser.mjs')
  const browserResult = await collectBossJobsViaBrowser(config, auth, db, {
    extractBossJobList,
    normalizeBossJob,
    cityCodeMap
  })
  const items = browserResult.items

  const inserted = await addCandidates(items)
  if (inserted.length === 0 && items.length > 0) {
    await addLogEntry(
      'warning',
      `本批从 BOSS 拉取 ${items.length} 条不同职位，但均在「已投递/已拒绝」排除列表或已在库中，未新增。可尝试换关键词/城市。`
    )
  } else if (inserted.length === 0 && items.length === 0) {
    await addLogEntry('warning', '未从 BOSS 拉取到职位（检查 Cookie 是否过期，或尝试重新获取 Cookie）')
  }
  await addLogEntry('success', `真实采集完成，新增 ${inserted.length} 条候选`)
  return inserted
}

export async function applyConfirmedCandidates(limit = 30, candidateIds = null) {
  const db = await readDb()
  const confirmed = pickConfirmedCandidatesForApply(db, candidateIds, limit)

  if (confirmed.length === 0) {
    await addLogEntry('info', '没有已确认的职位需要投递')
    return { count: 0 }
  }

  // 检查是否有 Puppeteer
  let puppeteer
  try {
    puppeteer = (await import('puppeteer')).default
  } catch {
    await addLogEntry('error', 'Puppeteer 未安装，请运行: npm install puppeteer')
    await addLogEntry('info', `即将使用模拟投递：${confirmed.length} 个职位`)
    await batchUpdateStatus(
      confirmed.map((item) => item.id),
      'applied'
    )
    await addLogEntry('success', `模拟投递完成，共 ${confirmed.length} 个职位`)
    return { count: confirmed.length }
  }

  await addLogEntry('info', `开始真实投递 ${confirmed.length} 个已确认职位，使用浏览器自动化`)

  // 启动浏览器 - 使用最小配置（避免反检测配置导致的问题）
  let browser
  try {
    browser = await launchBossBrowser(puppeteer, {
      args: ['--no-sandbox'],
      defaultViewport: {
        width: 1280,
        height: 800
      }
    })
  } catch {
    return { error: 'BROWSER_LAUNCH_FAILED' }
  }

  const results = {
    success: 0,
    skipped: 0,
    failed: 0
  }

  // 先设置 Cookie（如果有保存的登录态）
  const cookieJson = db.auth?.bossCookieJson?.trim()
  if (cookieJson) {
    try {
      const cookies = JSON.parse(cookieJson)
      if (Array.isArray(cookies)) {
        await addLogEntry('info', `正在加载 ${cookies.length} 个 Cookie...`)
      }
    } catch {
      await addLogEntry('warning', 'Cookie 格式错误，可能需要手动登录')
    }
  }

  // 逐个处理职位
  for (const candidate of confirmed) {
    const jobId = candidate.raw?.encryptJobId ?? candidate.sourceId?.replace(/^boss-/, '')
    if (!jobId) {
      await addLogEntry('warning', `职位 ${candidate.title} (${candidate.company}) 没有 job ID，跳过`)
      results.skipped++
      continue
    }

    const jobUrl = `https://www.zhipin.com/job_detail/${jobId}.html`
    await addLogEntry('info', `正在打开：${candidate.title} - ${candidate.company}`)

    try {
      const page = await browser.newPage()

      // 设置用户代理
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')

      // 设置 Cookie（如果有）
      if (cookieJson) {
        try {
          const cookies = JSON.parse(cookieJson)
          if (Array.isArray(cookies)) {
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
            await addLogEntry('info', `已加载 ${cleanCookies.length} 个 Cookie`)
          }
        } catch (cookieError) {
          await addLogEntry('warning', `Cookie 设置失败：${cookieError.message}`)
        }
      }

      // 打开职位详情页
      await addLogEntry('info', `正在打开：${candidate.title} - ${candidate.company}`)

      try {
        await page.goto(jobUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        })
      } catch (gotoError) {
        await addLogEntry('warning', `页面加载超时：${gotoError.message}`)
        await page.close()
        results.failed++
        continue
      }

      // 等待页面稳定
      await new Promise(resolve => setTimeout(resolve, 3000))

      // 检查是否跳转到安全检查页
      const currentUrl = page.url()
      if (currentUrl.includes('security-check') || currentUrl.includes('security')) {
        await addLogEntry('warning', `遇到安全检查，等待手动完成...(${candidate.title} - ${candidate.company})`)

        // 等待用户手动完成安全检查（最多60秒）
        let checkPassed = false
        for (let i = 0; i < 30; i++) {
          await new Promise(resolve => setTimeout(resolve, 2000))
          const newUrl = page.url()

          // 检查是否通过了安全检查
          if (!newUrl.includes('security-check') && !newUrl.includes('security')) {
            checkPassed = true
            await addLogEntry('info', `安全检查已完成，继续处理...`)
            break
          }
        }

        if (!checkPassed) {
          await addLogEntry('warning', `安全检查超时，跳过此职位`)
          await page.close()
          results.failed++
          continue
        }

        // 安全检查通过后，继续等待页面加载
        await new Promise(resolve => setTimeout(resolve, 3000))
      } else if (currentUrl.includes('login') || currentUrl.includes('passport')) {
        await addLogEntry('warning', `跳转到登录页，Cookie 可能已失效`)
        await page.close()
        results.failed++
        continue
      }

      // 检查按钮状态（使用更安全的等待方式）
      // 等待页面完全加载
      await new Promise(resolve => setTimeout(resolve, 5000))

      let buttonText = null
      let pageInfo = null
      try {
        pageInfo = await page.evaluate(() => {
          const btn = document.querySelector('.job-detail-box .op-btn.op-btn-chat')
          return {
            hasButton: !!btn,
            buttonText: btn ? btn.innerHTML.trim() : null,
            title: document.title,
            url: window.location.href
          }
        })
        buttonText = pageInfo.buttonText
      } catch (evalError) {
        await addLogEntry('warning', `页面状态检测失败：${evalError.message}`)
        await page.close()
        results.failed++
        continue
      }

      if (!buttonText) {
        await addLogEntry('warning', `未找到沟通按钮 (${candidate.title} - ${candidate.company})`)
        if (pageInfo) {
          await addLogEntry('info', `调试: 标题="${pageInfo.title.substring(0, 50)}", URL="${pageInfo.url.substring(0, 80)}"`)
        }
        await page.close()
        results.failed++
        continue
      }

      if (buttonText !== '立即沟通') {
        await addLogEntry('info', `按钮状态：${buttonText}，已跳过 ${candidate.title} - ${candidate.company}`)
        await page.close()
        results.skipped++

        // 如果是"待沟通"状态，说明已经投递过了，更新状态
        if (buttonText === '待沟通') {
          await updateCandidateStatus(candidate.id, 'applied')
        }
        continue
      }

      // 点击"立即沟通"按钮
      await addLogEntry('info', `点击"立即沟通"按钮：${candidate.title} - ${candidate.company}`)

      try {
        await page.click('.job-detail-box .op-btn.op-btn-chat')
      } catch (clickError) {
        await addLogEntry('warning', `点击按钮失败，可能页面已变化`)
        await page.close()
        results.failed++
        continue
      }

      await new Promise(resolve => setTimeout(resolve, 1500))

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
          await new Promise(resolve => setTimeout(resolve, 1000))
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

      await page.close()

      // 随机延迟，避免操作太快
      await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000))

    } catch (error) {
      await addLogEntry('error', `处理 ${candidate.title} - ${candidate.company} 失败：${error.message}`)
      results.failed++
    }
  }

  await browser.close()

  await addLogEntry('success', `投递完成！成功：${results.success}，跳过：${results.skipped}，失败：${results.failed}`)
  return results
}

function renderGreeting(templates = [], job) {
  const fallback = '您好，我对贵司的{职位名称}很感兴趣，希望可以进一步沟通。'
  const template = templates.length ? templates[Math.floor(Math.random() * templates.length)] : fallback
  return template
    .replaceAll('{职位名称}', job.title)
    .replaceAll('{公司名称}', job.company)
    .replaceAll('{城市}', job.city)
}

function buildCookieHeader(cookieJson) {
  const cookies = JSON.parse(cookieJson)
  if (!Array.isArray(cookies)) {
    throw new Error('Cookie JSON 必须是数组')
  }
  return cookies
    .filter((item) => item?.name && item?.value)
    .map((item) => `${item.name}=${item.value}`)
    .join('; ')
}

function extractBossJobList(payload) {
  const data = payload.zpData ?? payload.data ?? {}
  return (
    data.jobList ??
    data.list ??
    data.resultList ??
    data.recJobList ??
    data.searchJobResult?.jobList ??
    data.result?.jobList ??
    []
  )
}

/** 列表项常见为「顶层 + jobInfo 嵌套」混排，合并后取值更稳 */
function flattenBossJobRaw(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const nested = raw.jobInfo && typeof raw.jobInfo === 'object' ? raw.jobInfo : {}
  return { ...raw, ...nested }
}

function normalizeBossJob(raw, { keyword, city, config }) {
  const f = flattenBossJobRaw(raw)
  const bossInfo = raw.bossInfo ?? {}
  const companyInfo = raw.companyInfo ?? {}
  const title = f.jobName ?? f.title ?? f.positionName
  const company =
    companyInfo.brandName ?? companyInfo.companyName ?? f.brandName ?? f.companyName
  const encryptId = f.encryptJobId ?? f.encryptId
  if (!title || !company || !encryptId) return null
  const sourceId = normalizeSourceId(encryptId)

  const salary = f.salaryDesc ?? f.salary ?? ''
  const companyScale = resolveCompanyScale(f, companyInfo, raw)
  const jobRequirement = buildJobRequirement(f, raw)
  return {
    sourceId,
    title,
    company,
    companyScale,
    city: f.cityName ?? f.locationName ?? raw.cityName ?? city,
    salary,
    experience:
      f.jobExperience ?? f.experienceName ?? f.expName ?? raw.jobExperience ?? '',
    jobRequirement,
    tags: [keyword, 'BOSS真实数据'].filter(Boolean),
    reason: `BOSS 搜索命中：${keyword}`,
    greeting: renderGreeting(config.greetingTemplates, {
      title,
      company,
      city: f.cityName ?? city
    }),
    raw: {
      encryptJobId: encryptId,
      encryptBossId: bossInfo.encryptBossId ?? f.encryptBossId ?? raw.encryptBossId,
      encryptCompanyId: companyInfo.encryptCompanyId ?? f.encryptCompanyId ?? raw.encryptCompanyId
    }
  }
}

function stripHtml(html) {
  if (!html || typeof html !== 'string') return ''
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** BOSS 列表接口 brandScale 常见枚举 */
const BOSS_BRAND_SCALE = {
  301: '0-20人',
  302: '20-99人',
  303: '100-499人',
  304: '500-999人',
  305: '1000-9999人',
  306: '10000人以上'
}

/** 列表里 jobExperience / jobDegree 可能为数值编码 */
const BOSS_EXP_CODE = {
  101: '在校/应届',
  102: '1年以内',
  103: '1-3年',
  104: '3-5年',
  105: '5-10年',
  106: '10年以上'
}

const BOSS_DEGREE_CODE = {
  201: '大专',
  202: '本科',
  203: '硕士',
  204: '博士',
  205: '高中',
  206: '中专',
  208: '中专/中技',
  209: '学历不限'
}

function resolveCompanyScale(f, companyInfo, raw) {
  const name =
    f.brandScaleName ||
    f.scaleName ||
    companyInfo.brandScaleName ||
    companyInfo.scaleName ||
    companyInfo.companyScale ||
    f.brandScaleDesc ||
    raw.brandScaleName
  if (name) return String(name)
  const code = companyInfo.brandScale ?? f.brandScale ?? raw.brandScale
  if (code != null && BOSS_BRAND_SCALE[Number(code)]) return BOSS_BRAND_SCALE[Number(code)]
  return ''
}

function buildJobRequirement(f, raw) {
  const parts = []
  const desc =
    f.postDescription ??
    f.jobDesc ??
    f.jobDescription ??
    f.positionDetail ??
    raw.postDescription ??
    raw.jobDesc
  if (desc) parts.push(stripHtml(String(desc)))

  const degRaw = f.jobDegree ?? f.degreeName ?? raw.jobDegree
  const expRaw = f.jobExperience ?? f.experienceName ?? f.expName ?? raw.jobExperience
  const mapCode = (rawVal, table) => {
    if (rawVal == null || rawVal === '') return ''
    if (typeof rawVal === 'string' && /^\d+$/.test(rawVal)) {
      const n = Number(rawVal)
      return table[n] ?? rawVal
    }
    if (typeof rawVal === 'number' && table[rawVal]) return table[rawVal]
    return rawVal
  }
  const deg = mapCode(degRaw, BOSS_DEGREE_CODE)
  const exp = mapCode(expRaw, BOSS_EXP_CODE)
  const metaBits = [deg && `学历：${deg}`, exp && `经验：${exp}`].filter(Boolean)
  if (metaBits.length) parts.push(metaBits.join('，'))

  const collectLabelParts = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return []
    return arr
      .map((x) => {
        if (x == null) return ''
        if (typeof x === 'string' || typeof x === 'number') return String(x)
        return (
          x.name ??
          x.label ??
          x.skillName ??
          x.word ??
          x.value ??
          (x.desc != null ? String(x.desc) : '')
        )
      })
      .filter(Boolean)
  }

  const skills = f.skills ?? f.skillText ?? raw.skills
  const skillLabels = collectLabelParts(skills)
  if (skillLabels.length) parts.push(`技能：${skillLabels.join('、')}`)

  const jobLabels = f.jobLabels ?? f.focusLexeme ?? f.highlight ?? raw.jobLabels
  const jl = collectLabelParts(jobLabels)
  if (jl.length) parts.push(`标签：${jl.join(' · ')}`)

  const iconWords = collectLabelParts(f.iconWordList ?? raw.iconWordList)
  if (iconWords.length) parts.push(`关键词：${iconWords.join(' · ')}`)

  const welfare = collectLabelParts(f.welfareList ?? raw.welfareList)
  if (welfare.length) parts.push(`福利：${welfare.join('、')}`)

  const industry = f.brandIndustry ?? f.industryName ?? raw.brandIndustry
  const stage = f.brandStageName ?? f.stageName ?? raw.brandStageName
  if (industry || stage) parts.push([industry && `行业：${industry}`, stage && `阶段：${stage}`].filter(Boolean).join('，'))

  let text = parts.filter(Boolean).join('\n')
  if (!text.trim()) {
    const hint = '（列表页字段较少，完整 JD 需在网页查看；可点「打开职位」）'
    const t = f.jobName ? `职位：${f.jobName}` : ''
    const co = f.brandName || f.companyName ? `公司：${f.brandName ?? f.companyName}` : ''
    text = [hint, t, co].filter(Boolean).join('\n')
  }
  return text.length > 4000 ? `${text.slice(0, 3997)}…` : text
}

const cityCodeMap = {
  北京: '101010100',
  上海: '101020100',
  广州: '101280100',
  深圳: '101280600',
  杭州: '101210100',
  南京: '101190100',
  苏州: '101190400',
  成都: '101270100',
  武汉: '101200100',
  西安: '101110100',
  重庆: '101040100',
  天津: '101030100'
}
