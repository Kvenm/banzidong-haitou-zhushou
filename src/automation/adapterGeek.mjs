import {
  addLogEntry,
  pickConfirmedCandidatesForApply,
  readDb,
  updateCandidateStatus
} from '../store.js'
import { launchBossBrowser } from './launchBossBrowser.mjs'
import { injectBossLocalStorage } from './injectBossLocalStorage.mjs'

/**
 * 参照原始 GeekGeekRun 的核心策略
 * 关键改进：
 * 1. 先访问推荐页面建立会话
 * 2. 等待页面完全加载
 * 3. 使用 waitForFunction 而不是简单的 evaluate
 * 4. 添加随机延迟模拟真人行为
 */

// 模拟原始项目的 sleep 函数
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const sleepWithRandomDelay = (baseMs) => sleep(baseMs + Math.random() * 1000)

/** puppeteer-extra 为单例，重复 .use() 会叠插件导致 launch 异常，只注册一次 */
let geekPuppeteerPluginsReady = false

async function resolvePuppeteerForGeek() {
  let puppeteer
  try {
    const imported = await import('puppeteer-extra')
    puppeteer = imported.default
  } catch {
    await addLogEntry('error', 'puppeteer-extra 未安装，回退到 puppeteer')
    const stdPuppeteer = await import('puppeteer')
    puppeteer = stdPuppeteer.default
    return { puppeteer }
  }

  if (!geekPuppeteerPluginsReady) {
    try {
      const stealth = (await import('puppeteer-extra-plugin-stealth')).default
      puppeteer.use(stealth())
    } catch (e) {
      await addLogEntry('warning', `Stealth 插件加载失败：${e.message}`)
    }
    try {
      const laodengMod = await import('@geekgeekrun/puppeteer-extra-plugin-laodeng')
      const Laodeng = laodengMod.default ?? laodengMod
      puppeteer.use(Laodeng())
      await addLogEntry('info', '已加载 GeekGeekRun 同款 laodeng 反检测插件')
    } catch (e) {
      await addLogEntry('warning', `laodeng 插件未加载（与 geek 行为可能不一致）：${e.message}`)
    }
    try {
      const anonymize = (await import('puppeteer-extra-plugin-anonymize-ua')).default
      puppeteer.use(anonymize({ makeWindows: false }))
      await addLogEntry('info', '已加载反爬虫插件（stealth + laodeng + anonymize-ua）')
    } catch (e) {
      await addLogEntry('warning', `UA 匿名插件加载失败：${e.message}`)
    }
    geekPuppeteerPluginsReady = true
  }

  return { puppeteer }
}

/**
 * 等待页面完全加载
 */
async function waitForPageComplete(page, timeout = 60000) {
  await page.waitForFunction(() => {
    return document.readyState === 'complete'
  }, { timeout })
}

/**
 * 等待元素出现
 */
async function waitForSelector(page, selector, timeout = 30000) {
  await page.waitForSelector(selector, { timeout })
}

/**
 * 检查登录状态
 */
async function checkLoginStatus(page) {
  try {
    const response = await page.evaluate(async () => {
      try {
        const res = await fetch('https://www.zhipin.com/wapi/zpuser/wap/getUserInfo.json')
        return await res.json()
      } catch {
        return null
      }
    })
    return response
  } catch {
    return null
  }
}

/** BOSS 职位详情 URL 中的 ID（可能带 .html 后缀） */
function normalizeBossEncryptJobId(id) {
  let s = String(id ?? '').trim()
  if (s.toLowerCase().endsWith('.html')) s = s.slice(0, -5)
  return s
}

