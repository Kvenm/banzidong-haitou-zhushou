import { addLogEntry, updateDb, addLog } from '../store.js'
import { launchBossBrowser } from './launchBossBrowser.mjs'
import { injectBossLocalStorageOnPage } from './injectBossLocalStorage.mjs'
import { normalizeSourceId } from '../jobFilters.js'
import { resolveBossPuppeteer, waitThroughBossSecurityCheck } from './bossPuppeteer.mjs'

const JOB_LIST_API_SNIPPETS = [
  '/wapi/zpgeek/search/joblist.json',
  '/wapi/zpgeek/pc/recommend/job/list.json'
]

const GEEK_JOBS_PAGE = 'https://www.zhipin.com/web/geek/jobs'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 在真实浏览器中采集职位（绕过 Node fetch 的「环境异常」风控）
 * @param {object} config
 * @param {object} auth
 * @param {object} db
 * @param {{ extractBossJobList: Function, normalizeBossJob: Function, cityCodeMap: Record<string,string> }} helpers
 */
export async function collectBossJobsViaBrowser(config, auth, db, helpers) {
  const { extractBossJobList, normalizeBossJob, cityCodeMap } = helpers
  const keywords = config.keywords?.length ? config.keywords : ['软件测试']
  const cities = config.cities?.length ? config.cities : ['杭州']

  await addLogEntry('info', '直连 API 不可用，改用浏览器采集（与 BOSS 网页搜索一致）')

  const { puppeteer } = await resolveBossPuppeteer()

  let browser
  try {
    browser = await launchBossBrowser(puppeteer, {
      defaultViewport: { width: 1440, height: 900 }
    })
  } catch (e) {
    await addLogEntry('error', `浏览器启动失败，无法采集：${e.message}`)
    return { items: [], grossJobCardsSeen: 0 }
  }

  const items = []
  const dedupe = new Set()
  let grossJobCardsSeen = 0

  try {
    for (const p of await browser.pages()) {
      await p.close().catch(() => {})
    }
    const page = await browser.newPage()
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    )

    const ok = await applyAuthToPage(page, auth, db)
    if (!ok) {
      return { items: [], grossJobCardsSeen: 0 }
    }

    const sessionOk = await ensureBossSessionOrWaitLogin(page, browser)
    if (!sessionOk) {
      return { items: [], grossJobCardsSeen: 0 }
    }

    await sleep(1500)

    // 阶段一：通过「期望岗位」标签采集（走推荐引擎，质量更高）
    const expectedTotal = await collectFromExpectedJobTabs(page, {
      config, extractBossJobList, normalizeBossJob, dedupe, items
    })
    grossJobCardsSeen += expectedTotal

    if (expectedTotal > 0) {
      await addLogEntry('info', `期望岗位采集完成，共新增 ${expectedTotal} 条`)
    }

    // 阶段二：关键词 × 城市搜索采集
    for (const keyword of keywords) {
      for (const city of cities) {
        const cityCode = cityCodeMap[city] ?? ''
        const batch = await collectOneKeywordCity(page, {
          keyword,
          city,
          cityCode,
          config,
          extractBossJobList,
          normalizeBossJob,
          dedupe,
          items
        })
        grossJobCardsSeen += batch.gross
        // 关键词×城市之间随机延迟，模拟人工操作
        const gap = 3000 + Math.random() * 5000
        await sleep(gap)
      }
    }
  } finally {
    await browser.close().catch(() => {})
  }

  await addLogEntry(
    'info',
    `[浏览器拉取汇总] 关键词 ${keywords.length} 个 × 城市 ${cities.length} 个；` +
      `接口/页面累计约 ${grossJobCardsSeen} 条，去重后待入库 ${items.length} 条`
  )

  return { items, grossJobCardsSeen }
}

function isLoginUrl(url) {
  return /login|passport|signin|about:blank/i.test(url) && !url.includes('/web/geek')
}

