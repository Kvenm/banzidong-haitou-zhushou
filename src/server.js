import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addLogEntry,
  batchUpdateStatus,
  clearAllCandidateNewFlags,
  clearAuth,
  getSnapshot,
  pickConfirmedCandidatesForApply,
  readDb,
  replaceDb,
  saveAuth,
  saveConfig,
  updateCandidateStatus
} from './store.js'
import { applyConfirmedCandidates, collectCandidates, collectCandidatesViaMobile } from './automation/adapter.js'
import { applyConfirmedCandidatesGeekStyle } from './automation/adapterGeek.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const publicDir = path.join(rootDir, 'public')
const port = Number(process.env.PORT || 4173)

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url)
      return
    }
    await serveStatic(url.pathname, res)
  } catch (error) {
    sendJson(res, 500, { error: error.message })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`海投助手 Next 已启动: http://127.0.0.1:${port}`)
  startScheduleTimer()
})

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/snapshot') {
    sendJson(res, 200, await getSnapshot())
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/config') {
    const body = await readBody(req)
    sendJson(res, 200, { config: await saveConfig(body) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/auth') {
    const body = await readBody(req)
    sendJson(res, 200, { auth: await saveAuth(body) })
    return
  }

  if (req.method === 'DELETE' && url.pathname === '/api/auth') {
    sendJson(res, 200, { auth: await clearAuth() })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/collect') {
    const body = await readBody(req)
    const db = await readDb()
    if (body?.config && typeof body.config === 'object') {
      const keywords = normalizeCollectKeywords(body.config.keywords)
      if (keywords.length) {
        db.config = {
          ...db.config,
          ...body.config,
          keywords,
          keywordsMode: body.config.keywordsMode === 'single' ? 'single' : 'multiple'
        }
      }
    }
    const keywordsUsed = db.config?.keywords?.length ? db.config.keywords : ['软件测试']
    const candidates = await collectCandidates(db.config)
    sendJson(res, 200, { candidates, keywordsUsed })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/collect/mobile') {
    const db = await readDb()
    const keywordsUsed = db.config?.keywords?.length ? db.config.keywords : ['软件测试']
    const cities = db.config?.cities?.length ? db.config.cities : ['杭州']
    sendJson(res, 200, { status: 'started', keywordsUsed, cities })
    const candidates = await collectCandidatesViaMobile(db.config)
    if (candidates.length) {
      await addLogEntry('success', `[移动端采集] 完成，共新增 ${candidates.length} 个候选职位`)
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/apply') {
    const body = await readBody(req)
    const db = await readDb()
    const limit = db.config.dailyApplyLimit || 30
    const candidateIds = normalizeCandidateIds(body?.candidateIds)
    const confirmed = pickConfirmedCandidatesForApply(db, candidateIds, limit)
    if (!confirmed.length) {
      sendJson(res, 400, {
        error: candidateIds?.length
          ? '所选候选中没有仍处于「已确认」状态的职位，请刷新页面后重试'
          : '没有已确认的职位可以投递'
      })
      return
    }

    applyConfirmedCandidates(limit, candidateIds).catch((error) => {
      console.error('投递任务失败:', error)
    })

    sendJson(res, 200, {
      mode: 'semi-auto',
      message: `投递任务已启动，将按候选确认顺序处理 ${confirmed.length} 个职位（本轮上限 ${limit}）`,
      count: confirmed.length
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/apply-original') {
    const body = await readBody(req)
    const db = await readDb()
    const limit = db.config.dailyApplyLimit || 30
    const candidateIds = normalizeCandidateIds(body?.candidateIds)
    const confirmed = pickConfirmedCandidatesForApply(db, candidateIds, limit)
    if (!confirmed.length) {
      sendJson(res, 400, {
        error: candidateIds?.length
          ? '所选候选中没有仍处于「已确认」状态的职位，请刷新页面后重试'
          : '没有已确认的职位可以投递'
      })
      return
    }

    applyConfirmedCandidatesGeekStyle(limit, candidateIds).catch((error) => {
      console.error('Geek风格投递任务失败:', error)
    })

    sendJson(res, 200, {
      mode: 'geek-style',
      message: `Geek 反检测策略投递已启动，将按候选确认顺序处理 ${confirmed.length} 个职位（本轮上限 ${limit}）`,
      count: confirmed.length
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/capture') {
    // 异步执行 Cookie 捕获
    const { captureCookies } = await import('./automation/captureCookies.js')
    captureCookies().catch((error) => {
      console.error('Cookie 捕获失败:', error)
    })
    sendJson(res, 200, { message: '浏览器已打开，请在浏览器中登录 BOSS 直聘，登录成功后 Cookie 会自动保存' })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/candidate/open-url') {
    const id = url.searchParams.get('id')
    const db = await readDb()
    const candidate = db.candidates.find((item) => item.id === id)
    if (!candidate) {
      sendJson(res, 404, { error: '候选职位不存在' })
      return
    }
    const encryptJobId = candidate.raw?.encryptJobId ?? candidate.sourceId?.replace(/^boss-/, '')
    sendJson(res, 200, {
      url: encryptJobId ? `https://www.zhipin.com/job_detail/${encryptJobId}.html` : null
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/candidates/clear-new') {
    sendJson(res, 200, await clearAllCandidateNewFlags())
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/candidate/status') {
    const body = await readBody(req)
    sendJson(res, 200, { candidate: await updateCandidateStatus(body.id, body.status) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/candidates/status') {
    const body = await readBody(req)
    sendJson(res, 200, await batchUpdateStatus(body.ids ?? [], body.status))
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/export') {
    sendJson(res, 200, await readDb())
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/import') {
    const body = await readBody(req)
    sendJson(res, 200, await replaceDb(body))
    return
  }

  sendJson(res, 404, { error: 'API not found' })
}

async function serveStatic(pathname, res) {
  const safePath = pathname === '/' ? '/index.html' : pathname
  const filePath = path.normalize(path.join(publicDir, safePath))
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'Forbidden' })
    return
  }
  try {
    const content = await fs.readFile(filePath)
    res.writeHead(200, { 'content-type': mime[path.extname(filePath)] ?? 'application/octet-stream' })
    res.end(content)
  } catch {
    const content = await fs.readFile(path.join(publicDir, 'index.html'))
    res.writeHead(200, { 'content-type': mime['.html'] })
    res.end(content)
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/** @param {unknown} raw */
function normalizeCandidateIds(raw) {
  if (!Array.isArray(raw)) return null
  const ids = raw.map((id) => String(id).trim()).filter(Boolean)
  return ids.length ? ids : null
}

function normalizeCollectKeywords(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean)
  }
  return String(raw ?? '')
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

// ── 定时采集调度 ──
let scheduleTimer = null
let lastScheduledRun = ''

function startScheduleTimer() {
  if (scheduleTimer) clearInterval(scheduleTimer)
  scheduleTimer = setInterval(checkSchedule, 30000)
  console.log('定时采集调度已启动（每 30 秒检查一次）')
}

async function checkSchedule() {
  try {
    const db = await readDb()
    const cfg = db.config || {}
    if (!cfg.scheduleEnabled) return

    const now = new Date()

    // 检查星期
    const days = Array.isArray(cfg.scheduleDays) ? cfg.scheduleDays : [1, 2, 3, 4, 5]
    if (!days.includes(now.getDay())) return

    // 检查多时间段
    const times = Array.isArray(cfg.scheduleTimes) && cfg.scheduleTimes.length
      ? cfg.scheduleTimes
      : ['21:00', '21:30']

    let matchedTime = null
    for (const t of times) {
      const [h, m] = String(t).trim().split(':').map(Number)
      if (isNaN(h) || isNaN(m)) continue
      // ±1 分钟容差
      if (now.getHours() === h && now.getMinutes() >= m && now.getMinutes() <= m + 1) {
        matchedTime = `${h}:${String(m).padStart(2, '0')}`
        break
      }
    }
    if (!matchedTime) return

    // 防重复（同一时段只跑一次）
    const runKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${matchedTime}`
    if (lastScheduledRun === runKey) return
    lastScheduledRun = runKey

    await addLogEntry('info', `定时采集触发（${matchedTime}），开始自动采集…`)
    const result = await collectCandidates(db.config)
    const n = Array.isArray(result) ? result.length : 0
    await addLogEntry('success', `定时采集完成（${matchedTime}），新增 ${n} 条候选`)
  } catch (e) {
    console.error('定时采集异常:', e.message)
  }
}