/** 从当前页 URL 解析 BOSS 职位 encryptJobId（与库里比较的均为 normalize 后） */
function jobIdFromPageUrl(url) {
  const m = String(url).match(/\/job_detail\/([^/?#]+)/)
  if (!m) return ''
  return normalizeBossEncryptJobId(decodeURIComponent(m[1]))
}

/** GeekGeekRun 固定用此地址建立求职者端 SPA 会话（注意是 jobs 复数，不是 job） */
const GEEK_RECOMMEND_PAGE = 'https://www.zhipin.com/web/geek/jobs'

/**
 * BOSS 职位页「立即沟通」：Geek 主路径为 .job-detail-box .op-btn.op-btn-chat，补充其它壳层选择器
 */
const CHAT_BTN_SELECTORS = [
  '.job-detail-box .op-btn.op-btn-chat',
  '.job-detail-box .job-detail-operate .op-btn-chat',
  '.job-detail-operation .op-btn.op-btn-chat',
  'a.btn.btn-startchat',
  'a.btn-startchat',
  '.job-banner-operation a.btn-startchat',
  'a.op-btn.op-btn-chat',
  '.job-detail-header .op-btn.op-btn-chat',
  '.op-btn.op-btn-chat'
]

/**
 * 与 geek-auto-start-chat-with-boss 的 toRecommendPage 对齐： lands on /web/geek/jobs + complete
 * @param {import('puppeteer').Page} page
 */
async function ensureGeekRecommendSession(page) {
  await addLogEntry('info', '正在访问 Geek 同款推荐页 /web/geek/jobs 建立会话...')
  const userInfoPromise = page
    .waitForResponse(
      (r) => r.url().startsWith('https://www.zhipin.com/wapi/zpuser/wap/getUserInfo.json'),
      { timeout: 40000 }
    )
    .then((r) => r.json())
    .catch(() => null)

  await page.goto(GEEK_RECOMMEND_PAGE, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
  await sleep(3000)

  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 120000 })

  await page.waitForFunction(
    (prefix) => location.href.startsWith(prefix) && document.readyState === 'complete',
    { timeout: 120000 },
    GEEK_RECOMMEND_PAGE
  )

  const userInfoResponse = await userInfoPromise
  if (userInfoResponse && userInfoResponse.code !== 0) {
    await addLogEntry('warning', `推荐页阶段 getUserInfo code=${userInfoResponse.code}，后续仍会做登录校验`)
  }
}

/**
 * 轮询直至 Geek 主按钮存在且可见、文案含「立即沟通」（先不点击，便于随后再挂 waitForResponse）
 * @param {import('puppeteer').Page} page
 */
async function pollGeekPrimaryChatReady(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await page.evaluate((sels) => {
      function merged(el) {
        return `${el.textContent || ''} ${el.innerText || ''} ${el.innerHTML || ''}`
      }
      for (const sel of sels) {
        const el = document.querySelector(sel)
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) continue
        if (/立即沟通/.test(merged(el))) return true
      }
      return false
    }, CHAT_BTN_SELECTORS)
    if (ready) return true
    await sleep(400)
  }
  return false
}

/**
 * Geek 原版点击路径（须在注册 waitForResponse 之后调用）
 * @param {import('puppeteer').Page} page
 */
async function clickGeekPrimaryChatButton(page) {
  for (const sel of CHAT_BTN_SELECTORS) {
    const handle = await page.$(sel)
    if (!handle) continue
    const ok = await handle.evaluate((el) => {
      const merged = `${el.textContent || ''} ${el.innerText || ''} ${el.innerHTML || ''}`
      return /立即沟通/.test(merged)
    })
    if (!ok) {
      await handle.dispose().catch(() => {})
      continue
    }
    await handle.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }))
    await sleep(200)
    await handle.click({ delay: 40 })
    await handle.dispose().catch(() => {})
    return true
  }
  return false
}

/** @param {import('puppeteer').Page} page */
async function waitForUrlSubstring(page, sub, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (page.url().includes(sub)) return true
    } catch {
      //
    }
    await sleep(120)
  }
  return false
}

/**
 * 收集任意 friend/add.json 响应（解决 jobId 参数形态与库中 encrypt 不一致导致 waitForResponse 永不命中）
 * @param {import('puppeteer').Page} page
 */
function attachFriendAddCollector(page) {
  /** @type {import('puppeteer').HTTPResponse[]} */
  const list = []
  /** @param {import('puppeteer').HTTPResponse} res */
  const onResp = (res) => {
    try {
      const u = res.url()
      if (u.includes('/wapi/zpgeek/friend/add.json')) list.push(res)
    } catch {
      //
    }
  }
  page.on('response', onResp)
  return {
    takeLatest() {
      return list.length ? list[list.length - 1] : null
    },
    dispose() {
      page.off('response', onResp)
    }
  }
}

/**
 * 页面内原生 DOM 点击（与 Puppeteer 合成点击叠加；部分风控只拦一种）
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string>} 命中的选择器，空字符串表示未点
 */
async function domClickChatButtonEvaluate(page) {
  return page.evaluate((sels) => {
    for (const sel of sels) {
      const el = document.querySelector(sel)
      if (!el) continue
      const merged = `${el.textContent || ''} ${el.innerText || ''} ${el.innerHTML || ''}`
      if (!/立即沟通/.test(merged)) continue
      try {
        el.scrollIntoView({ block: 'center', inline: 'nearest' })
      } catch {
        //
      }
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      el.click()
      return sel
    }
    return ''
  }, CHAT_BTN_SELECTORS)
}