async function applyAuthToPage(page, auth, db) {
  const cookieJson = auth?.bossCookieJson?.trim()
  if (!cookieJson) {
    await addLogEntry('error', '未保存 Cookie，无法使用浏览器采集')
    return false
  }

  let cookies
  try {
    cookies = JSON.parse(cookieJson)
    if (!Array.isArray(cookies)) throw new Error('not array')
  } catch {
    await addLogEntry('error', 'Cookie 格式错误')
    return false
  }

  await page.goto('https://www.zhipin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await sleep(800)

  for (const c of cookies) {
    const copy = { ...c }
    if (Object.hasOwn(copy, 'sameSite')) copy.sameSite = 'unspecified'
    try {
      await page.setCookie(copy)
    } catch {
      //
    }
  }

  const lsText = String(db.auth?.bossLocalStorageJson ?? '').trim()
  if (lsText) {
    try {
      const lsObj = JSON.parse(lsText)
      if (lsObj && typeof lsObj === 'object' && !Array.isArray(lsObj)) {
        await injectBossLocalStorageOnPage(page, lsObj)
      }
    } catch (e) {
      await addLogEntry('warning', `localStorage 注入失败：${e.message}`)
    }
  }

  return true
}

/** Cookie 失效时留在当前窗口等待用户登录，避免跳转登录子域黑屏后立即关闭 */
async function ensureBossSessionOrWaitLogin(page, browser) {
  await page.goto(GEEK_JOBS_PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await sleep(2000)
  await waitThroughBossSecurityCheck(page)

  let url = page.url()
  if (!isLoginUrl(url) && url.includes('zhipin.com')) {
    return true
  }

  await addLogEntry(
    'warning',
    '登录已过期：请在已打开的浏览器窗口完成登录（推荐扫码），勿关闭窗口；登录成功后采集会自动继续'
  )

  const deadline = Date.now() + 8 * 60 * 1000
  while (Date.now() < deadline) {
    if (page.isClosed() || !browser.isConnected()) {
      await addLogEntry('error', '浏览器已关闭，采集中断')
      return false
    }

    url = page.url()
    if (!isLoginUrl(url) && url.includes('zhipin.com')) {
      const cookies = await page.cookies()
      if (cookies.length > 5 && cookies.some((c) => c.name === 'wt2' || c.name === '__zp_stoken__')) {
        const lsJson = await page
          .evaluate(() => {
            const out = {}
            for (let i = 0; i < localStorage.length; i += 1) {
              const k = localStorage.key(i)
              if (k) out[k] = localStorage.getItem(k)
            }
            return JSON.stringify(out)
          })
          .catch(() => '')

        await updateDb((db) => {
          db.auth.bossCookieJson = JSON.stringify(cookies)
          if (lsJson && lsJson.length > 2) db.auth.bossLocalStorageJson = lsJson
          db.auth.savedAt = new Date().toISOString()
          db.auth.lastCheckAt = new Date().toISOString()
          db.auth.lastCheckResult = '采集过程中已重新登录并更新凭据'
          addLog(db, 'success', '采集等待登录：已自动更新 Cookie')
        })
        await addLogEntry('success', '检测到登录成功，继续采集职位')
        return true
      }
    }

    if (url === 'about:blank' || !url.includes('zhipin')) {
      await page.goto(GEEK_JOBS_PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    }

    await sleep(2000)
  }

  await addLogEntry('error', '等待登录超时（8 分钟），请重新「自动获取 Cookie」后再采集')
  return false
}

async function collectOneKeywordCity(page, ctx) {
  const { keyword, city, cityCode, config, extractBossJobList, normalizeBossJob, dedupe, items } =
    ctx
  const rawAccumulator = []
  const apiErrors = []

  const onResponse = async (response) => {
    const url = response.url()
    if (!JOB_LIST_API_SNIPPETS.some((s) => url.includes(s))) return
    try {
      const payload = await response.json()
      if (payload.code !== 0) {
        apiErrors.push(payload.message || payload.msg || `code=${payload.code}`)
        return
      }
      const list = extractBossJobList(payload)
      if (list.length) rawAccumulator.push(...list)
    } catch {
      //
    }
  }

  page.on('response', onResponse)

  const searchUrl =
    `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(keyword)}` +
    (cityCode ? `&city=${cityCode}` : '')

  await addLogEntry('info', `浏览器搜索：${city} / ${keyword}`)
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
  } catch (e) {
    await addLogEntry('warning', `打开搜索页超时：${e.message}`)
  }

  await waitThroughBossSecurityCheck(page)

  await page
    .waitForFunction(() => !document.querySelector('.job-recommend-result .job-rec-loading'), {
      timeout: 25000
    })
    .catch(() => {})

  // 切换排序为「最新发布」，绕过推荐算法的付费加权
  await page
    .evaluate(() => {
      const all = document.querySelectorAll('span, a, div, button, li')
      for (const el of all) {
        if (el.textContent?.trim() === '最新' && el.offsetParent !== null) {
          el.click()
          return true
        }
      }
      // fallback: 搜索排序栏常见选择器
      const selectors = [
        '.search-sort-bar .sort-item:last-child',
        '.sort-bar .sort-item:last-child',
        '[class*="sort"] [class*="item"]:last-child',
        '.job-tags-bar span:last-child'
      ]
      for (const sel of selectors) {
        const target = document.querySelector(sel)
        if (target && target.offsetParent) {
          target.click()
          return true
        }
      }
      return false
    })
    .then((clicked) => {
      if (clicked) addLogEntry('info', `${city} / ${keyword}：已切换排序为「最新发布」`)
    })
    .catch(() => {})

  await sleep(2500)

  const result = await scrollAndCollectFromPage(page, {
    config, normalizeBossJob, dedupe, items, label: `${city} / ${keyword}`, rawAccumulator
  })

  page.off('response', onResponse)

  if (apiErrors.length && !rawAccumulator.length) {
    await addLogEntry(
      'warning',
      `${city} / ${keyword} 页面接口异常：${apiErrors[0]}（若持续失败请重新「自动获取 Cookie」）`
    )
  }

  await addLogEntry(
    'info',
    `${city} / ${keyword}：获取 ${result.gross} 条，过滤 ${result.filtered} 条（公司过滤），新增候选 ${result.added} 条` +
      (result.added >= result.target ? `（已达目标 ${result.target}）` : '')
  )

  return result
}

async function scrollAndCollectFromPage(page, ctx) {
  const { config, normalizeBossJob, dedupe, items, label, rawAccumulator } = ctx

  const target = Math.max(1, Number(config.collectTargetPerQuery) || 20)
  const maxScrolls = 40
  const blockedCompanies = [
    ...(config?.blacklistCompanies ?? []),
    ...(config?.excludeOutsourcingCompanies ?? [])
  ]
  let batchAdded = 0
  let filteredByConfig = 0
  let lastProcessedIdx = rawAccumulator.length
  let noNewDataStreak = 0

  for (let scroll = 0; scroll < maxScrolls && batchAdded < target; scroll += 1) {
    await page
      .evaluate(() => {
        const list =
          document.querySelector('.job-list-container .rec-job-list') ||
          document.querySelector('.job-list-container') ||
          document.querySelector('.rec-job-list')
        if (list) list.scrollTop = list.scrollHeight
        window.scrollBy(0, 1200)
      })
      .catch(() => {})
    await sleep(1800)

    if (rawAccumulator.length > lastProcessedIdx) {
      const result = processRawSlice(rawAccumulator.slice(lastProcessedIdx), {
        keyword: label, city: '', config, normalizeBossJob, dedupe, items, blockedCompanies
      })
      lastProcessedIdx = rawAccumulator.length
      batchAdded += result.added
      filteredByConfig += result.filtered
      noNewDataStreak = 0
    } else {
      noNewDataStreak += 1
    }

    if (noNewDataStreak >= 6) break
  }

  // 处理剩余
  if (rawAccumulator.length > lastProcessedIdx) {
    const result = processRawSlice(rawAccumulator.slice(lastProcessedIdx), {
      keyword: label, city: '', config, normalizeBossJob, dedupe, items, blockedCompanies
    })
    batchAdded += result.added
    filteredByConfig += result.filtered
  }

  // Vue 内部状态兜底
  const vueJobs = await page
    .evaluate(() => {
      const list = document.querySelector('.page-jobs-main')?.__vue__?.jobList
      return Array.isArray(list) ? list : []
    })
    .catch(() => [])

  if (vueJobs.length) {
    const result = processRawSlice(vueJobs, {
      keyword: label, city: '', config, normalizeBossJob, dedupe, items, blockedCompanies
    })
    batchAdded += result.added
    filteredByConfig += result.filtered
  }

  return {
    gross: rawAccumulator.length + vueJobs.length,
    added: batchAdded,
    filtered: filteredByConfig,
    target
  }
}

/** 在 BOSS 推荐页依次点击「期望岗位」标签进行采集 */
async function collectFromExpectedJobTabs(page, ctx) {
  const { config, extractBossJobList, normalizeBossJob, dedupe, items } = ctx

  await page.goto(GEEK_JOBS_PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await sleep(3000)
  await waitThroughBossSecurityCheck(page)

  await page
    .waitForFunction(() => !document.querySelector('.job-recommend-result .job-rec-loading'), {
      timeout: 25000
    })
    .catch(() => {})

  // 探测「期望岗位」标签
  const tabs = await page
    .evaluate(() => {
      const selectors = [
        '.expect-job-item',
        '.expect-item',
        '.job-expect-item',
        '.expect-tab',
        '[class*="expect-item"]',
        '[class*="expectJob"]',
        '[class*="expect"]'
      ]
      for (const sel of selectors) {
        const els = [...document.querySelectorAll(sel)]
        if (els.length >= 2 && els.length <= 5) {
          return els.map((el) => ({
            text: el.textContent.trim(),
            active: el.classList.contains('active') || el.getAttribute('aria-selected') === 'true'
          }))
        }
      }
      return []
    })
    .catch(() => [])

  if (!tabs.length) {
    await addLogEntry('info', '未检测到期望岗位标签，跳过推荐页采集')
    return 0
  }

  await addLogEntry('info', `检测到 ${tabs.length} 个期望岗位：${tabs.map((t) => t.text).join('、')}`)

  let totalAdded = 0

  for (let i = 0; i < tabs.length; i++) {
    const tabText = tabs[i].text
    if (!tabText) continue

    // 点击标签
    const clicked = await page
      .evaluate((idx) => {
        const selectors = [
          '.expect-job-item',
          '.expect-item',
          '.job-expect-item',
          '.expect-tab',
          '[class*="expect-item"]',
          '[class*="expectJob"]',
          '[class*="expect"]'
        ]
        for (const sel of selectors) {
          const els = [...document.querySelectorAll(sel)]
          if (els.length >= 2 && els.length <= 5) {
            if (els[idx]) {
              els[idx].click()
              return els[idx].textContent.trim()
            }
          }
        }
        return null
      }, i)
      .catch(() => null)

    if (!clicked) continue

    await addLogEntry('info', `期望岗位 [${i + 1}/${tabs.length}]：${clicked}`)
    await sleep(2500)

    await page
      .waitForFunction(() => !document.querySelector('.job-recommend-result .job-rec-loading'), {
        timeout: 25000
      })
      .catch(() => {})

    // 设置响应拦截，然后滚动采集
    const rawAccumulator = []
    const onResponse = async (response) => {
      const url = response.url()
      if (!JOB_LIST_API_SNIPPETS.some((s) => url.includes(s))) return
      try {
        const payload = await response.json()
        if (payload.code !== 0) return
        const list = extractBossJobList(payload)
        if (list.length) rawAccumulator.push(...list)
      } catch {
        //
      }
    }

    page.on('response', onResponse)

    const result = await scrollAndCollectFromPage(page, {
      config, normalizeBossJob, dedupe, items,
      label: `期望岗位-${clicked}`,
      rawAccumulator
    })

    page.off('response', onResponse)

    totalAdded += result.added
    await addLogEntry(
      'info',
      `期望岗位 ${clicked}：获取 ${result.gross} 条，新增 ${result.added} 条` +
        (result.added >= result.target ? `（已达目标 ${result.target}）` : '')
    )

    // 标签间延迟
    await sleep(2000 + Math.random() * 3000)
  }

  return totalAdded
}

/** 阶段三：移动端模拟采集，使用 iPhone UA 和移动视口获取 App 端同款推荐 */
async function collectViaMobileEmulation(browser, ctx) {
  const { config, auth, db, keywords, cities, cityCodeMap, extractBossJobList, normalizeBossJob, dedupe, items } = ctx

  await addLogEntry('info', '启动移动端模拟采集（iPhone UA + 移动视口，绕过 Web 端竞价排名）')

  const mobileUA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

  let mobilePage
  let totalGross = 0

  try {
    mobilePage = await browser.newPage()
    await mobilePage.setViewport({
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true
    })
    await mobilePage.setUserAgent(mobileUA)

    const ok = await applyAuthToPage(mobilePage, auth, db)
    if (!ok) return 0

    await mobilePage.goto('https://www.zhipin.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    }).catch(() => {})
    await sleep(2000)
    await waitThroughBossSecurityCheck(mobilePage)

    for (const keyword of keywords) {
      for (const city of cities) {
        const cityCode = cityCodeMap[city] ?? ''
        const searchUrl =
          `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(keyword)}` +
          (cityCode ? `&city=${cityCode}` : '')

        await addLogEntry('info', `[移动端] 搜索：${city} / ${keyword}`)

        const rawAccumulator = []
        const onResponse = async (response) => {
          const url = response.url()
          if (!JOB_LIST_API_SNIPPETS.some((s) => url.includes(s))) return
          try {
            const payload = await response.json()
            if (payload.code !== 0) return
            const list = extractBossJobList(payload)
            if (list.length) rawAccumulator.push(...list)
          } catch { /* ignore */ }
        }

        mobilePage.on('response', onResponse)

        await mobilePage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
        await waitThroughBossSecurityCheck(mobilePage)
        await sleep(2500)

        // 尝试切换「最新发布」排序
        await mobilePage.evaluate(() => {
          const all = document.querySelectorAll('span, a, div, button, li')
          for (const el of all) {
            if (el.textContent?.trim() === '最新' && el.offsetParent !== null) {
              el.click()
              return true
            }
          }
          return false
        }).catch(() => {})
        await sleep(2000)

        const result = await scrollAndCollectFromPage(mobilePage, {
          config, normalizeBossJob, dedupe, items,
          label: `[移动端] ${city} / ${keyword}`,
          rawAccumulator
        })

        mobilePage.off('response', onResponse)
        totalGross += result.gross

        await addLogEntry(
          'info',
          `[移动端] ${city} / ${keyword}：获取 ${result.gross} 条，新增候选 ${result.added} 条` +
            (result.added >= result.target ? `（已达目标 ${result.target}）` : '')
        )

        const gap = 3000 + Math.random() * 5000
        await sleep(gap)
      }
    }

    return totalGross
  } finally {
    if (mobilePage && !mobilePage.isClosed()) {
      await mobilePage.close().catch(() => {})
    }
  }
}

function processRawSlice(rawList, ctx) {
  const { keyword, city, config, normalizeBossJob, dedupe, items, blockedCompanies } = ctx
  let added = 0
  let filtered = 0
  for (const raw of rawList) {
    const normalized = normalizeBossJob(raw, { keyword, city, config })
    if (!normalized) continue
    const sid = normalizeSourceId(normalized.sourceId)
    if (!sid || dedupe.has(sid)) continue

    const company = String(normalized.company ?? '')
    const blocked = blockedCompanies.some((name) => name && company.includes(name))
    if (blocked) {
      filtered += 1
      continue
    }

    normalized.sourceId = sid
    dedupe.add(sid)
    items.push(normalized)
    added += 1
  }
  return { added, filtered }
}

/**
 * 独立的移动端模拟采集入口（App 端 UA + 视口），用户手动触发。
 * 不与桌面采集合并执行，作为「开始采集」的补充。
 */
export async function collectBossJobsViaMobile(config, auth, db, helpers) {
  const { extractBossJobList, normalizeBossJob, cityCodeMap } = helpers

  await addLogEntry('info', '启动移动端模拟采集（iPhone UA + 移动视口）')

  const { puppeteer } = await resolveBossPuppeteer()

  let browser
  try {
    browser = await launchBossBrowser(puppeteer, {
      defaultViewport: { width: 390, height: 844 }
    })
  } catch (e) {
    await addLogEntry('error', `移动端浏览器启动失败：${e.message}`)
    return { items: [], grossJobCardsSeen: 0 }
  }

  const keywords = config.keywords?.length ? config.keywords : ['软件测试']
  const cities = config.cities?.length ? config.cities : ['杭州']
  const items = []
  const dedupe = new Set()
  let grossJobCardsSeen = 0

  try {
    for (const p of await browser.pages()) {
      await p.close().catch(() => {})
    }

    const mobileGross = await collectViaMobileEmulation(browser, {
      config, auth, db, keywords, cities, cityCodeMap,
      extractBossJobList, normalizeBossJob, dedupe, items
    })
    grossJobCardsSeen += mobileGross
  } finally {
    await browser.close().catch(() => {})
  }

  await addLogEntry(
    'info',
    `[移动端采集汇总] 关键词 ${keywords.length} 个 × 城市 ${cities.length} 个；` +
      `累计约 ${grossJobCardsSeen} 条，去重后待入库 ${items.length} 条`
  )

  return { items, grossJobCardsSeen }
}