/** 在主文档 + iframe 内解析招呼 UI 状态 */
async function readGreetUiState(page) {
  return page.evaluate((sels) => {
    function scan(doc) {
      if (doc.querySelector('.greet-boss-dialog') || doc.querySelector('[class*="greet-boss-dialog"]')) {
        return 'dialog'
      }
      const ta = doc.querySelector(
        '.greet-boss-dialog .greet-boss-content textarea, [class*="greet-boss-content"] textarea, .dialog-body textarea'
      )
      if (ta) {
        const r = ta.getBoundingClientRect()
        if (r.width >= 1 && r.height >= 1) return 'dialog'
      }
      for (const sel of sels) {
        const btn = doc.querySelector(sel)
        if (!btn) continue
        const t = (btn.textContent || btn.innerText || '').replace(/\s+/g, ' ').trim()
        if (/待沟通/.test(t)) return 'already-chat'
        if (/继续沟通/.test(t)) return 'already-chat'
      }
      return ''
    }
    let s = scan(document)
    if (s) return s
    for (const fr of document.querySelectorAll('iframe')) {
      try {
        const d = fr.contentDocument
        if (d) {
          s = scan(d)
          if (s) return s
        }
      } catch {
        //
      }
    }
    return ''
  }, CHAT_BTN_SELECTORS)
}

async function waitForGreetOrAlreadyChat(page, timeoutMs) {
  await page.waitForFunction(
    (sels) => {
      function any(doc) {
        if (doc.querySelector('.greet-boss-dialog') || doc.querySelector('[class*="greet-boss-dialog"]')) {
          return true
        }
        const ta = doc.querySelector(
          '.greet-boss-dialog .greet-boss-content textarea, [class*="greet-boss-content"] textarea, .dialog-body textarea'
        )
        if (ta) {
          const r = ta.getBoundingClientRect()
          if (r.width >= 1 && r.height >= 1) return true
        }
        for (const sel of sels) {
          const btn = doc.querySelector(sel)
          if (!btn) continue
          const t = (btn.textContent || btn.innerText || '').replace(/\s+/g, ' ').trim()
          if (/待沟通/.test(t)) return true
          if (/继续沟通/.test(t)) return true
        }
        return false
      }
      if (any(document)) return true
      for (const fr of document.querySelectorAll('iframe')) {
        try {
          const d = fr.contentDocument
          if (d && any(d)) return true
        } catch {
          //
        }
      }
      return false
    },
    { timeout: timeoutMs, polling: 280 },
    CHAT_BTN_SELECTORS
  )
}

/** @param {import('puppeteer').Page} page */
async function logJobPageDiagnostics(page, label) {
  try {
    const d = await page.evaluate(() => ({
      href: location.href.slice(0, 220),
      ready: document.readyState,
      hasJobDetailBox: !!document.querySelector('.job-detail-box'),
      chatCandidates: document.querySelectorAll('.op-btn-chat, [class*="op-btn-chat"]').length
    }))
    await addLogEntry('warning', `${label} 页况：${JSON.stringify(d)}`)
  } catch (e) {
    await addLogEntry('warning', `${label} 诊断失败：${e?.message ?? e}`)
  }
}

/**
 * 在页面/iframe 内寻找「立即沟通」可点击区域，返回 **顶层视口** 下的点击坐标（修复 iframe getBoundingClientRect 偏差）
 * @param {import('puppeteer').Page} page
 */
async function deepFindChatClickTarget(page) {
  return page.evaluate((sels) => {
    function visible(el) {
      if (!el || el.nodeType !== 1) return false
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return false
      const st = window.getComputedStyle(el)
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false
      return true
    }

    function labelOf(el) {
      const t = (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim()
      if (t) return t
      return (el.getAttribute?.('aria-label') || '').trim()
    }

    function hasLiJi(el) {
      const lab = labelOf(el)
      if (/立即沟通/.test(lab)) return true
      const html = el.innerHTML || ''
      if (/立即沟通/.test(html.replace(/<[^>]+>/g, ' '))) return true
      return false
    }

    function centerMain(el) {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }

    /** @param {Element} el @param {HTMLIFrameElement} frameEl */
    function centerInFrame(el, frameEl) {
      const ir = el.getBoundingClientRect()
      const fr = frameEl.getBoundingClientRect()
      return {
        x: fr.left + ir.left + ir.width / 2,
        y: fr.top + ir.top + ir.height / 2
      }
    }

    /**
     * 防止 XPath 命中「包含整页文案」的祖先节点：日志里曾出现 label 为 var staticPath、_PAGE 全量输出
     */
    function isReasonableChatTarget(node) {
      const lab = labelOf(node)
      const cls = node.className?.toString?.() || ''
      const isOpBtn = /op-btn-chat|btn-chat/.test(cls)
      if (lab.length > 72 && !isOpBtn) return false
      if (lab.length > 200) return false
      return true
    }

    /**
     * @param {Element | null} el
     * @param {string} source
     * @param {HTMLIFrameElement | null} frameEl
     */
    function probe(el, source, frameEl) {
      if (!el || !visible(el)) return null
      let node = el
      if (el.tagName !== 'A' && el.tagName !== 'BUTTON' && el.getAttribute?.('role') !== 'button') {
        node = el.closest('a, button, [role="button"]') || el
      }
      const tag = node.tagName
      if (tag !== 'A' && tag !== 'BUTTON' && node.getAttribute?.('role') !== 'button') {
        const cls = node.className?.toString?.() || ''
        if (!/op-btn-chat|btn-chat/.test(cls)) return null
      }
      if (!visible(node) || !hasLiJi(node)) return null
      if (!isReasonableChatTarget(node)) return null
      const pos = frameEl ? centerInFrame(node, frameEl) : centerMain(node)
      const shortLabel = labelOf(node)
      const safeLabel =
        shortLabel.length > 80 ? `${shortLabel.slice(0, 77)}…(${shortLabel.length}字)` : shortLabel || '立即沟通'
      return { x: pos.x, y: pos.y, label: safeLabel, source }
    }

    for (const sel of sels) {
      const hit = probe(document.querySelector(sel), `sel:${sel}`, null)
      if (hit) return hit
    }

    for (const el of document.querySelectorAll('[class*="op-btn-chat"], [class*="btn-chat"]')) {
      const hit = probe(el, 'scan-class', null)
      if (hit) return hit
    }

    const snap = document.evaluate(
      ".//*[self::a or self::button][contains(normalize-space(string(.)), '立即沟通')]",
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    )
    for (let i = 0; i < snap.snapshotLength; i++) {
      const raw = snap.snapshotItem(i)
      if (!raw || raw.nodeType !== 1) continue
      const el = /** @type {Element} */ (raw)
      const hit = probe(el.closest('a, button, [role="button"]') || el, 'xpath', null)
      if (hit) return hit
    }

    for (const fr of document.querySelectorAll('iframe')) {
      let doc
      try {
        doc = fr.contentDocument
      } catch {
        continue
      }
      if (!doc) continue
      for (const sel of sels) {
        const hit = probe(doc.querySelector(sel), `iframe:${sel}`, fr)
        if (hit) return hit
      }
      try {
        const snap2 = doc.evaluate(
          ".//*[self::a or self::button][contains(normalize-space(string(.)), '立即沟通')]",
          doc,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null
        )
        for (let j = 0; j < snap2.snapshotLength; j++) {
          const raw = snap2.snapshotItem(j)
          if (!raw || raw.nodeType !== 1) continue
          const el = /** @type {Element} */ (raw)
          const hit = probe(el.closest('a, button, [role="button"]') || el, 'xpath-ifr', fr)
          if (hit) return hit
        }
      } catch {
        //
      }
    }

    return null
  }, CHAT_BTN_SELECTORS)
}

/** @param {import('puppeteer').Page} page */
async function pollFindChatTarget(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = await deepFindChatClickTarget(page).catch(() => null)
    if (hit && Number.isFinite(hit.x) && Number.isFinite(hit.y)) return hit
    await sleep(400)
  }
  return null
}

/**
 * 主投递函数 - Geek 风格浏览器投递（海投候选列表 + 插件栈）
 */
export async function applyConfirmedCandidatesGeekStyle(limit = 30, candidateIds = null) {
  const db = await readDb()
  const confirmed = pickConfirmedCandidatesForApply(db, candidateIds, limit)

  if (confirmed.length === 0) {
    await addLogEntry('info', '没有已确认的职位需要投递')
    return { count: 0 }
  }

  await addLogEntry('info', `开始投递 ${confirmed.length} 个职位，使用 GeekGeekRun 原始策略`)

  // 记录将要投递的职位列表
  for (const c of confirmed) {
    await addLogEntry('info', `[准备投递] ${c.title} - ${c.company} (ID: ${c.sourceId})`)
  }

  const { puppeteer } = await resolvePuppeteerForGeek()

  // 启动浏览器（多路回退：环境变量 → 自带 Chromium → 本机 Chrome）
  let browser
  try {
    browser = await launchBossBrowser(puppeteer, {
      defaultViewport: {
        width: 1440,
        height: 760
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

  // 获取 Cookie
  const cookieJson = db.auth?.bossCookieJson?.trim()
  if (!cookieJson) {
    await addLogEntry('error', '未找到 Cookie')
    await browser.close()
    return { error: 'No cookie found' }
  }

  let cookies
  try {
    cookies = JSON.parse(cookieJson)
    await addLogEntry('info', `已加载 ${cookies.length} 个 Cookie`)
  } catch (error) {
    await addLogEntry('error', `Cookie 解析失败：${error.message}`)
    await browser.close()
    return { error: 'Invalid cookie format' }
  }

  // 获取第一页
  const page = (await browser.pages())[0]

  // 设置 Cookie（参照原始逻辑）
  await addLogEntry('info', '正在设置 Cookie...')
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

  const lsText = String(db.auth?.bossLocalStorageJson ?? '').trim()
  if (lsText) {
    try {
      const lsObj = JSON.parse(lsText)
      if (lsObj && typeof lsObj === 'object' && !Array.isArray(lsObj)) {
        await injectBossLocalStorage(browser, lsObj)
      } else {
        await addLogEntry('info', 'bossLocalStorageJson 需为对象 {...}，当前已跳过注入')
      }
    } catch (e) {
      await addLogEntry('warning', `bossLocalStorageJson 解析失败：${e.message}`)
    }
  } else {
    await addLogEntry(
      'info',
      '提示：未配置 LocalStorage 时仅依赖 Cookie；若与 Geek 行为差异大，请在「授权」里粘贴已登录 BOSS 的 localStorage JSON'
    )
  }

  // 关键：与 Geek 一致，先落在 /web/geek/jobs（复数）再跑详情，避免 SPA 会话与直聘内嵌页不一致
  try {
    await ensureGeekRecommendSession(page)
  } catch (e) {
    await addLogEntry('warning', `推荐页就绪等待异常（仍将尝试继续）：${e?.message ?? e}`)
  }

  // 验证登录状态
  await addLogEntry('info', '验证登录状态...')
  const userInfo = await checkLoginStatus(page)

  if (!userInfo || userInfo.code !== 0) {
    await addLogEntry('error', '登录状态无效，Cookie 可能已失效')
    await browser.close()
    return { error: 'LOGIN_STATUS_INVALID' }
  }

  await addLogEntry('success', '登录状态验证通过')

  // 等待页面完全稳定
  try {
    await waitForPageComplete(page, 30000)
  } catch {
    await addLogEntry('warning', '等待页面完全加载超时，继续处理...')
  }

  await page.bringToFront().catch(() => {})

  // GeekGeekRun 同款：始终用登录时这一个 Tab 在「推荐页 <-> 职位详情」间跳转；新开 Tab 易触发风控（about:blank / 黑屏）
  for (let jobIdx = 0; jobIdx < confirmed.length; jobIdx++) {
    const candidate = confirmed[jobIdx]
    const encryptRaw = candidate.raw?.encryptJobId ?? candidate.sourceId?.replace(/^boss-/, '')
    const expectNorm = normalizeBossEncryptJobId(encryptRaw)
    if (!expectNorm) {
      await addLogEntry('warning', `职位缺少 job ID`)
      results.skipped++
      continue
    }

    const jobUrl = `https://www.zhipin.com/job_detail/${encryptRaw}.html`
    await addLogEntry('info', `正在打开：${candidate.title} - ${candidate.company}`)

    await sleepWithRandomDelay(1800)

    try {
      await addLogEntry('info', '打开职位页（Referer=推荐页，优先 waitUntil=load）...')
      await page
        .goto(jobUrl, { waitUntil: 'load', timeout: 60000, referer: GEEK_RECOMMEND_PAGE })
        .catch(async () =>
          page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000, referer: GEEK_RECOMMEND_PAGE })
        )
      await sleep(3000)

      try {
        await waitForPageComplete(page, 35000)
      } catch {
        await addLogEntry('warning', '页面加载超时，尝试继续...')
      }

      let currentUrl = page.url()
      if (currentUrl === 'about:blank' || !currentUrl.includes('zhipin.com')) {
        await addLogEntry('warning', '职位页疑似未加载，重试一次 goto')
        await sleep(2000)
        await page
          .goto(jobUrl, { waitUntil: 'load', timeout: 60000, referer: GEEK_RECOMMEND_PAGE })
          .catch(async () =>
            page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000, referer: GEEK_RECOMMEND_PAGE })
          )
        await sleep(2000)
        currentUrl = page.url()
      }

      if (currentUrl.includes('403.html') || currentUrl.includes('error.html')) {
        await addLogEntry('error', `访问被拒绝 (403/Error)：${candidate.title}`)
        results.failed++
        await page.goto(GEEK_RECOMMEND_PAGE, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
        await sleep(2000)
        continue
      }

      if (currentUrl.includes('login') || currentUrl.includes('passport')) {
        await addLogEntry('warning', `跳转到登录页，Cookie 失效`)
        results.failed++
        continue
      }

      const urlNorm = jobIdFromPageUrl(currentUrl)
      if (urlNorm === expectNorm) {
        await addLogEntry('info', `地址栏职位 ID 与当前候选一致`)
      } else {
        await addLogEntry(
          'info',
          `当前为 SPA 常见地址（未含 job_detail 或与预期 ID 不一致），仍按原 Geek 流试投：${currentUrl.slice(0, 140)}`
        )
      }

      if (currentUrl.includes('_security_check')) {
        await addLogEntry('info', '检测到地址栏含 _security_check，延长等待 SPA 稳定…')
        await sleep(4000)
      }

      const domHasEncrypt = await page.evaluate((id) => {
        if (!id) return false
        const h = document.documentElement.innerHTML
        if (h.includes(id)) return true
        const noT = id.replace(/~$/, '')
        return noT !== id && h.includes(noT)
      }, encryptRaw)

      if (!domHasEncrypt) {
        await addLogEntry(
          'warning',
          `当前页 DOM 未包含本候选 encryptId（常见于安全/跳转后详情被替换），将二次 goto job_detail`
        )
        await page
          .goto(jobUrl, { waitUntil: 'load', timeout: 60000, referer: GEEK_RECOMMEND_PAGE })
          .catch(async () =>
            page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000, referer: GEEK_RECOMMEND_PAGE })
          )
        await sleep(4000)
      }

      const pcClassicState = await page.evaluate(() => {
        const start = document.querySelector(
          'a.btn.btn-startchat, a.btn-startchat, .job-banner-operation a.btn-startchat'
        )
        const tx = (start?.textContent || '').replace(/\s+/g, ' ').trim()
        if (start && /继续沟通/.test(tx)) return 'continue-chat'
        if (start && /立即沟通/.test(tx)) return 'immediate'
        return ''
      })
      if (pcClassicState === 'continue-chat') {
        await addLogEntry('info', `PC 直链样式详情：主按钮为「继续沟通」，视为已开聊跳过：${candidate.title}`)
        await updateCandidateStatus(candidate.id, 'applied')
        results.skipped++
        await page.goto(GEEK_RECOMMEND_PAGE, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
        await sleep(2000)
        continue
      }

      const capMode = process.env.HAITOU_CAPTURE_JOB_DETAIL ?? 'first'
      if (capMode !== '0' && (capMode === '1' || (capMode === 'first' && jobIdx === 0))) {
        try {
          const { captureJobDetailProbe } = await import('./captureJobDetailProbe.mjs')
          const { jsonPath, probe } = await captureJobDetailProbe(page, {
            encryptRaw: expectNorm,
            candidateTitle: candidate.title,
            company: candidate.company,
            selectors: CHAT_BTN_SELECTORS
          })
          await addLogEntry(
            'info',
            `职位详情已自动探测：chatLike=${probe.chatLikeControls?.length ?? 0} opBtnChat=${probe.opBtnChatCount} JSON=${jsonPath}`
          )
        } catch (e) {
          await addLogEntry('warning', `详情页探测失败：${e.message}`)
        }
      }

      await addLogEntry('info', '探测沟通按钮：优先 Geek 主选择器，其次深度扫描坐标...')
      let geekReady = await pollGeekPrimaryChatReady(page, 45000)
      let hit = null

      if (!geekReady) {
        hit = await pollFindChatTarget(page, 35000)
      }

      if (!geekReady && !hit) {
        await addLogEntry('warning', '首轮未识别到按钮，尝试 reload 后再探测')
        await page.reload({ waitUntil: 'load', timeout: 45000 }).catch(() => {})
        await sleep(3000)
        geekReady = await pollGeekPrimaryChatReady(page, 25000)
        if (!geekReady) {
          hit = await pollFindChatTarget(page, 25000)
        }
      }

      if (!geekReady && !hit) {
        await logJobPageDiagnostics(page, '未找到立即沟通')
        await addLogEntry('warning', `仍未找到可点击的「立即沟通」：${candidate.title}`)
        results.failed++
        await page.goto(GEEK_RECOMMEND_PAGE, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
        await sleep(2000)
        continue
      }

      if (!geekReady && hit) {
        await addLogEntry(
          'info',
          `已定位沟通区（坐标兜底）：${hit.label}（${hit.source}）视口 (${Math.round(hit.x)}, ${Math.round(hit.y)})`
        )
        if (!/立即沟通/.test((hit.label || '').replace(/\s/g, ''))) {
          await addLogEntry('info', `当前区域文案：${hit.label}（非立即沟通则跳过点击）`)
          if (/待沟通/.test(hit.label) || /继续沟通/.test(hit.label)) {
            await updateCandidateStatus(candidate.id, 'applied')
            results.skipped++
          }
          await page.goto(GEEK_RECOMMEND_PAGE, {
            waitUntil: 'domcontentloaded',
            timeout: 15000
          })
          await sleep(2000)
          continue
        }
      } else if (geekReady) {
        await addLogEntry('info', 'Geek 主按钮已就绪，将使用 ElementHandle.click（与 geekgeekrun 一致）')
      }

      const matchFriendAddStrict = (r) => {
        const u = r.url()
        if (!u.includes('/wapi/zpgeek/friend/add.json')) return false
        return (
          u.includes(`jobId=${encryptRaw}`) ||
          (encryptRaw && u.includes(encodeURIComponent(encryptRaw))) ||
          u.includes(expectNorm) ||
          (expectNorm && u.includes(encodeURIComponent(expectNorm))) ||
          u.includes(encryptRaw)
        )
      }

      const friendCollector = attachFriendAddCollector(page)
      let collectionDisposed = false
      const disposeCollector = () => {
        if (collectionDisposed) return
        collectionDisposed = true
        friendCollector.dispose()
      }

      try {
        const respPromise = page.waitForResponse(matchFriendAddStrict, { timeout: 30000 }).catch(() => null)

        let clicked = false
        if (geekReady) {
          clicked = await clickGeekPrimaryChatButton(page)
          if (!clicked && hit) {
            await addLogEntry('warning', '主选择器点击失败，回退到坐标点击')
            await page.mouse.move(hit.x + (Math.random() * 4 - 2), hit.y + (Math.random() * 4 - 2))
            await sleep(100 + Math.floor(Math.random() * 120))
            await page.mouse.click(hit.x, hit.y, { delay: 60 + Math.floor(Math.random() * 60) })
            clicked = true
          }
        } else if (hit) {
          await addLogEntry('info', `模拟点击「立即沟通」视口坐标...`)
          await page.mouse.move(hit.x + (Math.random() * 4 - 2), hit.y + (Math.random() * 4 - 2))
          await sleep(100 + Math.floor(Math.random() * 120))
          await page.mouse.click(hit.x, hit.y, { delay: 60 + Math.floor(Math.random() * 60) })
          clicked = true
        }

        if (clicked) {
          await sleep(320)
          const domSel = await domClickChatButtonEvaluate(page)
          if (domSel) {
            await addLogEntry('info', `已追加页面内原生 click（${domSel}），提高开聊触发率`)
          }
        }

        if (!clicked) {
          await logJobPageDiagnostics(page, '点击失败')
          results.failed++
          await page.goto(GEEK_RECOMMEND_PAGE, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
          await sleep(2000)
          continue
        }

        let addResp = await respPromise
        if (!addResp?.ok?.()) {
          await sleep(650)
          const loose = friendCollector.takeLatest()
          if (loose?.ok?.()) {
            addResp = loose
            await addLogEntry('info', '严格 URL 未命中，已用语义收集器拾取 friend/add.json')
          }
        }

        let body = null
        if (addResp?.ok?.()) {
          await addLogEntry('info', `开聊接口响应：HTTP ${addResp.status()} ${addResp.url().slice(-96)}`)
          try {
            body = await addResp.json()
          } catch {
            body = null
          }
        }

        let apiOk = body?.code === 0
        if (addResp?.ok?.() && body == null) {
          apiOk = true
        }

        for (let confirmRound = 0; !apiOk && confirmRound < 2; confirmRound++) {
          const sure = await page.$('.chat-block-dialog .chat-block-footer .sure-btn')
          if (!sure) break
          await addLogEntry('info', `检测到开聊拦截/二次确认弹窗，第 ${confirmRound + 1} 次点击「确定」（对齐 Geek）`)
          const nextP = page.waitForResponse(matchFriendAddStrict, { timeout: 25000 }).catch(() => null)
          try {
            await sure.click()
          } catch {
            break
          }
          addResp = await nextP
          body = addResp?.ok?.() ? await addResp.json().catch(() => null) : null
          apiOk = body?.code === 0
          if (addResp?.ok?.() && body == null) apiOk = true
        }

        let chatJumped = page.url().includes('/web/geek/chat')
        if (!chatJumped) {
          chatJumped = await waitForUrlSubstring(page, '/web/geek/chat', 6000)
        }
        if (chatJumped) {
          apiOk = true
          await addLogEntry('info', '页面已跳转至 /web/geek/chat（Geek 同款视为开聊成功）')
        }

        let greetState = 'timeout'
        if (chatJumped) {
          greetState = ''
        } else {
          try {
            await waitForGreetOrAlreadyChat(page, 38000)
            greetState = await readGreetUiState(page)
          } catch {
            greetState = await readGreetUiState(page)
          }
        }

        if (greetState === 'already-chat') {
          await addLogEntry('info', `未检测到招呼弹窗，按钮已为「待沟通」，视为已开聊：${candidate.title}`)
          await updateCandidateStatus(candidate.id, 'applied')
          results.success++
        } else if (apiOk && greetState !== 'dialog') {
          await addLogEntry(
            'success',
            `开聊接口已成功且无必须处理的异常状态，记为投递成功：${candidate.title} - ${candidate.company}`
          )
          await updateCandidateStatus(candidate.id, 'applied')
          results.success++
        } else if (greetState === 'dialog') {
          try {
            await page.waitForFunction(
              () => {
                function hasTa(doc) {
                  return !!doc.querySelector(
                    '.greet-boss-dialog .greet-boss-content textarea, [class*="greet-boss-content"] textarea, .dialog-body textarea'
                  )
                }
                if (hasTa(document)) return true
                for (const fr of document.querySelectorAll('iframe')) {
                  try {
                    const d = fr.contentDocument
                    if (d && hasTa(d)) return true
                  } catch {
                    //
                  }
                }
                return false
              },
              { timeout: 16000, polling: 250 }
            )
          } catch {
            await addLogEntry('warning', '招呼弹窗已出现但输入框未及时就绪')
          }

          if (candidate.greeting) {
            await page.evaluate((text) => {
              function fill(doc) {
                const sels = [
                  '.greet-boss-dialog .greet-boss-content textarea',
                  '[class*="greet-boss-content"] textarea',
                  '.dialog-body textarea'
                ]
                for (const s of sels) {
                  const textarea = doc.querySelector(s)
                  if (textarea) {
                    textarea.value = text
                    textarea.dispatchEvent(new Event('input', { bubbles: true }))
                    return true
                  }
                }
                return false
              }
              if (fill(document)) return
              for (const fr of document.querySelectorAll('iframe')) {
                try {
                  const d = fr.contentDocument
                  if (d && fill(d)) return
                } catch {
                  //
                }
              }
            }, candidate.greeting)
            await sleep(600)
          }

          const sendViaEvaluate = await page.evaluate(() => {
            function tap(doc) {
              const sels = [
                '.greet-boss-dialog .greet-boss-footer .sure-btn',
                '[class*="greet-boss-footer"] .sure-btn',
                '.greet-boss-dialog button.sure-btn',
                'button.sure-btn'
              ]
              for (const s of sels) {
                const b = doc.querySelector(s)
                if (b) {
                  const r = b.getBoundingClientRect()
                  if (r.width >= 1 && r.height >= 1) {
                    b.click()
                    return true
                  }
                }
              }
              return false
            }
            if (tap(document)) return true
            for (const fr of document.querySelectorAll('iframe')) {
              try {
                const d = fr.contentDocument
                if (d && tap(d)) return true
              } catch {
                //
              }
            }
            return false
          })

          if (sendViaEvaluate) {
            await page
              .waitForFunction(() => !document.querySelector('.greet-boss-dialog'), {
                timeout: 20000,
                polling: 300
              })
              .catch(() => {})
            await sleepWithRandomDelay(1500)
            await addLogEntry('success', `已发送招呼：${candidate.title} - ${candidate.company}`)

            await updateCandidateStatus(candidate.id, 'applied')
            results.success++
          } else {
            const sendButton = await page.$('.greet-boss-dialog .greet-boss-footer .sure-btn')
            if (sendButton) {
              await sendButton.click()
              await page
                .waitForFunction(() => !document.querySelector('.greet-boss-dialog'), {
                  timeout: 20000,
                  polling: 300
                })
                .catch(() => {})
              await sleepWithRandomDelay(1500)
              await addLogEntry('success', `已发送招呼：${candidate.title} - ${candidate.company}`)

              await updateCandidateStatus(candidate.id, 'applied')
              results.success++
            } else {
              await addLogEntry('warning', '未找到发送按钮')
              results.failed++
            }
          }
        } else {
          await addLogEntry(
            'warning',
            `点击沟通后无招呼弹窗且按钮未变「待沟通」：${candidate.title} - ${candidate.company}`
          )
          results.failed++
        }

        await page.goto(GEEK_RECOMMEND_PAGE, {
          waitUntil: 'domcontentloaded',
          timeout: 15000
        })
        await sleepWithRandomDelay(2500)
      } finally {
        disposeCollector()
      }
    } catch (error) {
      const em = String(error?.message ?? error)
      if (/detached frame/i.test(em)) {
        await addLogEntry(
          'error',
          `页面被置换或框架已断开（常见于黑屏/风控）：${candidate.title} — ${em}`
        )
      } else {
        await addLogEntry('error', `处理失败：${error.message}`)
      }
      results.failed++
      await page.goto(GEEK_RECOMMEND_PAGE, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
      await sleep(2000)
    }
  }

  await browser.close()

  await addLogEntry('success', `投递完成！成功：${results.success}，跳过：${results.skipped}，失败：${results.failed}`)
  return results
}
